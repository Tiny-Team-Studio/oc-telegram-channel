import { tool } from "@opencode-ai/plugin";
import { postShim } from "./_shim.ts";

export default tool({
  description: "Edit a Telegram message previously sent by this bot in the current chat. Rich edits are not supported by Telegram editMessageText; use html or text.",
  args: {
    message_id: tool.schema.string().describe("Telegram message_id to edit"),
    text: tool.schema.string().describe("Replacement message text. Telegram editMessageText is limited to 4096 characters."),
    format: tool.schema.enum(["text", "html"]).optional().describe("Message format. rich is not supported for edits."),
  },
  async execute(args, ctx) {
    return postShim("/edit_message", {
      sessionID: ctx.sessionID,
      ...args,
    }, "edited");
  },
});
