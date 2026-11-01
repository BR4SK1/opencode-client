import { describe, expect, it } from "vitest";
import { findActiveMentionQuery } from "./prompt-mentions";
import {
  clearComposerDraftIfRevision,
  getComposerDraft,
  isSameDismissedMention,
  prepareComposerDraftSubmission,
  removeComposerMention,
  resolveComposerKeyAction,
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

  it("Enter is never hijacked: it always resolves to the native newline", () => {
    // Enter appears in no branch of the resolver — there is no "send" or
    // "select-candidate" outcome for it under any state, modifier, or IME
    // condition. It must always fall through to the textarea's native
    // newline insertion.
    for (const input of [
      { key: "Enter", isComposing: false, hasActiveMention: false, candidateCount: 0 },
      { key: "Enter", isComposing: false, hasActiveMention: true, candidateCount: 0 },
      { key: "Enter", isComposing: false, hasActiveMention: true, candidateCount: 3 },
      { key: "Enter", isComposing: true, hasActiveMention: false, candidateCount: 0 },
      { key: "Enter", isComposing: true, hasActiveMention: true, candidateCount: 3 },
      // No modifier combination changes Enter's outcome.
      { key: "Enter", isComposing: false, hasActiveMention: false, candidateCount: 0, shiftKey: true },
      { key: "Enter", isComposing: false, hasActiveMention: true, candidateCount: 3, shiftKey: true },
      { key: "Enter", isComposing: false, hasActiveMention: true, candidateCount: 3, ctrlKey: true },
      { key: "Enter", isComposing: false, hasActiveMention: true, candidateCount: 3, metaKey: true },
      { key: "Enter", isComposing: false, hasActiveMention: true, candidateCount: 3, altKey: true },
      { key: "Enter", isComposing: false, hasActiveMention: true, candidateCount: 3, ctrlKey: true, shiftKey: true, altKey: true },
    ] as const) {
      expect(resolveComposerKeyAction(input), JSON.stringify(input)).toEqual({ type: "default" });
    }
  });

  it("keeps Tab-only keyboard selection when the candidate menu is open", () => {
    const base = { isComposing: false, hasActiveMention: true, candidateCount: 3 };
    expect(resolveComposerKeyAction({ ...base, key: "ArrowDown" })).toEqual({ type: "move-candidate", delta: 1 });
    expect(resolveComposerKeyAction({ ...base, key: "ArrowUp" })).toEqual({ type: "move-candidate", delta: -1 });
    expect(resolveComposerKeyAction({ ...base, key: "Tab" })).toEqual({ type: "select-candidate" });
    // Enter must not select, even with candidates visible.
    expect(resolveComposerKeyAction({ ...base, key: "Enter" })).toEqual({ type: "default" });
    // Without candidates the menu is not open: navigation keys behave normally.
    const noCandidates = { ...base, candidateCount: 0 };
    expect(resolveComposerKeyAction({ ...noCandidates, key: "ArrowDown" })).toEqual({ type: "default" });
    expect(resolveComposerKeyAction({ ...noCandidates, key: "Tab" })).toEqual({ type: "default" });
    // Composition input never hijacks keys while the IME is active.
    expect(resolveComposerKeyAction({ ...base, key: "ArrowDown", isComposing: true })).toEqual({ type: "default" });
    expect(resolveComposerKeyAction({ ...base, key: "Tab", isComposing: true })).toEqual({ type: "default" });
  });

  it("keeps Escape dismissing the mention menu", () => {
    expect(resolveComposerKeyAction({ key: "Escape", isComposing: false, hasActiveMention: true, candidateCount: 3 }))
      .toEqual({ type: "dismiss-mention" });
    expect(resolveComposerKeyAction({ key: "Escape", isComposing: false, hasActiveMention: true, candidateCount: 0 }))
      .toEqual({ type: "dismiss-mention" });
    expect(resolveComposerKeyAction({ key: "Escape", isComposing: false, hasActiveMention: false, candidateCount: 0 }))
      .toEqual({ type: "default" });
  });

  it("leaves every other key to the textarea", () => {
    for (const key of ["a", "Backspace", "ArrowLeft", "Shift", "Tab"]) {
      expect(resolveComposerKeyAction({ key, isComposing: false, hasActiveMention: false, candidateCount: 0 }))
        .toEqual({ type: "default" });
    }
  });
});
