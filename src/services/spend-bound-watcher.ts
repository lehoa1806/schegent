// FR-R3-112 (FR-119..FR-123) — the bound, wired to the pause it produces.
//
// WHY IT OBSERVES THE AUDIT LOG RATHER THAN SITTING IN THE DRIVE LOOP. The usage a
// bound must read is written to exactly one place: the `phase-end` audit entry, by
// `phase-runner.ts`, once per invocation, for all three backends. Reading it there
// makes the figure the bound acts on the SAME figure an operator reads and
// `npm run audit:verify` chains — a private accumulator could pause a run for spend
// the evidence does not show, or miss spend it does.
//
// WHY IT WRITES THE PAUSE PAIR AND NOTHING ELSE. `manualPauseAt` + `manualPauseCause`
// IS the operator-resumable pause: `PhaseControlService.pauseActivePhase` writes
// exactly that pair, `PhaseSequencer.decideAfterPhase` returns `pause-manual` when it
// sees the timestamp on the persisted snapshot, and `RunDriver` then performs the
// transition, the queue pause, the audit event and the status-bar update. This is that
// seam, used the way the operator's own control uses it — not a second pause
// mechanism. `RunDriver` needs no change, and the resume path already works because
// the cause joins a closed union the migrator and the projector both already read.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not cancel the child. The operator's pause
// does, because an operator asking for a pause wants the current turn to stop; a spend
// bound is observed at the boundary of a turn that has ALREADY completed and been paid
// for, and killing the next-to-nothing in flight would trade a recorded turn for a
// destroyed one. **The bound pauses; it never destroys** — no terminal transition, no
// cancel, no discarded work.
//
// TIMING, STATED HONESTLY. The stamp is written while the phase's own `phase-end`
// append is in flight, and the driver reads the persisted snapshot a few awaits later.
// In the ordinary case the pause takes effect at the boundary that recorded the
// crossing. If the store write lands after that read, it takes effect at the NEXT
// boundary — one phase of overshoot, never more, and never a pause in the middle of a
// phase. That is the same bound the design gives anyway: spend cannot be observed
// mid-turn, because no backend reports it until the turn ends.
import type { AuditEntry } from '../audit/audit-entry';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkflowRun } from '../state/workflow-run';
import {
  accumulateSpend,
  effectiveSpendBound,
  evaluateSpend,
  NO_SPEND_OBSERVED,
  spendPauseMessage,
  type SpendBoundConfig,
  type SpendObserved
} from './spend-bound';

export interface SpendBoundWatcherDeps {
  /** The workspace bound, re-read per evaluation so a settings change takes effect now. */
  readonly config: () => SpendBoundConfig;
  /** Resolve the run this entry belongs to, with the queue that owns it. */
  readonly findRunById: (
    runId: string
  ) => { readonly queueId: string; readonly run: WorkflowRun } | null;
  /** Persist the pause pair under the caller's execution fence. */
  readonly pause: (queueId: string, run: WorkflowRun) => Promise<void>;
  /** Operator-visible notice naming the bound and the measured spend. */
  readonly notify: (message: string) => void;
  readonly logger: SanitizedLogger;
  readonly now: () => number;
}

export interface SpendBoundWatcher {
  /** Subscribe this to `AuditLogWriter.subscribe`. */
  readonly onAuditEntry: (entry: AuditEntry) => void;
  /** Observed spend for a run, for the disclosure and for tests. */
  readonly observedFor: (runId: string) => SpendObserved;
  /** Drop a finished run's tally. */
  readonly forget: (runId: string) => void;
}

/**
 * Runs whose tallies are retained.
 *
 * Bounded, because a host outlives many runs and an unbounded map keyed by run id
 * is a leak that grows with use. Eviction is oldest-first and only matters for a run
 * that is no longer being driven: a run that loses its tally is measured from that
 * point on, which understates spend rather than fabricating it.
 */
const MAX_TRACKED_RUNS = 64;

export function createSpendBoundWatcher(deps: SpendBoundWatcherDeps): SpendBoundWatcher {
  const observed = new Map<string, SpendObserved>();
  /** Runs already paused for spend, so one crossing produces one pause. */
  const paused = new Set<string>();

  const forget = (runId: string): void => {
    observed.delete(runId);
    paused.delete(runId);
  };

  const remember = (runId: string, spend: SpendObserved): void => {
    observed.set(runId, spend);
    while (observed.size > MAX_TRACKED_RUNS) {
      const oldest = observed.keys().next();
      if (oldest.done === true) break;
      forget(oldest.value);
    }
  };

  const onAuditEntry = (entry: AuditEntry): void => {
    if (entry.eventType !== 'phase-end') return;
    // `AuditEntry.runId` is typed as a string, so the only unusable value it can hold is the
    // empty one — a run-less entry, which no bound applies to.
    const runId = entry.runId;
    if (runId === '') return;

    const spend = accumulateSpend(observed.get(runId) ?? NO_SPEND_OBSERVED, entry.payload);
    remember(runId, spend);
    if (paused.has(runId)) return;

    const found = deps.findRunById(runId);
    if (found === null) return;
    // Already pausing for some other reason: an operator pause, a breakpoint, a
    // delayed retry. Stamping over it would replace the cause the resume path reads
    // with this one, and the run would resume by the wrong door.
    if (found.run.manualPauseAt !== null) return;

    const bound = effectiveSpendBound(
      deps.config(),
      found.run.pipeline?.phases.find((phase) => phase.id === found.run.currentPhase)
    );
    const verdict = evaluateSpend(spend, bound);
    if (verdict.kind === 'unmeasurable') {
      deps.logger.warn(`spend bound: ${verdict.reason}`, { reasonCode: 'spend-unmeasurable' });
      return;
    }
    if (verdict.kind !== 'exceeded') return;

    paused.add(runId);
    const message = spendPauseMessage(verdict);
    void deps
      .pause(found.queueId, {
        ...found.run,
        manualPauseAt: deps.now(),
        manualPauseCause: 'spend-bound-reached'
      })
      .then(() => {
        deps.notify(message);
      })
      .catch((err: unknown) => {
        // The tally stands and the run keeps going. A failed pause write must not
        // also lose the reason it was attempted, so the retry is the next
        // `phase-end`: clearing the flag is what makes that retry happen.
        paused.delete(runId);
        deps.logger.warn(
          `spend bound: pause write failed, run continues: ${err instanceof Error ? err.message : 'unknown'}`,
          { reasonCode: 'spend-pause-write-failed' }
        );
      });
  };

  return {
    onAuditEntry,
    observedFor: (runId) => observed.get(runId) ?? NO_SPEND_OBSERVED,
    forget
  };
}
