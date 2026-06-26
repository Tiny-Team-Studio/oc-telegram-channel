import { readFileSync, statSync, realpathSync } from "node:fs";
import { extname } from "node:path";
import { Bot, InputFile } from "grammy";
import type { ReactionTypeEmoji } from "grammy/types";
import type { Config, Format } from "./config.ts";

// Telegram caps messages at 4096 chars. Split long replies, preferring
// paragraph boundaries when chunkMode is 'newline'.
// Lifted verbatim from cc-telegram-channel/server.ts:425-444.

export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      // Prefer the last double-newline (paragraph), then single newline,
      // then space. Fall back to hard cut.
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

const NO_REPLY_RE = /^\s*NO_REPLY\s*$/i;
export function isNoReply(text: string, fileCount: number): boolean {
  return fileCount === 0 && NO_REPLY_RE.test(text);
}

export function pickParseMode(format: "text" | "html" | "rich"): "HTML" | undefined {
  return format === "html" ? "HTML" : undefined; // rich is sent via raw sendRichMessage
}

// DM-only allowlist. allowFrom is a string array of Telegram user IDs — the
// fleet convention (see gotchas.md "access.json allowFrom must be a string array").
export type Access = { allowFrom: string[] };

export function loadAccess(path: string): Access {
  // Fail-closed: a missing/malformed access.json must not crash-loop the bot.
  // On any error, boot with an empty allowlist (ignore everyone until fixed).
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const allowFrom = Array.isArray(raw.allowFrom) ? raw.allowFrom.map(String) : [];
    return { allowFrom };
  } catch (e) {
    process.stderr.write(
      `oc-telegram: failed to load access.json (${path}): ${e instanceof Error ? e.message : String(e)} — failing closed (empty allowlist)\n`,
    );
    return { allowFrom: [] };
  }
}

export function isAllowed(access: Access, userId: number | string): boolean {
  return access.allowFrom.includes(String(userId));
}

// --- Reply sender (lifted + de-MCP'd from cc-telegram-channel/server.ts) ---

const MAX_CHUNK_LIMIT = 4096;
const RICH_MAX_CHARS = 32768; // Bot API 10.1 rich cap (chars). Guarded via .length (UTF-16 units, conservative); over-cap is also caught by the json.ok fallback.
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

// .jpg/.jpeg/.png/.gif/.webp go as photos (Telegram compresses + shows inline);
// .ogg/.oga/.mp3/.m4a/.opus go as voice notes (native playable bubble);
// everything else goes as documents (raw file, no compression).
const PHOTO_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);
const VOICE_EXTS = new Set([".ogg", ".oga", ".mp3", ".m4a", ".opus"]);

// Telegram caps all media captions at 1024 chars. When a voice file is sent
// with a longer caption, we send the voice bare and follow up with the text
// as a threaded reply so nothing is lost.
const MAX_VOICE_CAPTION = 1024;

// Validate a local file path is resolvable before attempting to send it.
// (The cc-telegram source also refused to leak the channel's own STATE_DIR;
// this lean channel has no such state dir, so only the resolvability check
// remains — statSync below enforces the size guard.)
function assertSendable(f: string): void {
  realpathSync(f);
}

export function createBot(cfg: Config): Bot {
  return new Bot(cfg.token, { client: { apiRoot: cfg.apiRoot } });
}

export function startTyping(bot: Bot, chatId: number): () => void {
  void bot.api.sendChatAction(chatId, "typing").catch(() => {});
  const interval = setInterval(() => {
    void bot.api.sendChatAction(chatId, "typing").catch(() => {});
  }, 5000);
  return () => clearInterval(interval);
}

export async function sendReply(
  bot: Bot,
  cfg: Config,
  chatId: number,
  args: { text: string; format?: Format; files?: string[]; reply_to?: number },
): Promise<void> {
  const text = args.text;
  const files = args.files ?? [];
  const replyParameters = args.reply_to != null
    ? { reply_parameters: { message_id: args.reply_to } }
    : {};

  // Silent reply: if the agent returns exactly "NO_REPLY" with no files,
  // suppress delivery entirely (mirrors cc-slack-channel).
  if (isNoReply(text, files.length)) return;

  const format: Format = args.format ?? cfg.defaultFormat;
  let parseMode: "HTML" | undefined = pickParseMode(format);

  const localFiles = files.filter(
    (f) => !f.startsWith("http://") && !f.startsWith("https://"),
  );
  for (const f of localFiles) {
    assertSendable(f);
    const st = statSync(f);
    if (st.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`,
      );
    }
  }

  const limit = MAX_CHUNK_LIMIT;

  // Rich messages (Bot API 10.1): sendRichMessage takes one HTML string in a
  // far larger grammar (tables, headings, <details>, blockquotes, …). grammy
  // has no binding, so call the raw method. Text-bodied structured content
  // only — rich carries no local-file upload, so a reply with files (local OR
  // url) is ineligible and degrades to the HTML path below (rich media must
  // instead be inline <img src="https://…"> in the text).
  if (format === "rich") {
    const richEligible = files.length === 0 && text.length <= RICH_MAX_CHARS;
    if (richEligible) {
      try {
        const res = await fetch(`${cfg.apiRoot}/bot${cfg.token}/sendRichMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            rich_message: { html: text },
            ...replyParameters,
          }),
        });
        const json = (await res.json()) as {
          ok: boolean;
          result?: { message_id: number };
          description?: string;
        };
        if (json.ok && json.result) {
          return;
        }
        process.stderr.write(
          `telegram channel: sendRichMessage rejected (${json.description ?? "unknown"}) — falling back to HTML\n`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `telegram channel: sendRichMessage threw (${msg}) — falling back to HTML\n`,
        );
      }
    } else {
      process.stderr.write(
        `telegram channel: rich ineligible (files=${files.length}, len=${text.length}) — using HTML\n`,
      );
    }
    // Fallback: ship the rich-HTML as best-effort HTML via chunking. Basic
    // tags still render; block tags (<table>) degrade to raw text.
    parseMode = "HTML";
  }

  const chunks = chunk(text, limit, "newline");

  // When files are present, skip sending text as a separate message —
  // it will be used as caption on the first file instead.
  const skipTextMessage = files.length > 0;
  const sentCount = { n: 0 };

  if (!skipTextMessage) {
    for (let i = 0; i < chunks.length; i++) {
      try {
        await bot.api.sendMessage(chatId, chunks[i], {
          ...(i === 0 ? replyParameters : {}),
          ...(parseMode ? { parse_mode: parseMode } : {}),
        });
        sentCount.n++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `reply failed after ${sentCount.n} of ${chunks.length} chunk(s) sent: ${msg}`,
        );
      }
    }
  }

  // Files go as separate messages (Telegram doesn't mix text+file in one
  // sendMessage call). Supports both local file paths and URLs. URLs are
  // passed directly to Telegram's API — Telegram downloads them server-side.
  // When files are present and text was provided, use text as caption on the
  // first file and skip sending it as a separate sendMessage.
  let captionUsed = false;
  for (const f of files) {
    try {
      const isUrl = f.startsWith("http://") || f.startsWith("https://");
      const caption = !captionUsed && text ? text : undefined;
      const opts = {
        ...replyParameters,
        ...(caption ? { caption, ...(parseMode ? { parse_mode: parseMode } : {}) } : {}),
      };
      if (caption) captionUsed = true;

      if (isUrl) {
        // Detect type from URL path (strip query params).
        const urlPath = new URL(f).pathname.toLowerCase();
        const urlExt = extname(urlPath);
        if (VIDEO_EXTS.has(urlExt)) {
          await bot.api.sendVideo(chatId, f, opts);
        } else if (PHOTO_EXTS.has(urlExt) || urlPath.match(/\/media\//)) {
          // Twitter image URLs sometimes lack extensions — /media/ path is a photo.
          await bot.api.sendPhoto(chatId, f, opts);
        } else {
          await bot.api.sendDocument(chatId, f, opts);
        }
      } else {
        const ext = extname(f).toLowerCase();
        const input = new InputFile(f);
        if (PHOTO_EXTS.has(ext)) {
          await bot.api.sendPhoto(chatId, input, opts);
        } else if (VIDEO_EXTS.has(ext)) {
          await bot.api.sendVideo(chatId, input, opts);
        } else if (VOICE_EXTS.has(ext)) {
          // Telegram caps captions at 1024 chars. If the caller passed a longer
          // text alongside the voice file, send the voice without a caption and
          // follow up with the text so nothing is lost.
          if (opts.caption && opts.caption.length > MAX_VOICE_CAPTION) {
            const sent = await bot.api.sendVoice(chatId, input, replyParameters);
            // Send the full text as a follow-up using the existing chunk logic
            // so long transcripts are split across multiple messages as needed.
            const followupChunks = chunk(text, limit, "newline");
            for (const c of followupChunks) {
              await bot.api.sendMessage(chatId, c, {
                reply_parameters: { message_id: sent.message_id },
                ...(parseMode ? { parse_mode: parseMode } : {}),
              });
            }
          } else {
            await bot.api.sendVoice(chatId, input, opts);
          }
        } else {
          await bot.api.sendDocument(chatId, input, opts);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`telegram channel: failed to send file ${f}: ${msg}\n`);
    }
  }
}

export async function reactMessage(
  bot: Bot,
  chatId: number,
  args: { message_id: number; emoji: string },
): Promise<void> {
  await bot.api.setMessageReaction(chatId, args.message_id, [
    { type: "emoji", emoji: args.emoji as ReactionTypeEmoji["emoji"] },
  ]);
}

export async function editMessage(
  bot: Bot,
  cfg: Config,
  chatId: number,
  args: { message_id: number; text: string; format?: Format },
): Promise<number> {
  const format = args.format ?? (cfg.defaultFormat === "rich" ? "html" : cfg.defaultFormat);
  if (format === "rich") {
    throw new Error("edit_message does not support rich format; use html or text");
  }
  if (args.text.length > MAX_CHUNK_LIMIT) {
    throw new Error(`edit_message text too long (${args.text.length} chars, max ${MAX_CHUNK_LIMIT})`);
  }
  const parseMode = pickParseMode(format);
  const edited = await bot.api.editMessageText(chatId, args.message_id, args.text, {
    ...(parseMode ? { parse_mode: parseMode } : {}),
  });
  return typeof edited === "object" && edited && "message_id" in edited
    ? Number(edited.message_id)
    : args.message_id;
}
