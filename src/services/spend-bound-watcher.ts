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
import { effectiveRunnerKindForPhase } from '../config/pipeline-snapshot';
import { spendDenominationOf } from '../contracts/backend-spend-denomination';
import type { SanitizedLogger } from '../lib/logger';
import { isTerminalRunStatus, type WorkflowRun } from '../state/workflow-run';
import type { SpendReplay } from './spend-bound-replay';
import {
  accumulateSpend,
  effectiveSpendBound,
  evaluateSpend,
  NO_SPEND_OBSERVED,
  spendPauseMessage,
  type SpendBoundConfig,
  type SpendDenomination,
  type RunSpendTotal
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
  /**
   * Rebuild the tally from the restart replay and mark each Run complete or incomplete by the
   * replay's verdict; called once, by the wiring. Never rejects.
   */
  readonly seedFrom: (replay: Promise<SpendReplay>) => Promise<void>;
  /** Observed spend for a run, for the disclosure and for tests. */
  readonly observedFor: (runId: string) => RunSpendTotal;
  /** Drop a finished run's tally, its paused flag and its notice keys. */
  readonly forget: (runId: string) => void;
  /**
   * Whether the bound in `denomination` can be trusted for this run right now (contract E1 G3):
   * `not-trustworthy` while the figure in that denomination has never been observed or the total is
   * only a lower bound.
   */
  readonly trustFor: (runId: string, denomination: SpendDenomination) => 'enforced' | 'not-trustworthy';
}

/**
 * Runs whose tallies are retained.
 *
 * Bounded, because a host outlives many runs and an unbounded map keyed by run id
 * is a leak that grows with use. Eviction takes a run that is terminal or no longer in the store
 * first, oldest-first among those, and only when every tracked run is still live does it take the
 * oldest of them (FR-R4-F02, contract S2 G9): a run that loses its tally is measured from that
 * point on, which understates spend rather than fabricating it. A restart no longer empties a
 * live run's tally: the seed rebuilds it from the audit log's last window (FR-R3-209).
 */
const MAX_TRACKED_RUNS = 64;

/**
 * The separator of a notice key. A run id never contains it, so `${runId}${SEP}${denomination}`
 * cannot collide with another run's key, and `forget(runId)` can drop a run's keys by prefix.
 * Written as an escape; the file is scanned for a raw control character.
 */
const NOTICE_KEY_SEPARATOR = '\u0000';

const UNIT_LABEL: Readonly<Record<SpendDenomination, string>> = {
  usd: 'USD',
  tokens: 'tokens'
};

export function createSpendBoundWatcher(deps: SpendBoundWatcherDeps): SpendBoundWatcher {
  const observed = new Map<string, RunSpendTotal>();
  /** Runs already paused for spend, so one crossing produces one pause. */
  const paused = new Set<string>();
  /**
   * While a seed is pending, the ids of the `phase-end` rows the live handler folds, so the seed
   * does not fold them again. Null when no seed is pending.
   */
  let liveDuringSeed: Set<string> | null = null;
  /**
   * The ids the seed folded, each consumed by its live notice. The audit writer notifies after
   * the write and the file's close settle, so a row the seed read can be notified after the seed
   * finished. Bounded by the window, and no timer empties it, because a timer at wiring time is a
   * producer act (FR-R3-136).
   */
  const seeded = new Set<string>();
  /**
   * `(runId, denomination)` keys already reported. In memory only, so a reload may report a run
   * once more (SC-011), and it lives as long as the watcher: once per run per denomination per
   * host session (FR-030).
   */
  const notified = new Set<string>();
  /**
   * Live runs whose tally was dropped to stay under `MAX_TRACKED_RUNS`. Their next row re-creates
   * the tally as `incomplete('evicted')` (contract S2 G9), because what was dropped is not coming
   * back. Cleared with the run's other state at its terminal transition.
   */
  const evicted = new Set<string>();

  const forget = (runId: string): void => {
    observed.delete(runId);
    paused.delete(runId);
    evicted.delete(runId);
    const prefix = `${runId}${NOTICE_KEY_SEPARATOR}`;
    for (const key of [...notified]) {
      if (key.startsWith(prefix)) notified.delete(key);
    }
  };

  /** A run that no longer needs its tally: gone from the store, or already terminal. */
  const isFinished = (runId: string): boolean => {
    const found = deps.findRunById(runId);
    return found === null || isTerminalRunStatus(found.run.status);
  };

  /** The tracked run to drop: the oldest finished one, else the oldest of all. */
  const evictionVictim = (): string | null => {
    let oldest: string | null = null;
    for (const runId of observed.keys()) {
      if (oldest === null) oldest = runId;
      if (isFinished(runId)) return runId;
    }
    return oldest;
  };

  const remember = (runId: string, spend: RunSpendTotal): void => {
    observed.set(runId, spend);
    while (observed.size > MAX_TRACKED_RUNS) {
      const victim = evictionVictim();
      if (victim === null) break;
      const live = !isFinished(victim);
      forget(victim);
      if (live) evicted.add(victim);
    }
  };

  /**
   * FR-R4-F02 (contract S3 G10) — tell the operator, once per `(run, denomination)`, that this
   * run's spend cannot be measured or confirmed. One notice naming the unit and the reason class
   * and no amount, and one log line with a reason code, a denomination and a reason: never a line
   * per row, which is what this replaces.
   */
  const reportOnce = (
    runId: string,
    verdict: Extract<ReturnType<typeof evaluateSpend>, { kind: 'unmeasurable' | 'incomplete' }>
  ): void => {
    const key = `${runId}${NOTICE_KEY_SEPARATOR}${verdict.denomination}`;
    if (notified.has(key)) return;
    notified.add(key);
    const unit = UNIT_LABEL[verdict.denomination];
    deps.notify(
      verdict.kind === 'unmeasurable'
        ? `Schegent cannot measure this run's spend in ${unit}: the usage is not reported by this backend, so its spend bound is not being enforced.`
        : `Schegent cannot confirm this run's spend in ${unit}: the history is incomplete, so the total shown is a lower bound.`
    );
    deps.logger.warn('spend bound: cannot measure', {
      reasonCode: verdict.kind === 'unmeasurable' ? 'spend-unmeasurable' : 'spend-incomplete',
      denomination: verdict.denomination,
      reason: verdict.reason
    });
  };

  /** Where a row's fold starts: the run's tally, or nothing, or what an eviction left of it. */
  const baseTotal = (runId: string): RunSpendTotal => {
    const known = observed.get(runId);
    if (known !== undefined) return known;
    if (!evicted.delete(runId)) return NO_SPEND_OBSERVED;
    return { ...NO_SPEND_OBSERVED, completeness: { kind: 'incomplete', reason: 'evicted' } };
  };

  const onAuditEntry = (entry: AuditEntry): void => {
    if (entry.eventType !== 'phase-end') return;
    // `AuditEntry.runId` is typed as a string, so the only unusable value it can hold is the
    // empty one — a run-less entry, which no bound applies to.
    const runId = entry.runId;
    if (runId === '') return;
    if (seeded.delete(entry.id)) return;
    liveDuringSeed?.add(entry.id);

    const spend = accumulateSpend(baseTotal(runId), entry.payload, entry.id);
    remember(runId, spend);
    if (paused.has(runId)) return;

    const found = deps.findRunById(runId);
    if (found === null) return;
    // Already pausing for some other reason: an operator pause, a breakpoint, a
    // delayed retry. Stamping over it would replace the cause the resume path reads
    // with this one, and the run would resume by the wrong door.
    if (found.run.manualPauseAt !== null) return;

    // The phase whose `phase-end` this is, not the one the Run reads now: the Run may already have
    // advanced to a phase on another backend, and the figures belong to the one that just ended.
    const endedPhase = found.run.pipeline?.phases.find((phase) => phase.id === entry.phase);
    const denomination = spendDenominationOf(
      effectiveRunnerKindForPhase(endedPhase, found.run.defaultRunnerKind)
    );
    const verdict = evaluateSpend(spend, effectiveSpendBound(deps.config(), endedPhase), denomination);
    if (verdict.kind === 'unmeasurable' || verdict.kind === 'incomplete') {
      reportOnce(runId, verdict);
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

  const seedFrom = async (replay: Promise<SpendReplay>): Promise<void> => {
    liveDuringSeed = new Set();
    let read: SpendReplay;
    try {
      read = await replay;
    } catch {
      // The reader never rejects; this is for a caller's promise. No replay is the unseeded state.
      read = { rows: [], completeness: new Map() };
    }
    const foldedLive = liveDuringSeed;
    liveDuringSeed = null;

    for (const entry of read.rows) {
      if (entry.eventType !== 'phase-end' || entry.runId === '' || foldedLive.has(entry.id)) {
        continue;
      }
      const found = deps.findRunById(entry.runId);
      if (found === null || isTerminalRunStatus(found.run.status)) continue;

      remember(entry.runId, accumulateSpend(baseTotal(entry.runId), entry.payload, entry.id));
      seeded.add(entry.id);
      if (found.run.manualPauseCause === 'spend-bound-reached') paused.add(entry.runId);
    }

    // A Run's completeness is the replay's verdict (contract S4 G16). A complete verdict is the
    // default and needs no entry; an incomplete one is recorded even for a Run with no rows, so
    // the live rows that follow are added to a total that already says it is a lower bound. A Run
    // the replay never covered is not in the map and is not created.
    for (const [runId, completeness] of read.completeness) {
      if (completeness.kind === 'complete') continue;
      const found = deps.findRunById(runId);
      if (found === null || isTerminalRunStatus(found.run.status)) continue;
      remember(runId, { ...baseTotal(runId), completeness });
    }
  };

  return {
    onAuditEntry,
    seedFrom,
    observedFor: (runId) => observed.get(runId) ?? NO_SPEND_OBSERVED,
    forget,
    trustFor: (runId, denomination) => {
      const total = observed.get(runId) ?? NO_SPEND_OBSERVED;
      const figure = denomination === 'usd' ? total.costUsd : total.totalTokens;
      return figure === undefined || total.completeness.kind === 'incomplete'
        ? 'not-trustworthy'
        : 'enforced';
    }
  };
}
