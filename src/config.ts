export type Format = "text" | "html" | "rich";
export interface Config {
  token: string;
  apiRoot: string;
  serveUrl: string;
  workdir: string;
  accessPath: string;
  defaultFormat: Format;
  modelProvider: string;
  modelId: string;
  shimPort: string;
}

export function loadConfig(): Config {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
  const workdir = process.env.OPENCODE_WORKDIR || "/home/opencode/workspace";
  return {
    token,
    apiRoot: process.env.TELEGRAM_API_ROOT || "https://api.telegram.org",
    serveUrl: process.env.OPENCODE_API_URL || "http://127.0.0.1:4096",
    workdir,
    accessPath: process.env.ACCESS_PATH || `${process.env.HOME}/.config/oc-telegram/access.json`,
    defaultFormat: (process.env.DEFAULT_FORMAT as Format) || "html",
    // Leave model resolution to OpenCode: with no per-prompt model, serve uses the
    // agent's model from opencode.json (verified on OpenCode 1.17.7 — a no-model
    // prompt resolved to opencode.json's model, and no stale persisted selection
    // exists). Set OPENCODE_MODEL_ID only to FORCE an override; empty (the default)
    // means "use opencode.json's model". See opencode.ts sendPrompt.
    modelProvider: process.env.OPENCODE_MODEL_PROVIDER || "openrouter",
    modelId: process.env.OPENCODE_MODEL_ID || "",
    // Localhost shim port for the tg_reply custom tool → existing sendReply.
    shimPort: process.env.SHIM_PORT || "4097",
  };
}
