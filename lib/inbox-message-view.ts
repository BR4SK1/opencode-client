import { mapHistoryImageFiles } from "./prompt-images";
import { resolveClientMessageText } from "./client-message-text";

export interface InboxUserMessageVM {
  kind: "user";
  id: string;
  text: string;
  time?: number;
  clientMessageID?: string;
  images: Array<{ src: string; name: string }>;
  queued: true;
  imageWarning?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Map pending user items, including image-only prompts and visible preview-limit warnings. */
export function buildInboxUserMessages(value: unknown): InboxUserMessageVM[] {
  if (!Array.isArray(value)) return [];
  const result: InboxUserMessageVM[] = [];
  for (const raw of value) {
    const item = record(raw);
    if (item.type !== "user") continue;
    const payload = record(item.payload);
    const id = string(item.id);
    if (!id) continue;
    const metadata = record(payload.metadata);
    const text = resolveClientMessageText(payload.text, metadata, id);
    const mapped = mapHistoryImageFiles(payload.files, id);
    const files = Array.isArray(payload.files) ? payload.files : [];
    if (!text.trim() && mapped.images.length === 0 && mapped.omittedCount === 0 && files.length === 0) continue;
    const created = Number(record(item.time).created) || Number(item.created) || undefined;
    const unsupportedFileCount = Math.max(0, files.length - mapped.images.length - mapped.omittedCount);
    const warnings = [
      mapped.omittedCount > 0
        ? `${mapped.omittedCount} image${mapped.omittedCount === 1 ? " was" : "s were"} not previewed (invalid data or preview size limit).`
        : "",
      unsupportedFileCount > 0 ? `${unsupportedFileCount} attachment${unsupportedFileCount === 1 ? " is" : "s are"} not previewable here.` : "",
    ].filter(Boolean);
    result.push({
      kind: "user",
      id: `inbox-${id}`,
      text,
      time: created,
      clientMessageID: string(metadata.opencodeClientMessageID) || undefined,
      images: mapped.images.map(({ src, name }) => ({ src, name })),
      queued: true,
      ...(warnings.length > 0 ? { imageWarning: warnings.join(" ") } : {}),
    });
  }
  return result;
}

export interface MessageSnapshotLike {
  kind: string;
  id: string;
  clientMessageID?: string;
  queued?: boolean;
  time?: number;
  text?: string;
  images?: Array<{ src: string; name: string }>;
}

function canonicalUserMessageID(message: MessageSnapshotLike): string | undefined {
  if (message.kind !== "user") return undefined;
  return message.id.startsWith("inbox-") ? message.id.slice("inbox-".length) : message.id;
}

function messageKey(message: MessageSnapshotLike): string {
  return `${message.kind}:${canonicalUserMessageID(message) ?? message.id}`;
}

export function sortMessageSnapshot<T extends MessageSnapshotLike>(messages: T[]): T[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => (a.message.time ?? 0) - (b.message.time ?? 0) || a.index - b.index)
    .map(({ message }) => message);
}

/** Merge durable history over equivalent inbox/optimistic user entries by OpenCode message ID. */
export function mergeMessageSnapshots<T extends MessageSnapshotLike>(existing: T[], incoming: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const message of existing) byKey.set(messageKey(message), message);
  for (const message of incoming) {
    if (message.kind === "user" && message.clientMessageID) {
      for (const [key, current] of byKey) {
        if (current.kind === "user" && current.clientMessageID === message.clientMessageID && key !== messageKey(message)) {
          byKey.delete(key);
        }
      }
    }
    byKey.set(messageKey(message), message);
  }
  return sortMessageSnapshot(Array.from(byKey.values()));
}

/**
 * Apply a successful pending-inbox snapshot as authoritative. Keep in-flight local
 * optimistic sends (not yet acknowledged by the prompt endpoint), but remove stale
 * queued entries omitted from the snapshot. On inbox failure, retain old entries.
 */
export function reconcileMessageSnapshot<T extends MessageSnapshotLike>(
  existing: T[],
  incoming: T[],
  inboxSnapshotSucceeded: boolean,
): T[] {
  if (!inboxSnapshotSucceeded) return mergeMessageSnapshots(existing, incoming);
  const incomingUsers = incoming.filter((message) => message.kind === "user");
  const retained = existing.filter((message) => {
    if (message.kind !== "user" || !message.queued) return true;
    const sameID = incomingUsers.some((candidate) => messageKey(candidate) === messageKey(message));
    const sameClientID = Boolean(message.clientMessageID && incomingUsers.some((candidate) => candidate.clientMessageID === message.clientMessageID));
    return sameID || sameClientID;
  });
  return mergeMessageSnapshots(retained, incoming);
}
