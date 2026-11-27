// FR-R3-150 (code-review finding) — the pieces `runClearAll` (workspace-wide)
// and `runClearQueue` (queue-scoped) share, factored out so a change to the
// runner-ack budget or the runner-state vocabulary is made once rather than
// by hand in both orchestrators.
//
// This module is deliberately narrow: it holds only side-effect-free values
// and pure functions common to both scopes. The poll LOOP itself stays
// separate (`src/commands/clear-all.ts`'s `waitForRunnerStop` polls the
// workspace-wide `controller.running`; `src/controller/queue-runner-ack.ts`'s
// `waitForQueueRunnerStop` polls the addressed `controller.isDriving(queueId)`
// predicate) — the two check different things and folding them into one
// parameterized function would hide that at the call site.

// Bounded poll window from FR-007. The 2s budget is split across short
// poll intervals so a probe resolves promptly once the runner's
// `cancelActive()` propagates through the driver's own running flag.
export const RUNNER_ACK_WINDOW_MS = 2_000;
export const RUNNER_ACK_POLL_INTERVAL_MS = 25;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function deriveRunnerState(result: {
  inflightAborted: boolean;
  runnerAcked: boolean;
}): 'acked' | 'timed-out' | 'no-active-run' {
  if (!result.inflightAborted) return 'no-active-run';
  return result.runnerAcked ? 'acked' : 'timed-out';
}
