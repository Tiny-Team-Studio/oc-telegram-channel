declare module "oc-schedule" {
  export type CronSpec = {
    name: string;
    expr: string;
    tz: string;
    instructions: string;
  };

  export type ScheduleDeps<TTarget = number> = {
    crons: CronSpec[];
    getTargetChat: (cron: CronSpec) => TTarget;
    ensureSession: (target: TTarget, cron: CronSpec) => Promise<string>;
    sendPrompt: (sessionID: string, text: string, target: TTarget, cron: CronSpec) => Promise<void>;
    registerTurn: (sessionID: string, target: TTarget, cron: CronSpec) => void;
    isValidTarget?: (target: TTarget) => boolean;
    describeTarget?: (target: TTarget) => string;
  };

  export type Schedule = { stop: () => void };

  export class UnsuffixedScheduleCronError extends Error {}

  export function parseCrons(env: Record<string, string | undefined>): CronSpec[];
  export function startSchedule<TTarget = number>(deps: ScheduleDeps<TTarget>): Schedule;
  export function isValidTargetChat(target: unknown): boolean;
  export function isValidScheduleTarget(target: unknown): boolean;
  export function formatScheduledPrompt(args: Pick<CronSpec, "name" | "instructions" | "tz"> & { triggeredAt: Date }): string;
}
