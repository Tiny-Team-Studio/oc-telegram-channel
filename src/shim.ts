import type { Format } from "./config.ts";

// Localhost shim into the channel's existing sender. The `tg_reply` custom tool
// (deploy repo: tools/tg_reply.ts) POSTs {sessionID,text,files?,format?} here;
// we map sessionID→chatId and call the EXISTING sendReply (telegram.ts). This
// gives the OpenCode agent a real, multi-message delivery contract while the
// channel keeps owning the sender (NO_REPLY, chunking, media, rich).

type MessageIdInput = number | string;

export type ReplyBody = {
  sessionID?: string;
  // The assistant message id of the turn calling tg_reply (ctx.messageID in the
  // tool). Reply tracking is keyed by this, not sessionID, so overlapping turns
  // in one chat (which share a session) don't clobber each other's reply flag.
  messageID?: string;
  text?: string;
  files?: string[];
  format?: Format;
  reply_to?: MessageIdInput;
};

export type ReactBody = {
  sessionID?: string;
  message_id?: MessageIdInput;
  emoji?: string;
};

export type EditMessageBody = {
  sessionID?: string;
  message_id?: MessageIdInput;
  text?: string;
  format?: Format;
};

type ShimFailure = { ok: false; error: string };
type ChatResolution = { ok: true; chatId: number } | ShimFailure;
type MessageIdResolution = { ok: true; messageId: number } | ShimFailure;
type FormatResolution = { ok: true; format?: Format } | ShimFailure;

export type ShimResult = { ok: true } | ShimFailure;

export type ShimDeps = {
  // Send through the channel's real sender (telegram.ts sendReply, partially applied).
  sendReply: (
    chatId: number,
    args: { text: string; files?: string[]; format?: Format; reply_to?: number },
  ) => Promise<void>;
  reactMessage: (chatId: number, args: { message_id: number; emoji: string }) => Promise<void>;
  editMessage: (
    chatId: number,
    args: { message_id: number; text: string; format?: Format },
  ) => Promise<void>;
  // Resolve the chat for this session (index.ts chatBySession).
  getChatId: (sessionID: string) => number | undefined;
  // Record that this turn (keyed by its assistant messageID) produced a
  // deliberate reply (delivery-floor switch). messageID-keyed so overlapping
  // same-chat turns can't reset each other's flag.
  markReplied: (sessionID: string, messageID: string) => void;
  replaceProgressWithFinal?: (sessionID: string, text: string, format?: Format) => Promise<boolean>;
};

function resolveChat(body: { sessionID?: string }, deps: ShimDeps): ChatResolution {
  const sessionID = body?.sessionID;
  if (!sessionID || typeof sessionID !== "string") {
    return { ok: false, error: "missing sessionID" };
  }
  const chatId = deps.getChatId(sessionID);
  if (chatId == null) {
    return { ok: false, error: `unknown sessionID: ${sessionID}` };
  }
  return { ok: true, chatId };
}

function parseMessageId(value: unknown, name: string): MessageIdResolution {
  if (value == null || value === "") return { ok: false, error: `missing ${name}` };
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: `invalid ${name}` };
  return { ok: true, messageId: n };
}

function parseFormat(value: unknown): FormatResolution {
  if (value == null) return { ok: true };
  if (value === "text" || value === "html" || value === "rich") {
    return { ok: true, format: value };
  }
  return { ok: false, error: "invalid format" };
}

// Pure, unit-tested core. Validates the body, resolves the chat, dispatches to
// the real sender, and marks the turn as replied so the floor won't double-send.
export async function handleReply(body: ReplyBody, deps: ShimDeps): Promise<ShimResult> {
  const chat = resolveChat(body, deps);
  if (!chat.ok) return chat;
  const messageID = body?.messageID;
  if (!messageID || typeof messageID !== "string") {
    return { ok: false, error: "missing messageID" };
  }
  if (typeof body.text !== "string") {
    return { ok: false, error: "missing text" };
  }
  const format = parseFormat(body.format);
  if (!format.ok) return format;
  let replyTo: number | undefined;
  if (body.reply_to != null) {
    const parsed = parseMessageId(body.reply_to, "reply_to");
    if (!parsed.ok) return parsed;
    replyTo = parsed.messageId;
  }
  // Mark replied BEFORE the await so an in-flight turn-complete during the send
  // already sees the deliberate reply and suppresses the accumulated-text floor.
  // Keyed by messageID (this turn), not sessionID — overlapping turns are distinct.
  deps.markReplied(body.sessionID!, messageID);
  if (!body.files?.length && await deps.replaceProgressWithFinal?.(body.sessionID!, body.text, format.format)) {
    return { ok: true };
  }
  await deps.sendReply(chat.chatId, {
    text: body.text,
    ...(body.files ? { files: body.files } : {}),
    ...(format.format ? { format: format.format } : {}),
    ...(replyTo != null ? { reply_to: replyTo } : {}),
  });
  return { ok: true };
}

export async function handleReact(body: ReactBody, deps: ShimDeps): Promise<ShimResult> {
  const chat = resolveChat(body, deps);
  if (!chat.ok) return chat;
  const message = parseMessageId(body.message_id, "message_id");
  if (!message.ok) return message;
  if (!body.emoji || typeof body.emoji !== "string") {
    return { ok: false, error: "missing emoji" };
  }
  await deps.reactMessage(chat.chatId, { message_id: message.messageId, emoji: body.emoji });
  return { ok: true };
}

export async function handleEditMessage(body: EditMessageBody, deps: ShimDeps): Promise<ShimResult> {
  const chat = resolveChat(body, deps);
  if (!chat.ok) return chat;
  const message = parseMessageId(body.message_id, "message_id");
  if (!message.ok) return message;
  if (typeof body.text !== "string") {
    return { ok: false, error: "missing text" };
  }
  const format = parseFormat(body.format);
  if (!format.ok) return format;
  await deps.editMessage(chat.chatId, {
    message_id: message.messageId,
    text: body.text,
    ...(format.format ? { format: format.format } : {}),
  });
  return { ok: true };
}

// HTTP wrapper: 127.0.0.1-only Bun.serve exposing POST /reply → handleReply.
export function startShim(port: number, deps: ShimDeps): { stop: () => void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const isKnownRoute = url.pathname === "/reply" || url.pathname === "/react" || url.pathname === "/edit_message";
      if (req.method !== "POST" || !isKnownRoute) {
        return new Response(JSON.stringify({ ok: false, error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      let body: ReplyBody | ReactBody | EditMessageBody;
      try {
        body = (await req.json()) as ReplyBody | ReactBody | EditMessageBody;
      } catch {
        return new Response(JSON.stringify({ ok: false, error: "invalid json" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      let result: ShimResult;
      try {
        if (url.pathname === "/reply") result = await handleReply(body as ReplyBody, deps);
        else if (url.pathname === "/react") result = await handleReact(body as ReactBody, deps);
        else result = await handleEditMessage(body as EditMessageBody, deps);
      } catch (e) {
        result = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 400,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { stop: () => server.stop(true) };
}
