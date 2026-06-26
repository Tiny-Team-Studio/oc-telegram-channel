import { tool } from "@opencode-ai/plugin";
import { postShim } from "./_shim.ts";

export default tool({
  description: "Add an emoji reaction to a Telegram message in the current chat. Requires a message_id from the Telegram conversation; chat is inferred from the OpenCode session.",
  args: {
    message_id: tool.schema.string().describe("Telegram message_id to react to"),
    emoji: tool.schema.string().describe("Reaction emoji. Telegram only accepts its fixed reaction whitelist."),
  },
  async execute(args, ctx) {
    return postShim("/react", {
      sessionID: ctx.sessionID,
      ...args,
    }, "reacted");
  },
});
