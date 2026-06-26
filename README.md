# oc-telegram-channel

Lean OpenCode Telegram channel for DM-only bots.

## Custom Tools

Package-local OpenCode tool scripts live in `tools/`:

- `tg_reply`: sends Telegram replies through the channel-owned sender. It infers chat context from `ctx.sessionID`, supports `reply_to`, `files`, `format`, chunking, rich send fallback, and `NO_REPLY` suppression.
- `react`: adds a Telegram reaction with `setMessageReaction`. It accepts `message_id` and `emoji`; chat context is inferred from `ctx.sessionID` and arbitrary `chat_id` is intentionally not accepted.
- `edit_message`: edits a bot-sent Telegram message with `editMessageText`. It accepts `message_id`, `text`, and optional `format` (`text` or `html`). Rich edits are not supported because the Bot API rich sender is `sendRichMessage`; there is no equivalent rich edit path in this channel.

## Attachments

Inbound media is auto-downloaded into `~/inbox` before prompting OpenCode. Photos small enough to fit safely are inlined as data URLs; voice/audio/video/video-note/sticker/document files are referenced by local inbox path in the prompt.

`download_attachment` is deferred intentionally: unlike the Claude Code MCP channel, this channel does not expose raw Telegram `file_id` metadata to the model. Auto-download keeps the useful context in-band, avoids an extra tool call for common DM use, and avoids adding a file-id based tool that would duplicate the inbox handoff.

## Schedule

Schedule support is provided by the separate `oc-schedule` package via `import { parseCrons, startSchedule } from "oc-schedule"`.
