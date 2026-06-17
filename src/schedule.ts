import { Cron } from "croner";

// OpenCode has no native cron and no channel concept, so the digest (and any
// future scheduled prompt) is driven by an in-channel cron timer. The env
// convention mirrors CC's cc-schedule-channel: per-named-cron triples
//   SCHEDULE_CRON_<NAME>          = the cron expression (REQUIRED)
//   SCHEDULE_TZ_<NAME>            = IANA timezone (default Europe/Amsterdam)
//   SCHEDULE_INSTRUCTIONS_<NAME>  = the prompt text sent on fire (REQUIRED)
// On fire a cron opens/reuses the owner-DM session and sends the instructions
// through the SAME delivery path as an interactive turn (registerTurn +
// sendPrompt) so the digest hits tg_reply / the delivery floor identically.

const DEFAULT_TZ = "Europe/Amsterdam";
const CRON_KEY_RE = /^SCHEDULE_CRON_(.+)$/;

export type CronSpec = {
  name: string;
  expr: string;
  tz: string;
  instructions: string;
};

// Pure: scan an env-like record for SCHEDULE_CRON_<NAME> keys, pairing each with
// its TZ (default Europe/Amsterdam) and INSTRUCTIONS (required — skip + warn if
// absent). A blank/whitespace-only cron expression is also skipped. Returns one
// CronSpec per fully-specified named cron.
export function parseCrons(env: Record<string, string | undefined>): CronSpec[] {
  const out: CronSpec[] = [];
  for (const [key, rawExpr] of Object.entries(env)) {
    const m = CRON_KEY_RE.exec(key);
    if (!m) continue;
    const name = m[1];
    const expr = (rawExpr ?? "").trim();
    if (!expr) continue; // empty cron expression — nothing to schedule
    const instructions = env[`SCHEDULE_INSTRUCTIONS_${name}`];
    if (!instructions) {
      console.warn(
        `[schedule] SCHEDULE_CRON_${name} has no SCHEDULE_INSTRUCTIONS_${name} — skipping`,
      );
      continue;
    }
    const tz = env[`SCHEDULE_TZ_${name}`] || DEFAULT_TZ;
    out.push({ name, expr, tz, instructions });
  }
  return out;
}

export type ScheduleDeps = {
  crons: CronSpec[];
  // Resolve the chat a scheduled run targets (the owner's DM chat_id).
  getTargetChat: () => number;
  ensureSession: (chatId: number) => Promise<string>;
  sendPrompt: (sessionID: string, text: string) => Promise<void>;
  // Mirror the interactive turn-start sequence: route SSE back to this chat,
  // reset the per-turn reply flag, start the typing indicator (refcounted).
  registerTurn: (sessionID: string, chatId: number) => void;
};

export type Schedule = { stop: () => void };

// Register one croner job per parsed cron. On fire, run the exact interactive
// turn-start sequence then send the instructions. Each job is independent; the
// callback swallows its own errors so one failed run never tears down the timer.
export function startSchedule(deps: ScheduleDeps): Schedule {
  const jobs: Cron[] = [];
  for (const { name, expr, tz, instructions } of deps.crons) {
    const job = new Cron(expr, { timezone: tz, name }, async () => {
      try {
        const chatId = deps.getTargetChat();
        const sessionID = await deps.ensureSession(chatId);
        deps.registerTurn(sessionID, chatId);
        await deps.sendPrompt(sessionID, instructions);
      } catch (e) {
        console.warn(
          `[schedule] cron ${name} fire failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    });
    console.log(`[schedule] registered cron ${name}: "${expr}" (${tz})`);
    jobs.push(job);
  }
  return {
    stop() {
      for (const j of jobs) j.stop();
    },
  };
}
