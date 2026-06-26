import { tool } from "@opencode-ai/plugin";
import { postShim } from "./_shim.ts";

export default tool({
  description: "Send a message to the current Telegram chat. Call once per message. Attach media via files (URLs or local paths). format defaults to html.",
  args: {
    text: tool.schema.string().describe("Message text (HTML by default). Use 'NO_REPLY' to stay silent."),
    reply_to: tool.schema.string().optional().describe("Telegram message_id to quote-reply to. Omit for normal replies."),
    files: tool.schema.array(tool.schema.string()).optional().describe("Media URLs or local file paths"),
    format: tool.schema.enum(["text", "html", "rich"]).optional().describe("Message format; default html"),
  },
  async execute(args, ctx) {
    return postShim("/reply", {
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      ...args,
    }, "sent");
  },
});
