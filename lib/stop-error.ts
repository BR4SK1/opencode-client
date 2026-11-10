export type StopFailureStage = "preview" | "execution";

export function stopFailureNotice(stage: StopFailureStage, detail: string): string {
  if (stage === "preview") {
    return `Could not inspect session-owned shells: ${detail}. You can still submit an interrupt-only request; no shell will be removed without verified ownership.`;
  }
  return `The stop request failed, so its outcome is unknown. The server may have received it; retrying may race with that request. Details: ${detail}`;
}
