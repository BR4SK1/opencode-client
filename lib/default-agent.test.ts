import { describe, expect, it } from "vitest";
import {
  createAgentDefaultCoordinator,
  DEFAULT_AGENT_ID,
  pickDefaultAgent,
  shouldApplyDefaultAgent,
} from "./default-agent";

/** Let pending microtasks (await chains) run without advancing timers. */
function flush(): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < 8; i++) p = p.then(() => {});
  return p;
}

describe("pickDefaultAgent", () => {
  it("returns the default agent id when it is selectable", () => {
    expect(
      pickDefaultAgent([
        { id: "general", mode: "subagent" },
        { id: "cal", mode: "primary", hidden: false },
        { id: "mark", mode: "primary" },
      ]),
    ).toBe(DEFAULT_AGENT_ID);
  });

  it("ignores hidden and subagent entries", () => {
    expect(pickDefaultAgent([{ id: "cal", mode: "subagent" }])).toBeUndefined();
    expect(
      pickDefaultAgent([{ id: "cal", mode: "primary", hidden: true }]),
    ).toBeUndefined();
  });

  it("is undefined when the agent is absent or the list is unknown", () => {
    expect(pickDefaultAgent([{ id: "mark", mode: "primary" }])).toBeUndefined();
    expect(pickDefaultAgent([])).toBeUndefined();
    expect(pickDefaultAgent(undefined)).toBeUndefined();
  });
});

describe("shouldApplyDefaultAgent", () => {
  const agents = [{ id: "cal", mode: "primary" }];

  it("applies only to agentless sessions with the default available", () => {
    expect(
      shouldApplyDefaultAgent({
        currentAgent: "",
        agents,
        alreadyAttempted: false,
        switchInProgress: false,
      }),
    ).toBe(true);
    expect(
      shouldApplyDefaultAgent({
        currentAgent: "   ",
        agents,
        alreadyAttempted: false,
        switchInProgress: false,
      }),
    ).toBe(true);
  });

  it("preserves an explicit agent selection", () => {
    expect(
      shouldApplyDefaultAgent({
        currentAgent: "mark",
        agents,
        alreadyAttempted: false,
        switchInProgress: false,
      }),
    ).toBe(false);
  });

  it("does not repeat and does not race an in-flight switch", () => {
    expect(
      shouldApplyDefaultAgent({
        currentAgent: "",
        agents,
        alreadyAttempted: true,
        switchInProgress: false,
      }),
    ).toBe(false);
    expect(
      shouldApplyDefaultAgent({
        currentAgent: "",
        agents,
        alreadyAttempted: false,
        switchInProgress: true,
      }),
    ).toBe(false);
  });

  it("requires the default agent to be selectable", () => {
    expect(
      shouldApplyDefaultAgent({
        currentAgent: "",
        agents: [{ id: "cal", hidden: true }],
        alreadyAttempted: false,
        switchInProgress: false,
      }),
    ).toBe(false);
    expect(
      shouldApplyDefaultAgent({
        currentAgent: "",
        agents: undefined,
        alreadyAttempted: false,
        switchInProgress: false,
      }),
    ).toBe(false);
  });
});

describe("createAgentDefaultCoordinator", () => {
  const selectableAgents = [{ id: "cal", mode: "primary" }];

  function note(
    coordinator: ReturnType<typeof createAgentDefaultCoordinator>,
    overrides: Partial<Parameters<typeof coordinator.noteAgentState>[0]> = {},
  ) {
    return coordinator.noteAgentState({
      sessionID: "s1",
      currentAgent: "",
      agents: selectableAgents,
      switchInProgress: false,
      ...overrides,
    });
  }

  it("resolves immediately when nothing is pending", async () => {
    const coordinator = createAgentDefaultCoordinator();
    expect(coordinator.defaultOutcome("s1")).toBeUndefined();
    await coordinator.whenAgentStateSettled("s1");
  });

  it("starts at most one default attempt for overlapping state fetches", () => {
    const coordinator = createAgentDefaultCoordinator();
    const first = note(coordinator);
    const second = note(coordinator);
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
  });

  it("does not start a default while a user switch is in flight", () => {
    const coordinator = createAgentDefaultCoordinator();
    expect(
      note(coordinator, { switchInProgress: true }),
    ).toBeUndefined();
    expect(coordinator.defaultOutcome("s1")).toBeUndefined();
  });

  it("unmarks a failed attempt so a later fetch retries with a fresh outcome", async () => {
    const coordinator = createAgentDefaultCoordinator();
    const first = note(coordinator);
    if (!first) throw new Error("expected a default attempt to start");
    const firstOutcome = coordinator.defaultOutcome("s1");
    first(false);
    await expect(firstOutcome).resolves.toBe(false);

    const retry = note(coordinator);
    if (!retry) throw new Error("expected a retry attempt to start");
    const retryOutcome = coordinator.defaultOutcome("s1");
    expect(retryOutcome).not.toBe(firstOutcome);
    retry(true);
    await expect(retryOutcome).resolves.toBe(true);
    // Applied: stays marked, so further fetches start nothing.
    expect(note(coordinator)).toBeUndefined();
  });

  it("ignores a duplicate settle and keeps the successful outcome", async () => {
    const coordinator = createAgentDefaultCoordinator();
    const settle = note(coordinator);
    if (!settle) throw new Error("expected a default attempt to start");
    const outcome = coordinator.defaultOutcome("s1");
    settle(true);
    settle(false);
    await expect(outcome).resolves.toBe(true);
    // A late awaiter (e.g. a user switch arriving afterwards) still sees it.
    await expect(coordinator.defaultOutcome("s1")).resolves.toBe(true);
  });

  it("applies an in-flight default before an explicit user switch is sent", async () => {
    const coordinator = createAgentDefaultCoordinator();
    const serverOrder: string[] = [];
    let releaseDefaultPost!: () => void;
    const defaultPostInFlight = new Promise<void>((resolve) => {
      releaseDefaultPost = resolve;
    });

    // fetchAgentState: agentless, Cal available — the coordinator marks and
    // starts the attempt, then settles the state fetch.
    const settleFetch = coordinator.beginStateFetch("s1");
    const startDefault = note(coordinator);
    if (!startDefault) throw new Error("expected a default attempt to start");
    settleFetch();

    // The component's default POST: lands server-side only when released.
    void (async () => {
      await defaultPostInFlight;
      serverOrder.push("default-applied");
      startDefault(true);
    })();

    // The user selects another agent while the default POST is in flight.
    // The component awaits the default outcome before sending the switch.
    const userSwitch = (async () => {
      await coordinator.defaultOutcome("s1");
      serverOrder.push("user-switch-sent");
    })();

    await flush();
    // Neither the default nor the switch has reached the server yet.
    expect(serverOrder).toEqual([]);

    releaseDefaultPost();
    await userSwitch;
    // The user's switch is sent strictly after the default was applied.
    expect(serverOrder).toEqual(["default-applied", "user-switch-sent"]);
  });

  it("holds a prompt sent during the state fetch until fetch and default settle", async () => {
    const coordinator = createAgentDefaultCoordinator();
    const order: string[] = [];
    const settleFetch = coordinator.beginStateFetch("s1");

    // The user sends while the agent-state fetch is still in flight.
    const promptSent = (async () => {
      await coordinator.whenAgentStateSettled("s1");
      order.push("prompt-sent");
    })();

    await flush();
    expect(order).toEqual([]);

    // The fetch returns: agentless, Cal available — the decision starts the
    // default before the fetch gate resolves, exactly as the component does.
    const startDefault = note(coordinator);
    if (!startDefault) throw new Error("expected a default attempt to start");
    settleFetch();

    await flush();
    expect(order).toEqual([]);

    startDefault(true);
    await promptSent;
    expect(order).toEqual(["prompt-sent"]);
  });

  it("holds a prompt until an in-flight default settles even after the fetch", async () => {
    const coordinator = createAgentDefaultCoordinator();
    const order: string[] = [];
    let releaseDefaultPost!: () => void;
    const defaultPostInFlight = new Promise<void>((resolve) => {
      releaseDefaultPost = resolve;
    });

    const settleFetch = coordinator.beginStateFetch("s1");
    const startDefault = note(coordinator);
    if (!startDefault) throw new Error("expected a default attempt to start");
    settleFetch();

    const promptSent = (async () => {
      await coordinator.whenAgentStateSettled("s1");
      order.push("prompt-sent");
    })();

    await flush();
    expect(order).toEqual([]);

    void (async () => {
      await defaultPostInFlight;
      startDefault(true);
    })();
    releaseDefaultPost();
    await promptSent;
    expect(order).toEqual(["prompt-sent"]);
  });

  it("does not hold prompts when the default agent is unavailable", async () => {
    const coordinator = createAgentDefaultCoordinator();
    const settleFetch = coordinator.beginStateFetch("s1");
    expect(
      coordinator.noteAgentState({
        sessionID: "s1",
        currentAgent: "",
        agents: [{ id: "mark", mode: "primary" }],
        switchInProgress: false,
      }),
    ).toBeUndefined();
    settleFetch();
    // No attempt was started, so the gate resolves with the fetch alone.
    await coordinator.whenAgentStateSettled("s1");
  });

  it("tracks sessions independently", async () => {
    const coordinator = createAgentDefaultCoordinator();
    const settleFetchA = coordinator.beginStateFetch("a");
    const startDefaultA = coordinator.noteAgentState({
      sessionID: "a",
      currentAgent: "",
      agents: selectableAgents,
      switchInProgress: false,
    });
    if (!startDefaultA) throw new Error("expected a default attempt to start");

    // Session b is unaffected by a's pending attempt and gate.
    const startDefaultB = coordinator.noteAgentState({
      sessionID: "b",
      currentAgent: "",
      agents: selectableAgents,
      switchInProgress: false,
    });
    if (!startDefaultB) throw new Error("expected a default attempt to start");
    const settleFetchB = coordinator.beginStateFetch("b");
    settleFetchB();
    startDefaultB(true);
    await coordinator.whenAgentStateSettled("b");

    settleFetchA();
    startDefaultA(true);
    await coordinator.whenAgentStateSettled("a");
  });
});
