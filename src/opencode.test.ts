import { test, expect } from "bun:test";
import { isTurnComplete, TurnAccumulator } from "./opencode.ts";

test("isTurnComplete fires only on a completed assistant message.updated", () => {
  expect(isTurnComplete({ type: "message.updated", properties: {
    info: { id: "m1", sessionID: "s1", role: "assistant", time: { created: 1, completed: 2 } } } }))
    .toEqual({ sessionID: "s1", messageID: "m1" });

  // not completed yet
  expect(isTurnComplete({ type: "message.updated", properties: {
    info: { id: "m1", sessionID: "s1", role: "assistant", time: { created: 1 } } } })).toBeNull();

  // user message
  expect(isTurnComplete({ type: "message.updated", properties: {
    info: { id: "m1", sessionID: "s1", role: "user", time: { completed: 2 } } } })).toBeNull();

  // unrelated event
  expect(isTurnComplete({ type: "session.status", properties: {} })).toBeNull();
});

test("TurnAccumulator concatenates ordered part deltas, snapshot wins over delta", () => {
  const acc = new TurnAccumulator();
  const ev = (partID: string, delta?: string, text?: string): any => ({
    type: "message.part.delta",
    properties: { part: { id: partID, messageID: "m1", type: "text", text }, delta },
  });
  acc.apply(ev("p1", "Hel"));
  acc.apply(ev("p1", "lo"));
  acc.apply(ev("p2", " world"));
  expect(acc.text("m1")).toBe("Hello world");

  // a fuller snapshot replaces the delta-accumulated value
  acc.apply(ev("p1", undefined, "Hello!"));
  expect(acc.text("m1")).toBe("Hello! world");
});

test("TurnAccumulator ignores non-text parts and clears on demand", () => {
  const acc = new TurnAccumulator();
  acc.apply({ type: "message.part.delta", properties: {
    part: { id: "r1", messageID: "m1", type: "reasoning", text: "thinking" }, delta: "thinking" } });
  acc.apply({ type: "message.part.delta", properties: {
    part: { id: "t1", messageID: "m1", type: "text" }, delta: "answer" } });
  expect(acc.text("m1")).toBe("answer");
  acc.clear("m1");
  expect(acc.text("m1")).toBe("");
});
