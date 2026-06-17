import { test, expect } from "bun:test";
import { handleReply, type ShimDeps } from "./shim.ts";

type SendCall = { chatId: number; args: { text: string; files?: string[]; format?: string } };

function makeDeps(opts: { chatId?: number } = {}): {
  deps: ShimDeps;
  sent: SendCall[];
  replied: string[];
} {
  const sent: SendCall[] = [];
  const replied: string[] = [];
  const deps: ShimDeps = {
    sendReply: async (chatId, args) => {
      sent.push({ chatId, args });
    },
    getChatId: (sessionID) =>
      sessionID === "sess-known" ? (opts.chatId ?? 42) : undefined,
    markReplied: (sessionID) => {
      replied.push(sessionID);
    },
  };
  return { deps, sent, replied };
}

test("valid body → sendReply with resolved chatId + text/files/format, marks replied", async () => {
  const { deps, sent, replied } = makeDeps({ chatId: 99 });
  const res = await handleReply(
    { sessionID: "sess-known", text: "hello", files: ["a.png"], format: "rich" },
    deps,
  );
  expect(res).toEqual({ ok: true });
  expect(sent.length).toBe(1);
  expect(sent[0].chatId).toBe(99);
  expect(sent[0].args.text).toBe("hello");
  expect(sent[0].args.files).toEqual(["a.png"]);
  expect(sent[0].args.format).toBe("rich");
  expect(replied).toEqual(["sess-known"]);
});

test("unknown sessionID → {ok:false} and does NOT call sendReply or markReplied", async () => {
  const { deps, sent, replied } = makeDeps();
  const res = await handleReply({ sessionID: "sess-ghost", text: "hi" }, deps);
  expect(res.ok).toBe(false);
  expect("error" in res).toBe(true);
  expect(sent.length).toBe(0);
  expect(replied.length).toBe(0);
});

test("missing sessionID → {ok:false} and no dispatch", async () => {
  const { deps, sent } = makeDeps();
  const res = await handleReply({ text: "hi" } as any, deps);
  expect(res.ok).toBe(false);
  expect(sent.length).toBe(0);
});

test("NO_REPLY text still routes to sendReply (sender suppresses) and marks replied", async () => {
  // The shim does not itself interpret NO_REPLY — it dispatches to sendReply,
  // which honors isNoReply. markReplied is set so the floor does not double-send.
  const { deps, sent, replied } = makeDeps({ chatId: 7 });
  const res = await handleReply({ sessionID: "sess-known", text: "NO_REPLY" }, deps);
  expect(res).toEqual({ ok: true });
  expect(sent.length).toBe(1);
  expect(sent[0].args.text).toBe("NO_REPLY");
  expect(replied).toEqual(["sess-known"]);
});
