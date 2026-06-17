import { test, expect } from "bun:test";
import {
  classifyAttachment,
  toFilePartInput,
  voiceTextPart,
  replyContextPart,
} from "./inbound.ts";

test("classifyAttachment routes by extension", () => {
  expect(classifyAttachment(".jpg")).toBe("photo");
  expect(classifyAttachment(".JPEG")).toBe("photo");
  expect(classifyAttachment("png")).toBe("photo");
  expect(classifyAttachment(".webp")).toBe("photo");

  expect(classifyAttachment(".ogg")).toBe("voice");
  expect(classifyAttachment(".oga")).toBe("voice");
  expect(classifyAttachment(".m4a")).toBe("voice");
  expect(classifyAttachment(".opus")).toBe("voice");
  expect(classifyAttachment(".mp3")).toBe("voice");

  expect(classifyAttachment(".pdf")).toBe("document");
  expect(classifyAttachment(".zip")).toBe("document");
  expect(classifyAttachment("")).toBe("document");
});

test("classifyAttachment routes by mime when given a slash form", () => {
  expect(classifyAttachment("image/jpeg")).toBe("photo");
  expect(classifyAttachment("image/png")).toBe("photo");
  expect(classifyAttachment("audio/ogg")).toBe("voice");
  expect(classifyAttachment("audio/mpeg")).toBe("voice");
  expect(classifyAttachment("application/pdf")).toBe("document");
});

test("toFilePartInput builds a data-URL FilePartInput", () => {
  const bytes = new Uint8Array([0x68, 0x69]); // "hi"
  const part = toFilePartInput("photo.jpg", bytes, "image/jpeg");
  expect(part.type).toBe("file");
  expect(part.mime).toBe("image/jpeg");
  expect(part.filename).toBe("photo.jpg");
  expect(part.url).toBe(`data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`);
  // sanity: "hi" base64-encodes to "aGk="
  expect(part.url).toBe("data:image/jpeg;base64,aGk=");
});

test("toFilePartInput accepts a Buffer too", () => {
  const buf = Buffer.from("hi");
  const part = toFilePartInput("x.png", buf, "image/png");
  expect(part.url).toBe("data:image/png;base64,aGk=");
});

test("voiceTextPart references the inbox path with a transcribe instruction", () => {
  const part = voiceTextPart("/home/opencode/inbox/voice_123.ogg");
  expect(part.type).toBe("text");
  expect(part.text).toContain("/home/opencode/inbox/voice_123.ogg");
  expect(part.text.toLowerCase()).toContain("voice memo");
  expect(part.text.toLowerCase()).toContain("transcribe");
});

test("replyContextPart uses the quoted message text", () => {
  const part = replyContextPart({ text: "Just posted this tweet 🚀" });
  expect(part).not.toBeNull();
  expect(part!.type).toBe("text");
  expect(part!.text).toContain("In reply to an earlier message");
  expect(part!.text).toContain("Just posted this tweet 🚀");
});

test("replyContextPart falls back to caption when there is no text", () => {
  const part = replyContextPart({ caption: "Photo caption here" });
  expect(part).not.toBeNull();
  expect(part!.text).toContain("Photo caption here");
});

test("replyContextPart prefers text over caption when both present", () => {
  const part = replyContextPart({ text: "the text", caption: "the caption" });
  expect(part!.text).toContain("the text");
  expect(part!.text).not.toContain("the caption");
});

test("replyContextPart trims surrounding whitespace in the quote", () => {
  const part = replyContextPart({ text: "   spaced out   " });
  expect(part!.text).toContain('"spaced out"');
  expect(part!.text).not.toContain("   spaced out   ");
});

test("replyContextPart returns null when there is no usable quoted content", () => {
  expect(replyContextPart(undefined)).toBeNull();
  expect(replyContextPart(null)).toBeNull();
  expect(replyContextPart({})).toBeNull();
  expect(replyContextPart({ text: "   " })).toBeNull();
  expect(replyContextPart({ caption: "" })).toBeNull();
});

test("replyContextPart caps overly long quoted text", () => {
  const long = "x".repeat(2000);
  const part = replyContextPart({ text: long });
  expect(part).not.toBeNull();
  // quote body capped to ~500 chars (plus the wrapper prose); never the full 2000.
  expect(part!.text.length).toBeLessThan(600);
  expect(part!.text).toContain("x".repeat(500));
  expect(part!.text).not.toContain("x".repeat(501));
});
