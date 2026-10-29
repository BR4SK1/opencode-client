import { describe, expect, it } from "vitest";
import {
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

  it("lists via the session location, filters hidden entries, and preserves type collisions", async () => {
    const location = { directory: "/session/root" };
    const calls: Array<{ kind: string; location: { directory: string }; query?: string }> = [];
    const client: MentionCatalogClient = {
      file: {
        find: async ({ query, location: scoped }) => {
          calls.push({ kind: "find", location: scoped, query });
          return { data: [
            { path: "README", type: "file" },
            { path: "README", type: "directory" },
            { path: ".hidden", type: "file" },
          ] };
        },
        list: async ({ location: scoped }) => {
          calls.push({ kind: "list", location: scoped });
          return { data: [{ path: "README", type: "file" }, { path: ".hidden", type: "directory" }] };
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
    expect(calls.every((call) => call.location === location)).toBe(true);
    expect(calls.find((call) => call.kind === "find")?.query).toBe("read");
    expect(candidates.map((item) => item.kind)).toEqual(["file", "directory", "reference"]);
    expect(candidates.every((item) => item.label === "README")).toBe(true);

    const rootCandidates = await listMentionCandidates(client, location, "");
    expect(calls.some((call) => call.kind === "list" && call.location === location)).toBe(true);
    expect(rootCandidates.some((item) => item.label.startsWith("."))).toBe(false);
  });

  it("keeps visible references represented when file results fill the candidate limit", async () => {
    const client: MentionCatalogClient = {
      file: {
        find: async () => ({ data: [] }),
        list: async () => ({ data: Array.from({ length: 80 }, (_, index) => ({ path: `file-${index}.ts`, type: "file" as const })) }),
      },
      reference: {
        list: async () => ({ data: [
          { name: "design-docs", path: "/refs/design" },
          { name: "api-docs", path: "/refs/api" },
        ] }),
      },
    };
    const candidates = await listMentionCandidates(client, { directory: "/project" }, "");
    expect(candidates).toHaveLength(60);
    expect(candidates.filter((candidate) => candidate.kind === "reference").map((candidate) => candidate.alias))
      .toEqual(["design-docs", "api-docs"]);
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
