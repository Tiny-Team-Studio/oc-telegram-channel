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

test("TurnAccumulator concatenates ordered flat deltas, snapshot wins over delta", () => {
  const acc = new TurnAccumulator();
  // Flat message.part.delta: { messageID, partID, field, delta } — no `part` object.
  const delta = (partID: string, d: string): any => ({
    type: "message.part.delta",
    properties: { messageID: "m1", partID, field: "text", delta: d },
  });
  acc.apply(delta("p1", "Hel"));
  acc.apply(delta("p1", "lo"));
  acc.apply(delta("p2", " world"));
  expect(acc.text("m1")).toBe("Hello world");

  // a fuller snapshot (message.part.updated, with a `part` object) replaces the delta-accumulated value
  acc.apply({ type: "message.part.updated", properties: {
    part: { id: "p1", messageID: "m1", sessionID: "s1", type: "text", text: "Hello!" } } });
  expect(acc.text("m1")).toBe("Hello! world");
});

test("TurnAccumulator ignores non-text parts/fields and clears on demand", () => {
  const acc = new TurnAccumulator();
  // reasoning-field delta must not contribute
  acc.apply({ type: "message.part.delta", properties: {
    messageID: "m1", partID: "r1", field: "reasoning", delta: "thinking" } });
  // reasoning snapshot via message.part.updated must not contribute
  acc.apply({ type: "message.part.updated", properties: {
    part: { id: "r1", messageID: "m1", sessionID: "s1", type: "reasoning", text: "thinking" } } });
  // a text-field delta does contribute
  acc.apply({ type: "message.part.delta", properties: {
    messageID: "m1", partID: "t1", field: "text", delta: "answer" } });
  expect(acc.text("m1")).toBe("answer");
  acc.clear("m1");
  expect(acc.text("m1")).toBe("");
});
