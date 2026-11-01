import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MENTION_SEARCH_DEBOUNCE_MS,
  sameMentionRequest,
  scheduleMentionSearch,
  type MentionSearchHost,
  type MentionSearchRequest,
} from "./mention-search";
import type { MentionCandidate } from "./prompt-mentions";

const request = (over: Partial<MentionSearchRequest> = {}): MentionSearchRequest => ({
  sessionID: "s1",
  start: 0,
  end: 5,
  query: "docs",
  ...over,
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain the scheduler's promise chain without touching faked macrotask timers. */
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

interface Harness {
  live: MentionSearchRequest | null;
  fetches: Array<{ url: string; deferred: Deferred<{ candidates?: unknown }> }>;
  applied: MentionCandidate[][];
  errors: number;
  host: MentionSearchHost;
}

function makeHarness(): Harness {
  const harness: Harness = {
    live: null,
    fetches: [],
    applied: [],
    errors: 0,
    host: {
      currentRequest: () => harness.live,
      fetchMentionCandidates: (url) => {
        const d = deferred<{ candidates?: unknown }>();
        harness.fetches.push({ url, deferred: d });
        return d.promise;
      },
      applyResults: (rows) => harness.applied.push(rows),
      applyError: () => {
        harness.errors += 1;
      },
    },
  };
  return harness;
}

const reference = { kind: "reference", alias: "docs", label: "docs", name: "docs" } as const;

describe("mention search race guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies filtered results when the request is still current", async () => {
    const harness = makeHarness();
    harness.live = request();
    const cancel = scheduleMentionSearch(harness.host, request());

    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS);
    expect(harness.fetches).toHaveLength(1);
    expect(harness.fetches[0]?.url).toBe("/api/sessions/s1/mentions?q=docs");

    harness.fetches[0]?.deferred.resolve({ candidates: [reference, { nope: true }, null] });
    await flush();
    expect(harness.applied).toEqual([[reference]]);
    expect(harness.errors).toBe(0);
    cancel();
  });

  it("discards a response that arrives after the query changed (pre-cleanup window)", async () => {
    const harness = makeHarness();
    const stale = request({ query: "doc" });
    harness.live = stale;
    const cancel = scheduleMentionSearch(harness.host, stale);

    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS);
    expect(harness.fetches).toHaveLength(1);

    // The user keeps typing before any effect cleanup runs; the response for
    // the old query resolves in that window and must never be applied.
    harness.live = request({ query: "docs", end: 6 });
    harness.fetches[0]?.deferred.resolve({ candidates: [reference] });
    await flush();
    expect(harness.applied).toEqual([]);
    expect(harness.errors).toBe(0);
    cancel();
  });

  it("discards a response after whitespace terminates the search", async () => {
    const harness = makeHarness();
    harness.live = request();
    const cancel = scheduleMentionSearch(harness.host, request());

    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS);
    expect(harness.fetches).toHaveLength(1);

    // Whitespace set the live request to null synchronously; the in-flight
    // response must not reopen the menu.
    harness.live = null;
    harness.fetches[0]?.deferred.resolve({ candidates: [reference] });
    await flush();
    expect(harness.applied).toEqual([]);
    expect(harness.errors).toBe(0);
    cancel();
  });

  it("discards a response after the session changes", async () => {
    const harness = makeHarness();
    harness.live = request();
    const cancel = scheduleMentionSearch(harness.host, request());

    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS);
    harness.live = request({ sessionID: "s2" });
    harness.fetches[0]?.deferred.resolve({ candidates: [reference] });
    await flush();
    expect(harness.applied).toEqual([]);
    cancel();
  });

  it("does not initiate a fetch when the request is superseded during the debounce window", () => {
    const harness = makeHarness();
    harness.live = request();
    const cancel = scheduleMentionSearch(harness.host, request());

    harness.live = request({ query: "docsx", end: 6 });
    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS + 100);
    expect(harness.fetches).toHaveLength(0);
    expect(harness.applied).toEqual([]);
    cancel();
  });

  it("cancel prevents fetch initiation and blocks late response application", async () => {
    const harness = makeHarness();
    harness.live = request();
    const cancel = scheduleMentionSearch(harness.host, request());

    cancel();
    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS + 100);
    expect(harness.fetches).toHaveLength(0);

    // In-flight variant: fetch started, then cancelled; a late resolution is
    // still blocked by the abort check even though the live request matches.
    const late = makeHarness();
    late.live = request();
    const lateCancel = scheduleMentionSearch(late.host, request());
    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS);
    expect(late.fetches).toHaveLength(1);
    lateCancel();
    late.fetches[0]?.deferred.resolve({ candidates: [reference] });
    await flush();
    expect(late.applied).toEqual([]);
  });

  it("applies errors only while the request is current", async () => {
    const harness = makeHarness();
    harness.live = request();
    const cancel = scheduleMentionSearch(harness.host, request());

    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS);
    harness.fetches[0]?.deferred.reject(new Error("Search failed"));
    await flush();
    expect(harness.errors).toBe(1);

    const superseded = makeHarness();
    superseded.live = request();
    const supersededCancel = scheduleMentionSearch(superseded.host, request());
    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS);
    superseded.live = null;
    superseded.fetches[0]?.deferred.reject(new Error("Search failed"));
    await flush();
    expect(superseded.errors).toBe(0);
    supersededCancel();
    cancel();
  });
});

describe("sameMentionRequest", () => {
  it("matches only on identical session, span, and query", () => {
    const base = request();
    expect(sameMentionRequest(base, request())).toBe(true);
    expect(sameMentionRequest(null, base)).toBe(false);
    expect(sameMentionRequest(base, null)).toBe(false);
    expect(sameMentionRequest(base, request({ sessionID: "s2" }))).toBe(false);
    expect(sameMentionRequest(base, request({ start: 1 }))).toBe(false);
    expect(sameMentionRequest(base, request({ end: 6 }))).toBe(false);
    expect(sameMentionRequest(base, request({ query: "doc" }))).toBe(false);
  });
});
