// Telegram caps messages at 4096 chars. Split long replies, preferring
// paragraph boundaries when chunkMode is 'newline'.
// Lifted verbatim from cc-telegram-channel/server.ts:425-444.

export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      // Prefer the last double-newline (paragraph), then single newline,
      // then space. Fall back to hard cut.
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

const NO_REPLY_RE = /^\s*NO_REPLY\s*$/i;
export function isNoReply(text: string, fileCount: number): boolean {
  return fileCount === 0 && NO_REPLY_RE.test(text);
}

export function pickParseMode(format: "text" | "html" | "rich"): "HTML" | undefined {
  return format === "html" ? "HTML" : undefined; // rich is sent via raw sendRichMessage
}
