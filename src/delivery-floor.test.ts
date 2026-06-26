import { describe, expect, test } from "bun:test";
import { DeliveryFloor } from "./delivery-floor.ts";

describe("DeliveryFloor", () => {
  test("waits until session idle before exposing fallback text", () => {
    const floor = new DeliveryFloor();
    floor.beginTurn("s1");
    floor.recordCompletion({ sessionID: "s1", messageID: "m1", text: "fallback" }, () => false);

    expect(floor.resolveIdle("other")).toBeUndefined();
    expect(floor.resolveIdle("s1")).toBe("fallback");
  });

  test("suppresses earlier assistant text when tg_reply happens before idle", () => {
    const floor = new DeliveryFloor();
    floor.beginTurn("s1");
    floor.recordCompletion({ sessionID: "s1", messageID: "m1", text: "internal status" }, () => false);
    floor.markReplied("s1", "m1");

    expect(floor.resolveIdle("s1")).toBeUndefined();
  });

  test("honors NO_REPLY fallback suppression", () => {
    const floor = new DeliveryFloor();
    floor.beginTurn("s1");
    floor.recordCompletion({ sessionID: "s1", messageID: "m1", text: "NO_REPLY" }, () => true);

    expect(floor.resolveIdle("s1")).toBeUndefined();
  });
});
