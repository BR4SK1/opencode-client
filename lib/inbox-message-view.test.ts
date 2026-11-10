import { describe, expect, it } from "vitest";
import {
  buildInboxUserMessages,
  mergeMessageSnapshots,
  reconcileMessageSnapshot,
  type MessageSnapshotLike,
} from "./inbox-message-view";
import { resolveClientMessageText } from "./client-message-text";

const pending = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  sessionID: "session-a",
  type: "user",
  time: { created: 10 },
  payload: { text, files: [], ...extra },
});

const vm = (value: Partial<MessageSnapshotLike> & Pick<MessageSnapshotLike, "id" | "kind">): MessageSnapshotLike => value;

describe("inbox message views and reconciliation", () => {
  it("shows web-authored text from metadata for queued messages without rendering prompt context", () => {
    const original = "Check this exact text: 😀\n  keep whitespace  ";
    const expanded = `${original}\n\n[web prompt context that is not user-authored]`;
    const result = buildInboxUserMessages([pending("msg_web", expanded, {
      metadata: {
        opencodeClientMessageID: "msg_web",
        opencodeClientOriginalText: original,
      },
    })]);

    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe(original);
    expect(result[0]?.text).not.toContain("web prompt context");
  });

  it("keeps inbox text verbatim for external, legacy, and mismatched-message metadata", () => {
    const external = "external client's actual text\n\nwith all content preserved";
    const result = buildInboxUserMessages([
      pending("msg_external", external),
      pending("msg_legacy", "legacy text with no metadata"),
      pending("msg_edited", "edited message content", {
        metadata: {
          opencodeClientMessageID: "msg_other",
          opencodeClientOriginalText: "stale original text",
        },
      }),
    ]);

    expect(result.map((message) => message.text)).toEqual([
      external,
      "legacy text with no metadata",
      "edited message content",
    ]);
  });

  it("includes image-only pending entries from clients without this app's metadata", () => {
    const result = buildInboxUserMessages([pending("msg_external", "", {
      files: [{ mime: "image/png", data: "iVBORw0KGgo=", name: "clipboard.png" }],
    })]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "inbox-msg_external",
      text: "",
      queued: true,
      images: [{ name: "clipboard.png", src: "data:image/png;base64,iVBORw0KGgo=" }],
    });
    expect(result[0]?.clientMessageID).toBeUndefined();
  });

  it("removes stale pending entries after a successful authoritative snapshot", () => {
    const existing = [
      vm({ kind: "user", id: "inbox-msg_cancelled", text: "cancelled", queued: true }),
      vm({ kind: "user", id: "msg_old", text: "history" }),
    ];
    const updated = reconcileMessageSnapshot(existing, [], true);
    expect(updated.map((message) => message.id)).toEqual(["msg_old"]);
  });

  it("retains in-flight optimistic sends across a snapshot race but removes acknowledged stale sends", () => {
    const optimistic = vm({
      kind: "user",
      id: "msg_local",
      clientMessageID: "msg_local",
      text: "still sending",
    });
    const accepted = vm({
      kind: "user",
      id: "msg_accepted",
      clientMessageID: "msg_accepted",
      text: "accepted but cancelled",
      queued: true,
    });
    expect(reconcileMessageSnapshot([optimistic], [], true)).toContain(optimistic);
    expect(reconcileMessageSnapshot([accepted], [], true)).toEqual([]);
  });

  it("deduplicates delivered inbox messages by OpenCode ID even without metadata", () => {
    const inbox = vm({ kind: "user", id: "inbox-msg_external", text: "from another client", queued: true });
    const delivered = vm({ kind: "user", id: "msg_external", text: "from another client" });
    const merged = mergeMessageSnapshots([inbox], [delivered]);
    expect(merged).toEqual([delivered]);
  });

  it("keeps the original web text when enriched delivered history replaces the optimistic bubble", () => {
    const original = "Summarize the attached content without losing this sentence.";
    const expanded = `${original}\n\n[web prompt context that is not user-authored]`;
    const messageID = "msg_web-history";
    const metadata = {
      opencodeClientMessageID: messageID,
      opencodeClientOriginalText: original,
    };
    const optimistic = vm({
      kind: "user",
      id: messageID,
      clientMessageID: messageID,
      text: original,
    });
    const delivered = vm({
      kind: "user",
      id: messageID,
      clientMessageID: messageID,
      text: resolveClientMessageText(expanded, metadata, messageID),
    });

    const merged = mergeMessageSnapshots([optimistic], [delivered]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe(original);
    expect(merged[0]?.text).not.toContain("web prompt context");
  });

  it("does not prune old pending entries when inbox reconciliation fails", () => {
    const existing = [vm({ kind: "user", id: "inbox-msg_pending", text: "pending", queued: true })];
    expect(reconcileMessageSnapshot(existing, [], false)).toEqual(existing);
  });
});
