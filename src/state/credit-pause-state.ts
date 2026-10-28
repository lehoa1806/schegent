// FR-R4-F02 (spec 240, data-model §3 and §4, contract W4; hard rules 7 and 28) — the persisted shape of
// a credit pause: the standing invariant, and the two defaults the v14 -> v15 step writes.
//
// All three are pure and take what the store already read, so the store keeps only what has to run
// inside its own serialized links: the one `update()` of each key. They live apart from
// `workspace-state.ts` for the reason the other migrators do: they decide nothing about the memento,
// and a reader of the store needs to know *that* they run, not their case analysis.
import { isRunStateMap, type RunStateMap } from './run-state-migrator';
import type { WatchdogState, WorkflowRun } from './workflow-run';

/**
 * Refuse a Run whose `creditPause` sits on a state it has no meaning in.
 *
 * A credit pause is one nullable object, so there is no half of it to leave behind, but it is only
 * meaningful on a Run paused for credits and on no other. Refusing the other shapes at every write
 * is what makes a clearing site that forgets `creditPause: null` throw instead of persisting a Run
 * two pause machineries both claim.
 */
export function assertCreditPauseShape(run: WorkflowRun): void {
  if (run.creditPause === null || run.creditPause === undefined) return;
  if (
    run.status === 'paused' &&
    run.pendingRetryAt === null &&
    run.pendingRetryCause === null &&
    run.manualPauseCause === null
  ) {
    return;
  }
  throw new Error(
    `WorkflowRun invariant violation: creditPause requires status 'paused' with no pending retry and no manual pause (got status '${run.status}', pendingRetryAt ${run.pendingRetryAt}, pendingRetryCause ${run.pendingRetryCause}, manualPauseCause ${run.manualPauseCause})`
  );
}

/** Refuse a watchdog record whose `lastPollOutcome` is not one of the three values it may hold. */
export function assertWatchdogShape(state: WatchdogState): void {
  const outcome: unknown = state.lastPollOutcome;
  if (outcome === undefined || outcome === null || outcome === 'not-recovered' || outcome === 'unreachable') {
    return;
  }
  throw new Error("WatchdogState invariant violation: lastPollOutcome must be 'not-recovered', 'unreachable' or null");
}

/** What the v14 -> v15 step has to write: each value is `null` when there is nothing to write. */
export interface CreditPauseMigration {
  readonly runs: RunStateMap | null;
  readonly watchdog: WatchdogState | null;
}

/**
 * The v14 -> v15 ladder step as a pure function over the two persisted values the store read.
 * Keyed on the shape of each record, never on the persisted number, so a second pass finds nothing
 * to write.
 */
export function migrateV14ToV15(rawRuns: unknown, rawWatchdog: unknown): CreditPauseMigration {
  return {
    runs: isRunStateMap(rawRuns) ? withCreditPauseDefault(rawRuns) : null,
    watchdog: withPollOutcomeDefault(rawWatchdog)
  };
}

/**
 * The Run map with an explicit `creditPause: null` on every Run that lacked the key, or `null`
 * when every Run already has one (so the caller writes nothing). A Run that has the key is kept by
 * reference, which is what makes a second pass find nothing to do.
 */
function withCreditPauseDefault(runs: RunStateMap): RunStateMap | null {
  const next: RunStateMap = {};
  let changed = false;
  for (const [queueId, run] of Object.entries(runs)) {
    if (run.creditPause !== undefined) {
      next[queueId] = run;
      continue;
    }
    next[queueId] = { ...run, creditPause: null };
    changed = true;
  }
  return changed ? next : null;
}

/**
 * The watchdog record with an explicit `lastPollOutcome: null`, or `null` when the persisted value
 * is not a record or already carries the key.
 */
function withPollOutcomeDefault(raw: unknown): WatchdogState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Partial<WatchdogState>;
  if (record.lastPollOutcome !== undefined) return null;
  return { ...record, lastPollOutcome: null } as WatchdogState;
}
