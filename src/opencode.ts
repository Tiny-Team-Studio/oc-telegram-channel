import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { FilePartInput, TextPartInput } from "@opencode-ai/sdk/v2";
import type { Config } from "./config.ts";

export type PromptPart = TextPartInput | FilePartInput;

export type OcEvent = { type: string; properties: Record<string, any> };

export function isTurnComplete(ev: OcEvent): { sessionID: string; messageID: string } | null {
  if (ev.type !== "message.updated") return null;
  const info = ev.properties?.info;
  if (!info || info.role !== "assistant") return null;
  if (!info.time?.completed) return null;
  return { sessionID: info.sessionID, messageID: info.id };
}

// Per-message, per-part ordered accumulation. The answer is assembled ONLY from
// `message.part.updated` snapshots whose `part.type === "text"`. We deliberately ignore
// `message.part.delta` events: a delta carries no part-type, and a ReasoningPart streams
// its body in a delta whose within-part `field` is literally "text" — indistinguishable
// from answer text — so the delta path leaked reasoning into the answer. Snapshots carry
// `part.type`, so reasoning parts are cleanly excluded. We only ever send on turn
// completion, so incremental deltas were never needed.
export class TurnAccumulator {
  private order = new Map<string, string[]>();        // messageID -> ordered partIDs
  private parts = new Map<string, Map<string, string>>(); // messageID -> partID -> text

  apply(ev: OcEvent): void {
    if (ev.type !== "message.part.updated") return;
    // Snapshot shape: { sessionID, part, time }; text parts carry part.text.
    const part = ev.properties?.part;
    if (part?.type !== "text") return;             // exclude reasoning/tool/step parts
    const messageID: string = part.messageID;
    const partID: string = part.id;
    const pm = this.ensure(messageID, partID);
    const prev = pm.get(partID) ?? "";
    if (typeof part.text === "string" && part.text.length >= prev.length) pm.set(partID, part.text);
  }

  // Lazily create the per-message order list + part map and register first-seen partIDs.
  private ensure(messageID: string, partID: string): Map<string, string> {
    if (!this.order.has(messageID)) this.order.set(messageID, []);
    if (!this.parts.has(messageID)) this.parts.set(messageID, new Map());
    const ord = this.order.get(messageID)!;
    const pm = this.parts.get(messageID)!;
    if (!pm.has(partID)) ord.push(partID);
    return pm;
  }

  text(messageID: string): string {
    const ord = this.order.get(messageID);
    const pm = this.parts.get(messageID);
    if (!ord || !pm) return "";
    return ord.map((id) => pm.get(id) ?? "").join("");
  }

  clear(messageID: string): void {
    this.order.delete(messageID);
    this.parts.delete(messageID);
  }
}

// --- OpenCode SDK adapter (@opencode-ai/sdk/v2) ---

export function createClient(cfg: Config) {
  return createOpencodeClient({ baseUrl: cfg.serveUrl });
}

const sessionByChat = new Map<number, string>();

// One session per chat = conversation continuity. Cached for the process lifetime.
export async function ensureSession(client: any, cfg: Config, chatId: number): Promise<string> {
  const existing = sessionByChat.get(chatId);
  if (existing) return existing;
  const { data, error } = await client.session.create({ directory: cfg.workdir });
  if (error || !data?.id) throw new Error(`session.create failed: ${JSON.stringify(error)}`);
  sessionByChat.set(chatId, data.id);
  return data.id;
}

// Tell the attached `opencode attach` TUI to navigate to and display this session, so
// the TUI shows the live conversation instead of the welcome splash. Best-effort: the TUI
// may not be attached, so swallow all errors — this must never throw into the caller.
export async function focusTui(client: any, sessionID: string): Promise<void> {
  try {
    await client.tui.selectSession({ sessionID });
  } catch {
    // TUI not attached / serve unavailable — non-fatal, ignore.
  }
}

// Fire-and-forget: promptAsync returns immediately; the answer arrives via the SSE loop.
// Accepts EITHER a plain string (existing callers — wrapped to a single text part)
// OR a parts array (inbound media: TextPartInput[] / FilePartInput[]). The parts
// array is exactly the SDK prompt shape (types.gen.ts SessionPromptData.parts).
export async function sendPrompt(
  client: any,
  cfg: Config,
  sessionID: string,
  input: string | PromptPart[],
): Promise<void> {
  const parts: PromptPart[] =
    typeof input === "string" ? [{ type: "text", text: input }] : input;
  const { error } = await client.session.promptAsync({
    sessionID,
    directory: cfg.workdir,
    // Omit `model` so OpenCode resolves it from opencode.json (the agent's model).
    // Only force an override when OPENCODE_MODEL_ID is set (cfg.modelId non-empty).
    ...(cfg.modelId ? { model: { providerID: cfg.modelProvider, modelID: cfg.modelId } } : {}),
    parts,
  });
  if (error) throw new Error(`promptAsync failed: ${JSON.stringify(error)}`);
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const IDLE_TIMEOUT_MS = 30000;

// Backoff for consecutive reconnect attempts: 1s, 2s, 4s, 8s, capped at 15s.
// `attempt` is 1-based (the Nth consecutive drop without a successful event).
export function nextBackoff(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
}

// Injection seams so the reconnect loop is unit-testable without real timers/server.
export interface EventLoopOpts {
  sleep?: (ms: number, attempt: number) => Promise<void>;
  log?: (msg: string) => void;
}

// Reconnecting global SSE loop. Survives serve blips and the daily container roll.
//
// Outer loop re-subscribes until the signal aborts. EVERY drop — a thrown subscribe,
// a stream that throws mid-iteration, OR a clean stream end while not aborted — is
// logged exactly once and followed by a backoff sleep before the next subscribe.
// Backoff escalates (1s→15s) across consecutive drops and RESETS to 1s only after a
// (re)subscribe that yielded at least one event — so a server that accepts the SSE
// connection then immediately drops can't spin at 1s forever. `signal.aborted` exits
// cleanly with no reconnect. A 30s idle watchdog inside the stream forces a reconnect.
// The setImmediate yield per event keeps grammy's long-poll from being starved.
export async function runEventLoop(
  client: any,
  cfg: Config,
  onEvent: (ev: OcEvent) => void,
  signal: AbortSignal,
  opts: EventLoopOpts = {},
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log =
    opts.log ?? ((msg: string) => process.stderr.write(`oc-telegram: ${msg}\n`));

  let attempt = 0; // consecutive drops since the last event-bearing subscribe
  while (!signal.aborted) {
    let deliveredThisConn = false;
    let reason = "stream ended"; // overwritten if the connection threw
    try {
      const { stream } = await client.global.event({ signal });
      while (!signal.aborted) {
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<{ idle: true }>((r) => {
          idleTimer = setTimeout(() => r({ idle: true }), IDLE_TIMEOUT_MS);
        });
        const next = await Promise.race([stream.next(), idle]);
        clearTimeout(idleTimer); // always clear the losing timer once the race settles
        if ((next as any).idle) {
          reason = "idle timeout";
          await stream.return?.(undefined); // idle watchdog -> close + reconnect
          break;
        }
        const { value, done } = next as IteratorResult<any>;
        if (done) break;
        // global events are wrapped { directory, payload }; filter to our workdir, unwrap
        if (value?.directory && value.directory !== cfg.workdir) continue;
        const payload = value?.payload ?? value;
        if (payload && typeof payload.type === "string") {
          deliveredThisConn = true;
          onEvent(payload as OcEvent);
        }
        await new Promise((r) => setImmediate(r)); // yield so grammy long-poll isn't starved
      }
    } catch (e) {
      if (signal.aborted) return;
      reason = e instanceof Error ? e.message : String(e);
    }
    if (signal.aborted) return;
    // We dropped (throw, idle, or clean end) while still running -> reconnect. Reset
    // backoff only if this connection actually delivered an event; otherwise escalate.
    attempt = deliveredThisConn ? 1 : attempt + 1;
    // Exactly one log per drop (here, never per retry spin) so a flapping server
    // doesn't spam — the backoff sleep is what spaces the retries.
    log(`SSE stream dropped (${reason}), reconnecting (attempt ${attempt})`);
    await sleep(nextBackoff(attempt), attempt);
  }
}
