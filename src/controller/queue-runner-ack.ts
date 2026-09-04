// FR-R3-150 (T1620) — the queue-scoped runner-ack probe for the queue-scoped
// Clean All orchestrator (`src/commands/clear-queue.ts`).
//
// Mirrors `clear-all.ts`'s workspace-wide `waitForRunnerStop`, addressed: it
// races `controller.isDriving(queueId)` against a bounded poll window
// instead of the workspace-wide `controller.running` getter, so cleaning
// one queue never waits on — or reports on — a sibling's still-executing
// Run. A separate module rather than a further addition to
// `workflow-controller.ts`: that file's own line budget
// (`tests/lint/source-loc-budget.test.ts`) is a frozen, shrink-only ceiling,
// and this probe's own logic has nothing to do with the controller's
// internals beyond the one addressed predicate it already exposes.
//
// HOW THAT PREDICATE WAS PAID FOR (2026-09-03). By the time this landed,
// `workflow-controller.ts` measured exactly its recorded 1040, so `isDriving`
// could not simply be added: `a listed file does not raise its own ceiling`
// (FR-R3-143 T056) forbids raising the number, and converting the entry to a
// waiver would have retired a live hard ceiling to buy one line. The gate's
// own first option was taken instead — the addition is size-negative. Two
// lines came back from work this feature made necessary anyway: the redundant
// explicit annotation on `cancelActive`'s `targets` (inferred identically),
// and the `running` getter's docstring, which had gone stale twice over — it
// named a consumer deleted by T081, and it called Clean All's runner-ack
// probe singular when FR-R3-150 had just split it into a workspace-wide and
// a queue-addressed one. Correcting it was owed regardless.
//
// So `isDriving` carries a one-line pointer rather than a docstring, and the
// reasoning about the two probes lives in `runner-ack-shared.ts` beside the
// budget they share. It is documented, just not on the method.

import type { SchegentWorkflowController } from './workflow-controller';
import { RUNNER_ACK_POLL_INTERVAL_MS, RUNNER_ACK_WINDOW_MS, sleep } from './runner-ack-shared';

export async function waitForQueueRunnerStop(
  controller: SchegentWorkflowController,
  queueId: string
): Promise<boolean> {
  const deadline = Date.now() + RUNNER_ACK_WINDOW_MS;
  while (Date.now() < deadline) {
    if (!controller.isDriving(queueId)) return true;
    await sleep(RUNNER_ACK_POLL_INTERVAL_MS);
  }
  return !controller.isDriving(queueId);
}
