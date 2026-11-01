import type { MentionCandidate } from "./prompt-mentions";

/**
 * Identity of one in-flight mention search: the session, the @ span, and the
 * query it was issued for. A response may only be applied when the composer's
 * live request is still this exact request.
 */
export interface MentionSearchRequest {
  sessionID: string;
  start: number;
  end: number;
  query: string;
}

/** Two requests match only when session, span, and query all match. */
export function sameMentionRequest(
  a: MentionSearchRequest | null,
  b: MentionSearchRequest | null,
): boolean {
  return Boolean(
    a &&
      b &&
      a.sessionID === b.sessionID &&
      a.start === b.start &&
      a.end === b.end &&
      a.query === b.query,
  );
}

export const MENTION_SEARCH_DEBOUNCE_MS = 180;

export interface MentionSearchHost {
  /**
   * The request the composer currently wants results for, or null when no
   * search is active (e.g. whitespace terminated it). Must reflect uncommitted
   * state synchronously — this is what closes the gap before effect cleanup.
   */
  currentRequest: () => MentionSearchRequest | null;
  fetchMentionCandidates: (
    url: string,
    signal: AbortSignal,
  ) => Promise<{ candidates?: unknown }>;
  applyResults: (rows: MentionCandidate[]) => void;
  applyError: () => void;
}

function candidateRows(value: { candidates?: unknown }): MentionCandidate[] {
  if (!Array.isArray(value.candidates)) return [];
  return value.candidates.filter((item): item is MentionCandidate => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Partial<MentionCandidate>;
    return (
      (candidate.kind === "file" || candidate.kind === "directory" || candidate.kind === "reference") &&
      typeof candidate.label === "string" &&
      typeof candidate.name === "string" &&
      (candidate.kind === "reference" ? typeof candidate.alias === "string" : typeof candidate.path === "string")
    );
  });
}

/**
 * Debounce-guarded mention search. Every checkpoint — timer fire, fetch
 * initiation, result application, and error application — re-validates the
 * live request synchronously via host.currentRequest(), so a response for a
 * superseded query (caret moved, whitespace terminated the search, session
 * changed) can never be applied, even in the window before the caller's
 * passive-effect cleanup runs. The returned cancel still aborts the
 * controller as belt-and-braces for unmount.
 */
export function scheduleMentionSearch(
  host: MentionSearchHost,
  request: MentionSearchRequest,
): () => void {
  const controller = new AbortController();
  const isCurrent = () =>
    !controller.signal.aborted && sameMentionRequest(host.currentRequest(), request);

  const timer = setTimeout(() => {
    if (!isCurrent()) {
      controller.abort();
      return;
    }
    const url = `/api/sessions/${encodeURIComponent(request.sessionID)}/mentions?q=${encodeURIComponent(request.query)}`;
    void host
      .fetchMentionCandidates(url, controller.signal)
      .then((result) => {
        if (!isCurrent()) return;
        host.applyResults(candidateRows(result));
      })
      .catch(() => {
        if (!isCurrent()) return;
        host.applyError();
      });
  }, MENTION_SEARCH_DEBOUNCE_MS);

  return () => {
    clearTimeout(timer);
    controller.abort();
  };
}
