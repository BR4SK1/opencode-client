import { requireAuth } from "@/lib/api-auth";
import { opencode } from "@/lib/opencode";
import { readBoundedRequestText, RequestBodyTooLargeError } from "@/lib/bounded-request";

export const dynamic = "force-dynamic";

const MAX_STOP_REQUEST_BYTES = 16 * 1024;

interface StopShell {
  id: string;
  command: string;
  cwd: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/**
 * Shells are location-scoped in OpenCode. A shell is considered owned by this
 * session only when its durable session log records the corresponding start
 * event and has no later end event for that shell ID.
 */
async function ownedRunningShells(sessionID: string): Promise<StopShell[]> {
  const session = await opencode.session.get({ sessionID });
  const location = session.location;
  const started = new Set<string>();

  for await (const item of opencode.session.log({ sessionID })) {
    const event = record(item);
    const data = record(event.data);
    if (event.type !== "session.shell.started" && event.type !== "session.shell.ended") continue;
    const shell = record(data.shell);
    const shellID = typeof shell.id === "string" ? shell.id : "";
    if (!shellID || data.sessionID !== sessionID) continue;
    if (event.type === "session.shell.started") started.add(shellID);
    else started.delete(shellID);
  }

  const listed = await opencode.shell.list({
    location: { directory: location.directory },
  });
  return listed.data.flatMap((shell) =>
    shell.status === "running" && started.has(shell.id)
      ? [{ id: shell.id, command: shell.command, cwd: shell.cwd }]
      : [],
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  try {
    const shells = await ownedRunningShells(id);
    return Response.json({ sessionID: id, shells, shellDiscovery: "verified" });
  } catch (error) {
    console.error("OpenCode stop preview failed:", error);
    // Interruption remains available even if shell ownership cannot be
    // established. Never guess based on a matching command or working folder.
    return Response.json({
      sessionID: id,
      shells: [],
      shellDiscovery: "unavailable",
    });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readBoundedRequestText(request, MAX_STOP_REQUEST_BYTES));
  } catch (error) {
    return Response.json(
      { error: error instanceof RequestBodyTooLargeError ? "Stop request is too large" : "Invalid JSON body" },
      { status: 400 },
    );
  }
  const body = record(decoded);
  if (!Array.isArray(body.removeShellIDs) || body.removeShellIDs.some((value) => typeof value !== "string")) {
    return Response.json({ error: "removeShellIDs must be an array of shell IDs" }, { status: 400 });
  }
  const requestedShellIDs = [...new Set(body.removeShellIDs as string[])];

  let interrupt: "interrupted" | "not-running" | "failed" = "failed";
  let interruptError: string | undefined;
  try {
    const result = await opencode.session.interrupt({ sessionID: id });
    interrupt = result.interrupted ? "interrupted" : "not-running";
  } catch (error) {
    interruptError = error instanceof Error ? error.message : "Interrupt request failed";
  }

  let verifiedShells: StopShell[] = [];
  let shellDiscovery: "verified" | "unavailable" = "verified";
  try {
    // Re-check ownership and running state immediately before deletion. This
    // narrows (but cannot eliminate) the race with shell completion/reuse.
    verifiedShells = await ownedRunningShells(id);
  } catch (error) {
    shellDiscovery = "unavailable";
    console.error("OpenCode shell ownership recheck failed:", error);
  }

  const verifiedByID = new Map(verifiedShells.map((shell) => [shell.id, shell]));
  const removedShells: string[] = [];
  const failedShells: Array<{ id: string; error: string }> = [];
  for (const shellID of requestedShellIDs) {
    if (!verifiedByID.has(shellID)) continue;
    try {
      const session = await opencode.session.get({ sessionID: id });
      await opencode.shell.remove({
        id: shellID,
        location: { directory: session.location.directory },
      });
      removedShells.push(shellID);
    } catch (error) {
      failedShells.push({
        id: shellID,
        error: error instanceof Error ? error.message : "Shell removal failed",
      });
    }
  }

  const unverifiedShellIDs = requestedShellIDs.filter((shellID) => !verifiedByID.has(shellID));
  return Response.json({
    sessionID: id,
    interrupt,
    ...(interruptError ? { interruptError } : {}),
    shellDiscovery,
    removedShells,
    failedShells,
    unverifiedShellIDs,
    parentState: "unknown",
    note: "An accepted interrupt does not confirm that the parent is idle. Removing a shell may race with completion or wake the child before the interrupt settles. Queued prompts are preserved and may start later work.",
  });
}
