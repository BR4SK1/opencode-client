/**
 * The agent every session in this client starts with. Sessions created here
 * are created with this agent, and sessions opened here that still have no
 * agent are defaulted to it once. An explicit agent selection within a session
 * is always preserved — the default only fills the empty case.
 */
export const DEFAULT_AGENT_ID = "cal";

/**
 * Minimal agent shape needed to decide availability. Fields are `unknown` so
 * both the raw server agent list and client agent-state records fit without
 * casting; `pickDefaultAgent` validates them.
 */
export interface DefaultAgentCandidate {
  id?: unknown;
  hidden?: unknown;
  mode?: unknown;
}

function isSelectable(agent: DefaultAgentCandidate): boolean {
  return (
    agent.id === DEFAULT_AGENT_ID &&
    agent.hidden !== true &&
    agent.mode !== "subagent"
  );
}

/**
 * The default agent id when it is selectable (present, visible, and not a
 * subagent) in the given list, otherwise undefined so callers fall back to
 * server-side behavior instead of stamping an agent the server cannot resolve.
 */
export function pickDefaultAgent(
  agents: readonly DefaultAgentCandidate[] | undefined,
): string | undefined {
  return (agents ?? []).some(isSelectable) ? DEFAULT_AGENT_ID : undefined;
}

export interface DefaultAgentDecision {
  /** The session's current agent id; empty means no agent selected yet. */
  currentAgent: string;
  /** Selectable agents for the session's location, when known. */
  agents?: readonly DefaultAgentCandidate[];
  /** The default was already applied (or is being applied) for this session. */
  alreadyAttempted: boolean;
  /** A user-initiated agent switch is in flight for this session. */
  switchInProgress: boolean;
}

/**
 * Whether opening a session should apply this client's default agent. Only
 * agentless sessions are defaulted, and never while an explicit switch is in
 * progress, so a user's choice always wins.
 */
export function shouldApplyDefaultAgent(input: DefaultAgentDecision): boolean {
  return (
    !input.switchInProgress &&
    !input.alreadyAttempted &&
    input.currentAgent.trim() === "" &&
    pickDefaultAgent(input.agents) !== undefined
  );
}

export interface AgentStateObservation {
  sessionID: string;
  /** The session's current agent id; empty means no agent selected yet. */
  currentAgent: string;
  /** Selectable agents for the session's location, when known. */
  agents?: readonly DefaultAgentCandidate[];
  /** A user-initiated agent switch is in flight for this session. */
  switchInProgress: boolean;
}

/**
 * Coordinates the automatic default agent across the asynchronous flows that
 * touch a session's agent: agent-state fetches, the default switch itself,
 * explicit user switches, and prompts.
 *
 * Guarantees:
 * - At most one automatic default attempt per session runs at a time; a failed
 *   attempt is unmarked so a later agent-state fetch retries it, and the
 *   outcome promise is replaced by the retry.
 * - An explicit user switch awaits `defaultOutcome` before sending its request,
 *   so it is applied strictly after any in-flight default and always wins.
 * - `whenAgentStateSettled` resolves only after the session's latest in-flight
 *   agent-state fetch has settled — its default decision included — and any
 *   default attempt has settled. Prompts await it so an agentless session's
 *   first prompt cannot run before the default is in effect. When the default
 *   agent is unavailable or its switch fails, it resolves anyway (the server's
 *   own configured default applies) rather than blocking prompts indefinitely.
 */
export interface AgentDefaultCoordinator {
  /**
   * Record a fetched agent state. Starts (and marks) the automatic default
   * when the state is agentless, the default agent is selectable, no attempt
   * is marked, and no user switch is in flight. Returns the settle callback
   * for the started attempt — call it with the outcome (true when the default
   * was applied) — or undefined when nothing was started.
   */
  noteAgentState(
    observation: AgentStateObservation,
  ): ((applied: boolean) => void) | undefined;
  /**
   * Outcome of the session's default attempt: true when it was applied, false
   * when it failed or was not applicable. Undefined when no attempt was ever
   * started. A settled promise stays readable so late awaiters (a user switch
   * or a prompt) observe the outcome without waiting.
   */
  defaultOutcome(sessionID: string): Promise<boolean> | undefined;
  /**
   * Register the session's latest in-flight agent-state fetch. Returns the
   * resolve callback; it must be called once the fetch has settled — after its
   * default decision, so a waiter cannot observe the pre-decision instant.
   */
  beginStateFetch(sessionID: string): () => void;
  /**
   * Resolves once the session's latest agent-state fetch has settled and any
   * default attempt has settled. Resolves immediately when nothing is pending.
   * A retry attempt started by a fetch that begins after a caller read the
   * gate is not awaited by that caller; it can only follow a failed earlier
   * attempt, where proceeding on the server's own default is already accepted.
   */
  whenAgentStateSettled(sessionID: string): Promise<void>;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export function createAgentDefaultCoordinator(): AgentDefaultCoordinator {
  // Sessions with a marked default attempt: running or successfully applied.
  const attempted = new Set<string>();
  // Latest default attempt per session; kept after settling so late awaiters
  // (a user switch, a prompt) observe the outcome. A retry replaces it.
  const outcomes = new Map<string, Promise<boolean>>();
  // Latest in-flight agent-state fetch per session; each fetch resolves its
  // own gate, so a waiter holds exactly the gate it read.
  const stateGates = new Map<string, Promise<void>>();

  return {
    noteAgentState: (observation) => {
      if (
        !shouldApplyDefaultAgent({
          currentAgent: observation.currentAgent,
          agents: observation.agents,
          alreadyAttempted: attempted.has(observation.sessionID),
          switchInProgress: observation.switchInProgress,
        })
      ) {
        return undefined;
      }
      attempted.add(observation.sessionID);
      const gate = deferred<boolean>();
      outcomes.set(observation.sessionID, gate.promise);
      let settled = false;
      return (applied) => {
        if (settled) return;
        settled = true;
        // A failure unmarks the attempt so the next agent-state fetch retries.
        if (!applied) attempted.delete(observation.sessionID);
        gate.resolve(applied);
      };
    },
    defaultOutcome: (sessionID) => outcomes.get(sessionID),
    beginStateFetch: (sessionID) => {
      const gate = deferred<void>();
      stateGates.set(sessionID, gate.promise);
      return gate.resolve;
    },
    whenAgentStateSettled: async (sessionID) => {
      // The state gate is resolved after its fetch's default decision, so the
      // outcome entry — if one was started — already exists here.
      await stateGates.get(sessionID);
      await outcomes.get(sessionID);
    },
  };
}
