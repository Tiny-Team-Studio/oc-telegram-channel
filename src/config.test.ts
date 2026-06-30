import { test, expect } from "bun:test";
import { loadConfig } from "./config.ts";

test("loadConfig reads required env + defaults", () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:abc";
  process.env.OPENCODE_WORKDIR = "/home/opencode/workspace";
  delete process.env.TELEGRAM_API_ROOT;
  delete process.env.OPENCODE_API_URL;
  delete process.env.OPENCODE_MODEL_PROVIDER;
  delete process.env.OPENCODE_MODEL_ID;
  const c = loadConfig();
  expect(c.token).toBe("123:abc");
  expect(c.workdir).toBe("/home/opencode/workspace");
  expect(c.apiRoot).toBe("https://api.telegram.org");      // default
  expect(c.serveUrl).toBe("http://127.0.0.1:4096");        // default
  expect(c.defaultFormat).toBe("html");
  expect(c.modelProvider).toBe("openrouter");              // default
  expect(c.modelId).toBe("");                              // default = use opencode.json model
});

test("loadConfig throws when token missing", () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  expect(() => loadConfig()).toThrow();
});
