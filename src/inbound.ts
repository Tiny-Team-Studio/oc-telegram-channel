import type { FilePartInput, TextPartInput } from "@opencode-ai/sdk/v2";

// Inbound media classification + part-building for feeding Telegram attachments
// into an OpenCode session. Pure helpers (no I/O) so they're trivially testable:
// callers download bytes and pass them in.

export type AttachmentKind = "photo" | "voice" | "document";

// Mirrors the OUTBOUND extension sets in telegram.ts, but for INBOUND routing:
// photos travel inline as data-URL FilePartInput (the agent reads them directly);
// voice memos go to the inbox so the `voice-transcribe` skill can act on them.
const PHOTO_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const VOICE_EXTS = new Set(["ogg", "oga", "mp3", "m4a", "opus", "wav", "flac"]);

// Classify by either a file extension (".jpg" / "jpg") OR a mime type
// ("image/jpeg"). Anything unrecognised is a document.
export function classifyAttachment(extOrMime: string): AttachmentKind {
  const s = extOrMime.toLowerCase().trim();
  if (s.includes("/")) {
    const major = s.split("/")[0];
    if (major === "image") return "photo";
    if (major === "audio") return "voice";
    return "document";
  }
  const ext = s.startsWith(".") ? s.slice(1) : s;
  if (PHOTO_EXTS.has(ext)) return "photo";
  if (VOICE_EXTS.has(ext)) return "voice";
  return "document";
}

// Build a FilePartInput whose bytes travel inline as a base64 data URL — the
// only way to ship file bytes to the prompt endpoint (no upload endpoint exists;
// confirmed against packages/sdk/js/src/gen/types.gen.ts FilePartInput.url).
export function toFilePartInput(
  filename: string,
  bytes: Uint8Array | Buffer,
  mime: string,
): FilePartInput {
  const b64 = Buffer.from(bytes).toString("base64");
  return { type: "file", mime, filename, url: `data:${mime};base64,${b64}` };
}

// Reference a downloaded voice memo by its inbox path and instruct the agent to
// transcribe it (the `voice-transcribe` skill reads the file from this path).
export function voiceTextPart(inboxPath: string): TextPartInput {
  return {
    type: "text",
    text: `[voice memo received at ${inboxPath} — transcribe it]`,
  };
}
