export type MentionDescriptor =
  | { kind: "file" | "directory"; path: string }
  | { kind: "reference"; alias: string };

export interface MentionSpan {
  start: number;
  end: number;
  text: string;
}

export interface ActiveMentionQuery {
  start: number;
  end: number;
  query: string;
}

export function findActiveMentionQuery(
  text: string,
  caret: number,
  mentions: readonly { mention: MentionSpan }[],
): ActiveMentionQuery | null {
  const position = Math.max(0, Math.min(caret, text.length));
  const lineStart = text.lastIndexOf("\n", Math.max(0, position - 1)) + 1;
  const beforeCaret = text.slice(lineStart, position);
  const startInLine = beforeCaret.lastIndexOf("@");
  if (startInLine < 0) return null;
  const start = lineStart + startInLine;
  const previous = start > 0 ? text[start - 1] : "";
  if (previous && !/[\s([{]/u.test(previous)) return null;
  if (mentions.some((item) => start >= item.mention.start && start < item.mention.end)) return null;

  const lineEnd = text.indexOf("\n", position);
  const endOfLine = lineEnd < 0 ? text.length : lineEnd;
  let end = position;
  while (end < endOfLine && !/\s/u.test(text[end] ?? "")) end += 1;
  return { start, end, query: text.slice(start + 1, position) };
}

export interface PromptMentionAttachment {
  descriptor: MentionDescriptor;
  mention: MentionSpan;
}

/** A UI-safe suggestion returned by the authenticated, location-scoped API. */
export interface MentionCandidate {
  kind: "file" | "directory" | "reference";
  path?: string;
  alias?: string;
  label: string;
  name: string;
}

/**
 * Textarea selection offsets and OpenCode's PromptMention offsets are JavaScript
 * string offsets (UTF-16 code units). OpenCode's composer serializes spans using
 * String.length and restores them using String.slice.
 */
export function mentionSpanIsValid(text: string, span: MentionSpan): boolean {
  return (
    Number.isInteger(span.start) &&
    Number.isInteger(span.end) &&
    span.start >= 0 &&
    span.end > span.start &&
    span.end <= text.length &&
    typeof span.text === "string" &&
    span.text.length > 0 &&
    text.slice(span.start, span.end) === span.text
  );
}

/**
 * Track chosen mentions through textarea edits. Changes touching any part of a
 * mention invalidate that attachment; edits before it shift its exact range.
 */
export function trackMentionEdits<T extends { mention: MentionSpan }>(
  previous: string,
  next: string,
  attachments: readonly T[],
): T[] {
  if (previous === next) return [...attachments];

  let start = 0;
  while (
    start < previous.length &&
    start < next.length &&
    previous.charCodeAt(start) === next.charCodeAt(start)
  ) {
    start += 1;
  }

  let oldEnd = previous.length;
  let newEnd = next.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    previous.charCodeAt(oldEnd - 1) === next.charCodeAt(newEnd - 1)
  ) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  const delta = newEnd - oldEnd;
  return attachments.flatMap((attachment) => {
    const { start: mentionStart, end: mentionEnd } = attachment.mention;
    if (!mentionSpanIsValid(previous, attachment.mention)) return [];

    const insertion = oldEnd === start;
    const overlaps = insertion
      ? start > mentionStart && start < mentionEnd
      : start < mentionEnd && oldEnd > mentionStart;
    if (overlaps) return [];

    const shiftedStart = mentionStart >= oldEnd ? mentionStart + delta : mentionStart;
    const shiftedEnd = mentionEnd > oldEnd ? mentionEnd + delta : mentionEnd;
    const mention = { ...attachment.mention, start: shiftedStart, end: shiftedEnd };
    return mentionSpanIsValid(next, mention) ? [{ ...attachment, mention }] : [];
  });
}

/** Adjust exact UTF-16 ranges when the submitted prompt is trimmed. */
export function trimPromptMentions<T extends { mention: MentionSpan }>(
  text: string,
  attachments: readonly T[],
): { text: string; attachments: T[] } {
  const start = text.length - text.trimStart().length;
  const trimmed = text.trim();
  const end = start + trimmed.length;
  const adjusted = attachments.flatMap((attachment) => {
    const { mention } = attachment;
    if (!mentionSpanIsValid(text, mention) || mention.start < start || mention.end > end) return [];
    const nextMention = { ...mention, start: mention.start - start, end: mention.end - start };
    return mentionSpanIsValid(trimmed, nextMention)
      ? [{ ...attachment, mention: nextMention }]
      : [];
  });
  return { text: trimmed, attachments: adjusted };
}

/** Lexical validation for OpenCode file.find results; does not claim symlink confinement. */
export function isSafeRelativePath(candidate: string): boolean {
  if (!candidate || candidate.includes("\\") || candidate.includes("\0")) return false;
  if (candidate.startsWith("/") || candidate.split("/").some((part) => part === ".." || part === "." || part === "")) {
    return false;
  }
  return true;
}

/** Visibility policy only: hidden path segments are excluded, without claiming symlink confinement. */
export function isVisibleRelativePath(candidate: string): boolean {
  return isSafeRelativePath(candidate) && !candidate.split("/").some((segment) => segment.startsWith("."));
}

export function validatePromptMentions(
  text: unknown,
  attachments: unknown,
): { text: string; attachments: PromptMentionAttachment[] } | null {
  if (typeof text !== "string" || text.length > 20_000 || !text.trim()) return null;
  if (!Array.isArray(attachments) || attachments.length > 30) return null;

  const parsed: PromptMentionAttachment[] = [];
  for (const raw of attachments) {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    const descriptor = value.descriptor;
    const mention = value.mention;
    if (!descriptor || typeof descriptor !== "object" || !mention || typeof mention !== "object") return null;

    const d = descriptor as Record<string, unknown>;
    const m = mention as Record<string, unknown>;
    let safeDescriptor: MentionDescriptor;
    if ((d.kind === "file" || d.kind === "directory") && typeof d.path === "string" && isVisibleRelativePath(d.path)) {
      safeDescriptor = { kind: d.kind, path: d.path };
    } else if (d.kind === "reference" && typeof d.alias === "string" && d.alias.length > 0 && d.alias.length <= 200) {
      safeDescriptor = { kind: "reference", alias: d.alias };
    } else {
      return null;
    }
    if (
      typeof m.start !== "number" ||
      typeof m.end !== "number" ||
      typeof m.text !== "string"
    ) return null;
    const span = { start: m.start, end: m.end, text: m.text };
    if (!mentionSpanIsValid(text, span) || !span.text.startsWith("@")) return null;
    parsed.push({ descriptor: safeDescriptor, mention: span });
  }
  return { text, attachments: parsed };
}
