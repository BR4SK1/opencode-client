import { describe, expect, it } from "vitest";
import { stopFailureNotice } from "./stop-error";

describe("stop failure notices", () => {
  it("offers interrupt-only guidance only when shell preview failed", () => {
    expect(stopFailureNotice("preview", "network unavailable")).toContain("interrupt-only request");
    expect(stopFailureNotice("preview", "network unavailable")).toContain("no shell will be removed without verified ownership");
  });

  it("reports execution failures as unknown outcomes without suggesting another stop remains available", () => {
    const notice = stopFailureNotice("execution", "connection closed");
    expect(notice).toContain("outcome is unknown");
    expect(notice).toContain("retrying may race");
    expect(notice).not.toContain("You can still submit an interrupt-only request");
  });
});
