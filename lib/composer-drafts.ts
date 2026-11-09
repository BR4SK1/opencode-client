import {
  mentionSpanIsValid,
  trackMentionEdits,
  trimPromptMentions,
  type MentionCandidate,
  type MentionDescriptor,
  type MentionSpan,
} from "./prompt-mentions";
import {
  prepareComposerImages,
  type ComposerImage,
} from "./prompt-images";

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
  images: ComposerImage[];
  /** Stable OpenCode message ID retained across retries until the draft is edited or accepted. */
  clientMessageID?: string;
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

const EMPTY_DRAFT: ComposerDraft = { text: "", mentions: [], images: [], revision: 0 };

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

/**
 * What the composer should do with a keydown. There is deliberately no "send"
 * action, and Enter is deliberately absent from every branch: the visible Send
 * button is the only way to submit, and Enter — with any modifiers, during IME
 * composition, and whether attachment candidates are loading or visible —
 * always maps to "default", letting the textarea insert its native newline.
 * Attachment candidates are chosen by tap or Tab only.
 */
export type ComposerKeyAction =
  | { type: "default" }
  | { type: "select-candidate" }
  | { type: "move-candidate"; delta: 1 | -1 }
  | { type: "dismiss-mention" };

export interface ComposerKeyInput {
  key: string;
  isComposing: boolean;
  hasActiveMention: boolean;
  candidateCount: number;
  /** Modifier state is part of the contract so tests can pin that no
   * modifier combination changes Enter's outcome; no branch consults it. */
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

export function resolveComposerKeyAction(input: ComposerKeyInput): ComposerKeyAction {
  if (input.isComposing) return { type: "default" };
  if (input.hasActiveMention && input.candidateCount > 0) {
    if (input.key === "ArrowDown") return { type: "move-candidate", delta: 1 };
    if (input.key === "ArrowUp") return { type: "move-candidate", delta: -1 };
    if (input.key === "Tab") return { type: "select-candidate" };
  }
  if (input.key === "Escape" && input.hasActiveMention) return { type: "dismiss-mention" };
  return { type: "default" };
}

export function getComposerDraft(store: SessionComposerDrafts, sessionID: string): ComposerDraft {
  return store.get(sessionID) ?? EMPTY_DRAFT;
}

export function prepareComposerDraftSubmission(
  text: string,
  mentions: readonly ComposerDraftMention[],
  images: readonly ComposerImage[] = [],
): { text: string; mentions: ComposerDraftMention[]; images: ComposerImage[]; valid: boolean } {
  const trimmed = trimPromptMentions(text, mentions);
  const preparedImages = prepareComposerImages(text, images);
  return {
    text: trimmed.text,
    mentions: trimmed.attachments,
    images: preparedImages.images,
    valid: trimmed.attachments.length === mentions.length && preparedImages.valid,
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
