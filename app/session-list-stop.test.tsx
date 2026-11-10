import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@mui/material/styles";
import { describe, expect, it } from "vitest";
import theme from "./theme";
import { SubagentSessionRow } from "./components/SessionList";

const session = {
  id: "child-session",
  parentID: "parent-session",
  title: "Background worker",
  created: 1,
  updated: 2,
  agent: "worker",
};

function renderRow(status?: "running" | "waiting") {
  return renderToStaticMarkup(
    <ThemeProvider theme={theme}>
      <SubagentSessionRow
        session={session}
        status={status}
        pendingCount={0}
        active={false}
        onOpen={() => {}}
        onStop={() => {}}
      />
    </ThemeProvider>,
  );
}

describe("subagent row stop affordance", () => {
  it.each([
    ["running", "Processing"],
    ["waiting", "Needs input"],
    [undefined, undefined],
  ] as const)("remains available for %s sessions without changing status labels", (status, label) => {
    const html = renderRow(status);

    expect(html).toContain('aria-label="Stop or clean up subagent session: Background worker"');
    if (label) expect(html).toContain(label);
    else expect(html).not.toContain("Processing");
  });
});
