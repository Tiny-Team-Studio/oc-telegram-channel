import { loadConfig } from "./config.ts";
import {
  createBot, sendReply, startTyping, loadAccess, isAllowed,
} from "./telegram.ts";
import {
  createClient, ensureSession, sendPrompt, runEventLoop, TurnAccumulator, isTurnComplete,
  type OcEvent,
} from "./opencode.ts";

const cfg = loadConfig();
const access = loadAccess(cfg.accessPath);
const bot = createBot(cfg);
const client = createClient(cfg);
const acc = new TurnAccumulator();

// sessionID -> chatId, so SSE completions route back to the right chat.
const chatBySession = new Map<string, number>();
// sessionID -> stop-typing fn, so we can clear the typing indicator on completion.
const stopTypingBySession = new Map<string, () => void>();

bot.on("message:text", async (ctx) => {
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;
  if (!userId || !isAllowed(access, userId)) return; // silent ignore (DM allowlist)
  try {
    const sessionID = await ensureSession(client, cfg, chatId);
    chatBySession.set(sessionID, chatId);
    // Replace any in-flight typing loop for this session before starting a new one.
    stopTypingBySession.get(sessionID)?.();
    stopTypingBySession.set(sessionID, startTyping(bot, chatId));
    await sendPrompt(client, cfg, sessionID, ctx.message.text);
  } catch (e) {
    await bot.api.sendMessage(chatId, `⚠️ ${String(e)}`).catch(() => {});
  }
});

function onEvent(ev: OcEvent): void {
  acc.apply(ev);
  const done = isTurnComplete(ev);
  if (!done) return;
  const chatId = chatBySession.get(done.sessionID);
  // Always stop typing + clear accumulator state for this turn, even if we
  // can't route the reply — otherwise typing loops and part state leak.
  stopTypingBySession.get(done.sessionID)?.();
  stopTypingBySession.delete(done.sessionID);
  const text = acc.text(done.messageID).trim();
  acc.clear(done.messageID);
  if (chatId == null) return;
  if (!text) return;
  void sendReply(bot, cfg, chatId, { text, format: cfg.defaultFormat }).catch((e) =>
    bot.api.sendMessage(chatId, `⚠️ send failed: ${String(e)}`).catch(() => {}),
  );
}

const ac = new AbortController();
runEventLoop(client, cfg, onEvent, ac.signal).catch(() => {});

function shutdown(): void {
  ac.abort();
  void bot.stop();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

bot.start({ onStart: (me) => console.log(`oc-telegram-channel up as @${me.username}`) });
