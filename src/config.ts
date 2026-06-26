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
    // Model is set explicitly per-prompt via the SDK (serve does not reliably pick up
    // opencode.json's model, and a stale persisted selection can otherwise win).
    modelProvider: process.env.OPENCODE_MODEL_PROVIDER || "openrouter",
    modelId: process.env.OPENCODE_MODEL_ID || "google/gemini-3.5-flash",
    // Localhost shim port for the tg_reply custom tool → existing sendReply.
    shimPort: process.env.SHIM_PORT || "4097",
  };
}
