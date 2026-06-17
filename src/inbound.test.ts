import { test, expect } from "bun:test";
import {
  classifyAttachment,
  toFilePartInput,
  voiceTextPart,
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
