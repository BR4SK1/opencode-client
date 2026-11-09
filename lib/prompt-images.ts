import { mentionSpanIsValid, trackMentionEdits, type MentionSpan } from "./prompt-mentions";

export const SUPPORTED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type SupportedImageMime = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];
export const MAX_IMAGE_ATTACHMENTS = 4;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_PROMPT_REQUEST_BYTES = 9 * 1024 * 1024;

export interface ComposerImage {
  id: string;
  name: string;
  mime: SupportedImageMime;
  size: number;
  /** Base64 without a data-URI prefix. Null while the browser is reading it. */
  data: string | null;
  mention: MentionSpan;
  error?: string;
}

export interface PromptImageAttachment {
  name: string;
  mime: SupportedImageMime;
  data: string;
  mention: MentionSpan;
}

export function isSupportedImageMime(value: unknown): value is SupportedImageMime {
  return typeof value === "string" && (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

/** Strict-alphabet base64 decoding shared by browser previews and server validation. */
export function decodeCanonicalBase64(value: string): Uint8Array | null {
  if (!value || value.length % 4 !== 0) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  for (let index = 0; index < value.length - padding; index += 1) {
    const code = value.charCodeAt(index);
    const isBase64 =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2f;
    if (!isBase64) return null;
  }
  if (padding > 0 && !value.endsWith("=".repeat(padding))) return null;
  const finalSextet = value.charCodeAt(value.length - padding - 1);
  const finalValue =
    finalSextet >= 0x41 && finalSextet <= 0x5a ? finalSextet - 0x41 :
    finalSextet >= 0x61 && finalSextet <= 0x7a ? finalSextet - 0x61 + 26 :
    finalSextet >= 0x30 && finalSextet <= 0x39 ? finalSextet - 0x30 + 52 :
    finalSextet === 0x2b ? 62 : finalSextet === 0x2f ? 63 : -1;
  if (padding === 2 && (finalValue < 0 || finalValue & 0x0f) || padding === 1 && (finalValue < 0 || finalValue & 0x03)) {
    return null;
  }
  try {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export function imageBytesMatchMime(bytes: Uint8Array, mime: SupportedImageMime): boolean {
  if (mime === "image/png") {
    return bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  }
  if (mime === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
}

export function sanitizeImageName(value: unknown): string {
  if (typeof value !== "string") return "image";
  const safe = value.normalize("NFKC").replace(/[\\/\u0000-\u001f\u007f]/gu, "_").trim().slice(0, 120);
  return safe || "image";
}

export interface HistoryImageViewModel {
  src: string;
  name: string;
  size: number;
}

export interface HistoryImageMapping {
  images: HistoryImageViewModel[];
  omittedCount: number;
}

export const MAX_HISTORY_IMAGE_CACHE_CHARS = 12 * 1024 * 1024;
export const MAX_HISTORY_IMAGE_CACHE_ENTRIES = 100;
const historyImageCache = new Map<string, { mapping: HistoryImageMapping; chars: number }>();
let historyImageCacheChars = 0;

function base64ByteLength(value: string): number | null {
  if (!value || value.length % 4 !== 0) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const finalSextet = value.charCodeAt(value.length - padding - 1);
  const finalValue =
    finalSextet >= 0x41 && finalSextet <= 0x5a ? finalSextet - 0x41 :
    finalSextet >= 0x61 && finalSextet <= 0x7a ? finalSextet - 0x61 + 26 :
    finalSextet >= 0x30 && finalSextet <= 0x39 ? finalSextet - 0x30 + 52 :
    finalSextet === 0x2b ? 62 : finalSextet === 0x2f ? 63 : -1;
  if (
    (padding === 1 && (finalValue < 0 || (finalValue & 0x03) !== 0)) ||
    (padding === 2 && (finalValue < 0 || (finalValue & 0x0f) !== 0))
  ) return null;
  return value.length / 4 * 3 - padding;
}

function imagePrefixMatches(data: string, mime: SupportedImageMime): boolean {
  const prefixLength = mime === "image/jpeg" ? 4 : mime === "image/png" ? 12 : 16;
  const prefix = decodeCanonicalBase64(data.slice(0, prefixLength));
  return Boolean(prefix && imageBytesMatchMime(prefix, mime));
}

/**
 * Map trusted OpenCode history image data without decoding multi-megabyte buffers
 * synchronously. OpenCode materializes these inline attachments; locally we check
 * bounded length, canonical tail bits, and magic bytes only. New submissions are
 * fully validated by the authenticated prompt route.
 */
export function mapHistoryImageFiles(value: unknown, cacheKey?: string): HistoryImageMapping {
  if (!Array.isArray(value)) return { images: [], omittedCount: 0 };
  if (cacheKey) {
    const cached = historyImageCache.get(cacheKey);
    if (cached) {
      historyImageCache.delete(cacheKey);
      historyImageCache.set(cacheKey, cached);
      return cached.mapping;
    }
  }
  const images: HistoryImageViewModel[] = [];
  let totalBytes = 0;
  let omittedCount = 0;
  let supportedCount = 0;
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const file = raw as Record<string, unknown>;
    const mime = file.mime;
    if (!isSupportedImageMime(mime)) {
      if (typeof mime === "string" && mime.startsWith("image/")) omittedCount += 1;
      continue;
    }
    supportedCount += 1;
    if (supportedCount > MAX_IMAGE_ATTACHMENTS) {
      omittedCount += 1;
      continue;
    }
    let data = typeof file.data === "string" ? file.data : "";
    if (data.startsWith("data:")) {
      const comma = data.indexOf(",");
      if (comma < 0 || data.slice(0, comma) !== `data:${mime};base64`) {
        omittedCount += 1;
        continue;
      }
      data = data.slice(comma + 1);
    } else if (!data) {
      const source = file.source && typeof file.source === "object" ? file.source as Record<string, unknown> : {};
      const uri = typeof source.uri === "string" ? source.uri : "";
      const comma = uri.indexOf(",");
      if (comma < 0 || uri.slice(0, comma) !== `data:${mime};base64`) {
        omittedCount += 1;
        continue;
      }
      data = uri.slice(comma + 1);
    }
    if (data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
      omittedCount += 1;
      continue;
    }
    const size = base64ByteLength(data);
    if (
      size === null || size === 0 || size > MAX_IMAGE_BYTES ||
      totalBytes + size > MAX_TOTAL_IMAGE_BYTES || !imagePrefixMatches(data, mime)
    ) {
      omittedCount += 1;
      continue;
    }
    totalBytes += size;
    images.push({ src: `data:${mime};base64,${data}`, name: sanitizeImageName(file.name), size });
  }
  const mapping = { images, omittedCount };
  if (cacheKey && images.length > 0) {
    const chars = images.reduce((sum, image) => sum + image.src.length, 0);
    if (chars <= MAX_HISTORY_IMAGE_CACHE_CHARS) {
      historyImageCache.set(cacheKey, { mapping, chars });
      historyImageCacheChars += chars;
      while (
        historyImageCacheChars > MAX_HISTORY_IMAGE_CACHE_CHARS ||
        historyImageCache.size > MAX_HISTORY_IMAGE_CACHE_ENTRIES
      ) {
        const oldestKey = historyImageCache.keys().next().value;
        if (!oldestKey) break;
        const oldest = historyImageCache.get(oldestKey);
        if (oldest) historyImageCacheChars -= oldest.chars;
        historyImageCache.delete(oldestKey);
      }
    }
  }
  return mapping;
}

/** Validate client-supplied image bytes and tag ranges; never accepts a URI or file path. */
export function validatePromptImages(text: string, value: unknown): PromptImageAttachment[] | null {
  if (!Array.isArray(value) || value.length > MAX_IMAGE_ATTACHMENTS) return null;
  const parsed: PromptImageAttachment[] = [];
  let totalBytes = 0;
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    if (!isSupportedImageMime(item.mime) || typeof item.data !== "string") return null;
    const bytes = decodeCanonicalBase64(item.data);
    if (!bytes || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || !imageBytesMatchMime(bytes, item.mime)) return null;
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) return null;
    const mentionValue = item.mention;
    if (!mentionValue || typeof mentionValue !== "object") return null;
    const spanValue = mentionValue as Record<string, unknown>;
    if (typeof spanValue.start !== "number" || typeof spanValue.end !== "number" || typeof spanValue.text !== "string") return null;
    const mention = { start: spanValue.start, end: spanValue.end, text: spanValue.text };
    if (!mentionSpanIsValid(text, mention) || !/^\[image[1-9]\d*\]$/u.test(mention.text)) return null;
    parsed.push({
      data: item.data,
      mime: item.mime,
      name: sanitizeImageName(item.name),
      mention,
    });
  }
  const ordered = [...parsed].sort((a, b) => a.mention.start - b.mention.start);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.mention.start < ordered[index - 1]!.mention.end) return null;
  }
  return ordered;
}

export function insertComposerImages(
  text: string,
  mentions: readonly { mention: MentionSpan }[],
  images: readonly ComposerImage[],
  selectionStart: number,
  selectionEnd: number,
  incoming: readonly Omit<ComposerImage, "mention" | "data">[],
): { text: string; mentions: typeof mentions[number][]; images: ComposerImage[]; caret: number } {
  const start = Math.max(0, Math.min(selectionStart, text.length));
  const end = Math.max(start, Math.min(selectionEnd, text.length));
  let nextNumber = 0;
  for (const match of text.matchAll(/\[image(\d+)\]/gu)) nextNumber = Math.max(nextNumber, Number(match[1]) || 0);
  const tags = incoming.map((_, index) => `[image${nextNumber + index + 1}]`);
  const inserted = tags.join("");
  const nextText = text.slice(0, start) + inserted + text.slice(end);
  const adjustedMentions = trackMentionEdits(text, nextText, mentions);
  const adjustedImages = trackMentionEdits(text, nextText, images);
  let offset = start;
  const additions = incoming.map((image, index) => {
    const tag = tags[index]!;
    const attachment: ComposerImage = {
      ...image,
      data: null,
      mention: { start: offset, end: offset + tag.length, text: tag },
    };
    offset += tag.length;
    return attachment;
  });
  return {
    text: nextText,
    mentions: adjustedMentions,
    images: [...adjustedImages, ...additions].sort((a, b) => a.mention.start - b.mention.start),
    caret: start + inserted.length,
  };
}

export interface ComposerImageInsertPlan {
  text: string;
  mentions: Array<{ mention: MentionSpan }>;
  images: ComposerImage[];
  caret: number;
  accepted: boolean;
  error?: string;
}

/** Replace the current textarea selection, tracking any tags/references it removes. */
export function planComposerImageInsertion(
  text: string,
  mentions: readonly { mention: MentionSpan }[],
  images: readonly ComposerImage[],
  selectionStart: number,
  selectionEnd: number,
  incoming: readonly Omit<ComposerImage, "mention" | "data">[],
  pastedText = "",
): ComposerImageInsertPlan {
  const start = Math.max(0, Math.min(selectionStart, text.length));
  const end = Math.max(start, Math.min(selectionEnd, text.length));
  const replacedText = text.slice(0, start) + pastedText + text.slice(end);
  const nextMentions = trackMentionEdits(text, replacedText, mentions);
  const nextImages = trackMentionEdits(text, replacedText, images);
  const caret = start + pastedText.length;
  const invalid = incoming.find((image) =>
    !isSupportedImageMime(image.mime) || image.size <= 0 || image.size > MAX_IMAGE_BYTES,
  );
  let error = "";
  if (invalid) {
    error = invalid.size > MAX_IMAGE_BYTES
      ? "Each image must be 4 MiB or smaller."
      : invalid.size === 0
        ? "The selected image is empty. Choose a non-empty PNG, JPEG, or WebP image."
        : "Choose PNG, JPEG, or WebP images only; HEIC is not supported.";
  } else if (nextImages.length + incoming.length > MAX_IMAGE_ATTACHMENTS) {
    error = `Attach at most ${MAX_IMAGE_ATTACHMENTS} PNG, JPEG, or WebP images, up to 4 MiB each and 6 MiB combined.`;
  } else {
    const totalSize = nextImages.reduce((sum, image) => sum + image.size, 0) + incoming.reduce((sum, image) => sum + image.size, 0);
    if (totalSize > MAX_TOTAL_IMAGE_BYTES) {
      error = `Attach at most ${MAX_IMAGE_ATTACHMENTS} PNG, JPEG, or WebP images, up to 4 MiB each and 6 MiB combined.`;
    }
  }
  if (error || incoming.length === 0) {
    return {
      text: replacedText,
      mentions: nextMentions,
      images: nextImages,
      caret,
      accepted: false,
      ...(error ? { error } : {}),
    };
  }
  const inserted = insertComposerImages(replacedText, nextMentions, nextImages, caret, caret, incoming);
  return { ...inserted, accepted: true };
}

export interface ClipboardImageItemLike {
  kind: string;
  type: string;
  getAsFile(): File | null;
}

/** Clipboard APIs may advertise an image item but fail to materialize its File. */
export function collectClipboardImageFiles(items: readonly ClipboardImageItemLike[]): { files: File[]; failedCount: number } {
  const files: File[] = [];
  let failedCount = 0;
  for (const item of items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    try {
      const file = item.getAsFile();
      if (file) files.push(file);
      else failedCount += 1;
    } catch {
      failedCount += 1;
    }
  }
  return { files, failedCount };
}

export function removeComposerImage(
  text: string,
  mentions: readonly { mention: MentionSpan }[],
  images: readonly ComposerImage[],
  id: string,
  fallbackCaret: number,
): { text: string; mentions: typeof mentions[number][]; images: ComposerImage[]; caret: number } | null {
  const removed = images.find((image) => image.id === id);
  if (!removed) return null;
  const valid = mentionSpanIsValid(text, removed.mention);
  const { start, end } = removed.mention;
  const nextText = valid ? text.slice(0, start) + text.slice(end) : text;
  const remainingMentions = valid ? trackMentionEdits(text, nextText, mentions) : [...mentions];
  const remainingImages = images.filter((image) => image.id !== id);
  return {
    text: nextText,
    mentions: remainingMentions,
    images: valid ? trackMentionEdits(text, nextText, remainingImages) : remainingImages,
    caret: Math.min(valid ? start : fallbackCaret, nextText.length),
  };
}

export function prepareComposerImages(
  text: string,
  images: readonly ComposerImage[],
): { images: ComposerImage[]; valid: boolean } {
  const trimmed = text.trim();
  const trimStart = text.length - text.trimStart().length;
  const trimEnd = trimStart + trimmed.length;
  const adjusted = images.flatMap((image) => {
    if (!mentionSpanIsValid(text, image.mention) || image.mention.start < trimStart || image.mention.end > trimEnd) return [];
    const mention = { ...image.mention, start: image.mention.start - trimStart, end: image.mention.end - trimStart };
    return mentionSpanIsValid(trimmed, mention) ? [{ ...image, mention }] : [];
  });
  const valid = adjusted.length === images.length && adjusted.every((image) => Boolean(image.data) && !image.error);
  return { images: adjusted, valid };
}
