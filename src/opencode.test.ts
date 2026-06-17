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

test("TurnAccumulator assembles only text-part snapshots and excludes reasoning", () => {
  const acc = new TurnAccumulator();
  const updated = (part: any): any => ({ type: "message.part.updated", properties: { part } });

  // reasoning part MUST be excluded even though it carries a `text` field
  acc.apply(updated({ id: "r1", messageID: "m1", sessionID: "s1", type: "reasoning", text: "thinking..." }));
  // text parts are included, in first-seen order
  acc.apply(updated({ id: "p1", messageID: "m1", sessionID: "s1", type: "text", text: "Hello" }));
  acc.apply(updated({ id: "p2", messageID: "m1", sessionID: "s1", type: "text", text: " world" }));

  expect(acc.text("m1")).toBe("Hello world");
});

test("TurnAccumulator snapshot-replaces a part when later text is longer", () => {
  const acc = new TurnAccumulator();
  const updated = (part: any): any => ({ type: "message.part.updated", properties: { part } });

  acc.apply(updated({ id: "p1", messageID: "m1", sessionID: "s1", type: "text", text: "Hel" }));
  acc.apply(updated({ id: "p2", messageID: "m1", sessionID: "s1", type: "text", text: " world" }));
  // a later, longer snapshot for p1 replaces it
  acc.apply(updated({ id: "p1", messageID: "m1", sessionID: "s1", type: "text", text: "Hello" }));

  expect(acc.text("m1")).toBe("Hello world");
});

test("TurnAccumulator clears a message on demand", () => {
  const acc = new TurnAccumulator();
  acc.apply({ type: "message.part.updated", properties: {
    part: { id: "p1", messageID: "m1", sessionID: "s1", type: "text", text: "answer" } } });
  expect(acc.text("m1")).toBe("answer");
  acc.clear("m1");
  expect(acc.text("m1")).toBe("");
});
