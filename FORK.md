# Fork provenance & config contract

> `Tiny-Team-Studio/oc-telegram-channel` is a fork of [`grinev/opencode-telegram-bot`](https://github.com/grinev/opencode-telegram-bot) (MIT). Frozen for use as the Telegram channel of the `jamesx-opencode` OpenCode pilot on tinyteamxcc.

## Fork point
- Upstream: `grinev/opencode-telegram-bot`
- Fork commit (HEAD at fork time): `c790ec61f2bb374eef33f3b597b41e25a73f513d`
- Upstream version: `@grinev/opencode-telegram-bot@0.21.2`
- Forked: 2026-06-16

**Discipline:** do NOT blind-merge upstream (it ships multiple commits/day from a solo maintainer). Cherry-pick specific fixes deliberately. Same posture as `cc-slack-channel`.

## Runtime
- TypeScript, Node ≥20. Build: `npm ci && npm run build` (tsc → `dist/`). Start: `npm start` (`node dist/index.js`).
- Talks to OpenCode via the official `@opencode-ai/sdk` over HTTP — **attaches** to a running `opencode serve` at `OPENCODE_API_URL`. Does **not** spawn its own serve (the `child_process.spawn` in `src/runtime/service/manager.ts` is node child-procs for its own scheduled tasks; `taskkill` lines are Windows-only).

## Config contract (env vars — from `src/config.ts`)

| Var | Required | Meaning / our value |
|-----|----------|---------------------|
| `TELEGRAM_BOT_TOKEN` | yes | BotFather token (server `.env` only) |
| `TELEGRAM_ALLOWED_USER_ID` | yes | Single Telegram user id (int). James = `2111200087` |
| `TELEGRAM_API_ROOT` | no (default `api.telegram.org`) | `http://telegram-bot-api:8081` (self-hosted Bot API server) |
| `TELEGRAM_PROXY_SECRET` | no | unused |
| `OPENCODE_API_URL` | no (default `http://localhost:4096`) | `http://127.0.0.1:4096` (the serve we run) |
| `OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD` | no | unused (serve is localhost-only) |
| `OPENCODE_AUTO_RESTART_ENABLED` | no (default false) | leave false — entrypoint owns serve lifecycle |
| `OPENCODE_MODEL_PROVIDER` | **yes** | `openrouter` |
| `OPENCODE_MODEL_ID` | **yes** | `deepseek/deepseek-v4-pro` |
| `MESSAGE_FORMAT_MODE` | no (default `markdown`) | `markdown` (Telegram MarkdownV2). No HTML/rich (deferred) |
| `RESPONSE_STREAMING_MODE` | no (default `edit`) | `edit` — live response streaming via message edits (train-of-thought for free) |
| `HIDE_THINKING_MESSAGES` / `HIDE_TOOL_CALL_MESSAGES` | no | optional verbosity dials |

**Model split:** the channel sets the model per-session via the SDK using `OPENCODE_MODEL_PROVIDER`/`OPENCODE_MODEL_ID`. The OpenRouter **API key** is configured on the `opencode serve` side (via `OPENROUTER_API_KEY` env, auto-detected by OpenCode).

## Security skim (2026-06-16)
Clean. The only outbound `fetch` / `child_process` usage is explained by legitimate features:
- `src/app/services/tts-service.ts`, `stt-service.ts` — voice TTS/STT (only fire if voice configured; not used in the pilot). May need their own API keys if enabled.
- `src/app/services/file-download-service.ts` — Telegram file downloads.
- `src/app/services/worktree-service.ts` — `execFile` for `git worktree` ops.
- `src/runtime/service/manager.ts` — node child-procs for scheduled tasks.

No telemetry/analytics (no posthog/sentry/mixpanel), no `eval`/`new Function`, no phone-home. Token only flows to Telegram (+ the custom api root). Safe to run with tools enabled for the pilot.
