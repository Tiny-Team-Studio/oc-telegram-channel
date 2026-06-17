export type OcEvent = { type: string; properties: Record<string, any> };

export function isTurnComplete(ev: OcEvent): { sessionID: string; messageID: string } | null {
  if (ev.type !== "message.updated") return null;
  const info = ev.properties?.info;
  if (!info || info.role !== "assistant") return null;
  if (!info.time?.completed) return null;
  return { sessionID: info.sessionID, messageID: info.id };
}

// Per-message, per-part ordered accumulation. Snapshot (part.text) wins over delta concat.
export class TurnAccumulator {
  private order = new Map<string, string[]>();        // messageID -> ordered partIDs
  private parts = new Map<string, Map<string, string>>(); // messageID -> partID -> text

  apply(ev: OcEvent): void {
    if (ev.type !== "message.part.delta" && ev.type !== "message.part.updated") return;
    const part = ev.properties?.part;
    if (!part || part.type !== "text") return;       // ignore reasoning/tool/step parts
    const messageID: string = part.messageID;
    const partID: string = part.id;
    const delta: string | undefined = ev.properties?.delta;
    const snapshot: string | undefined = part.text;

    if (!this.order.has(messageID)) this.order.set(messageID, []);
    if (!this.parts.has(messageID)) this.parts.set(messageID, new Map());
    const ord = this.order.get(messageID)!;
    const pm = this.parts.get(messageID)!;
    if (!pm.has(partID)) ord.push(partID);

    const prev = pm.get(partID) ?? "";
    let next = prev;
    if (typeof delta === "string") next = prev + delta;
    if (typeof snapshot === "string" && snapshot.length >= next.length) next = snapshot;
    pm.set(partID, next);
  }

  text(messageID: string): string {
    const ord = this.order.get(messageID);
    const pm = this.parts.get(messageID);
    if (!ord || !pm) return "";
    return ord.map((id) => pm.get(id) ?? "").join("");
  }

  clear(messageID: string): void {
    this.order.delete(messageID);
    this.parts.delete(messageID);
  }
}
