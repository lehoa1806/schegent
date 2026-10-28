// FR-R3-112 (FR-119..FR-123) — the spend bound: it pauses, it never destroys, and it
// works in both denominations.
//
// WHAT EACH GROUP IS FOR, since four of the five would pass against a bound that only
// worked on `claude`:
//
//   1. THE SEAM (FR-119). An authored per-phase override is driven through the REAL
//      validator and the REAL catalog-to-PhaseDef conversion, and the value is asserted
//      where the bound reads it. This is the S7 shape the seam gate exists for: two
//      correct halves that never meet. A unit test on `effectiveSpendBound` alone would
//      pass with the field dropped at the conversion.
//   2. THE PAUSE (FR-120, FR-120a). The watcher's pause write is asserted to be the
//      operator-resumable pair with the new cause — the same pair
//      `PhaseControlService.pauseActivePhase` writes.
//   3. NO TERMINAL TRANSITION (FR-121). Asserted on the written record: status
//      untouched, no `endedAt`, nothing cleared.
//   4. MUTATION-VERIFIED (FR-120). The check is removed by handing the watcher a
//      config with no bound; the fixture then runs past its spend and no pause is
//      written. Restored, the same fixture pauses. Red then green, from one test.
//   5. TOKEN DENOMINATION (FR-122). A codex-shaped payload — tokens, and no cost field
//      at all — pauses identically on a token bound. A bound effective on one backend
//      only is the outcome this refuses.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { phaseDefinitionToPhaseDef } from '../../../src/config/process-catalog';
import { validatePhaseDefinition } from '../../../src/config/process-definition-validator';
import { SanitizedLogger } from '../../../src/lib/logger';
import { extractInvocationUsageMetrics } from '../../../src/parser/invocation-usage';
import {
  accumulateSpend,
  effectiveSpendBound,
  evaluateSpend,
  NO_SPEND_OBSERVED,
  spendPauseMessage,
  type RunSpendTotal
} from '../../../src/services/spend-bound';
import { createSpendBoundWatcher } from '../../../src/services/spend-bound-watcher';
import type { SpendReplay } from '../../../src/services/spend-bound-replay';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import type { WorkflowRun } from '../../../src/state/workflow-run';

const logger = new SanitizedLogger();

let rowCounter = 0;

/**
 * A `phase-end` entry shaped like the one `phase-runner.ts` actually appends. Each call gets its
 * OWN id: FR-R4-F02 (contract S2 G5) folds a row once per id, so a fixture that reused one id for
 * every row would be counting a single row however many it fed in.
 */
function phaseEnd(payload: Record<string, unknown>, runId = 'run-1'): AuditEntry {
  rowCounter += 1;
  return {
    id: `entry-${rowCounter}`,
    timestamp: '2026-08-27T00:00:00.000Z',
    runId,
    phase: 'implement',
    iteration: 1,
    eventType: 'phase-end',
    payload,
    outcome: 'success',
    schemaVersion: 1
  } as unknown as AuditEntry;
}

function runFixture(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    featureId: 'task-1',
    status: 'running',
    currentPhase: 'implement',
    currentIteration: 1,
    manualPauseAt: null,
    manualPauseCause: null,
    phasesCompleted: [],
    phaseOverrides: [],
    pendingRetryAt: null,
    pendingRetryCause: null,
    ...overrides
  } as unknown as WorkflowRun;
}

interface Written {
  readonly queueId: string;
  readonly run: WorkflowRun;
}

function watcherOver(
  config: { limitUsd: number | null; limitTokens: number | null },
  run: WorkflowRun = runFixture()
): { writes: Written[]; notices: string[]; watcher: ReturnType<typeof createSpendBoundWatcher> } {
  const writes: Written[] = [];
  const notices: string[] = [];
  const watcher = createSpendBoundWatcher({
    config: () => config,
    findRunById: (runId) => (runId === run.id ? { queueId: 'default', run } : null),
    pause: async (queueId, written) => {
      writes.push({ queueId, run: written });
    },
    notify: (message) => notices.push(message),
    logger,
    now: () => 1_700_000_000_000
  });
  return { writes, notices, watcher };
}

/** Let the watcher's awaited pause write settle; it is deliberately not blocking. */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('FR-119 — the authored per-phase override crosses the seam', () => {
  it('survives the validator and arrives on the PhaseDef the bound reads', () => {
    const validated = validatePhaseDefinition({
      phaseId: 'costly',
      name: 'Costly',
      version: 1,
      instruction: 'do the expensive thing',
      spendBoundUsd: 3.5,
      spendBoundTokens: 250_000
    });
    expect(validated.errors).toEqual([]);
    expect(validated.definition).not.toBeNull();

    // The conversion is the half that a text scan of the validator cannot see.
    const phaseDef = phaseDefinitionToPhaseDef(validated.definition!);
    expect(phaseDef.spendBoundUsd).toBe(3.5);
    expect(phaseDef.spendBoundTokens).toBe(250_000);

    // And the bound in force is the authored one, not the workspace default.
    const effective = effectiveSpendBound({ limitUsd: 100, limitTokens: 9_000_000 }, phaseDef);
    expect(effective).toEqual({ limitUsd: 3.5, limitTokens: 250_000 });
  });

  it('refuses an out-of-range authored bound, naming the field', () => {
    const result = validatePhaseDefinition({
      phaseId: 'costly',
      name: 'Costly',
      version: 1,
      instruction: 'x',
      spendBoundUsd: 0
    });
    expect(result.errors.map((e) => e.field)).toContain('spendBoundUsd');
  });

  it('leaves the other denomination alone when only one is authored', () => {
    // A phase declaring a token bound must not silently clear the operator's dollar
    // bound. Per-denomination precedence, asserted rather than assumed.
    const effective = effectiveSpendBound({ limitUsd: 5, limitTokens: 1_000 }, {
      spendBoundTokens: 42
    });
    expect(effective).toEqual({ limitUsd: 5, limitTokens: 42 });
  });
});

describe('FR-120 / FR-120a / FR-121 — crossing the bound pauses the run', () => {
  it('writes the operator-resumable pair with the new cause', async () => {
    const { writes, notices, watcher } = watcherOver({ limitUsd: 1, limitTokens: null });
    watcher.onAuditEntry(phaseEnd({ totalCostUsd: 0.6, inputTokens: 10 }));
    await settle();
    expect(writes).toHaveLength(0); // under the bound: nothing written

    watcher.onAuditEntry(phaseEnd({ totalCostUsd: 0.6, inputTokens: 10 }));
    await settle();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.queueId).toBe('default');
    expect(writes[0]!.run.manualPauseCause).toBe('spend-bound-reached');
    expect(writes[0]!.run.manualPauseAt).toBe(1_700_000_000_000);
    expect(notices[0]).toContain('$1.20');
    expect(notices[0]).toContain('$1.00');
  });

  it('produces NO terminal transition — the record is a pause, not an ending', async () => {
    const { writes, watcher } = watcherOver({ limitUsd: 1, limitTokens: null });
    watcher.onAuditEntry(phaseEnd({ totalCostUsd: 5 }));
    await settle();
    const written = writes[0]!.run;
    // The bound pauses; it never destroys. Status is left for the driver's existing
    // pause branch to transition, and nothing about the run's work is discarded.
    expect(written.status).toBe('running');
    expect(written.currentPhase).toBe('implement');
    expect(written.phasesCompleted).toEqual([]);
    expect(written.lastError).toBeUndefined();
  });

  it('pauses once, not once per subsequent phase', async () => {
    const { writes, watcher } = watcherOver({ limitUsd: 1, limitTokens: null });
    watcher.onAuditEntry(phaseEnd({ totalCostUsd: 5 }));
    watcher.onAuditEntry(phaseEnd({ totalCostUsd: 5 }));
    await settle();
    expect(writes).toHaveLength(1);
  });

  it('leaves an already-paused run alone rather than restamping its cause', async () => {
    const paused = runFixture({ manualPauseAt: 5, manualPauseCause: 'operator-paused' });
    const { writes, watcher } = watcherOver({ limitUsd: 1, limitTokens: null }, paused);
    watcher.onAuditEntry(phaseEnd({ totalCostUsd: 5 }));
    await settle();
    expect(writes).toHaveLength(0);
  });

  it('mutation-verified: with the bound removed the same fixture runs past its spend', async () => {
    const unbounded = watcherOver({ limitUsd: null, limitTokens: null });
    unbounded.watcher.onAuditEntry(phaseEnd({ totalCostUsd: 500 }));
    await settle();
    expect(unbounded.writes, 'no bound configured — nothing to cross').toHaveLength(0);

    const bounded = watcherOver({ limitUsd: 1, limitTokens: null });
    bounded.watcher.onAuditEntry(phaseEnd({ totalCostUsd: 500 }));
    await settle();
    expect(bounded.writes, 'the identical fixture pauses once the bound exists').toHaveLength(1);
  });
});

describe('FR-122 — the token denomination behaves identically', () => {
  it('pauses a token-only backend on a token bound', async () => {
    // FR-R4-F02 (D8): the denomination is the ended phase's BACKEND, so this run is a `codex` run.
    const { writes, notices, watcher } = watcherOver(
      { limitUsd: 10, limitTokens: 1_000 },
      runFixture({ defaultRunnerKind: 'codex' })
    );
    // Shaped like `codex`: tokens, and NO cost field at all — FR-R3-098 left cost
    // absent there rather than derived, so this is the payload the bound really sees.
    watcher.onAuditEntry(
      phaseEnd({ inputTokens: 400, outputTokens: 300, cacheReadInputTokens: 400 })
    );
    await settle();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.run.manualPauseCause).toBe('spend-bound-reached');
    expect(notices[0]).toContain('1,100 tokens');
    expect(notices[0]).toContain('1,000 tokens');
  });

  it('reports unmeasurable spend as its own verdict, not as compliance', () => {
    const verdict = evaluateSpend(NO_SPEND_OBSERVED, { limitUsd: 5, limitTokens: null }, 'usd');
    expect(verdict.kind).toBe('unmeasurable');
    // ...and says nothing when no bound applies, so an unbounded run is quiet.
    expect(
      evaluateSpend(NO_SPEND_OBSERVED, { limitUsd: null, limitTokens: null }, 'usd').kind
    ).toBe('no-applicable-bound');
  });

  it('accumulates all four token fields and ignores nonsense', () => {
    let spend = accumulateSpend(
      NO_SPEND_OBSERVED,
      { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 4, cacheReadInputTokens: 8 },
      'row-1'
    );
    expect(spend.totalTokens).toBe(15);
    expect(spend.costUsd).toBeUndefined();
    spend = accumulateSpend(spend, { totalCostUsd: -1, inputTokens: 'lots' }, 'row-2');
    expect(spend.totalTokens, 'a non-numeric field contributes nothing').toBe(15);
    expect(spend.costUsd, 'a negative cost is not spend').toBeUndefined();
  });

  it('names both figures in the pause message', () => {
    const message = spendPauseMessage({
      kind: 'exceeded',
      denomination: 'usd',
      observed: 12.5,
      limit: 10
    });
    expect(message).toContain('$12.50');
    expect(message).toContain('$10.00');
    expect(message).toContain('Nothing was cancelled');
  });
});

describe('the watcher reads only the record that carries usage', () => {
  it('ignores event types that are not phase-end', async () => {
    const { writes, watcher } = watcherOver({ limitUsd: 1, limitTokens: null });
    const other = { ...phaseEnd({ totalCostUsd: 500 }), eventType: 'phase-start' } as AuditEntry;
    watcher.onAuditEntry(other);
    await settle();
    expect(writes).toHaveLength(0);
    expect(watcher.observedFor('run-1')).toEqual(NO_SPEND_OBSERVED);
  });

  it('keeps the tally and retries when the pause write fails', async () => {
    const run = runFixture();
    const pause = vi
      .fn<(queueId: string, run: WorkflowRun) => Promise<void>>()
      .mockRejectedValueOnce(new Error('fence lost'))
      .mockResolvedValueOnce(undefined);
    const watcher = createSpendBoundWatcher({
      config: () => ({ limitUsd: 1, limitTokens: null }),
      findRunById: () => ({ queueId: 'default', run }),
      pause,
      notify: () => undefined,
      logger,
      now: () => 1
    });
    watcher.onAuditEntry(phaseEnd({ totalCostUsd: 5 }));
    await settle();
    expect(pause).toHaveBeenCalledTimes(1);
    // The next phase-end retries rather than leaving the run unbounded forever.
    watcher.onAuditEntry(phaseEnd({ totalCostUsd: 0.01 }));
    await settle();
    expect(pause).toHaveBeenCalledTimes(2);
  });
});

describe('the pause survives a host restart, which is the case that matters most', () => {
  it('is a cause the migrator parses back off disk', async () => {
    // FR-120a. A run paused for spend is paused ACROSS a restart by definition — nobody resumes a
    // budget pause in the same second — so this is the pause cause most likely to be read back
    // from the memento. If `VALID_MANUAL_PAUSE_CAUSES` did not hold it, the value would parse to
    // null, `manualPausePairInvariant` would zero `manualPauseAt` with it, and the run would
    // reload without the field the webview's Resume control requires: a run paused for spend that
    // an operator cannot resume. Asserted through the real migrator, not by reading the set.
    const { migrateLegacyRun } = await import('../../../src/state/workflow-run-migrator.js');
    const persisted = {
      ...runFixture({ status: 'paused' }),
      manualPauseAt: 1_700_000_000_000,
      manualPauseCause: 'spend-bound-reached'
    };
    const migrated = migrateLegacyRun(persisted);
    expect(migrated?.manualPauseCause).toBe('spend-bound-reached');
    expect(migrated?.manualPauseAt).toBe(1_700_000_000_000);

    // Non-vacuity from the other side: a value the set does NOT hold is dropped, and the pair
    // invariant zeroes the timestamp with it. That is the failure this case exists to exclude.
    const unknownCause = migrateLegacyRun({
      ...persisted,
      manualPauseCause: 'not-a-real-cause'
    });
    expect(unknownCause?.manualPauseCause).toBeNull();
    expect(unknownCause?.manualPauseAt).toBeNull();
  });
});

describe('the pause reaches the operator surface it was written for', () => {
  it('projects the spend cause through to the runtime the dashboard reads', async () => {
    // FR-120's "names the bound and the measured spend" has an operator-facing half, and a cause
    // that stopped at the store would satisfy every assertion above while the dashboard rendered
    // "Phase paused". This drives the host projection with a run paused for spend and asserts the
    // value the webview's badge keys on.
    const { composeQueueRuntimes } = await import(
      '../../../src/ui/sidebar/queue-runtime-composer.js'
    );
    const pausedForSpend = runFixture({
      status: 'paused',
      manualPauseAt: 1_700_000_000_000,
      manualPauseCause: 'spend-bound-reached'
    });
    const runtimes = composeQueueRuntimes({
      summaries: [{ id: 'default', name: 'Default queue', position: 0 }],
      runOf: () => ({
        run: pausedForSpend,
        status: 'paused',
        phases: [],
        activePipeline: null,
        liveActivity: null,
        outputs: [],
        delayedRetry: null,
        plannedTotal: null
      }),
      lifecycleOf: () => 'active-empty',
      scheduledStartOf: () => ({ at: null, source: null }),
      requestsOf: () => []
    } as never);

    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]!.manualPause?.cause).toBe('spend-bound-reached');
    // Non-vacuity: the timestamp travels with the cause, so a projection that dropped the pair
    // could not pass by carrying only the half this case names.
    expect(runtimes[0]!.manualPause?.at).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('renders the badge the operator actually reads', async () => {
    // The webview half, driven rather than assumed. `pauseBadgeLabel` is what
    // `PhaseProgression.svelte` binds, and `RunDetailTier.svelte` passes it
    // `runtime.manualPause.cause` — the same value the case above produced.
    const { pauseBadgeLabel } = await import('../../../webview-ui/src/lib/pause-labels.js');
    expect(pauseBadgeLabel('spend-bound-reached')).toBe('Spend bound reached');
    // And an unrecognized cause still reads as something rather than blanking the badge.
    expect(pauseBadgeLabel(undefined)).toBe('Phase paused');
  });
});

describe('FR-R3-198 (T1882) — a resumed session\'s cost is counted once', () => {
  it('A2: folds run 777491f8\'s 13 cumulative costs to 24.0459, not 184.5690', async () => {
    // Loaded here rather than at the top, so that until the module exists only
    // this case fails.
    const { SessionCostLedger } = await import('../../../src/runner/session-cost-ledger.js');
    // Run `777491f8`: one CLI session resumed across eleven phases. Each figure is
    // the running `total_cost_usd` on one invocation's last `result` row (research R9).
    const cumulativeUsd = [
      1.1731, 1.9194, 5.8407, 7.8224, 8.5354, 10.7153, 13.7383, 20.773, 21.4272, 22.4448,
      23.0404, 23.0931, 24.0459
    ];
    const session = 'session-a';
    const ledger = new SessionCostLedger();
    let recorded: RunSpendTotal = NO_SPEND_OBSERVED;
    let summed: RunSpendTotal = NO_SPEND_OBSERVED;
    for (const [index, costUsd] of cumulativeUsd.entries()) {
      const row = `{"type":"result","num_turns":1,"total_cost_usd":${costUsd}}`;
      const usage = extractInvocationUsageMetrics(row, 'claude', ledger.get(session));
      ledger.record(session, costUsd);
      recorded = accumulateSpend(recorded, { ...usage }, `recorded-${index}`);
      summed = accumulateSpend(summed, { totalCostUsd: costUsd }, `summed-${index}`);
    }
    expect(recorded.costUsd).toBeCloseTo(24.0459, 6);
    expect(summed.costUsd, 'every cumulative summed, as today').toBeCloseTo(184.569, 6);
  });
});

/** What a restart replay hands the watcher: the rows, and by default every Run complete. */
function replayOf(
  rows: readonly AuditEntry[],
  completeness: SpendReplay['completeness'] = new Map()
): SpendReplay {
  return { rows, completeness };
}

// FR-R3-209 (T1895) — the seed folds the log's `phase-end` rows into the tally a restart emptied.
describe('FR-R3-209 (T1895) — the seed rebuilds the tally after a restart', () => {
  interface Deferred<T> {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
    readonly reject: (reason: unknown) => void;
  }

  function deferred<T>(): Deferred<T> {
    let resolve: (value: T) => void = () => undefined;
    let reject: (reason: unknown) => void = () => undefined;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** A `phase-end` row with its own id, so one row can arrive twice, by the seed and live. */
  function row(id: string, runId: string, payload: Record<string, unknown>): AuditEntry {
    return { ...phaseEnd(payload, runId), id };
  }

  /** A watcher over a mutable Run map, read at call time so a case can replace a Run mid-way. */
  function seedHarness(
    config: { limitUsd: number | null; limitTokens: number | null } = {
      limitUsd: null,
      limitTokens: null
    }
  ): {
    runs: Map<string, WorkflowRun>;
    writes: Written[];
    notices: string[];
    watcher: ReturnType<typeof createSpendBoundWatcher>;
  } {
    const runs = new Map<string, WorkflowRun>();
    const writes: Written[] = [];
    const notices: string[] = [];
    const watcher = createSpendBoundWatcher({
      config: () => config,
      findRunById: (runId) => {
        const run = runs.get(runId);
        return run === undefined ? null : { queueId: 'default', run };
      },
      pause: async (queueId, written) => {
        writes.push({ queueId, run: written });
      },
      notify: (message) => notices.push(message),
      logger,
      now: () => 1_700_000_000_000
    });
    return { runs, writes, notices, watcher };
  }

  it('S1: folds the rows of a resolved, non-terminal Run into its tally, in dollars and tokens', async () => {
    const { runs, watcher } = seedHarness();
    runs.set('run-1', runFixture());
    await watcher.seedFrom(
      Promise.resolve(replayOf([
        row('e-1', 'run-1', { totalCostUsd: 0.25, inputTokens: 100, outputTokens: 20 }),
        row('e-2', 'run-1', { totalCostUsd: 0.5, inputTokens: 300, cacheReadInputTokens: 50 }),
        row('e-3', 'run-1', { totalCostUsd: 0.125, outputTokens: 40 })
      ]))
    );
    expect(watcher.observedFor('run-1')).toMatchObject({ costUsd: 0.875, totalTokens: 510 });
  });

  it('S2: counts no row of an unresolved or terminal Run, and gives such a row no slot', async () => {
    const first = seedHarness();
    first.runs.set('done', runFixture({ id: 'done', status: 'completed' }));
    await first.watcher.seedFrom(
      Promise.resolve(replayOf([
        row('g-1', 'ghost', { totalCostUsd: 1 }),
        row('d-1', 'done', { totalCostUsd: 1 })
      ]))
    );
    expect(first.watcher.observedFor('ghost')).toEqual(NO_SPEND_OBSERVED);
    expect(first.watcher.observedFor('done')).toEqual(NO_SPEND_OBSERVED);

    // Eviction is oldest-first, so a terminal Run's row that took a slot would push the first
    // live Run out. The terminal row comes last on purpose.
    const second = seedHarness();
    const liveIds = Array.from({ length: 64 }, (_, i) => `live-${i}`);
    for (const id of liveIds) second.runs.set(id, runFixture({ id }));
    second.runs.set('done', runFixture({ id: 'done', status: 'completed' }));
    await second.watcher.seedFrom(
      Promise.resolve(replayOf([
        ...liveIds.map((id, i) => row(`seed-${i}`, id, { totalCostUsd: 1 })),
        row('seed-done', 'done', { totalCostUsd: 1 })
      ]))
    );
    for (const id of liveIds) {
      expect(second.watcher.observedFor(id).costUsd, `${id} keeps its tally`).toBe(1);
    }
    expect(second.watcher.observedFor('done')).toEqual(NO_SPEND_OBSERVED);
  });

  it('S3: counts once a row the live handler folded while the seed was pending', async () => {
    const { runs, watcher } = seedHarness();
    runs.set('run-1', runFixture());
    const pending = deferred<SpendReplay>();
    const seeding = watcher.seedFrom(pending.promise);

    watcher.onAuditEntry(row('e-1', 'run-1', { totalCostUsd: 0.25 }));
    expect(watcher.observedFor('run-1').costUsd).toBe(0.25);

    pending.resolve(replayOf([
      row('e-1', 'run-1', { totalCostUsd: 0.25 }),
      row('e-2', 'run-1', { totalCostUsd: 0.5 })
    ]));
    await seeding;
    expect(watcher.observedFor('run-1').costUsd).toBe(0.75);
  });

  it('S4: counts once a seeded row whose live notice arrives after the seed', async () => {
    const { runs, watcher } = seedHarness();
    runs.set('run-1', runFixture());
    await watcher.seedFrom(
      Promise.resolve(replayOf([
        row('e-1', 'run-1', { totalCostUsd: 0.25 }),
        row('e-2', 'run-1', { totalCostUsd: 0.5 })
      ]))
    );
    expect(watcher.observedFor('run-1').costUsd).toBe(0.75);

    watcher.onAuditEntry(row('e-1', 'run-1', { totalCostUsd: 0.25 }));
    expect(watcher.observedFor('run-1').costUsd, 'the seeded row is not folded again').toBe(0.75);

    watcher.onAuditEntry(row('e-3', 'run-1', { totalCostUsd: 0.125 }));
    expect(watcher.observedFor('run-1').costUsd, 'a new row folds').toBe(0.875);
  });

  it('S5: remembers a Run seeded as paused for spend, so its next row writes no second pause', async () => {
    const { runs, writes, watcher } = seedHarness({ limitUsd: 1, limitTokens: null });
    runs.set(
      'run-1',
      runFixture({
        status: 'paused',
        manualPauseAt: 1_700_000_000_000,
        manualPauseCause: 'spend-bound-reached'
      })
    );
    await watcher.seedFrom(Promise.resolve(replayOf([row('e-1', 'run-1', { totalCostUsd: 1.5 })])));

    // The operator's resume clears the pair, as `PhaseControlService` does.
    runs.set('run-1', runFixture({ manualPauseAt: null, manualPauseCause: null }));
    watcher.onAuditEntry(row('e-2', 'run-1', { totalCostUsd: 0.5 }));
    await settle();
    expect(writes).toEqual([]);
  });

  it('S6: evaluates nothing at the seed, and pauses at the next live row', async () => {
    const { runs, writes, notices, watcher } = seedHarness({ limitUsd: 1, limitTokens: null });
    runs.set('run-1', runFixture());
    await watcher.seedFrom(Promise.resolve(replayOf([row('e-1', 'run-1', { totalCostUsd: 1.5 })])));
    await settle();
    expect(writes).toEqual([]);
    expect(notices).toEqual([]);

    watcher.onAuditEntry(row('e-2', 'run-1', { totalCostUsd: 0.1 }));
    await settle();
    expect(writes).toHaveLength(1);
    expect(writes.at(0)?.run.manualPauseCause).toBe('spend-bound-reached');
  });

  it('S7: evaluates a row folded live during the seed against what the tally holds then', async () => {
    const { runs, writes, watcher } = seedHarness({ limitUsd: 1, limitTokens: null });
    runs.set('run-1', runFixture());
    const pending = deferred<SpendReplay>();
    const seeding = watcher.seedFrom(pending.promise);

    // 0.5 alone is under the bound, though 0.8 of earlier spend is still being read.
    watcher.onAuditEntry(row('live-1', 'run-1', { totalCostUsd: 0.5 }));
    await settle();
    expect(writes).toEqual([]);

    pending.resolve(replayOf([row('seed-1', 'run-1', { totalCostUsd: 0.8 })]));
    await seeding;
    await settle();
    expect(writes, 'the seed itself writes nothing').toEqual([]);

    watcher.onAuditEntry(row('live-2', 'run-1', { totalCostUsd: 0.1 }));
    await settle();
    expect(writes).toHaveLength(1);
  });

  it('S8: a rejected seed leaves the watcher empty, and live rows fold as before', async () => {
    const seeded = seedHarness();
    seeded.runs.set('run-1', runFixture());
    await expect(
      seeded.watcher.seedFrom(Promise.reject(new Error('read failed')))
    ).resolves.toBeUndefined();
    expect(seeded.watcher.observedFor('run-1')).toEqual(NO_SPEND_OBSERVED);

    const unseeded = seedHarness();
    unseeded.runs.set('run-1', runFixture());
    const live = row('e-1', 'run-1', { totalCostUsd: 0.25, inputTokens: 10 });
    seeded.watcher.onAuditEntry(live);
    unseeded.watcher.onAuditEntry(live);
    expect(seeded.watcher.observedFor('run-1')).toMatchObject({ costUsd: 0.25, totalTokens: 10 });
    expect(seeded.watcher.observedFor('run-1')).toEqual(unseeded.watcher.observedFor('run-1'));
  });

  // FR-R4-F02 (spec 240, US4; contract S2 G9, S4 G16; US4-3, US4-4, US4-6) — completeness.
  const INCOMPLETE_BUDGET = { kind: 'incomplete', reason: 'budget' } as const;
  const completenessOf = (...entries: Array<[string, SpendReplay['completeness'] extends ReadonlyMap<string, infer V> ? V : never]>) =>
    new Map(entries);

  it('S9: seedFrom sets each Run\'s completeness from the replay, even for a Run with no rows', async () => {
    const { runs, watcher } = seedHarness();
    runs.set('run-1', runFixture());
    runs.set('run-2', runFixture({ id: 'run-2' }));
    runs.set('run-3', runFixture({ id: 'run-3' }));
    await watcher.seedFrom(
      Promise.resolve(
        replayOf(
          [row('e-1', 'run-1', { totalCostUsd: 0.25 })],
          completenessOf(['run-1', INCOMPLETE_BUDGET], ['run-2', INCOMPLETE_BUDGET], ['run-3', { kind: 'complete' }])
        )
      )
    );

    expect(watcher.observedFor('run-1').completeness).toEqual(INCOMPLETE_BUDGET);
    expect(watcher.observedFor('run-1').costUsd).toBe(0.25);
    expect(watcher.observedFor('run-2').completeness).toEqual(INCOMPLETE_BUDGET);
    expect(watcher.observedFor('run-3')).toEqual(NO_SPEND_OBSERVED);
  });

  it('S10: does not create a Run the replay never covered, or one that has ended', async () => {
    const { runs, watcher } = seedHarness();
    runs.set('done', runFixture({ id: 'done', status: 'completed' }));
    await watcher.seedFrom(
      Promise.resolve(replayOf([], completenessOf(['done', INCOMPLETE_BUDGET], ['ghost', INCOMPLETE_BUDGET])))
    );

    expect(watcher.observedFor('done')).toEqual(NO_SPEND_OBSERVED);
    expect(watcher.observedFor('ghost')).toEqual(NO_SPEND_OBSERVED);
  });

  it('S11: an incomplete total at or over the bound pauses: a lower bound over the limit is a measured crossing', async () => {
    const { runs, writes, watcher } = seedHarness({ limitUsd: 1, limitTokens: null });
    runs.set('run-1', runFixture());
    await watcher.seedFrom(
      Promise.resolve(
        replayOf([row('e-1', 'run-1', { totalCostUsd: 0.9 })], completenessOf(['run-1', INCOMPLETE_BUDGET]))
      )
    );

    watcher.onAuditEntry(row('live-1', 'run-1', { totalCostUsd: 0.2 }));
    await settle();

    expect(writes).toHaveLength(1);
    expect(writes.at(0)?.run.manualPauseCause).toBe('spend-bound-reached');
  });

  it('S12: an incomplete total below the bound is never `within`: it raises the shared notice once and does not pause', async () => {
    const { runs, writes, notices, watcher } = seedHarness({ limitUsd: 10, limitTokens: null });
    runs.set('run-1', runFixture());
    await watcher.seedFrom(
      Promise.resolve(
        replayOf([row('e-1', 'run-1', { totalCostUsd: 0.5 })], completenessOf(['run-1', INCOMPLETE_BUDGET]))
      )
    );

    watcher.onAuditEntry(row('live-1', 'run-1', { totalCostUsd: 0.1 }));
    watcher.onAuditEntry(row('live-2', 'run-1', { totalCostUsd: 0.1 }));
    watcher.onAuditEntry(row('live-3', 'run-1', { totalCostUsd: 0.1 }));
    await settle();

    expect(writes).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('history is incomplete');
    expect(notices[0]).not.toMatch(/\d/);
  });

  it('S13: a complete total below the bound raises nothing (the control for S12)', async () => {
    const { runs, writes, notices, watcher } = seedHarness({ limitUsd: 10, limitTokens: null });
    runs.set('run-1', runFixture());
    await watcher.seedFrom(
      Promise.resolve(replayOf([row('e-1', 'run-1', { totalCostUsd: 0.5 })], completenessOf(['run-1', { kind: 'complete' }])))
    );

    watcher.onAuditEntry(row('live-1', 'run-1', { totalCostUsd: 0.1 }));
    await settle();

    expect(writes).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('S14: a live Run evicted to stay under the cap is incomplete(evicted) at its next row; a finished one is not', async () => {
    const { runs, watcher } = seedHarness({ limitUsd: 100, limitTokens: null });
    // 64 live Runs fill the tally, then a 65th live Run evicts the oldest, which is live.
    const liveIds = Array.from({ length: 65 }, (_, index) => `live-${index}`);
    for (const id of liveIds) runs.set(id, runFixture({ id }));
    liveIds.forEach((id, index) => watcher.onAuditEntry(row(`first-${index}`, id, { totalCostUsd: 1 })));

    expect(watcher.observedFor('live-0')).toEqual(NO_SPEND_OBSERVED);
    watcher.onAuditEntry(row('again-0', 'live-0', { totalCostUsd: 2 }));
    expect(watcher.observedFor('live-0').completeness).toEqual({ kind: 'incomplete', reason: 'evicted' });
    expect(watcher.observedFor('live-0').costUsd).toBe(2);
    expect(watcher.observedFor('live-1').completeness).toEqual({ kind: 'complete' });
  });

  it('S15: a Run that finished before its eviction is simply forgotten, and a later row starts it complete', async () => {
    const { runs, watcher } = seedHarness({ limitUsd: 100, limitTokens: null });
    const ids = Array.from({ length: 65 }, (_, index) => `r-${index}`);
    for (const id of ids) runs.set(id, runFixture({ id }));
    runs.set('r-0', runFixture({ id: 'r-0', status: 'completed' }));
    ids.forEach((id, index) => watcher.onAuditEntry(row(`first-${index}`, id, { totalCostUsd: 1 })));

    watcher.onAuditEntry(row('late-0', 'r-0', { totalCostUsd: 2 }));

    expect(watcher.observedFor('r-0').completeness).toEqual({ kind: 'complete' });
  });

  it('S16: forget at the terminal transition removes the Run\'s state, its notice keys and its evicted mark', async () => {
    const { runs, notices, watcher } = seedHarness({ limitUsd: 10, limitTokens: null });
    runs.set('run-1', runFixture());
    await watcher.seedFrom(
      Promise.resolve(replayOf([], completenessOf(['run-1', INCOMPLETE_BUDGET])))
    );
    watcher.onAuditEntry(row('live-1', 'run-1', { totalCostUsd: 0.1 }));
    expect(notices).toHaveLength(1);

    watcher.forget('run-1');

    expect(watcher.observedFor('run-1')).toEqual(NO_SPEND_OBSERVED);
    watcher.onAuditEntry(row('live-2', 'run-1', { totalCostUsd: 0.1 }));
    expect(watcher.observedFor('run-1').completeness).toEqual({ kind: 'complete' });
    expect(notices, 'a forgotten Run reports again, because its keys went with it').toHaveLength(1);
  });

  it('S17: Runs on several queues, and a row delivered twice, are each counted once', async () => {
    const { runs, watcher } = seedHarness();
    runs.set('run-1', runFixture());
    runs.set('run-2', runFixture({ id: 'run-2' }));
    const shared = row('e-1', 'run-1', { totalCostUsd: 0.25 });
    await watcher.seedFrom(Promise.resolve(replayOf([shared, row('e-2', 'run-2', { totalCostUsd: 1 })])));

    watcher.onAuditEntry(shared);
    watcher.onAuditEntry(row('e-3', 'run-1', { totalCostUsd: 0.5 }));

    expect(watcher.observedFor('run-1').costUsd).toBe(0.75);
    expect(watcher.observedFor('run-2').costUsd).toBe(1);
  });

  it('S18: trustFor is `not-trustworthy` until the figure has been observed, and while the total is incomplete', async () => {
    const { runs, watcher } = seedHarness();
    runs.set('run-1', runFixture());
    runs.set('run-2', runFixture({ id: 'run-2' }));
    expect(watcher.trustFor('run-1', 'usd')).toBe('not-trustworthy');

    watcher.onAuditEntry(row('e-1', 'run-1', { totalCostUsd: 0.25 }));
    expect(watcher.trustFor('run-1', 'usd')).toBe('enforced');
    expect(watcher.trustFor('run-1', 'tokens'), 'tokens were never observed').toBe('not-trustworthy');

    await watcher.seedFrom(Promise.resolve(replayOf([row('e-2', 'run-2', { totalCostUsd: 1 })], completenessOf(['run-2', INCOMPLETE_BUDGET]))));
    expect(watcher.trustFor('run-2', 'usd')).toBe('not-trustworthy');
  });
});

// FR-R4-F02 (spec 240, US3; contract S2 G5 to G7, S3 G10 to G12; data-model §8, §9) — the verdict
// follows the denomination of the phase that just ended, and an unmeasurable one is reported once.
describe('FR-R4-F02 — evaluateSpend follows the data-model §8 table, row by row', () => {
  const bound = { limitUsd: 2, limitTokens: 1_000 };
  const total = (patch: Partial<RunSpendTotal>): RunSpendTotal => ({ ...NO_SPEND_OBSERVED, ...patch });

  it('no limit in the denomination: no applicable bound, whatever the total', () => {
    expect(evaluateSpend(total({ costUsd: 50 }), { limitUsd: null, limitTokens: 1_000 }, 'usd')).toEqual({
      kind: 'no-applicable-bound'
    });
    expect(evaluateSpend(total({ totalTokens: 5e6 }), { limitUsd: 2, limitTokens: null }, 'tokens')).toEqual({
      kind: 'no-applicable-bound'
    });
  });

  it('a limit and no value in that denomination: unmeasurable, never read from the other denomination', () => {
    expect(evaluateSpend(total({ totalTokens: 9_999 }), bound, 'usd')).toEqual({
      kind: 'unmeasurable',
      denomination: 'usd',
      reason: 'value-absent'
    });
    expect(evaluateSpend(total({ costUsd: 99 }), bound, 'tokens')).toEqual({
      kind: 'unmeasurable',
      denomination: 'tokens',
      reason: 'value-absent'
    });
  });

  it('absent beats incomplete: nothing was measured, so the reason is the missing value', () => {
    const verdict = evaluateSpend(
      total({ completeness: { kind: 'incomplete', reason: 'budget' } }),
      bound,
      'usd'
    );
    expect(verdict.kind).toBe('unmeasurable');
  });

  it('at or above the limit: exceeded, complete or not', () => {
    expect(evaluateSpend(total({ costUsd: 2 }), bound, 'usd')).toEqual({
      kind: 'exceeded',
      denomination: 'usd',
      observed: 2,
      limit: 2
    });
    expect(
      evaluateSpend(
        total({ totalTokens: 1_500, completeness: { kind: 'incomplete', reason: 'archive-missing' } }),
        bound,
        'tokens'
      )
    ).toEqual({ kind: 'exceeded', denomination: 'tokens', observed: 1_500, limit: 1_000 });
  });

  it('below the limit and incomplete: incomplete with the reason, never within', () => {
    expect(
      evaluateSpend(
        total({ costUsd: 0.5, completeness: { kind: 'incomplete', reason: 'damaged-row' } }),
        bound,
        'usd'
      )
    ).toEqual({ kind: 'incomplete', denomination: 'usd', reason: 'damaged-row' });
  });

  it('below the limit and complete: within', () => {
    expect(evaluateSpend(total({ costUsd: 0.5 }), bound, 'usd')).toEqual({ kind: 'within' });
    expect(evaluateSpend(total({ totalTokens: 0 }), bound, 'tokens')).toEqual({ kind: 'within' });
  });
});

describe('FR-R4-F02 — accumulateSpend folds a row once, through the reader', () => {
  it('a row seen twice changes nothing', () => {
    const payload = { metrics: { totalCostUsd: 0.5, inputTokens: 10 } };
    const once = accumulateSpend(NO_SPEND_OBSERVED, payload, 'row-1');
    const twice = accumulateSpend(once, payload, 'row-1');
    expect(twice.costUsd).toBe(0.5);
    expect(twice.totalTokens).toBe(10);
    expect(twice.countedRowIds.has('row-1')).toBe(true);
  });

  it('reads nested usage first and flat usage second', () => {
    const nested = accumulateSpend(NO_SPEND_OBSERVED, { metrics: { totalCostUsd: 1.5 } }, 'row-1');
    expect(nested.costUsd).toBe(1.5);
    const flat = accumulateSpend(NO_SPEND_OBSERVED, { totalCostUsd: 2.5 }, 'row-1');
    expect(flat.costUsd).toBe(2.5);
  });

  it('keeps absent apart from zero: a row with no cost leaves the cost unobserved', () => {
    const tokensOnly = accumulateSpend(NO_SPEND_OBSERVED, { metrics: { inputTokens: 4 } }, 'row-1');
    expect(tokensOnly.costUsd).toBeUndefined();
    expect(tokensOnly.totalTokens).toBe(4);
  });
});

describe('FR-R4-F02 — the denomination is the ended phase\'s backend, never the observed values', () => {
  const TOKENS_ONLY = { metrics: { inputTokens: 5_000_000 } };
  const COST_ONLY = { metrics: { totalCostUsd: 500 } };

  it('a claude run bounded in USD does not pause on tokens, and is unmeasurable instead', async () => {
    const { writes, notices, watcher } = watcherOver({ limitUsd: 1, limitTokens: 1_000 });
    watcher.onAuditEntry(phaseEnd(TOKENS_ONLY));
    await settle();
    expect(writes).toHaveLength(0);
    expect(notices).toHaveLength(1);
  });

  it('a codex run bounded in tokens does not pause on cost, and is unmeasurable instead', async () => {
    const { writes, notices, watcher } = watcherOver(
      { limitUsd: 1, limitTokens: 1_000 },
      runFixture({ defaultRunnerKind: 'codex' })
    );
    watcher.onAuditEntry(phaseEnd(COST_ONLY));
    await settle();
    expect(writes).toHaveLength(0);
    expect(notices).toHaveLength(1);
  });

  it('a Phase that pins its own runner takes that runner\'s denomination', async () => {
    const run = runFixture({
      defaultRunnerKind: 'claude',
      pipeline: {
        id: 'p',
        name: 'P',
        phases: [{ id: 'implement', name: 'Implement', instruction: 'x', runner: 'codex' }]
      }
    } as Partial<WorkflowRun>);
    const { writes, watcher } = watcherOver({ limitUsd: 1, limitTokens: 1_000 }, run);
    watcher.onAuditEntry(phaseEnd(TOKENS_ONLY));
    await settle();
    expect(writes).toHaveLength(1);
  });

  it('the phase that ENDED decides, not the one the Run has advanced to', async () => {
    const run = runFixture({
      currentPhase: 'review',
      pipeline: {
        id: 'p',
        name: 'P',
        phases: [
          { id: 'implement', name: 'Implement', instruction: 'x', runner: 'codex' },
          { id: 'review', name: 'Review', instruction: 'y', runner: 'claude' }
        ]
      }
    } as Partial<WorkflowRun>);
    const { writes, watcher } = watcherOver({ limitUsd: 1, limitTokens: 1_000 }, run);
    // The row names `implement`, the phase that just ended, while the Run already reads `review`.
    watcher.onAuditEntry(phaseEnd(TOKENS_ONLY));
    await settle();
    expect(writes).toHaveLength(1);
  });
});

describe('FR-R4-F02 — an unmeasurable denomination is reported once per Run per denomination', () => {
  function recordingWatcher(run: WorkflowRun = runFixture()): {
    watcher: ReturnType<typeof createSpendBoundWatcher>;
    notices: string[];
    warn: ReturnType<typeof vi.fn>;
  } {
    const notices: string[] = [];
    const warn = vi.fn();
    const recording = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as SanitizedLogger;
    const watcher = createSpendBoundWatcher({
      config: () => ({ limitUsd: 1, limitTokens: 1_000 }),
      findRunById: (runId) => (runId === run.id ? { queueId: 'default', run } : null),
      pause: async () => undefined,
      notify: (message) => notices.push(message),
      logger: recording,
      now: () => 1
    });
    return { watcher, notices, warn };
  }

  it('twenty rows with the denomination absent give one notice, one line, and no per-row warning', () => {
    const { watcher, notices, warn } = recordingWatcher();
    for (let index = 0; index < 20; index += 1) {
      watcher.onAuditEntry(phaseEnd({ metrics: { inputTokens: 10 } }));
    }
    expect(notices).toHaveLength(1);
    expect(notices[0]).not.toMatch(/\d/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'spend bound: cannot measure',
      expect.objectContaining({ reasonCode: 'spend-unmeasurable', denomination: 'usd' })
    );
  });

  it('the notice names the unit and the reason class, and no amount', () => {
    const { watcher, notices } = recordingWatcher();
    watcher.onAuditEntry(phaseEnd({ metrics: { inputTokens: 10 } }));
    expect(notices[0]).toMatch(/USD/i);
    expect(notices[0]).toMatch(/not reported by this backend/i);
  });

  it('a second Run is told once as well', () => {
    const second = runFixture({ id: 'run-2' });
    const first = runFixture();
    const notices: string[] = [];
    const watcher = createSpendBoundWatcher({
      config: () => ({ limitUsd: 1, limitTokens: null }),
      findRunById: (runId) =>
        runId === first.id
          ? { queueId: 'default', run: first }
          : runId === second.id
            ? { queueId: 'other', run: second }
            : null,
      pause: async () => undefined,
      notify: (message) => notices.push(message),
      logger,
      now: () => 1
    });
    for (const runId of ['run-1', 'run-2', 'run-1', 'run-2']) {
      watcher.onAuditEntry(phaseEnd({ metrics: { inputTokens: 10 } }, runId));
    }
    expect(notices).toHaveLength(2);
  });

  it('forget(runId) clears the key, so a later report is made again', () => {
    const { watcher, notices } = recordingWatcher();
    watcher.onAuditEntry(phaseEnd({ metrics: { inputTokens: 10 } }));
    watcher.onAuditEntry(phaseEnd({ metrics: { inputTokens: 10 } }));
    expect(notices).toHaveLength(1);
    watcher.forget('run-1');
    watcher.onAuditEntry(phaseEnd({ metrics: { inputTokens: 10 } }));
    expect(notices).toHaveLength(2);
  });

  it('a measured Run raises nothing', () => {
    const { watcher, notices, warn } = recordingWatcher();
    watcher.onAuditEntry(phaseEnd({ metrics: { totalCostUsd: 0.25 } }));
    expect(notices).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('FR-R4-F02 — a row folded by the seed and by the live notice is counted once, nested or flat', () => {
  it('counts a nested seeded row once when its live notice arrives after the seed', async () => {
    const { watcher } = watcherOver({ limitUsd: null, limitTokens: null });
    const seeded = { ...phaseEnd({ metrics: { totalCostUsd: 0.25 } }), id: 'seed-1' } as AuditEntry;
    await watcher.seedFrom(Promise.resolve(replayOf([seeded])));
    expect(watcher.observedFor('run-1').costUsd).toBe(0.25);
    watcher.onAuditEntry(seeded);
    expect(watcher.observedFor('run-1').costUsd).toBe(0.25);
    watcher.onAuditEntry(phaseEnd({ metrics: { totalCostUsd: 0.5 } }));
    expect(watcher.observedFor('run-1').costUsd).toBe(0.75);
  });
});

describe('FR-R4-F02 (contract S2 G8) — the watcher is subscribed before any drive can start (pins)', () => {
  it('the wiring subscribes the watcher to the audit writer before it starts the seed', () => {
    const wiring = readFileSync(
      resolve(__dirname, '../../../src/activation/run-safety-wiring.ts'),
      'utf8'
    );
    const subscribeAt = wiring.indexOf('auditWriter.subscribe(spendWatcher.onAuditEntry)');
    const seedAt = wiring.indexOf('spendWatcher.seedFrom(');
    expect(subscribeAt, 'the subscription is in the wiring').toBeGreaterThan(-1);
    expect(seedAt, 'the seed is in the wiring').toBeGreaterThan(subscribeAt);
  });
});

