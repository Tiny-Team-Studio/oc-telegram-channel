import { test, expect } from "bun:test";
import { renderProgress, ProgressBubble } from "./progress.ts";

test("renderProgress builds an HTML step log and escapes content", () => {
  const html = renderProgress([
    { kind: "think", label: "Looking at <files>" },
    { kind: "tool", label: "bash: ls" },
  ]);
  expect(html).toContain("💭");
  expect(html).toContain("🔧");
  expect(html).toContain("&lt;files&gt;"); // escaped
});

// C1 race: finish() runs (deleting the state entry) while the bubble's
// sendMessage is still in flight. When the send resolves, render() must delete
// the just-created message instead of orphaning it on a detached state object.
test("finish() before sendMessage resolves → the just-sent bubble is deleted, not orphaned", async () => {
  const sessionID = "sess-1";
  const chatId = 42;

  let resolveSend!: (v: { message_id: number }) => void;
  let resolveSendStartedSignal!: () => void;
  const sendStarted = new Promise<void>((r) => {
    // signaled once render() has called sendMessage
    resolveSendStartedSignal = r;
  });

  const deleted: number[] = [];
  const fakeBot: any = {
    api: {
      sendMessage: () => {
        resolveSendStartedSignal();
        return new Promise((res) => {
          resolveSend = res;
        });
      },
      editMessageText: async () => {},
      deleteMessage: async (_chat: number, msgId: number) => {
        deleted.push(msgId);
      },
    },
  };

  const chatBySession = new Map<string, number>([[sessionID, chatId]]);
  const bubble = new ProgressBubble(fakeBot, chatBySession);

  // First renderable event: creates the state entry and fires render() (async).
  bubble.onEvent({
    type: "message.part.updated",
    properties: { part: { type: "tool", tool: "bash", sessionID, state: { status: "running" } } },
  } as any);

  // Wait until render() has actually called sendMessage (so messageId is still null).
  await sendStarted;

  // Turn completes mid-send: finish() deletes the state entry (no messageId yet).
  bubble.finish(sessionID);

  // Now the send resolves with a real message id — render() must detect the
  // detached state and delete the message rather than storing its id.
  resolveSend({ message_id: 777 });
  await new Promise((r) => setTimeout(r, 0)); // let render()'s continuation run

  expect(deleted).toEqual([777]);
});
