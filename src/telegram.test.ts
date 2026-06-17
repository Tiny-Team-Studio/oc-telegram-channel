import { test, expect } from "bun:test";
import { chunk, isNoReply, pickParseMode, isAllowed } from "./telegram.ts";

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
