import {
  mentionSpanIsValid,
  trackMentionEdits,
  trimPromptMentions,
  type MentionCandidate,
  type MentionDescriptor,
  type MentionSpan,
} from "./prompt-mentions";

export interface ComposerDraftMention {
  id: string;
  descriptor: MentionDescriptor;
  mention: MentionSpan;
  kind: MentionCandidate["kind"];
  label: string;
}

export interface ComposerDraftContent {
  text: string;
  mentions: ComposerDraftMention[];
}

export interface ComposerDraft extends ComposerDraftContent {
  revision: number;
}

export type SessionComposerDrafts = ReadonlyMap<string, ComposerDraft>;

export interface DismissedMentionQuery {
  sessionID: string;
  start: number;
  query: string;
}

const EMPTY_DRAFT: ComposerDraft = { text: "", mentions: [], revision: 0 };

export function isSameDismissedMention(
  dismissed: DismissedMentionQuery | null,
  sessionID: string,
  next: { start: number; query: string } | null,
): boolean {
  return Boolean(
    dismissed && next &&
    dismissed.sessionID === sessionID &&
    dismissed.start === next.start &&
    dismissed.query === next.query,
  );
}

export function shouldBlockEnterDuringMentionSearch(input: {
  key: string;
  shiftKey: boolean;
  hasActiveMention: boolean;
  mentionState: "idle" | "loading" | "ready" | "error";
}): boolean {
  return input.key === "Enter" && !input.shiftKey && input.hasActiveMention && input.mentionState === "loading";
}

export function getComposerDraft(store: SessionComposerDrafts, sessionID: string): ComposerDraft {
  return store.get(sessionID) ?? EMPTY_DRAFT;
}

export function prepareComposerDraftSubmission(
  text: string,
  mentions: readonly ComposerDraftMention[],
): { text: string; mentions: ComposerDraftMention[]; valid: boolean } {
  const trimmed = trimPromptMentions(text, mentions);
  return {
    text: trimmed.text,
    mentions: trimmed.attachments,
    valid: trimmed.attachments.length === mentions.length,
  };
}

export function removeComposerMention(
  text: string,
  mentions: readonly ComposerDraftMention[],
  id: string,
  fallbackCaret: number,
): { text: string; mentions: ComposerDraftMention[]; caret: number } | null {
  const removed = mentions.find((item) => item.id === id);
  if (!removed) return null;
  const valid = mentionSpanIsValid(text, removed.mention);
  const { start, end } = removed.mention;
  const nextText = valid ? text.slice(0, start) + text.slice(end) : text;
  const remaining = mentions.filter((item) => item.id !== id);
  const nextMentions = valid ? trackMentionEdits(text, nextText, remaining) : remaining;
  return {
    text: nextText,
    mentions: nextMentions,
    caret: Math.min(valid ? start : fallbackCaret, nextText.length),
  };
}

/** Save a session's next draft revision without disturbing any other session. */
export function updateComposerDraft(
  store: SessionComposerDrafts,
  sessionID: string,
  content: ComposerDraftContent,
): Map<string, ComposerDraft> {
  const current = getComposerDraft(store, sessionID);
  const next = new Map(store);
  next.set(sessionID, { ...content, revision: current.revision + 1 });
  return next;
}

/** Clear only the exact revision submitted; stale completions cannot erase newer work. */
export function clearComposerDraftIfRevision(
  store: SessionComposerDrafts,
  sessionID: string,
  submittedRevision: number,
): SessionComposerDrafts {
  const current = getComposerDraft(store, sessionID);
  if (current.revision !== submittedRevision) return store;
  const next = new Map(store);
  next.set(sessionID, { ...EMPTY_DRAFT, revision: current.revision + 1 });
  return next;
}
