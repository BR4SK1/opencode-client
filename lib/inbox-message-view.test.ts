import { describe, expect, it } from "vitest";
import {
  buildInboxUserMessages,
  mergeMessageSnapshots,
  reconcileMessageSnapshot,
  type MessageSnapshotLike,
} from "./inbox-message-view";

const pending = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  sessionID: "session-a",
  type: "user",
  time: { created: 10 },
  payload: { text, files: [], ...extra },
});

const vm = (value: Partial<MessageSnapshotLike> & Pick<MessageSnapshotLike, "id" | "kind">): MessageSnapshotLike => value;

describe("inbox message views and reconciliation", () => {
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

  it("does not prune old pending entries when inbox reconciliation fails", () => {
    const existing = [vm({ kind: "user", id: "inbox-msg_pending", text: "pending", queued: true })];
    expect(reconcileMessageSnapshot(existing, [], false)).toEqual(existing);
  });
});
