/** Metadata fields used to keep web-authored message text separate from prompt context. */
export const CLIENT_MESSAGE_ID_METADATA_KEY = "opencodeClientMessageID";
export const CLIENT_MESSAGE_ORIGINAL_TEXT_METADATA_KEY = "opencodeClientOriginalText";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/**
 * Prefer the authenticated web client's original user-authored text only when
 * it is attached to the same durable message ID. Other/legacy clients keep
 * their message text verbatim, and metadata for a different message cannot
 * replace it.
 */
export function resolveClientMessageText(
  text: unknown,
  metadataValue: unknown,
  messageID: unknown,
): string {
  const fallback = typeof text === "string" ? text : "";
  const id = typeof messageID === "string" ? messageID : "";
  if (!id) return fallback;

  const metadata = record(metadataValue);
  if (
    metadata[CLIENT_MESSAGE_ID_METADATA_KEY] !== id ||
    typeof metadata[CLIENT_MESSAGE_ORIGINAL_TEXT_METADATA_KEY] !== "string"
  ) {
    return fallback;
  }
  return metadata[CLIENT_MESSAGE_ORIGINAL_TEXT_METADATA_KEY];
}
