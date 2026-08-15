// Feature 093 (T038) — the single site that decides which Run a control that
// did not name one is talking about.
//
// Window-level affordances — the "Cancel", "Resume", and "Retry" palette
// commands, and the phase controls the webview posts without a queue id — used
// to read the one `WorkflowRun` slot and act on whatever was in it. Under a
// per-queue run record there can be several, and the honest answer to "which
// one did the operator mean?" is often that it is unknown.
//
// So this resolver never picks. It answers with the *unique* Run matching the
// caller's predicate, or it refuses:
//
//   - no match          → `no-run-in-flight`, there is nothing to act on;
//   - exactly one match → that Run and the queue it executes on;
//   - several matches   → `ambiguous-run-target`, the caller must name a target.
//
// Guessing is the failure mode worth designing against: a cancel, a resume, or
// a breakpoint applied to a Run the operator was not looking at is silent and
// destructive, whereas a refusal is visible and recoverable. Callers that *can*
// name a target (a Task id, an explicit queue id) resolve it directly and never
// come here.
//
// Through phases C and D of this feature the record holds at most one entry, so
// every call below is byte-for-byte the previous behavior; the refusal branch
// only becomes reachable once drain step 4b is deleted (T081).

import { isOperableRunStatus, type WorkflowRun } from '../state/workflow-run';

/** Why a control with no named target could not be resolved to one Run. */
export type SoleRunRefusal = 'no-run-in-flight' | 'ambiguous-run-target';

export type SoleRunTarget =
  | { readonly ok: true; readonly queueId: string; readonly run: WorkflowRun }
  | { readonly ok: false; readonly reason: SoleRunRefusal };

/**
 * Resolve the one Run in `runs` that satisfies `matches`, or refuse.
 *
 * `runs` is the whole run record — the aggregate read SC-012 exempts. The Run
 * that comes back is still addressed by its queue, which is returned alongside
 * it so the caller writes back to the queue it read from rather than a derived
 * one.
 */
export function resolveSoleRun(
  runs: Readonly<Record<string, WorkflowRun>>,
  matches: (run: WorkflowRun) => boolean = () => true
): SoleRunTarget {
  let found: { queueId: string; run: WorkflowRun } | null = null;
  for (const [queueId, run] of Object.entries(runs)) {
    if (!matches(run)) continue;
    if (found !== null) return { ok: false, reason: 'ambiguous-run-target' };
    found = { queueId, run };
  }
  return found === null
    ? { ok: false, reason: 'no-run-in-flight' }
    : { ok: true, queueId: found.queueId, run: found.run };
}

/** The queue a control acts on, or why it could not be resolved to one. */
export type ControlTarget =
  | { readonly ok: true; readonly queueId: string }
  | { readonly ok: false; readonly reason: SoleRunRefusal };

/**
 * Feature 093 (T035/T036) — the one place a control that did not name a queue
 * is given one.
 *
 * The controller's phase controls are reached from the webview and the command
 * palette, neither of which carries a `queueId` yet; the payload gains one in
 * the US4 phase (T079/T080) and each caller becomes explicit then. Until it
 * does, this resolves the *unambiguous* case and refuses the ambiguous one — on
 * the same terms, and in the same vocabulary, as `resolveSoleRun` above, which
 * it delegates to precisely so the palette commands and the phase controls
 * cannot drift apart on what "ambiguous" means.
 *
 * It lives here rather than on the controller because the rule is about the run
 * record, not about the controller: the same question is asked by every surface
 * that can act on a Run without naming one.
 *
 * The predicate is **not** the default. Finished Runs stay in the record — only
 * `clearAll` ever calls `setRun(queueId, null)`, and an ordinary completion
 * writes the end status back so the finished pipeline still renders. Under one
 * slot that was invisible; under a map, a queue that has *ever* finished a Task
 * keeps an entry forever. Resolving with the default `() => true` therefore
 * counted history: two queues, one live and one that completed last week, and
 * every unaddressed phase control refused `ambiguous-run-target` — permanently,
 * in any workspace where a second queue had ever run. The palette commands in
 * `activation/ui-wiring.ts` say they refuse "when N are in flight", and
 * `isOperableRunStatus` is what makes that sentence true.
 *
 * It is deliberately **not** `!isTerminalRunStatus`, which was the first repair
 * and was wrong. That oracle counts `failed`, and three suites said so
 * immediately: `skipPhase` on a failed phase wakes the pipeline, and
 * `retryPhaseNow` reports `not-pending-retry` rather than `no-active-run`. Both
 * controls exist largely for failed Runs, so excluding them refused the very
 * operations the operator reaches for after a failure. `workflow-run.ts` now
 * carries both predicates side by side with the distinction spelled out:
 * terminality is about releasing the lease and the session, operability is about
 * what the operator can still reach. A **paused** Run is neither finished nor
 * uncontrollable and stays resolvable, which is what resume depends on.
 */
export function resolveControlTarget(
  explicit: string | undefined,
  runs: Readonly<Record<string, WorkflowRun>>
): ControlTarget {
  if (explicit !== undefined) return { ok: true, queueId: explicit };
  const sole = resolveSoleRun(runs, (run) => isOperableRunStatus(run.status));
  return sole.ok ? { ok: true, queueId: sole.queueId } : { ok: false, reason: sole.reason };
}
