import { loadConfig } from "./config.ts";
import {
  createBot, sendReply, reactMessage, editMessage, startTyping, loadAccess, isAllowed, isNoReply,
} from "./telegram.ts";
import { startShim } from "./shim.ts";
import {
  createClient, ensureSession, sendPrompt, runEventLoop, TurnAccumulator, isTurnComplete,
  focusTui, type OcEvent, type PromptPart,
} from "./opencode.ts";
import {
  classifyAttachment, toFilePartInput, voiceTextPart, replyContextPart,
  canInlinePhoto, oversizePhotoTextPart, mediaTextPart,
} from "./inbound.ts";
import { parseCrons, startSchedule } from "oc-schedule";
import { ProgressBubble } from "./progress.ts";
import { PermissionRelay } from "./permissions.ts";
import { GrammyError } from "grammy";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, extname, basename } from "node:path";

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

// messageID -> the agent deliberately delivered via tg_reply this turn.
// Keyed by the turn's assistant messageID (NOT sessionID): a chat has one shared
// session, so overlapping turns would clobber a session-keyed flag. Absence =
// not replied (no need to pre-set false on inbound). The shim's markReplied adds
// the messageID; on turn-complete the floor checks/deletes by done.messageID.
const repliedThisTurn = new Set<string>();
const repliedThisSession = new Set<string>();

// Localhost shim into the existing sender. The tg_reply custom tool POSTs here;
// we resolve the chat and call sendReply, marking the turn (by messageID) as
// replied so the floor below won't double-send the accumulated text.
const shim = startShim(Number(cfg.shimPort), {
  sendReply: (chatId, a) => sendReply(bot, cfg, chatId, a),
  reactMessage: (chatId, a) => reactMessage(bot, chatId, a),
  editMessage: async (chatId, a) => { await editMessage(bot, cfg, chatId, a); },
  getChatId: (s) => chatBySession.get(s),
  markReplied: (sessionID, messageID) => {
    repliedThisTurn.add(messageID);
    repliedThisSession.add(sessionID);
  },
  replaceProgressWithFinal: (sessionID, text, format) => bubble.replaceWithFinal(sessionID, text, format),
});

// In-channel cron schedule (OpenCode has no native cron). On fire, a scheduled
// run opens the owner-DM session and pushes its instructions through the exact
// same turn-start sequence as an interactive message, so the digest flows
// through tg_reply / the delivery floor identically. Target chat = first
// allowlisted user id (a DM chat_id equals the user id).
const parsedCrons = parseCrons(process.env);
// Boot warning: crons are configured but the allowlist is empty/malformed, so
// the target chat resolves to NaN. The per-fire guard in startSchedule skips the
// run safely, but surface it loudly at boot so the misconfig is obvious.
if (parsedCrons.length > 0 && !Number.isFinite(Number(access.allowFrom[0]))) {
  console.warn(
    `oc-telegram-channel: ${parsedCrons.length} cron(s) configured but no valid target chat ` +
      `(allowFrom is empty/malformed) — scheduled runs will be skipped until the allowlist is fixed.`,
  );
}
const schedule = startSchedule({
  crons: parsedCrons,
  getTargetChat: () => Number(access.allowFrom[0]),
  ensureSession: (chatId) => ensureSession(client, cfg, chatId),
  sendPrompt: (sid, text) => sendPrompt(client, cfg, sid, text),
  registerTurn: (sid, chatId) => {
    chatBySession.set(sid, chatId);
    repliedThisSession.delete(sid);
    // No reply-flag pre-set: tracking is messageID-keyed and absence = not replied.
    const c = (inFlightBySession.get(sid) ?? 0) + 1;
    inFlightBySession.set(sid, c);
    if (c === 1) stopTypingBySession.set(sid, startTyping(bot, chatId));
  },
});

bot.on("message:text", async (ctx) => {
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;
  if (!userId || !isAllowed(access, userId)) return; // silent ignore (DM allowlist)
  try {
    const sessionID = await ensureSession(client, cfg, chatId);
    chatBySession.set(sessionID, chatId);
    repliedThisSession.delete(sessionID);
    // No reply-flag pre-set: tracking is keyed by the turn's assistant messageID
    // (set by the shim's markReplied), so absence = not replied. The floor on
    // turn-complete delivers the accumulated text unless tg_reply was called.
    // Make the attached TUI follow this session (non-blocking, never throws).
    void focusTui(client, sessionID);
    // Refcount in-flight turns per session. Only the 0->1 transition starts typing;
    // an overlapping turn leaves the existing loop running (no second indicator).
    const count = (inFlightBySession.get(sessionID) ?? 0) + 1;
    inFlightBySession.set(sessionID, count);
    if (count === 1) stopTypingBySession.set(sessionID, startTyping(bot, chatId));
    // Swipe-to-reply: if this message quotes an earlier one, prepend that context
    // so the agent knows which message the user is replying to. Otherwise keep the
    // existing bare-string path unchanged.
    const replyCtx = replyContextPart(ctx.message.reply_to_message, ctx.message.quote?.text);
    if (replyCtx) {
      await sendPrompt(client, cfg, sessionID, [replyCtx, { type: "text", text: ctx.message.text }]);
    } else {
      await sendPrompt(client, cfg, sessionID, ctx.message.text);
    }
  } catch (e) {
    await bot.api.sendMessage(chatId, `⚠️ ${String(e)}`).catch(() => {});
  }
});

// Per-bot inbox for downloaded media. Voice/document references point the agent
// here; the voice-transcribe skill reads the file from this path.
const INBOX_DIR = join(homedir(), "inbox");
mkdirSync(INBOX_DIR, { recursive: true });

// Resolve a Telegram getFile() result to local bytes. With the self-hosted Bot
// API in --local mode, file_path is an ABSOLUTE path on the shared volume — read
// it directly. Otherwise it's a cloud-relative path — fetch over HTTPS. Mirrors
// cc-telegram-channel/server.ts's `file_path.startsWith('/')` detection.
async function downloadFile(filePath: string): Promise<Uint8Array> {
  if (filePath.startsWith("/")) {
    return new Uint8Array(await Bun.file(filePath).arrayBuffer());
  }
  const url = `${cfg.apiRoot}/file/bot${cfg.token}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Start a turn for an inbound: ensure the session, route SSE back to this chat,
// reset the reply flag, focus the TUI, and start the typing indicator (refcounted).
// Mirrors the message:text turn-start sequence exactly so media turns behave the
// same way (delivery floor, progress bubble, typing).
async function startInboundTurn(chatId: number, parts: PromptPart[]): Promise<void> {
  const sessionID = await ensureSession(client, cfg, chatId);
  chatBySession.set(sessionID, chatId);
  repliedThisSession.delete(sessionID);
  // No reply-flag pre-set — tracking is messageID-keyed (absence = not replied).
  void focusTui(client, sessionID);
  const count = (inFlightBySession.get(sessionID) ?? 0) + 1;
  inFlightBySession.set(sessionID, count);
  if (count === 1) stopTypingBySession.set(sessionID, startTyping(bot, chatId));
  await sendPrompt(client, cfg, sessionID, parts);
}

// Photos arrive inline as a data-URL FilePartInput so the agent can read the image
// directly. A caption (if any) rides alongside as a TextPartInput.
bot.on("message:photo", async (ctx) => {
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;
  if (!userId || !isAllowed(access, userId)) return; // silent ignore (DM allowlist)
  try {
    const file = await ctx.getFile();
    if (!file.file_path) throw new Error("Telegram returned no file_path");
    const bytes = await downloadFile(file.file_path);
    const ext = extname(file.file_path).toLowerCase() || ".jpg";
    const mime = ext === ".png" ? "image/png"
      : ext === ".webp" ? "image/webp"
      : ext === ".gif" ? "image/gif"
      : "image/jpeg";
    const filename = `photo_${ctx.message.message_id}${ext}`;
    // Cap inbound photo size: a large image base64'd into the prompt is an OOM
    // risk under the container mem_limit. Over the cap, send a text note instead
    // of inlining the bytes so the turn still runs without ballooning memory.
    const parts: PromptPart[] = [
      canInlinePhoto(bytes.length)
        ? toFilePartInput(filename, bytes, mime)
        : oversizePhotoTextPart(bytes.length),
    ];
    const caption = ctx.message.caption;
    if (caption && caption.trim()) parts.push({ type: "text", text: caption });
    const replyCtx = replyContextPart(ctx.message.reply_to_message, ctx.message.quote?.text);
    if (replyCtx) parts.unshift(replyCtx);
    await startInboundTurn(chatId, parts);
  } catch (e) {
    await bot.api.sendMessage(chatId, `⚠️ ${String(e)}`).catch(() => {});
  }
});

// Voice memos are downloaded to the inbox and referenced by path — the
// voice-transcribe skill reads the file and acts on it.
bot.on(":voice", async (ctx) => {
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;
  if (!userId || !isAllowed(access, userId)) return;
  try {
    const file = await ctx.getFile();
    if (!file.file_path) throw new Error("Telegram returned no file_path");
    const bytes = await downloadFile(file.file_path);
    const ext = extname(file.file_path).toLowerCase() || ".oga";
    const inboxPath = join(INBOX_DIR, `voice_${ctx.msg.message_id}${ext}`);
    await Bun.write(inboxPath, bytes);
    const parts: PromptPart[] = [voiceTextPart(inboxPath)];
    const replyCtx = replyContextPart(ctx.msg.reply_to_message, ctx.msg.quote?.text);
    if (replyCtx) parts.unshift(replyCtx);
    await startInboundTurn(chatId, parts);
  } catch (e) {
    await bot.api.sendMessage(chatId, `⚠️ ${String(e)}`).catch(() => {});
  }
});

bot.on(":audio", async (ctx) => {
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;
  if (!userId || !isAllowed(access, userId)) return;
  try {
    const file = await ctx.getFile();
    if (!file.file_path) throw new Error("Telegram returned no file_path");
    const bytes = await downloadFile(file.file_path);
    const ext = extname(file.file_path).toLowerCase() || ".mp3";
    const inboxPath = join(INBOX_DIR, `audio_${ctx.msg.message_id}${ext}`);
    await Bun.write(inboxPath, bytes);
    const parts: PromptPart[] = [mediaTextPart("audio", inboxPath)];
    const caption = ctx.msg.caption;
    if (caption && caption.trim()) parts.push({ type: "text", text: caption });
    const replyCtx = replyContextPart(ctx.msg.reply_to_message, ctx.msg.quote?.text);
    if (replyCtx) parts.unshift(replyCtx);
    await startInboundTurn(chatId, parts);
  } catch (e) {
    await bot.api.sendMessage(chatId, `⚠️ ${String(e)}`).catch(() => {});
  }
});

bot.on(":video", async (ctx) => {
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;
  if (!userId || !isAllowed(access, userId)) return;
  try {
    const file = await ctx.getFile();
    if (!file.file_path) throw new Error("Telegram returned no file_path");
    const bytes = await downloadFile(file.file_path);
    const ext = extname(file.file_path).toLowerCase() || ".mp4";
    const inboxPath = join(INBOX_DIR, `video_${ctx.msg.message_id}${ext}`);
    await Bun.write(inboxPath, bytes);
    const parts: PromptPart[] = [mediaTextPart("video", inboxPath)];
    const caption = ctx.msg.caption;
    if (caption && caption.trim()) parts.push({ type: "text", text: caption });
    const replyCtx = replyContextPart(ctx.msg.reply_to_message, ctx.msg.quote?.text);
    if (replyCtx) parts.unshift(replyCtx);
    await startInboundTurn(chatId, parts);
  } catch (e) {
    await bot.api.sendMessage(chatId, `⚠️ ${String(e)}`).catch(() => {});
  }
});

bot.on(":video_note", async (ctx) => {
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;
  if (!userId || !isAllowed(access, userId)) return;
  try {
    const file = await ctx.getFile();
    if (!file.file_path) throw new Error("Telegram returned no file_path");
    const bytes = await downloadFile(file.file_path);
    const ext = extname(file.file_path).toLowerCase() || ".mp4";
    const inboxPath = join(INBOX_DIR, `video_note_${ctx.msg.message_id}${ext}`);
    await Bun.write(inboxPath, bytes);
    const parts: PromptPart[] = [mediaTextPart("video note", inboxPath)];
    const replyCtx = replyContextPart(ctx.msg.reply_to_message, ctx.msg.quote?.text);
    if (replyCtx) parts.unshift(replyCtx);
    await startInboundTurn(chatId, parts);
  } catch (e) {
    await bot.api.sendMessage(chatId, `⚠️ ${String(e)}`).catch(() => {});
  }
});

bot.on(":sticker", async (ctx) => {
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;
  if (!userId || !isAllowed(access, userId)) return;
  try {
    const file = await ctx.getFile();
    if (!file.file_path) throw new Error("Telegram returned no file_path");
    const bytes = await downloadFile(file.file_path);
    const ext = extname(file.file_path).toLowerCase() || ".webp";
    const inboxPath = join(INBOX_DIR, `sticker_${ctx.msg.message_id}${ext}`);
    await Bun.write(inboxPath, bytes);
    const parts: PromptPart[] = [mediaTextPart("sticker", inboxPath)];
    const replyCtx = replyContextPart(ctx.msg.reply_to_message, ctx.msg.quote?.text);
    if (replyCtx) parts.unshift(replyCtx);
    await startInboundTurn(chatId, parts);
  } catch (e) {
    await bot.api.sendMessage(chatId, `⚠️ ${String(e)}`).catch(() => {});
  }
});

// Documents are downloaded to the inbox and referenced by path + classification.
bot.on(":document", async (ctx) => {
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;
  if (!userId || !isAllowed(access, userId)) return;
  try {
    const doc = ctx.msg.document;
    const file = await ctx.getFile();
    if (!file.file_path) throw new Error("Telegram returned no file_path");
    const bytes = await downloadFile(file.file_path);
    const origName = doc?.file_name ?? (basename(file.file_path) || `document_${ctx.msg.message_id}`);
    const inboxPath = join(INBOX_DIR, `doc_${ctx.msg.message_id}_${origName}`);
    await Bun.write(inboxPath, bytes);
    // Route audio documents (e.g. .m4a sent as a file) through the voice path so
    // they still hit voice-transcribe; everything else is a generic file reference.
    const kind = classifyAttachment(doc?.mime_type ?? extname(origName));
    const parts: PromptPart[] = kind === "voice"
      ? [voiceTextPart(inboxPath)]
      : [{ type: "text", text: `[file received at ${inboxPath}]` }];
    const caption = ctx.msg.caption;
    if (caption && caption.trim()) parts.push({ type: "text", text: caption });
    const replyCtx = replyContextPart(ctx.msg.reply_to_message, ctx.msg.quote?.text);
    if (replyCtx) parts.unshift(replyCtx);
    await startInboundTurn(chatId, parts);
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
  const text = acc.text(done.messageID).trim();
  acc.clear(done.messageID);
  // Delivery floor: the agent's normal path is to call tg_reply (via the shim),
  // which set repliedThisTurn=true. In that case we send NOTHING here — the
  // agent owns its own (possibly multi-message + media) delivery. Only when the
  // agent did NOT call tg_reply do we fall back to sending the accumulated text,
  // honoring NO_REPLY so an intentional silence stays silent.
  const replied = repliedThisTurn.has(done.messageID) || repliedThisSession.has(done.sessionID);
  repliedThisTurn.delete(done.messageID);
  if (chatId == null || replied || !text || isNoReply(text, 0)) {
    bubble.finish(done.sessionID);
    return;
  }
  void (async () => {
    if (await bubble.replaceWithFinal(done.sessionID, text, cfg.defaultFormat)) return;
    await sendReply(bot, cfg, chatId, { text, format: cfg.defaultFormat });
  })().catch((e) =>
    bot.api.sendMessage(chatId, `⚠️ send failed: ${String(e)}`).catch(() => {}),
  );
}

const ac = new AbortController();
runEventLoop(client, cfg, onEvent, ac.signal).catch(() => {});

let shuttingDown = false;
function shutdown(): void {
  shuttingDown = true;
  ac.abort();
  schedule.stop();
  shim.stop();
  void bot.stop();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Process-level guards: a stray rejection/throw should never silently leave the
// process alive-but-deaf (MCP/shim stdin keeps it running). Log everything; for
// an uncaught exception, exit so Docker's restart policy revives a clean process
// (matches CC's "let the supervisor restart" stance over limping on).
process.on("unhandledRejection", (reason) => {
  console.error(`oc-telegram-channel: unhandledRejection: ${String(reason)}`);
});
process.on("uncaughtException", (err) => {
  console.error(`oc-telegram-channel: uncaughtException, exiting for restart: ${String(err)}`);
  process.exit(1);
});

// Without this, any throw in a message handler stops polling permanently
// (grammy's default error handler calls bot.stop() and rethrows). Logging it
// keeps the long-poll loop alive across handler errors.
bot.catch((err) => {
  console.error(`oc-telegram-channel: handler error (polling continues): ${String(err.error)}`);
});

// Register permission-button callbacks before bot.start so taps are handled.
perms.registerCallbacks(bot);

// Retry polling with backoff on any error. A single ETIMEDOUT/ECONNRESET/DNS
// failure (or a transient 409 from a not-yet-reaped zombie poller) would reject
// bot.start() and leave the process alive but deaf to inbound messages until a
// full restart. Ported from cc-telegram-channel. Backoff caps at 30s; a fatal
// auth error (invalid token → 401/Unauthorized) is NOT retried — it can't fix
// itself, so we exit and let Docker surface the misconfig.
void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: (me) => {
          attempt = 0;
          console.log(`oc-telegram-channel up as @${me.username}`);
        },
      });
      return; // bot.stop() was called — clean exit from the loop
    } catch (err) {
      if (shuttingDown) return;
      // bot.stop() mid-setup rejects with grammy's "Aborted delay" — expected.
      if (err instanceof Error && err.message === "Aborted delay") return;
      const isAuthError =
        err instanceof GrammyError && (err.error_code === 401 || err.error_code === 404);
      if (isAuthError) {
        console.error(
          `oc-telegram-channel: fatal auth error (${err.error_code} ${err.description}) — ` +
            `invalid bot token, not retrying. Exiting.`,
        );
        process.exit(1);
      }
      const delay = Math.min(1000 * attempt, 30000);
      console.error(
        `oc-telegram-channel: polling error: ${String(err)}, retrying in ${delay / 1000}s`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
})();
