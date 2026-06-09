import type { Context } from "grammy";
import { foregroundSessionState } from "../../../scheduled-task/foreground-state.js";
import { attachManager } from "../../../attach/manager.js";
import { reconcileBusyStateNow } from "./busy-reconciliation.js";
import { t } from "../../../i18n/index.js";
import { logger } from "../../../utils/logger.js";

export function isForegroundBusy(): boolean {
  return foregroundSessionState.isBusy() || attachManager.isBusy();
}

function getBusyDirectories(): string[] {
  const directories = new Set<string>();

  for (const session of foregroundSessionState.getBusySessions()) {
    directories.add(session.directory);
  }

  const attached = attachManager.getSnapshot();
  if (attached?.busy) {
    directories.add(attached.directory);
  }

  return [...directories];
}

export async function reconcileForegroundBusyState(): Promise<void> {
  if (!isForegroundBusy()) {
    return;
  }

  for (const directory of getBusyDirectories()) {
    try {
      await reconcileBusyStateNow(directory);
    } catch (error) {
      logger.warn("[BusyGuard] Failed to reconcile foreground busy state", error);
    }
  }
}

export async function replyBusyBlocked(ctx: Context): Promise<void> {
  const message = t("bot.session_busy");

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: message }).catch(() => {});
    return;
  }

  if (ctx.chat) {
    await ctx.reply(message).catch(() => {});
  }
}
