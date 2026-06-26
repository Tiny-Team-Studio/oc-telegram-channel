import { test, expect } from "bun:test";
import { chunk, editMessage, isAllowed, isNoReply, pickParseMode, reactMessage, sendReply } from "./telegram.ts";
import type { Config } from "./config.ts";

const cfg: Config = {
  token: "token",
  apiRoot: "https://api.telegram.org",
  serveUrl: "http://127.0.0.1:4096",
  workdir: "/tmp/work",
  accessPath: "/tmp/access.json",
  defaultFormat: "html",
  modelProvider: "openrouter",
  modelId: "model",
  shimPort: "4097",
};

test("chunk splits on the limit without losing content", () => {
  const parts = chunk("a".repeat(50), 20, "length");
  expect(parts.length).toBe(3);
  expect(parts.join("")).toBe("a".repeat(50));
});

test("isNoReply matches the exact sentinel only, and only with no files", () => {
  expect(isNoReply("NO_REPLY", 0)).toBe(true);
  expect(isNoReply("  no_reply \n", 0)).toBe(true);
  expect(isNoReply("NO_REPLY and more", 0)).toBe(false);
  expect(isNoReply("NO_REPLY", 1)).toBe(false);
});

test("pickParseMode maps formats", () => {
  expect(pickParseMode("html")).toBe("HTML");
  expect(pickParseMode("text")).toBeUndefined();
  expect(pickParseMode("rich")).toBeUndefined(); // rich uses a raw fetch, not grammy parse_mode
});

test("isAllowed matches string-array allowFrom by stringified id", () => {
  const access = { allowFrom: ["2111200087"] };
  expect(isAllowed(access, 2111200087)).toBe(true);
  expect(isAllowed(access, "2111200087")).toBe(true);
  expect(isAllowed(access, 999)).toBe(false);
});

test("sendReply threads only the first text chunk when reply_to is provided", async () => {
  const calls: any[] = [];
  const bot = {
    api: {
      sendMessage: async (...args: any[]) => {
        calls.push(args);
        return { message_id: calls.length };
      },
    },
  };

  await sendReply(bot as any, cfg, 42, { text: `${"a".repeat(4096)}b`, reply_to: 99 });

  expect(calls.length).toBe(2);
  expect(calls[0][0]).toBe(42);
  expect(calls[0][2].reply_parameters).toEqual({ message_id: 99 });
  expect(calls[1][2].reply_parameters).toBeUndefined();
});

test("reactMessage uses Telegram setMessageReaction", async () => {
  const calls: any[] = [];
  const bot = {
    api: {
      setMessageReaction: async (...args: any[]) => {
        calls.push(args);
      },
    },
  };

  await reactMessage(bot as any, 42, { message_id: 99, emoji: "👍" });

  expect(calls).toEqual([[42, 99, [{ type: "emoji", emoji: "👍" }]]]);
});

test("editMessage edits text with HTML parse mode", async () => {
  const calls: any[] = [];
  const bot = {
    api: {
      editMessageText: async (...args: any[]) => {
        calls.push(args);
        return { message_id: args[1] };
      },
    },
  };

  const id = await editMessage(bot as any, cfg, 42, {
    message_id: 99,
    text: "<b>updated</b>",
    format: "html",
  });

  expect(id).toBe(99);
  expect(calls).toEqual([[42, 99, "<b>updated</b>", { parse_mode: "HTML" }]]);
});

test("editMessage rejects rich edits and oversized text", async () => {
  const bot = { api: { editMessageText: async () => ({ message_id: 1 }) } };
  await expect(editMessage(bot as any, cfg, 42, {
    message_id: 99,
    text: "<table><tr><td>x</td></tr></table>",
    format: "rich",
  })).rejects.toThrow("rich");
  await expect(editMessage(bot as any, cfg, 42, {
    message_id: 99,
    text: "x".repeat(4097),
    format: "html",
  })).rejects.toThrow("too long");
});
