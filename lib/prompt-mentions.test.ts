import { describe, expect, it } from "vitest";
import {
  findActiveMentionQuery,
  isSafeRelativePath,
  isVisibleRelativePath,
  mentionSpanIsValid,
  trackMentionEdits,
  trimPromptMentions,
  validatePromptMentions,
} from "./prompt-mentions";
import { listMentionCandidates, resolvePromptFiles, type MentionCatalogClient } from "./mention-catalog";

const mention = (text: string, start: number) => ({ start, end: start + text.length, text });

describe("prompt mention range tracking", () => {
  it("tracks UTF-16 offsets through emoji and edits before the mention", () => {
    const text = "😀 ask @src/file name.ts";
    const span = mention("@src/file", text.indexOf("@"));
    expect(text.slice(span.start, span.end)).toBe(span.text);
    expect(mentionSpanIsValid(text, span)).toBe(true);

    const next = `Please ${text}`;
    const [tracked] = trackMentionEdits(text, next, [{ mention: span }]);
    expect(tracked?.mention).toEqual(mention("@src/file", next.indexOf("@")));
  });

  it("invalidates mentions touched by insertion, replacement, or deletion", () => {
    const text = "use @a/b now";
    const selected = [{ key: "one", mention: mention("@a/b", 4) }];
    expect(trackMentionEdits(text, "use @z/b now", selected)).toEqual([]);
    expect(trackMentionEdits(text, "use @a/x/b now", selected)).toEqual([]);
    expect(trackMentionEdits(text, "use @a now", selected)).toEqual([]);
    const withAdjacentText = trackMentionEdits(text, "use @a/bx now", selected);
    expect(withAdjacentText).toHaveLength(1);
    expect(withAdjacentText[0]?.mention).toEqual(mention("@a/b", 4));
  });

  it("preserves duplicate attachments and adjusts their independent spans", () => {
    const text = "@src/a and @src/a";
    const padded = `  ${text}  `;
    const duplicate = { descriptor: { kind: "file" as const, path: "src/a" }, mention: mention("@src/a", 2) };
    const second = { descriptor: duplicate.descriptor, mention: mention("@src/a", 2 + text.lastIndexOf("@src/a")) };
    const result = trimPromptMentions(padded, [duplicate, second]);
    expect(result.text).toBe(text);
    expect(result.attachments.map((item) => item.mention.start)).toEqual([0, 11]);
    expect(result.attachments).toHaveLength(2);
  });

  it("trims exact spans and drops mentions trimmed out of the prompt", () => {
    const text = "  prompt @folder/  ";
    const span = mention("@folder/", 9);
    const result = trimPromptMentions(text, [{ mention: span }]);
    expect(result.text).toBe("prompt @folder/");
    expect(result.attachments[0]?.mention).toEqual(mention("@folder/", 7));
    expect(trimPromptMentions("   @folder/   ", [{ mention: mention("@folder/", 3) }]).attachments[0]?.mention.start).toBe(0);
  });
});

describe("active mention search termination", () => {
  const noMentions: { mention: { start: number; end: number; text: string } }[] = [];

  it("terminates the search on any whitespace in the query, including immediately after @", () => {
    // A space typed directly after "@" must not start a search.
    expect(findActiveMentionQuery("@ ", 2, noMentions)).toBeNull();
    expect(findActiveMentionQuery("@\t", 2, noMentions)).toBeNull();
    // A space anywhere between "@" and the caret terminates the search.
    expect(findActiveMentionQuery("@docs then", 10, noMentions)).toBeNull();
    expect(findActiveMentionQuery("@docs ", 6, noMentions)).toBeNull();
    expect(findActiveMentionQuery("@docs\tfoo", 9, noMentions)).toBeNull();
    expect(findActiveMentionQuery("see @docs and", 13, noMentions)).toBeNull();
  });

  it("still finds the active query when it contains no whitespace", () => {
    expect(findActiveMentionQuery("@", 1, noMentions)).toEqual({ start: 0, end: 1, query: "" });
    expect(findActiveMentionQuery("@docs", 5, noMentions)).toEqual({ start: 0, end: 5, query: "docs" });
    expect(findActiveMentionQuery("see @docs", 9, noMentions)).toEqual({ start: 4, end: 9, query: "docs" });
  });
});

describe("mention validation and session-location catalogue", () => {
  it("rejects traversal, browser URLs, malformed ranges, and forged aliases", () => {
    expect(isSafeRelativePath("src/file name.ts")).toBe(true);
    expect(isSafeRelativePath("../secret")).toBe(false);
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath("file:///etc/passwd")).toBe(false);
    expect(isVisibleRelativePath("src/.secret")).toBe(false);
    expect(isVisibleRelativePath("src/file.ts")).toBe(true);

    expect(validatePromptMentions("read @src/a", [{
      descriptor: { kind: "file", path: "../secret" },
      mention: mention("@src/a", 5),
    }])).toBeNull();
    expect(validatePromptMentions("read @src/a", [{
      descriptor: { kind: "reference", alias: "../secret" },
      mention: mention("@src/a", 5),
    }])).not.toBeNull();
    expect(validatePromptMentions("read @src/.secret", [{
      descriptor: { kind: "file", path: "src/.secret" },
      mention: mention("@src/.secret", 5),
    }])).toBeNull();
    expect(validatePromptMentions("read @src/a", [{
      descriptor: { kind: "file", path: "src/a" },
      mention: mention("@src/a", 4),
    }])).toBeNull();
  });

  it("lists references only via the session location and never searches project files", async () => {
    const location = { directory: "/session/root" };
    const calls: Array<{ kind: string; location: { directory: string }; query?: string }> = [];
    const client: MentionCatalogClient = {
      file: {
        find: async () => {
          throw new Error("file.find must not be called for mention candidates");
        },
        list: async () => {
          throw new Error("file.list must not be called for mention candidates");
        },
      },
      reference: {
        list: async ({ location: scoped }) => {
          calls.push({ kind: "reference", location: scoped });
          return { data: [
            { name: "README", path: "/references/readme" },
            { name: ".secret", path: "/references/secret" },
            { name: "private", path: "/references/private", hidden: true },
          ] };
        },
      },
    };

    const candidates = await listMentionCandidates(client, location, "read");
    expect(calls).toHaveLength(1);
    expect(calls.every((call) => call.location === location)).toBe(true);
    expect(candidates.map((item) => item.kind)).toEqual(["reference"]);
    expect(candidates.map((item) => item.label)).toEqual(["README"]);

    const rootCandidates = await listMentionCandidates(client, location, "");
    expect(calls).toHaveLength(2);
    expect(rootCandidates.every((item) => item.kind === "reference")).toBe(true);
    expect(rootCandidates.every((item) => item.label.startsWith("."))).toBe(false);
  });

  it("does not cap references by the file budget reserved for them", async () => {
    const client: MentionCatalogClient = {
      file: {
        find: async () => {
          throw new Error("file.find must not be called for mention candidates");
        },
        list: async () => {
          throw new Error("file.list must not be called for mention candidates");
        },
      },
      reference: {
        list: async () => ({
          data: Array.from({ length: 80 }, (_, index) => ({ name: `ref-${index}`, path: `/refs/${index}` })),
        }),
      },
    };
    const candidates = await listMentionCandidates(client, { directory: "/project" }, "");
    expect(candidates).toHaveLength(60);
    expect(candidates.every((candidate) => candidate.kind === "reference")).toBe(true);
  });

  it("re-resolves paths and aliases and emits structured file URLs with mention metadata", async () => {
    const location = { directory: "/project root" };
    const calls: Array<{ query?: string; location: { directory: string } }> = [];
    const client: MentionCatalogClient = {
      file: {
        find: async ({ query, location: scoped }) => {
          calls.push({ query, location: scoped });
          return { data: query === "space file.ts" ? [{ path: "dir/space file.ts", type: "file" }] : [] };
        },
        list: async () => ({ data: [] }),
      },
      reference: {
        list: async ({ location: scoped }) => {
          calls.push({ location: scoped });
          return { data: [{ name: "docs", path: "/reference roots/docs" }] };
        },
      },
    };

    const attachments = [
      { descriptor: { kind: "file" as const, path: "dir/space file.ts" }, mention: mention("@dir/space file.ts", 0) },
      { descriptor: { kind: "reference" as const, alias: "docs" }, mention: mention("@docs", 20) },
    ];
    const resolved = await resolvePromptFiles(client, location, attachments);
    expect(resolved).toHaveLength(2);
    expect(resolved?.[0]?.uri).toBe("file:///project%20root/dir/space%20file.ts");
    expect(resolved?.[0]?.mention).toEqual(attachments[0]?.mention);
    expect(resolved?.[1]?.uri).toBe("file:///reference%20roots/docs");
    expect(resolved?.[1]?.mention).toEqual(attachments[1]?.mention);
    expect(calls.every((call) => call.location === location)).toBe(true);
    expect(calls.some((call) => call.query === "dir/space file.ts")).toBe(true);
    expect(calls.some((call) => call.query === "space file.ts")).toBe(true);

    const hidden = await resolvePromptFiles(client, location, [
      { descriptor: { kind: "file", path: "dir/.secret" }, mention: mention("@dir/.secret", 0) },
    ]);
    expect(hidden).toBeNull();

    const forged = await resolvePromptFiles(client, location, [
      { descriptor: { kind: "file", path: "../outside" }, mention: mention("@../outside", 0) },
    ]);
    expect(forged).toBeNull();
    expect(calls).toHaveLength(3);
  });
});
