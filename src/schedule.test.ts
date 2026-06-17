import { test, expect } from "bun:test";
import { parseCrons } from "./schedule.ts";

test("single named cron → one entry with name/expr/tz/instructions", () => {
  const env = {
    SCHEDULE_CRON_DIGEST: "0 18 * * *",
    SCHEDULE_TZ_DIGEST: "Europe/Amsterdam",
    SCHEDULE_INSTRUCTIONS_DIGEST: "run it",
  };
  const crons = parseCrons(env);
  expect(crons).toEqual([
    { name: "DIGEST", expr: "0 18 * * *", tz: "Europe/Amsterdam", instructions: "run it" },
  ]);
});

test("tz defaults to Europe/Amsterdam when SCHEDULE_TZ_<NAME> is absent", () => {
  const env = {
    SCHEDULE_CRON_DIGEST: "0 18 * * *",
    SCHEDULE_INSTRUCTIONS_DIGEST: "run it",
  };
  const crons = parseCrons(env);
  expect(crons).toEqual([
    { name: "DIGEST", expr: "0 18 * * *", tz: "Europe/Amsterdam", instructions: "run it" },
  ]);
});

test("a cron with no matching INSTRUCTIONS is skipped (with a warning)", () => {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    const env = {
      SCHEDULE_CRON_DIGEST: "0 18 * * *",
      SCHEDULE_TZ_DIGEST: "Europe/Amsterdam",
      // no SCHEDULE_INSTRUCTIONS_DIGEST
    };
    const crons = parseCrons(env);
    expect(crons).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("DIGEST");
  } finally {
    console.warn = orig;
  }
});

test("multiple named crons → multiple entries", () => {
  const env = {
    SCHEDULE_CRON_DIGEST: "0 18 * * *",
    SCHEDULE_INSTRUCTIONS_DIGEST: "digest please",
    SCHEDULE_CRON_MORNING: "0 7 * * *",
    SCHEDULE_TZ_MORNING: "America/New_York",
    SCHEDULE_INSTRUCTIONS_MORNING: "morning brief",
  };
  const crons = parseCrons(env);
  // Order is not contractually guaranteed; compare as a set.
  expect(crons.length).toBe(2);
  expect(crons).toContainEqual({
    name: "DIGEST",
    expr: "0 18 * * *",
    tz: "Europe/Amsterdam",
    instructions: "digest please",
  });
  expect(crons).toContainEqual({
    name: "MORNING",
    expr: "0 7 * * *",
    tz: "America/New_York",
    instructions: "morning brief",
  });
});

test("ignores unrelated env keys and empty/whitespace cron exprs", () => {
  const env = {
    PATH: "/usr/bin",
    SCHEDULE_TZ_ORPHAN: "Europe/Amsterdam", // no SCHEDULE_CRON_ORPHAN → not a cron
    SCHEDULE_CRON_BLANK: "   ", // blank expr → skipped
    SCHEDULE_INSTRUCTIONS_BLANK: "x",
  };
  const crons = parseCrons(env);
  expect(crons).toEqual([]);
});
