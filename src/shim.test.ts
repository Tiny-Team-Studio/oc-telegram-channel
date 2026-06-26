import { test, expect } from "bun:test";
import { handleEditMessage, handleReact, handleReply, type ShimDeps } from "./shim.ts";

type SendCall = { chatId: number; args: { text: string; files?: string[]; format?: string; reply_to?: number } };
type ReactCall = { chatId: number; args: { message_id: number; emoji: string } };
type EditCall = { chatId: number; args: { message_id: number; text: string; format?: string } };

function makeDeps(opts: { chatId?: number } = {}): {
  deps: ShimDeps;
  sent: SendCall[];
  reacted: ReactCall[];
  edited: EditCall[];
  replied: string[];
} {
  const sent: SendCall[] = [];
  const reacted: ReactCall[] = [];
  const edited: EditCall[] = [];
  const replied: string[] = [];
  const deps: ShimDeps = {
    sendReply: async (chatId, args) => {
      sent.push({ chatId, args });
    },
    reactMessage: async (chatId, args) => {
      reacted.push({ chatId, args });
    },
    editMessage: async (chatId, args) => {
      edited.push({ chatId, args });
    },
    getChatId: (sessionID) =>
      sessionID === "sess-known" ? (opts.chatId ?? 42) : undefined,
    markReplied: (messageID) => {
      replied.push(messageID);
    },
  };
  return { deps, sent, reacted, edited, replied };
}

test("valid body → sendReply with resolved chatId + text/files/format, marks replied by messageID", async () => {
  const { deps, sent, replied } = makeDeps({ chatId: 99 });
  const res = await handleReply(
    { sessionID: "sess-known", messageID: "msg-1", text: "hello", files: ["a.png"], format: "rich" },
    deps,
  );
  expect(res).toEqual({ ok: true });
  expect(sent.length).toBe(1);
  expect(sent[0].chatId).toBe(99);
  expect(sent[0].args.text).toBe("hello");
  expect(sent[0].args.files).toEqual(["a.png"]);
  expect(sent[0].args.format).toBe("rich");
  // Tracking is keyed by messageID (the turn), not sessionID.
  expect(replied).toEqual(["msg-1"]);
});

test("reply_to is resolved to a numeric Telegram message id and forwarded", async () => {
  const { deps, sent, replied } = makeDeps({ chatId: 99 });
  const res = await handleReply(
    { sessionID: "sess-known", messageID: "msg-1", text: "threaded", reply_to: "123" },
    deps,
  );
  expect(res).toEqual({ ok: true });
  expect(sent[0]).toEqual({ chatId: 99, args: { text: "threaded", reply_to: 123 } });
  expect(replied).toEqual(["msg-1"]);
});

test("invalid reply_to does not dispatch or mark replied", async () => {
  const { deps, sent, replied } = makeDeps({ chatId: 99 });
  const res = await handleReply(
    { sessionID: "sess-known", messageID: "msg-1", text: "bad", reply_to: "not-a-number" },
    deps,
  );
  expect(res.ok).toBe(false);
  expect("error" in res && res.error).toContain("reply_to");
  expect(sent.length).toBe(0);
  expect(replied.length).toBe(0);
});

test("unknown sessionID → {ok:false} and does NOT call sendReply or markReplied", async () => {
  const { deps, sent, replied } = makeDeps();
  const res = await handleReply({ sessionID: "sess-ghost", messageID: "msg-1", text: "hi" }, deps);
  expect(res.ok).toBe(false);
  expect("error" in res).toBe(true);
  expect(sent.length).toBe(0);
  expect(replied.length).toBe(0);
});

test("missing sessionID → {ok:false} and no dispatch", async () => {
  const { deps, sent } = makeDeps();
  const res = await handleReply({ messageID: "msg-1", text: "hi" } as any, deps);
  expect(res.ok).toBe(false);
  expect(sent.length).toBe(0);
});

test("missing messageID → {ok:false} and no dispatch", async () => {
  const { deps, sent, replied } = makeDeps();
  const res = await handleReply({ sessionID: "sess-known", text: "hi" } as any, deps);
  expect(res.ok).toBe(false);
  expect("error" in res && res.error).toContain("messageID");
  expect(sent.length).toBe(0);
  expect(replied.length).toBe(0);
});

test("overlapping turns in one session mark distinct messageIDs (no clobber)", async () => {
  // Both turns share "sess-known"; messageID keying keeps their flags separate.
  const { deps, replied } = makeDeps({ chatId: 7 });
  await handleReply({ sessionID: "sess-known", messageID: "msg-A", text: "from A" }, deps);
  await handleReply({ sessionID: "sess-known", messageID: "msg-B", text: "from B" }, deps);
  expect(replied).toEqual(["msg-A", "msg-B"]);
});

test("NO_REPLY text still routes to sendReply (sender suppresses) and marks replied", async () => {
  // The shim does not itself interpret NO_REPLY — it dispatches to sendReply,
  // which honors isNoReply. markReplied is set so the floor does not double-send.
  const { deps, sent, replied } = makeDeps({ chatId: 7 });
  const res = await handleReply({ sessionID: "sess-known", messageID: "msg-1", text: "NO_REPLY" }, deps);
  expect(res).toEqual({ ok: true });
  expect(sent.length).toBe(1);
  expect(sent[0].args.text).toBe("NO_REPLY");
  expect(replied).toEqual(["msg-1"]);
});

test("react resolves session chat and calls Telegram reaction sender", async () => {
  const { deps, reacted, replied } = makeDeps({ chatId: 1234 });
  const res = await handleReact({ sessionID: "sess-known", message_id: "55", emoji: "👍" }, deps);
  expect(res).toEqual({ ok: true });
  expect(reacted).toEqual([{ chatId: 1234, args: { message_id: 55, emoji: "👍" } }]);
  expect(replied.length).toBe(0);
});

test("react rejects unknown sessions before calling Telegram", async () => {
  const { deps, reacted } = makeDeps({ chatId: 1234 });
  const res = await handleReact({ sessionID: "sess-ghost", message_id: "55", emoji: "👍" }, deps);
  expect(res.ok).toBe(false);
  expect(reacted.length).toBe(0);
});

test("edit_message resolves session chat and forwards text/format", async () => {
  const { deps, edited, replied } = makeDeps({ chatId: 1234 });
  const res = await handleEditMessage(
    { sessionID: "sess-known", message_id: "56", text: "updated", format: "html" },
    deps,
  );
  expect(res).toEqual({ ok: true });
  expect(edited).toEqual([
    { chatId: 1234, args: { message_id: 56, text: "updated", format: "html" } },
  ]);
  expect(replied.length).toBe(0);
});

test("edit_message rejects invalid message_id before dispatch", async () => {
  const { deps, edited } = makeDeps({ chatId: 1234 });
  const res = await handleEditMessage(
    { sessionID: "sess-known", message_id: "0", text: "updated" },
    deps,
  );
  expect(res.ok).toBe(false);
  expect(edited.length).toBe(0);
});
