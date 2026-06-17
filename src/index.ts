import { loadConfig } from "./config.ts";
import {
  createBot, sendReply, startTyping, loadAccess, isAllowed, isNoReply,
} from "./telegram.ts";
import { startShim } from "./shim.ts";
import {
  createClient, ensureSession, sendPrompt, runEventLoop, TurnAccumulator, isTurnComplete,
  focusTui, type OcEvent,
} from "./opencode.ts";
import { ProgressBubble } from "./progress.ts";
import { PermissionRelay } from "./permissions.ts";

const cfg = loadConfig();
const access = loadAccess(cfg.accessPath);
const bot = createBot(cfg);
const client = createClient(cfg);
const acc = new TurnAccumulator();

// sessionID -> chatId, so SSE completions route back to the right chat.
const chatBySession = new Map<string, number>();
// Live train-of-thought bubble, driven from reasoning/tool SSE parts.
const bubble = new ProgressBubble(bot, chatBySession);
// sessionID -> stop-typing fn, so we can clear the typing indicator on completion.
const stopTypingBySession = new Map<string, () => void>();
// sessionID -> in-flight turn count. Typing runs while ANY turn for the chat is
// in flight and stops only when the last one completes — overlapping same-chat
// turns must not delete each other's typing fn.
const inFlightBySession = new Map<string, number>();
// Relays OpenCode permission prompts to Telegram as inline Allow/Deny buttons.
const perms = new PermissionRelay(bot, client, cfg, chatBySession);

// sessionID -> did the agent deliberately deliver via tg_reply this turn?
// Reset false when a turn starts (inbound); set true by the shim's markReplied.
// On turn-complete this gates the accumulated-text "delivery floor".
const repliedThisTurn = new Map<string, boolean>();

// Localhost shim into the existing sender. The tg_reply custom tool POSTs here;
// we resolve the chat and call sendReply, marking the turn as replied so the
// floor below won't double-send the accumulated text.
const shim = startShim(Number(cfg.shimPort), {
  sendReply: (chatId, a) => sendReply(bot, cfg, chatId, a),
  getChatId: (s) => chatBySession.get(s),
  markReplied: (s) => repliedThisTurn.set(s, true),
});

bot.on("message:text", async (ctx) => {
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;
  if (!userId || !isAllowed(access, userId)) return; // silent ignore (DM allowlist)
  try {
    const sessionID = await ensureSession(client, cfg, chatId);
    chatBySession.set(sessionID, chatId);
    // A new turn starts: clear the reply flag. If the agent calls tg_reply this
    // turn, the shim flips it true and the floor stays silent; otherwise the
    // accumulated-text floor delivers on turn-complete.
    repliedThisTurn.set(sessionID, false);
    // Make the attached TUI follow this session (non-blocking, never throws).
    void focusTui(client, sessionID);
    // Refcount in-flight turns per session. Only the 0->1 transition starts typing;
    // an overlapping turn leaves the existing loop running (no second indicator).
    const count = (inFlightBySession.get(sessionID) ?? 0) + 1;
    inFlightBySession.set(sessionID, count);
    if (count === 1) stopTypingBySession.set(sessionID, startTyping(bot, chatId));
    await sendPrompt(client, cfg, sessionID, ctx.message.text);
  } catch (e) {
    await bot.api.sendMessage(chatId, `⚠️ ${String(e)}`).catch(() => {});
  }
});

function onEvent(ev: OcEvent): void {
  acc.apply(ev);
  bubble.onEvent(ev); // drive the live progress bubble (independent of completion)
  perms.onEvent(ev); // relay permission prompts to Telegram (independent of completion)
  const done = isTurnComplete(ev);
  if (!done) return;
  const chatId = chatBySession.get(done.sessionID);
  // Decrement the in-flight count; only stop typing when the LAST turn for this
  // session completes. An overlapping turn keeps the indicator alive. Clear
  // accumulator state for this turn regardless, so part state never leaks.
  const remaining = (inFlightBySession.get(done.sessionID) ?? 1) - 1;
  if (remaining <= 0) {
    inFlightBySession.delete(done.sessionID);
    stopTypingBySession.get(done.sessionID)?.();
    stopTypingBySession.delete(done.sessionID);
  } else {
    inFlightBySession.set(done.sessionID, remaining);
  }
  bubble.finish(done.sessionID); // delete the bubble before the final answer is sent
  const text = acc.text(done.messageID).trim();
  acc.clear(done.messageID);
  // Delivery floor: the agent's normal path is to call tg_reply (via the shim),
  // which set repliedThisTurn=true. In that case we send NOTHING here — the
  // agent owns its own (possibly multi-message + media) delivery. Only when the
  // agent did NOT call tg_reply do we fall back to sending the accumulated text,
  // honoring NO_REPLY so an intentional silence stays silent.
  const replied = repliedThisTurn.get(done.sessionID) === true;
  repliedThisTurn.delete(done.sessionID);
  if (chatId == null) return;
  if (replied) return;
  if (!text) return;
  if (isNoReply(text, 0)) return;
  void sendReply(bot, cfg, chatId, { text, format: cfg.defaultFormat }).catch((e) =>
    bot.api.sendMessage(chatId, `⚠️ send failed: ${String(e)}`).catch(() => {}),
  );
}

const ac = new AbortController();
runEventLoop(client, cfg, onEvent, ac.signal).catch(() => {});

function shutdown(): void {
  ac.abort();
  shim.stop();
  void bot.stop();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Register permission-button callbacks before bot.start so taps are handled.
perms.registerCallbacks(bot);

bot.start({ onStart: (me) => console.log(`oc-telegram-channel up as @${me.username}`) });
