import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  isVisibleRelativePath,
  type MentionCandidate,
  type PromptMentionAttachment,
} from "./prompt-mentions";

export interface MentionCatalogClient {
  file: {
    find(input: { query: string; location: { directory: string }; limit?: number }): Promise<{
      data: Array<{ path: string; type: "file" | "directory" }>;
    }>;
    list(input: { location: { directory: string } }): Promise<{
      data: Array<{ path: string; type: "file" | "directory" }>;
    }>;
  };
  reference: {
    list(input: { location: { directory: string } }): Promise<{
      data: Array<{ name: string; path: string; description?: string; hidden?: boolean }>;
    }>;
  };
}

function isVisibleReference(reference: { name: string; hidden?: boolean }): boolean {
  return !reference.hidden && Boolean(reference.name) && !reference.name.startsWith(".");
}

function displayName(value: string): string {
  return value.split("/").filter(Boolean).at(-1) ?? value;
}

/** Search only the given session's OpenCode location and visible configured references. */
export async function listMentionCandidates(
  client: MentionCatalogClient,
  location: { directory: string },
  query: string,
): Promise<MentionCandidate[]> {
  const needle = query.trim();
  const [entries, references] = await Promise.all([
    needle
      ? client.file.find({ query: needle, location, limit: 50 }).then((result) => result.data)
      : client.file.list({ location }).then((result) => result.data),
    client.reference.list({ location }).then((result) => result.data),
  ]);

  const files: MentionCandidate[] = entries.flatMap((entry) => {
    if (!isVisibleRelativePath(entry.path)) return [];
    if (entry.type !== "file" && entry.type !== "directory") return [];
    return [{
      kind: entry.type,
      path: entry.path,
      label: entry.path,
      name: displayName(entry.path),
    }];
  });

  const normalizedNeedle = needle.toLocaleLowerCase();
  const refs: MentionCandidate[] = references.flatMap((reference) => {
    if (!isVisibleReference(reference)) return [];
    if (normalizedNeedle && !reference.name.toLocaleLowerCase().includes(normalizedNeedle)) return [];
    return [{
      kind: "reference",
      alias: reference.name,
      label: reference.name,
      name: reference.name,
    }];
  });

  // Keep identical labels with different kinds: a file, a directory, and a
  // reference alias can all legitimately collide and must remain distinguishable.
  // Reserve up to ten slots for references so a large file result set cannot hide all of them.
  const visibleReferenceCount = Math.min(refs.length, 10);
  return [...files.slice(0, 60 - visibleReferenceCount), ...refs.slice(0, visibleReferenceCount)];
}

export interface ResolvedPromptFile {
  uri: string;
  name: string;
  mention: PromptMentionAttachment["mention"];
}

/**
 * Re-resolve every client descriptor through the session-location APIs before
 * building a file: URI. No browser-supplied URL or reference root is trusted.
 */
export async function resolvePromptFiles(
  client: MentionCatalogClient,
  location: { directory: string },
  attachments: PromptMentionAttachment[],
): Promise<ResolvedPromptFile[] | null> {
  const output: ResolvedPromptFile[] = [];
  const references = attachments.some((item) => item.descriptor.kind === "reference")
    ? await client.reference.list({ location }).then((result) => result.data)
    : [];

  for (const attachment of attachments) {
    const { descriptor, mention } = attachment;
    if (descriptor.kind === "reference") {
      const matches = references.filter((item) => isVisibleReference(item) && item.name === descriptor.alias);
      if (matches.length !== 1 || mention.text !== `@${descriptor.alias}`) return null;
      const reference = matches[0];
      if (!path.isAbsolute(reference.path)) return null;
      output.push({ uri: pathToFileURL(reference.path).href, name: reference.name, mention });
      continue;
    }

    if (!isVisibleRelativePath(descriptor.path) || mention.text !== `@${descriptor.path}`) return null;
    let result = await client.file.find({ query: descriptor.path, location, limit: 100 });
    let matches = result.data.filter(
      (item) => item.path === descriptor.path && item.type === descriptor.kind,
    );
    if (matches.length === 0) {
      const basename = displayName(descriptor.path);
      if (basename !== descriptor.path) {
        result = await client.file.find({ query: basename, location, limit: 100 });
        matches = result.data.filter(
          (item) => item.path === descriptor.path && item.type === descriptor.kind,
        );
      }
    }
    if (matches.length !== 1) return null;

    // The OpenCode API returns location-relative paths. Keep the resulting URL
    // lexically within that location; symlink confinement is owned by OpenCode.
    const absolutePath = path.resolve(location.directory, descriptor.path);
    const relative = path.relative(path.resolve(location.directory), absolutePath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;

    output.push({ uri: pathToFileURL(absolutePath).href, name: displayName(descriptor.path), mention });
  }

  return output;
}
