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
