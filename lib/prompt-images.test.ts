import { describe, expect, it, vi } from "vitest";
import { trackMentionEdits } from "./prompt-mentions";
import {
  decodeCanonicalBase64,
  imageBytesMatchMime,
  collectClipboardImageFiles,
  insertComposerImages,
  mapHistoryImageFiles,
  planComposerImageInsertion,
  MAX_HISTORY_IMAGE_CACHE_CHARS,
  MAX_HISTORY_IMAGE_CACHE_ENTRIES,
  MAX_IMAGE_BYTES,
  MAX_PROMPT_REQUEST_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  prepareComposerImages,
  removeComposerImage,
  validatePromptImages,
  type ComposerImage,
} from "./prompt-images";

const png = "iVBORw0KGgo="; // the PNG signature, sufficient for signature validation
function encodedPng(size: number): string {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

const image = (id: string, start: number, tag: string, data: string | null = png): ComposerImage => ({
  id,
  name: `${id}.png`,
  mime: "image/png",
  size: data ? decodeCanonicalBase64(data)!.length : 8,
  data,
  mention: { start, end: start + tag.length, text: tag },
});

describe("image attachment validation and composer spans", () => {
  it("validates raster signatures, canonical base64, and rejects arbitrary URIs or MIME spoofing", () => {
    expect(decodeCanonicalBase64("AB==")).toBeNull();
    expect(decodeCanonicalBase64("AAB=")).toBeNull();
    expect(decodeCanonicalBase64("AA==")).toEqual(new Uint8Array([0]));
    expect(imageBytesMatchMime(decodeCanonicalBase64(png)!, "image/png")).toBe(true);
    expect(imageBytesMatchMime(decodeCanonicalBase64(png)!, "image/jpeg")).toBe(false);
    expect(validatePromptImages("[image1]", [{
      data: png,
      mime: "image/png",
      name: "../private.png",
      mention: { start: 0, end: 8, text: "[image1]" },
    }])).toEqual([{
      data: png,
      mime: "image/png",
      name: ".._private.png",
      mention: { start: 0, end: 8, text: "[image1]" },
    }]);
    expect(validatePromptImages("[image1]", [{
      uri: "https://example.invalid/image.png",
      mime: "image/png",
      mention: { start: 0, end: 8, text: "[image1]" },
    }])).toBeNull();
    expect(validatePromptImages("[image1]", [{
      data: png,
      mime: "image/jpeg",
      mention: { start: 0, end: 8, text: "[image1]" },
    }])).toBeNull();
  });

  it("assigns stable image tags at UTF-16 cursor positions and tracks edits", () => {
    const text = "😀 prompt";
    const inserted = insertComposerImages(text, [], [], 3, 3, [{
      id: "one", name: "one.png", mime: "image/png", size: 8,
    }]);
    expect(inserted.text).toBe("😀 [image1]prompt");
    expect(inserted.images[0]?.mention).toEqual({ start: 3, end: 11, text: "[image1]" });

    const edited = `${inserted.text}!`;
    expect(trackMentionEdits(inserted.text, edited, inserted.images)[0]?.mention.start).toBe(3);
    expect(trackMentionEdits(inserted.text, inserted.text.replace("image1", "imageX"), inserted.images)).toEqual([]);
  });

  it("replaces the selected range and removes thumbnails whose tags were replaced", () => {
    const text = "[image1] @src/a [image2]";
    const first = image("first", 0, "[image1]");
    const secondStart = text.indexOf("[image2]");
    const second = image("second", secondStart, "[image2]");
    const reference = { mention: { start: 9, end: 15, text: "@src/a" } };
    const plan = planComposerImageInsertion(
      text,
      [reference],
      [first, second],
      0,
      "[image1]".length,
      [{ id: "replacement", name: "replacement.png", mime: "image/png", size: 8 }],
    );
    expect(plan.accepted).toBe(true);
    expect(plan.text).toBe("[image3] @src/a [image2]");
    expect(plan.images.map((item) => item.id)).toEqual(["replacement", "second"]);
    expect(plan.mentions[0]?.mention.start).toBe(9);

    const invalidMixedPaste = planComposerImageInsertion(
      "prefix replace suffix",
      [],
      [],
      7,
      14,
      [{ id: "bad", name: "bad.heic", mime: "image/heic" as never, size: 4 }],
      "pasted",
    );
    expect(invalidMixedPaste.text).toBe("prefix pasted suffix");
    expect(invalidMixedPaste.accepted).toBe(false);
    expect(invalidMixedPaste.error).toContain("PNG, JPEG, or WebP");
  });

  it("reports clipboard image items that fail to produce a File", () => {
    const file = new File([new Uint8Array([1])], "ok.png", { type: "image/png" });
    const result = collectClipboardImageFiles([
      { kind: "file", type: "image/png", getAsFile: () => file },
      { kind: "file", type: "image/png", getAsFile: () => null },
      { kind: "file", type: "image/jpeg", getAsFile: () => { throw new Error("unavailable"); } },
      { kind: "string", type: "text/plain", getAsFile: () => null },
    ]);
    expect(result.files).toEqual([file]);
    expect(result.failedCount).toBe(2);
  });

  it("removes an image token and shifts remaining images and @ references", () => {
    const text = "[image1] @src/a [image2]";
    const first = image("first", 0, "[image1]");
    const secondStart = text.indexOf("[image2]");
    const second = image("second", secondStart, "[image2]");
    const mention = { mention: { start: 9, end: 15, text: "@src/a" } };
    const removed = removeComposerImage(text, [mention], [first, second], "first", 0);
    expect(removed?.text).toBe(" @src/a [image2]");
    expect(removed?.images[0]?.mention.start).toBe(8);
    expect(removed?.mentions[0]?.mention.start).toBe(1);
  });

  it("rejects damaged tags, overlaps, too many files, and pending draft images", () => {
    expect(validatePromptImages("[image1]", [{
      data: png, mime: "image/png", mention: { start: 0, end: 8, text: "[image1]" },
    }, {
      data: png, mime: "image/png", mention: { start: 0, end: 8, text: "[image1]" },
    }])).toBeNull();
    expect(validatePromptImages("[image1]", [{
      data: png, mime: "image/png", mention: { start: 0, end: 7, text: "[image1]" },
    }])).toBeNull();
    const tooMany = Array.from({ length: 5 }, (_, index) => ({
      data: png,
      mime: "image/png",
      mention: { start: index * 9, end: index * 9 + 8, text: `[image${index + 1}]` },
    }));
    expect(validatePromptImages("[image1] [image2] [image3] [image4] [image5]", tooMany)).toBeNull();
    expect(prepareComposerImages("[image1]", [image("pending", 0, "[image1]", null)]).valid).toBe(false);
  });

  it("accepts the approved 4 MiB per-image and 6 MiB combined boundaries", () => {
    const largest = encodedPng(MAX_IMAGE_BYTES);
    const remainder = encodedPng(2 * 1024 * 1024);
    const accepted = validatePromptImages("[image1] [image2]", [
      { data: largest, mime: "image/png", mention: { start: 0, end: 8, text: "[image1]" } },
      { data: remainder, mime: "image/png", mention: { start: 9, end: 17, text: "[image2]" } },
    ]);
    expect(accepted).toHaveLength(2);
    expect(accepted?.map((item) => decodeCanonicalBase64(item.data)?.length)).toEqual([
      4 * 1024 * 1024,
      2 * 1024 * 1024,
    ]);

    expect(validatePromptImages("[image1]", [{
      data: encodedPng(MAX_IMAGE_BYTES + 1),
      mime: "image/png",
      mention: { start: 0, end: 8, text: "[image1]" },
    }])).toBeNull();
    expect(validatePromptImages("[image1] [image2] [image3]", [
      { data: largest, mime: "image/png", mention: { start: 0, end: 8, text: "[image1]" } },
      { data: remainder, mime: "image/png", mention: { start: 9, end: 17, text: "[image2]" } },
      { data: png, mime: "image/png", mention: { start: 18, end: 26, text: "[image3]" } },
    ])).toBeNull();
  });

  it("renders large history images without full-buffer decoding and reuses bounded cached views", () => {
    const data = encodedPng(2 * 1024 * 1024);
    const originalAtob = globalThis.atob;
    const atobSpy = vi.spyOn(globalThis, "atob").mockImplementation((value) => originalAtob(value));
    try {
      const files = [{ mime: "image/png", data, name: "screenshot.png" }];
      const mapped = mapHistoryImageFiles(files, "msg_cached-history-image");
      const repeated = mapHistoryImageFiles(files, "msg_cached-history-image");
      expect(mapped.omittedCount).toBe(0);
      expect(mapped.images).toHaveLength(1);
      expect(mapped.images[0]?.size).toBe(2 * 1024 * 1024);
      expect(mapped.images[0]?.src.startsWith("data:image/png;base64,")).toBe(true);
      expect(repeated).toBe(mapped);
      expect(atobSpy.mock.calls.every(([input]) => input.length <= 12)).toBe(true);
      expect(atobSpy).toHaveBeenCalledTimes(1);
    } finally {
      atobSpy.mockRestore();
    }
  });

  it("bounds cached image views by encoded-string size", () => {
    const data = encodedPng(2 * 1024 * 1024);
    const files = [{ mime: "image/png", data, name: "large.png" }];
    const originalAtob = globalThis.atob;
    const atobSpy = vi.spyOn(globalThis, "atob").mockImplementation((value) => originalAtob(value));
    try {
      for (let index = 0; index < 5; index += 1) {
        mapHistoryImageFiles(files, `msg_cache-bound-${index}`);
      }
      expect(MAX_HISTORY_IMAGE_CACHE_CHARS).toBe(12 * 1024 * 1024);
      expect(MAX_HISTORY_IMAGE_CACHE_ENTRIES).toBe(100);
      expect(atobSpy).toHaveBeenCalledTimes(5);
      mapHistoryImageFiles(files, "msg_cache-bound-0");
      expect(atobSpy).toHaveBeenCalledTimes(6);
    } finally {
      atobSpy.mockRestore();
    }
  });

  it("reports history images omitted by preview limits instead of silently dropping them", () => {
    const oversized = encodedPng(MAX_IMAGE_BYTES + 1);
    const mapped = mapHistoryImageFiles([{ mime: "image/png", data: oversized, name: "large.png" }]);
    expect(mapped.images).toEqual([]);
    expect(mapped.omittedCount).toBe(1);
  });

  it("keeps the encoded request cap under the documented 10 MB Next proxy threshold", () => {
    expect(MAX_TOTAL_IMAGE_BYTES).toBe(6 * 1024 * 1024);
    expect(MAX_IMAGE_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_PROMPT_REQUEST_BYTES).toBe(9 * 1024 * 1024);
    expect(MAX_PROMPT_REQUEST_BYTES).toBeLessThan(10_000_000);
  });
});
