// Feature 028 — sanitized reader for `WorkflowRun.phaseBreakpoints`.
//
// Mirrors the no-cache settings-accessor pattern used elsewhere
// (`VerboseDiagnosticsAccessor`, `FatalSignaturesAccessor`,
// `AutoCompactOverrideAccessor`, `ManualPauseAccessor`). The accessor is
// invoked at the top of every `PhaseRunner.run()` (and at any other phase
// dispatch boundary) so a breakpoint added via the sidebar mid-run applies
// to the very next phase invocation without any state-projector rebuild.
//
// The accessor reads breakpoints from the live `WorkflowRun` returned by the
// injected `resolveRun` resolver. The resolver MUST re-read state on every
// call; caching its result on the PhaseRunner would defeat the no-cache
// invariant.
//
// Feature 093 (T037) — the resolver is keyed by run id rather than being an
// ambient "the current run" thunk. This accessor's public method already names
// its target by identity, so the id it is handed is the whole address; what
// changed is that the binding site decides how to answer it. The window-level
// binding in `extension.ts` resolves against the whole run record — the C-4
// aggregate case SC-012 exempts — and it is the only binding.
//
// Feature 093 (T041, recorded deviation) — data-model §1.2 lists a per-queue
// `PhaseBreakpointAccessor` among a `RunSession`'s fields; the session does not
// hold one, and this is why. `PhaseRunner` is the accessor's only reader and is
// constructed once per window (`extension.ts`), so a session-held accessor has
// no consumer to reach: handing it to the runner would mean widening the shared
// `PhaseRunInputs` contract with a per-call override. It would also buy nothing
// — run ids are unique across queues, so resolving one against the whole record
// returns exactly what resolving it against its own queue would. A per-queue
// binding here would be a narrower address for a lookup that is already exact.
// The session's other three fields (`queueId`, `driver`, `isContinueGate`) each
// hold per-Run mutable state and are per-session for that reason.

import type { WorkflowRun } from '../state/workflow-run';

export interface PhaseBreakpointAccessor {
  /**
   * Returns the set of phase ids that currently have a one-shot breakpoint
   * armed on the given run. Empty set when the run is unknown / null.
   *
   * Invariants enforced by the workspace-state validator (see
   * `validateRunInvariants`):
   *   - Every returned phase id is in `pipeline.phases`.
   *   - No phase id appears in both `phaseBreakpoints` and `phaseOverrides`.
   *
   * Callers MUST NOT cache the returned set across iterations.
   */
  readBreakpointPhaseIds(runId: string): ReadonlySet<string>;
}

/**
 * Build a `PhaseBreakpointAccessor` that re-reads `WorkflowRun.phaseBreakpoints`
 * via the supplied `resolveRun` resolver on every call.
 */
export function createPhaseBreakpointAccessor(
  resolveRun: (runId: string) => WorkflowRun | null
): PhaseBreakpointAccessor {
  return {
    readBreakpointPhaseIds(runId: string): ReadonlySet<string> {
      const run = resolveRun(runId);
      if (run === null) return EMPTY;
      const ids = new Set<string>();
      for (const bp of run.phaseBreakpoints) ids.add(bp.phaseId);
      return ids;
    }
  };
}

const EMPTY: ReadonlySet<string> = new Set();
