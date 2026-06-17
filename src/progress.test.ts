import { test, expect } from "bun:test";
import { renderProgress } from "./progress.ts";

test("renderProgress builds an HTML step log and escapes content", () => {
  const html = renderProgress([
    { kind: "think", label: "Looking at <files>" },
    { kind: "tool", label: "bash: ls" },
  ]);
  expect(html).toContain("💭");
  expect(html).toContain("🔧");
  expect(html).toContain("&lt;files&gt;"); // escaped
});
