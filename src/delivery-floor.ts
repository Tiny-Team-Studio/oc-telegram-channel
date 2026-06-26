export interface CompletedTurn {
  sessionID: string;
  messageID: string;
  text: string;
}

export class DeliveryFloor {
  private repliedThisTurn = new Set<string>();
  private repliedThisSession = new Set<string>();
  private pendingFallbackBySession = new Map<string, string>();

  beginTurn(sessionID: string): void {
    this.repliedThisSession.delete(sessionID);
    this.pendingFallbackBySession.delete(sessionID);
  }

  markReplied(sessionID: string, messageID: string): void {
    this.repliedThisTurn.add(messageID);
    this.repliedThisSession.add(sessionID);
  }

  recordCompletion(turn: CompletedTurn, isNoReply: (text: string) => boolean): void {
    const replied = this.repliedThisTurn.has(turn.messageID) || this.repliedThisSession.has(turn.sessionID);
    this.repliedThisTurn.delete(turn.messageID);
    if (!replied && turn.text && !isNoReply(turn.text)) {
      this.pendingFallbackBySession.set(turn.sessionID, turn.text);
    }
  }

  resolveIdle(sessionID: string): string | undefined {
    const replied = this.repliedThisSession.has(sessionID);
    const text = this.pendingFallbackBySession.get(sessionID);
    this.pendingFallbackBySession.delete(sessionID);
    this.repliedThisSession.delete(sessionID);
    return replied ? undefined : text;
  }
}
