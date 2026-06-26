import type { Bot } from "grammy";
import type { OcEvent } from "./opencode.ts";
import type { Format } from "./config.ts";

// --- Pure formatter (TDD'd) ---

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type Step = { kind: "think" | "tool"; label: string };

const MAX_STEPS = 12;
const DELIVERY_TOOLS = new Set(["reply", "tg_reply"]);

function isDeliveryTool(tool: string): boolean {
  const normalized = tool.trim().toLowerCase();
  return DELIVERY_TOOLS.has(normalized) || normalized.endsWith("__reply");
}

function friendlyToolLabel(part: any): string {
  const tool = typeof part.tool === "string" ? part.tool : "tool";
  const normalized = tool.trim().toLowerCase();
  const mode = typeof part.state?.input?.mode === "string" ? part.state.input.mode.toLowerCase() : "";

  if (normalized === "memory") {
    if (mode === "add" || mode === "forget") return "updating my memory";
    return "checking my memory";
  }
  if (normalized === "bash") return "running a command";
  if (["read", "glob", "grep", "list"].includes(normalized)) return "checking the files";
  if (["edit", "write", "apply_patch"].includes(normalized)) return "updating files";
  return `using ${tool.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ")}`;
}

export function renderProgress(steps: Step[]): string {
  const step = steps.slice(-MAX_STEPS).at(-1);
  if (!step) return "";
  const label = esc(step.label);
  return step.kind === "think" ? "I'm thinking this through." : `I'm currently ${label}.`;
}

// --- ProgressBubble (integration; verified live, not unit-tested) ---

const THROTTLE_MS = 1500;

type SessionState = {
  steps: Step[];
  messageId?: number;
  lastEditAt: number;
  lastText: string;
};

// Drives a single live "train of thought" bubble per session. Lazy: no bubble
// is created until the first reasoning/tool event of a turn. Subsequent edits
// are throttled (≥1500ms) and deduped (skip identical text). On turn end the
// bubble is deleted and the session's state cleared. Every Telegram call is
// catch-guarded so a progress failure can never break the turn.
export class ProgressBubble {
  private state = new Map<string, SessionState>();

  constructor(
    private bot: Bot,
    private chatBySession: Map<string, number>,
  ) {}

  onEvent(ev: OcEvent): void {
    if (ev.type !== "message.part.updated" && ev.type !== "message.part.delta") return;
    const part = ev.properties?.part;
    if (!part) return;
    const sessionID: string | undefined = part.sessionID;
    if (!sessionID) return;

    const step = this.stepFor(part);
    if (!step) return;

    const st = this.ensure(sessionID);
    // Dedup consecutive identical steps (e.g. a tool moving pending→running→…
    // can repeat the same label; reasoning deltas can repeat snippets).
    const last = st.steps[st.steps.length - 1];
    if (last && last.kind === step.kind && last.label === step.label) return;
    st.steps.push(step);

    void this.render(sessionID, st);
  }

  // Delete the bubble + clear state for this session. Called on turn completion.
  finish(sessionID: string): void {
    const st = this.state.get(sessionID);
    this.state.delete(sessionID);
    if (!st?.messageId) return;
    const chatId = this.chatBySession.get(sessionID);
    if (chatId == null) return;
    void this.bot.api.deleteMessage(chatId, st.messageId).catch(() => {});
  }

  private stepFor(part: any): Step | null {
    switch (part.type) {
      case "reasoning": {
        const text = typeof part.text === "string" ? part.text.trim() : "";
        if (!text) return null;
        return { kind: "think", label: "thinking" };
      }
      case "tool": {
        const tool = typeof part.tool === "string" ? part.tool : "tool";
        if (isDeliveryTool(tool)) return null;
        return { kind: "tool", label: friendlyToolLabel(part) };
      }
      default:
        return null; // step-start / text / other → no bubble line
    }
  }

  async replaceWithFinal(sessionID: string, text: string, format?: Format): Promise<boolean> {
    if (format === "rich") return false;
    const st = this.state.get(sessionID);
    this.state.delete(sessionID);
    if (!st?.messageId) return false;
    const chatId = this.chatBySession.get(sessionID);
    if (chatId == null) return false;
    try {
      await this.bot.api.editMessageText(chatId, st.messageId, text, {
        ...(format !== "text" ? { parse_mode: "HTML" as const } : {}),
      });
      return true;
    } catch {
      return false;
    }
  }

  private ensure(sessionID: string): SessionState {
    let st = this.state.get(sessionID);
    if (!st) {
      st = { steps: [], lastEditAt: 0, lastText: "" };
      this.state.set(sessionID, st);
    }
    return st;
  }

  private async render(sessionID: string, st: SessionState): Promise<void> {
    const chatId = this.chatBySession.get(sessionID);
    if (chatId == null) return;
    const text = renderProgress(st.steps);
    if (!text) return;

    // Lazy creation: first renderable event creates the bubble.
    if (st.messageId == null) {
      try {
        const sent = await this.bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
        // Race guard: finish() may have run while sendMessage was in flight,
        // deleting (or replacing) this session's state entry. If so, the entry
        // we hold is detached — writing messageId onto it would orphan the
        // just-sent bubble forever (finish already read messageId==null). Delete
        // the message we just created instead of storing its id.
        if (this.state.get(sessionID) !== st) {
          void this.bot.api.deleteMessage(chatId, sent.message_id).catch(() => {});
          return;
        }
        st.messageId = sent.message_id;
        st.lastText = text;
        st.lastEditAt = Date.now();
      } catch {
        /* progress is best-effort */
      }
      return;
    }

    // Dedup + throttle edits.
    if (text === st.lastText) return;
    const now = Date.now();
    if (now - st.lastEditAt < THROTTLE_MS) return;

    try {
      await this.bot.api.editMessageText(chatId, st.messageId, text, { parse_mode: "HTML" });
      st.lastText = text;
      st.lastEditAt = now;
    } catch {
      /* edit failed (e.g. message unchanged / deleted) — ignore */
    }
  }
}
