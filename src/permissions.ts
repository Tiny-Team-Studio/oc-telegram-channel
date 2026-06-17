import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { OcEvent } from "./opencode.ts";
import type { Config } from "./config.ts";

type Reply = "once" | "always" | "reject";

const MAX_WHAT = 300;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Normalise the two payload shapes OpenCode emits for a permission request:
//   - legacy `permission.asked`: { id, sessionID, permission, patterns }
//   - `permission.v2.asked`:     { id, sessionID, action, resources }
// Both reply via the same client.permission.reply({ requestID, directory, reply }).
function parseAsked(
  ev: OcEvent,
): { requestID: string; sessionID: string; label: string; items: string[] } | null {
  if (ev.type !== "permission.asked" && ev.type !== "permission.v2.asked") return null;
  const p = ev.properties || {};
  const requestID: string | undefined = p.id;
  const sessionID: string | undefined = p.sessionID;
  if (!requestID || !sessionID) return null;
  const label: string = p.permission ?? p.action ?? "permission";
  const items: string[] = Array.isArray(p.patterns)
    ? p.patterns
    : Array.isArray(p.resources)
      ? p.resources
      : [];
  return { requestID, sessionID, label, items };
}

// Relays OpenCode permission prompts to Telegram as inline Allow/Always/Deny
// buttons, and routes the tapped choice back via client.permission.reply.
// Every Telegram call is catch-guarded so a relay failure can't break the turn.
export class PermissionRelay {
  private pending = new Map<string, { sessionID: string }>(); // requestID -> ctx

  constructor(
    private bot: Bot,
    private client: any,
    private cfg: Config,
    private chatBySession: Map<string, number>,
  ) {}

  onEvent(ev: OcEvent): void {
    const asked = parseAsked(ev);
    if (!asked) return;
    const chatId = this.chatBySession.get(asked.sessionID);
    if (chatId == null) return; // no chat known for this session — nothing to ask
    this.pending.set(asked.requestID, { sessionID: asked.sessionID });

    const kb = new InlineKeyboard()
      .text("✅ Allow", `perm:once:${asked.requestID}`)
      .text("✅ Always", `perm:always:${asked.requestID}`)
      .text("❌ Deny", `perm:reject:${asked.requestID}`);

    const what = `${asked.label}: ${asked.items.join(", ")}`.slice(0, MAX_WHAT);
    void this.bot.api
      .sendMessage(chatId, `🔐 Permission requested\n<code>${esc(what)}</code>`, {
        parse_mode: "HTML",
        reply_markup: kb,
      })
      .catch(() => {});
  }

  registerCallbacks(bot: Bot): void {
    bot.callbackQuery(/^perm:(once|always|reject):(.+)$/, async (ctx) => {
      const reply = ctx.match![1] as Reply;
      const requestID = ctx.match![2] as string;

      // Stale/expired request (already answered, or relay restarted): just
      // acknowledge and re-label so the user isn't left tapping a dead button.
      const known = this.pending.has(requestID);
      this.pending.delete(requestID);

      if (known) {
        try {
          await this.client.permission.reply({
            requestID,
            directory: this.cfg.workdir,
            reply,
          });
        } catch {
          /* the request may have expired server-side — fall through to re-label */
        }
      }

      const label = reply === "reject" ? "❌ Denied" : "✅ Allowed";
      await ctx.editMessageText(`🔐 ${label}`).catch(() => {});
      await ctx.answerCallbackQuery().catch(() => {});
    });
  }
}
