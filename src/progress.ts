import type { Bot } from "grammy";
import type { OcEvent } from "./opencode.ts";

// --- Pure formatter (TDD'd) ---

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type Step = { kind: "think" | "tool"; label: string };

const MAX_STEPS = 12;

export function renderProgress(steps: Step[]): string {
  return steps
    .slice(-MAX_STEPS)
    .map((s) => `${s.kind === "think" ? "💭" : "🔧"} ${esc(s.label)}`)
    .join("\n");
}

// --- ProgressBubble (integration; verified live, not unit-tested) ---

const THROTTLE_MS = 1500;
const THINK_SNIPPET = 200; // cap reasoning text length so the bubble stays readable

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
        const snippet = text.length > THINK_SNIPPET ? text.slice(0, THINK_SNIPPET) + "…" : text;
        // Collapse newlines so a multi-line reasoning chunk is one bubble line.
        return { kind: "think", label: snippet.replace(/\s+/g, " ") };
      }
      case "tool": {
        const tool = typeof part.tool === "string" ? part.tool : "tool";
        const status = part.state?.status;
        return { kind: "tool", label: status ? `${tool} (${status})` : tool };
      }
      default:
        return null; // step-start / text / other → no bubble line
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
