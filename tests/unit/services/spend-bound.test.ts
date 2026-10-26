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
import { describe, expect, it, vi } from 'vitest';
import { phaseDefinitionToPhaseDef } from '../../../src/config/process-catalog';
import { validatePhaseDefinition } from '../../../src/config/process-definition-validator';
import { SanitizedLogger } from '../../../src/lib/logger';
import { extractInvocationUsageMetrics } from '../../../src/parser/invocation-usage';
import {
  accumulateSpend,
  denominationFor,
  effectiveSpendBound,
  evaluateSpend,
  NO_SPEND_OBSERVED,
  spendPauseMessage
} from '../../../src/services/spend-bound';
import { createSpendBoundWatcher } from '../../../src/services/spend-bound-watcher';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import type { WorkflowRun } from '../../../src/state/workflow-run';

const logger = new SanitizedLogger();

/** A `phase-end` entry shaped like the one `phase-runner.ts` actually appends. */
function phaseEnd(payload: Record<string, unknown>, runId = 'run-1'): AuditEntry {
  return {
    id: 'entry-1',
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
    const { writes, notices, watcher } = watcherOver({ limitUsd: 10, limitTokens: 1_000 });
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

  it('derives the denomination from what the backend reported, not from its name', () => {
    expect(denominationFor({ costUsd: 0.5, totalTokens: 10 })).toBe('usd');
    expect(denominationFor({ costUsd: undefined, totalTokens: 10 })).toBe('tokens');
    expect(denominationFor({ costUsd: undefined, totalTokens: undefined })).toBeNull();
  });

  it('reports unmeasurable spend as its own verdict, not as compliance', () => {
    const verdict = evaluateSpend(
      { costUsd: undefined, totalTokens: undefined },
      { limitUsd: 5, limitTokens: null }
    );
    expect(verdict.kind).toBe('unmeasurable');
    // ...and says nothing when no bound is set, so an unbounded run is quiet.
    expect(
      evaluateSpend({ costUsd: undefined, totalTokens: undefined }, { limitUsd: null, limitTokens: null }).kind
    ).toBe('within');
  });

  it('accumulates all four token fields and ignores nonsense', () => {
    let spend = accumulateSpend(NO_SPEND_OBSERVED, {
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationInputTokens: 4,
      cacheReadInputTokens: 8
    });
    expect(spend.totalTokens).toBe(15);
    expect(spend.costUsd).toBeUndefined();
    spend = accumulateSpend(spend, { totalCostUsd: -1, inputTokens: 'lots' });
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
    let recorded = NO_SPEND_OBSERVED;
    let summed = NO_SPEND_OBSERVED;
    for (const costUsd of cumulativeUsd) {
      const row = `{"type":"result","num_turns":1,"total_cost_usd":${costUsd}}`;
      const usage = extractInvocationUsageMetrics(row, 'claude', ledger.get(session));
      ledger.record(session, costUsd);
      recorded = accumulateSpend(recorded, { ...usage });
      summed = accumulateSpend(summed, { totalCostUsd: costUsd });
    }
    expect(recorded.costUsd).toBeCloseTo(24.0459, 6);
    expect(summed.costUsd, 'every cumulative summed, as today').toBeCloseTo(184.569, 6);
  });
});

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
      Promise.resolve([
        row('e-1', 'run-1', { totalCostUsd: 0.25, inputTokens: 100, outputTokens: 20 }),
        row('e-2', 'run-1', { totalCostUsd: 0.5, inputTokens: 300, cacheReadInputTokens: 50 }),
        row('e-3', 'run-1', { totalCostUsd: 0.125, outputTokens: 40 })
      ])
    );
    expect(watcher.observedFor('run-1')).toEqual({ costUsd: 0.875, totalTokens: 510 });
  });

  it('S2: counts no row of an unresolved or terminal Run, and gives such a row no slot', async () => {
    const first = seedHarness();
    first.runs.set('done', runFixture({ id: 'done', status: 'completed' }));
    await first.watcher.seedFrom(
      Promise.resolve([
        row('g-1', 'ghost', { totalCostUsd: 1 }),
        row('d-1', 'done', { totalCostUsd: 1 })
      ])
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
      Promise.resolve([
        ...liveIds.map((id, i) => row(`seed-${i}`, id, { totalCostUsd: 1 })),
        row('seed-done', 'done', { totalCostUsd: 1 })
      ])
    );
    for (const id of liveIds) {
      expect(second.watcher.observedFor(id).costUsd, `${id} keeps its tally`).toBe(1);
    }
    expect(second.watcher.observedFor('done')).toEqual(NO_SPEND_OBSERVED);
  });

  it('S3: counts once a row the live handler folded while the seed was pending', async () => {
    const { runs, watcher } = seedHarness();
    runs.set('run-1', runFixture());
    const pending = deferred<readonly AuditEntry[]>();
    const seeding = watcher.seedFrom(pending.promise);

    watcher.onAuditEntry(row('e-1', 'run-1', { totalCostUsd: 0.25 }));
    expect(watcher.observedFor('run-1').costUsd).toBe(0.25);

    pending.resolve([
      row('e-1', 'run-1', { totalCostUsd: 0.25 }),
      row('e-2', 'run-1', { totalCostUsd: 0.5 })
    ]);
    await seeding;
    expect(watcher.observedFor('run-1').costUsd).toBe(0.75);
  });

  it('S4: counts once a seeded row whose live notice arrives after the seed', async () => {
    const { runs, watcher } = seedHarness();
    runs.set('run-1', runFixture());
    await watcher.seedFrom(
      Promise.resolve([
        row('e-1', 'run-1', { totalCostUsd: 0.25 }),
        row('e-2', 'run-1', { totalCostUsd: 0.5 })
      ])
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
    await watcher.seedFrom(Promise.resolve([row('e-1', 'run-1', { totalCostUsd: 1.5 })]));

    // The operator's resume clears the pair, as `PhaseControlService` does.
    runs.set('run-1', runFixture({ manualPauseAt: null, manualPauseCause: null }));
    watcher.onAuditEntry(row('e-2', 'run-1', { totalCostUsd: 0.5 }));
    await settle();
    expect(writes).toEqual([]);
  });

  it('S6: evaluates nothing at the seed, and pauses at the next live row', async () => {
    const { runs, writes, notices, watcher } = seedHarness({ limitUsd: 1, limitTokens: null });
    runs.set('run-1', runFixture());
    await watcher.seedFrom(Promise.resolve([row('e-1', 'run-1', { totalCostUsd: 1.5 })]));
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
    const pending = deferred<readonly AuditEntry[]>();
    const seeding = watcher.seedFrom(pending.promise);

    // 0.5 alone is under the bound, though 0.8 of earlier spend is still being read.
    watcher.onAuditEntry(row('live-1', 'run-1', { totalCostUsd: 0.5 }));
    await settle();
    expect(writes).toEqual([]);

    pending.resolve([row('seed-1', 'run-1', { totalCostUsd: 0.8 })]);
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
    expect(seeded.watcher.observedFor('run-1')).toEqual({ costUsd: 0.25, totalTokens: 10 });
    expect(seeded.watcher.observedFor('run-1')).toEqual(unseeded.watcher.observedFor('run-1'));
  });
});
