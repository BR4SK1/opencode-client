import { describe, expect, it } from "vitest";
import { findActiveMentionQuery } from "./prompt-mentions";
import {
  clearComposerDraftIfRevision,
  getComposerDraft,
  isSameDismissedMention,
  prepareComposerDraftSubmission,
  removeComposerMention,
  shouldBlockEnterDuringMentionSearch,
  updateComposerDraft,
  type SessionComposerDrafts,
} from "./composer-drafts";

const draftContent = (text: string) => ({ text, mentions: [] });

describe("per-session composer drafts", () => {
  it("keeps plain-text and attachment drafts isolated by session", () => {
    let drafts: SessionComposerDrafts = updateComposerDraft(new Map(), "session-a", draftContent("draft A"));
    drafts = updateComposerDraft(drafts, "session-b", draftContent("draft B"));
    expect(getComposerDraft(drafts, "session-a").text).toBe("draft A");
    expect(getComposerDraft(drafts, "session-b").text).toBe("draft B");
  });

  it("preserves selected attachment descriptors with the session draft", () => {
    const selected = {
      id: "mention-1",
      descriptor: { kind: "file" as const, path: "src/main.ts" },
      kind: "file" as const,
      label: "src/main.ts",
      mention: { start: 0, end: 12, text: "@src/main.ts" },
    };
    const drafts = updateComposerDraft(new Map(), "session-a", {
      text: "@src/main.ts",
      mentions: [selected],
    });
    expect(getComposerDraft(drafts, "session-a").mentions).toEqual([selected]);
  });

  it("reindexes remaining attachment spans when a chip is removed", () => {
    const text = "@a and @b";
    const mentions = [
      { id: "first", descriptor: { kind: "file" as const, path: "a" }, kind: "file" as const, label: "a", mention: { start: 0, end: 2, text: "@a" } },
      { id: "second", descriptor: { kind: "file" as const, path: "b" }, kind: "file" as const, label: "b", mention: { start: 7, end: 9, text: "@b" } },
    ];
    const removed = removeComposerMention(text, mentions, "first", 0);
    expect(removed?.text).toBe(" and @b");
    expect(removed?.mentions[0]?.mention).toEqual({ start: 5, end: 7, text: "@b" });
    expect(findActiveMentionQuery(removed!.text, removed!.text.length, removed!.mentions)).toBeNull();
    expect(findActiveMentionQuery(removed!.text, removed!.text.length, mentions)?.start).toBe(5);
  });

  it("removes a corrupted chip without deleting arbitrary draft text", () => {
    const result = removeComposerMention("leave this text", [
      { id: "bad", descriptor: { kind: "file", path: "a" }, kind: "file", label: "a", mention: { start: 90, end: 92, text: "@a" } },
    ], "bad", 4);
    expect(result).toEqual({ text: "leave this text", mentions: [], caret: 4 });
  });

  it("blocks submission instead of silently dropping a corrupted selected attachment", () => {
    const prepared = prepareComposerDraftSubmission("keep the draft", [
      { id: "bad", descriptor: { kind: "file", path: "a" }, kind: "file", label: "a", mention: { start: 90, end: 92, text: "@a" } },
    ]);
    expect(prepared.valid).toBe(false);
    expect(prepared.text).toBe("keep the draft");
    expect(prepared.mentions).toEqual([]);
  });

  it("does not let an old send completion clear a newer draft", () => {
    let drafts: SessionComposerDrafts = updateComposerDraft(new Map(), "session-a", draftContent("submitted"));
    const submittedRevision = getComposerDraft(drafts, "session-a").revision;
    drafts = updateComposerDraft(drafts, "session-a", draftContent("newer unsent text"));

    const afterStaleCompletion = clearComposerDraftIfRevision(drafts, "session-a", submittedRevision);
    expect(afterStaleCompletion).toBe(drafts);
    expect(getComposerDraft(afterStaleCompletion, "session-a").text).toBe("newer unsent text");
  });

  it("clears only the submitted session and revision", () => {
    let drafts: SessionComposerDrafts = updateComposerDraft(new Map(), "session-a", draftContent("sent"));
    drafts = updateComposerDraft(drafts, "session-b", draftContent("keep"));
    const revision = getComposerDraft(drafts, "session-a").revision;
    drafts = clearComposerDraftIfRevision(drafts, "session-a", revision);
    expect(getComposerDraft(drafts, "session-a").text).toBe("");
    expect(getComposerDraft(drafts, "session-b").text).toBe("keep");
  });

  it("keeps Escape dismissal on the same token but reactivates after token edits or caret movement", () => {
    const dismissed = { sessionID: "session-a", start: 4, query: "src/ma" };
    expect(isSameDismissedMention(dismissed, "session-a", { start: 4, query: "src/ma" })).toBe(true);
    expect(isSameDismissedMention(dismissed, "session-a", { start: 4, query: "src/main" })).toBe(false);
    expect(isSameDismissedMention(dismissed, "session-a", null)).toBe(false);
    expect(isSameDismissedMention(dismissed, "session-b", { start: 4, query: "src/ma" })).toBe(false);
  });

  it("blocks Enter from sending while the active mention search is loading", () => {
    expect(shouldBlockEnterDuringMentionSearch({ key: "Enter", shiftKey: false, hasActiveMention: true, mentionState: "loading" })).toBe(true);
    expect(shouldBlockEnterDuringMentionSearch({ key: "Enter", shiftKey: true, hasActiveMention: true, mentionState: "loading" })).toBe(false);
    expect(shouldBlockEnterDuringMentionSearch({ key: "Enter", shiftKey: false, hasActiveMention: false, mentionState: "loading" })).toBe(false);
    expect(shouldBlockEnterDuringMentionSearch({ key: "Enter", shiftKey: false, hasActiveMention: true, mentionState: "ready" })).toBe(false);
  });
});
