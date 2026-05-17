// Feature 028 — sanitized reader for `WorkflowRun.phaseBreakpoints`.
//
// Mirrors the no-cache settings-accessor pattern used elsewhere
// (`VerboseDiagnosticsAccessor`, `FatalSignaturesAccessor`,
// `AutoCompactOverrideAccessor`, `ManualPauseAccessor`). The accessor is
// invoked at the top of every `PhaseRunner.run()` (and at any other phase
// dispatch boundary) so a breakpoint added via the sidebar mid-run applies
// to the very next phase invocation without any state-projector rebuild.
//
// The accessor reads breakpoints from the live `WorkflowRun` retrieved via
// the injected `getRun` thunk. The thunk MUST return the current run
// snapshot (typically `WorkspaceStateStore.getRun()`); caching it on the
// PhaseRunner would defeat the no-cache invariant.

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
 * via the supplied `getRun` thunk on every call.
 */
export function createPhaseBreakpointAccessor(
  getRun: () => WorkflowRun | null
): PhaseBreakpointAccessor {
  return {
    readBreakpointPhaseIds(runId: string): ReadonlySet<string> {
      const run = getRun();
      if (run === null || run.id !== runId) return EMPTY;
      const ids = new Set<string>();
      for (const bp of run.phaseBreakpoints) ids.add(bp.phaseId);
      return ids;
    }
  };
}

const EMPTY: ReadonlySet<string> = new Set();
