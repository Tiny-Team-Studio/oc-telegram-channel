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

// Per-message, per-part ordered accumulation. Snapshot (part.text) wins over delta concat.
export class TurnAccumulator {
  private order = new Map<string, string[]>();        // messageID -> ordered partIDs
  private parts = new Map<string, Map<string, string>>(); // messageID -> partID -> text

  apply(ev: OcEvent): void {
    if (ev.type !== "message.part.delta" && ev.type !== "message.part.updated") return;
    const part = ev.properties?.part;
    if (!part || part.type !== "text") return;       // ignore reasoning/tool/step parts
    const messageID: string = part.messageID;
    const partID: string = part.id;
    const delta: string | undefined = ev.properties?.delta;
    const snapshot: string | undefined = part.text;

    if (!this.order.has(messageID)) this.order.set(messageID, []);
    if (!this.parts.has(messageID)) this.parts.set(messageID, new Map());
    const ord = this.order.get(messageID)!;
    const pm = this.parts.get(messageID)!;
    if (!pm.has(partID)) ord.push(partID);

    const prev = pm.get(partID) ?? "";
    let next = prev;
    if (typeof delta === "string") next = prev + delta;
    if (typeof snapshot === "string" && snapshot.length >= next.length) next = snapshot;
    pm.set(partID, next);
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

// Fire-and-forget: promptAsync returns immediately; the answer arrives via the SSE loop.
export async function sendPrompt(client: any, cfg: Config, sessionID: string, text: string): Promise<void> {
  const { error } = await client.session.promptAsync({
    sessionID,
    directory: cfg.workdir,
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
        const next = await Promise.race([
          stream.next(),
          new Promise<{ idle: true }>((r) => setTimeout(() => r({ idle: true }), IDLE_TIMEOUT_MS)),
        ]);
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
    } catch (_e) {
      if (signal.aborted) return;
    }
    if (signal.aborted) return;
    attempt++;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
    await new Promise((r) => setTimeout(r, delay));
  }
}
