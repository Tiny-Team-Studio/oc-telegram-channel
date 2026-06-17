import { test, expect } from "bun:test";
import { isTurnComplete, TurnAccumulator, nextBackoff, runEventLoop } from "./opencode.ts";

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

// --- SSE reconnect (Plan 3 Task 2) ---

test("nextBackoff doubles 1s→15s and caps", () => {
  // attempt is the number of consecutive failures so far (1-based after the first drop)
  expect(nextBackoff(1)).toBe(1000);
  expect(nextBackoff(2)).toBe(2000);
  expect(nextBackoff(3)).toBe(4000);
  expect(nextBackoff(4)).toBe(8000);
  expect(nextBackoff(5)).toBe(15000); // 16000 capped to 15000
  expect(nextBackoff(6)).toBe(15000);
  expect(nextBackoff(99)).toBe(15000);
});

// A fake SSE stream that yields the given items then ends (done). `next()`/`return()`
// mirror the SDK's async-iterator surface used by runEventLoop.
function fakeStream(items: any[]) {
  let i = 0;
  return {
    async next(): Promise<IteratorResult<any>> {
      if (i < items.length) return { value: items[i++], done: false };
      return { value: undefined, done: true };
    },
    async return(_v?: any): Promise<IteratorResult<any>> {
      i = items.length;
      return { value: undefined, done: true };
    },
  };
}

const evPayload = (type: string) => ({ payload: { type, properties: {} } });

test("runEventLoop re-subscribes after a throw and still delivers the event", async () => {
  const ac = new AbortController();
  let calls = 0;
  const client = {
    global: {
      event: async () => {
        calls++;
        if (calls === 1) throw new Error("boom"); // first subscribe throws
        // second subscribe yields one real event then ends
        return { stream: fakeStream([evPayload("message.updated")]) };
      },
    },
  };

  const received: OcEventLike[] = [];
  const logs: string[] = [];
  const onEvent = (ev: any) => {
    received.push(ev);
    ac.abort(); // stop after first delivered event so the loop exits
  };

  await runEventLoop(client as any, { workdir: "/w" } as any, onEvent, ac.signal, {
    sleep: async () => {}, // no real backoff waits in the test
    log: (m) => logs.push(m),
  });

  expect(calls).toBe(2); // re-subscribed after the throw
  expect(received.map((e) => e.type)).toEqual(["message.updated"]);
  expect(logs.length).toBeGreaterThanOrEqual(1); // logged the drop once
});

test("runEventLoop reconnects on a CLEAN stream end (no throw) and logs the drop once", async () => {
  const ac = new AbortController();
  let calls = 0;
  const client = {
    global: {
      event: async () => {
        calls++;
        if (calls === 1) return { stream: fakeStream([]) }; // clean end, no events
        return { stream: fakeStream([evPayload("session.idle")]) };
      },
    },
  };

  const received: any[] = [];
  const logs: string[] = [];
  await runEventLoop(client as any, { workdir: "/w" } as any, (ev) => { received.push(ev); ac.abort(); }, ac.signal, {
    sleep: async () => {},
    log: (m) => logs.push(m),
  });

  expect(calls).toBe(2); // clean end -> reconnect
  expect(received.map((e) => e.type)).toEqual(["session.idle"]);
  expect(logs.length).toBe(1); // exactly one drop log for the one (clean) drop
});

test("runEventLoop resets backoff only after a drop that delivered an event", async () => {
  const ac = new AbortController();
  let calls = 0;
  const attempts: number[] = []; // backoff attempt seen at each sleep
  const client = {
    global: {
      event: async () => {
        calls++;
        if (calls === 1) return { stream: fakeStream([]) };          // open, 0 events, clean end
        if (calls === 2) return { stream: fakeStream([]) };          // open, 0 events, clean end
        if (calls === 3) return { stream: fakeStream([evPayload("a")]) }; // open, 1 event, clean end
        return { stream: fakeStream([evPayload("b")]) };             // open, 1 event -> abort
      },
    },
  };

  const received: any[] = [];
  await runEventLoop(client as any, { workdir: "/w" } as any, (ev) => {
    received.push(ev);
    if (received.length === 2) ac.abort();
  }, ac.signal, {
    sleep: async (_ms, attempt) => { attempts.push(attempt); },
    log: () => {},
  });

  // Two zero-event drops escalate backoff (attempt 1 then 2); the event-bearing drop
  // (call 3) resets, so the sleep after it is attempt 1 again.
  expect(attempts).toEqual([1, 2, 1]);
});

test("runEventLoop exits cleanly when the signal is already aborted (no subscribe)", async () => {
  const ac = new AbortController();
  ac.abort();
  let calls = 0;
  const client = { global: { event: async () => { calls++; return { stream: fakeStream([]) }; } } };
  await runEventLoop(client as any, { workdir: "/w" } as any, () => {}, ac.signal, {
    sleep: async () => {},
    log: () => {},
  });
  expect(calls).toBe(0); // aborted before any subscribe
});

type OcEventLike = { type: string; properties: Record<string, any> };
