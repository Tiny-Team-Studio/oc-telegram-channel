import type { Format } from "./config.ts";

// Localhost shim into the channel's existing sender. The `tg_reply` custom tool
// (deploy repo: tools/tg_reply.ts) POSTs {sessionID,text,files?,format?} here;
// we map sessionID→chatId and call the EXISTING sendReply (telegram.ts). This
// gives the OpenCode agent a real, multi-message delivery contract while the
// channel keeps owning the sender (NO_REPLY, chunking, media, rich).

export type ReplyBody = {
  sessionID?: string;
  text?: string;
  files?: string[];
  format?: Format;
};

export type ShimResult = { ok: true } | { ok: false; error: string };

export type ShimDeps = {
  // Send through the channel's real sender (telegram.ts sendReply, partially applied).
  sendReply: (
    chatId: number,
    args: { text: string; files?: string[]; format?: Format },
  ) => Promise<void>;
  // Resolve the chat for this session (index.ts chatBySession).
  getChatId: (sessionID: string) => number | undefined;
  // Record that this turn produced a deliberate reply (delivery-floor switch).
  markReplied: (sessionID: string) => void;
};

// Pure, unit-tested core. Validates the body, resolves the chat, dispatches to
// the real sender, and marks the turn as replied so the floor won't double-send.
export async function handleReply(body: ReplyBody, deps: ShimDeps): Promise<ShimResult> {
  const sessionID = body?.sessionID;
  if (!sessionID || typeof sessionID !== "string") {
    return { ok: false, error: "missing sessionID" };
  }
  if (typeof body.text !== "string") {
    return { ok: false, error: "missing text" };
  }
  const chatId = deps.getChatId(sessionID);
  if (chatId == null) {
    return { ok: false, error: `unknown sessionID: ${sessionID}` };
  }
  // Mark replied BEFORE the await so an in-flight turn-complete during the send
  // already sees the deliberate reply and suppresses the accumulated-text floor.
  deps.markReplied(sessionID);
  await deps.sendReply(chatId, {
    text: body.text,
    ...(body.files ? { files: body.files } : {}),
    ...(body.format ? { format: body.format } : {}),
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
      if (req.method !== "POST" || url.pathname !== "/reply") {
        return new Response(JSON.stringify({ ok: false, error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      let body: ReplyBody;
      try {
        body = (await req.json()) as ReplyBody;
      } catch {
        return new Response(JSON.stringify({ ok: false, error: "invalid json" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      let result: ShimResult;
      try {
        result = await handleReply(body, deps);
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
