import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { Config } from "./config.ts";

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
export async function sendPrompt(client: any, cfg: Config, sessionID: string, text: string): Promise<void> {
  const { error } = await client.session.promptAsync({
    sessionID,
    directory: cfg.workdir,
    model: { providerID: cfg.modelProvider, modelID: cfg.modelId },
    parts: [{ type: "text", text }],
  });
  if (error) throw new Error(`promptAsync failed: ${JSON.stringify(error)}`);
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const IDLE_TIMEOUT_MS = 30000;

// Reconnecting global SSE loop. Backoff 1s→15s, 30s idle watchdog forces a reconnect,
// and a setImmediate yield per event keeps grammy's long-poll from being starved.
export async function runEventLoop(
  client: any,
  cfg: Config,
  onEvent: (ev: OcEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let attempt = 0;
  while (!signal.aborted) {
    try {
      const { stream } = await client.global.event({ signal });
      attempt = 0; // reset backoff on a successful open
      while (!signal.aborted) {
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<{ idle: true }>((r) => {
          idleTimer = setTimeout(() => r({ idle: true }), IDLE_TIMEOUT_MS);
        });
        const next = await Promise.race([stream.next(), idle]);
        clearTimeout(idleTimer); // always clear the losing timer once the race settles
        if ((next as any).idle) {
          await stream.return?.(undefined); // idle watchdog -> close + reconnect
          break;
        }
        const { value, done } = next as IteratorResult<any>;
        if (done) break;
        // global events are wrapped { directory, payload }; filter to our workdir, unwrap
        if (value?.directory && value.directory !== cfg.workdir) continue;
        const payload = value?.payload ?? value;
        if (payload && typeof payload.type === "string") onEvent(payload as OcEvent);
        await new Promise((r) => setImmediate(r)); // yield so grammy long-poll isn't starved
      }
    } catch (e) {
      if (signal.aborted) return;
      process.stderr.write(
        `oc-telegram: SSE loop error, reconnecting: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
    if (signal.aborted) return;
    attempt++;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
    await new Promise((r) => setTimeout(r, delay));
  }
}
