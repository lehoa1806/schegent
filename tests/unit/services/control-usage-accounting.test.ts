import { describe, expect, it } from 'vitest';
import type { Memento } from '../../../src/state/workspace-state';
import type { ExecutionFence } from '../../../src/contracts/control-ledger';
import { ControlAttemptAdmissionService } from '../../../src/services/workflow-execution/control-attempt-admission';
import { ControlLedgerStore } from '../../../src/services/workflow-execution/control-ledger-store';
import {
  ControlUsageAccountingService,
  checkStrictUsdAdmission,
  createEmptyRootUsageRollup,
  deriveFrozenRootBudget,
  validateUsageRecord
} from '../../../src/services/workflow-execution/control-usage-accounting';
import { preserveSpendTotalAcrossBackendSwitch } from '../../../src/services/spend-bound';
import { resolveRootControlBudgetLimits } from '../../../src/services/effective-limits';

function makeMemoryMemento(): Memento {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return map.has(key) ? (map.get(key) as T) : defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) {
        map.delete(key);
      } else {
        map.set(key, structuredClone(value));
      }
    }
  };
}

function makeFence(rootGeneration = 1): ExecutionFence {
  return {
    primacyClaim: 'primacy-1',
    queueClaim: 'queue-1',
    rootGeneration
  };
}

describe('ControlUsageAccountingService unit tests (FR-R5-F30 / SPEC-08 / D6)', () => {
  it('validates closed UsageRecord shape with attemptId XOR checkId and rejects unknown fields or unavailable costMicrousd', () => {
    const validAttempt = validateUsageRecord({
      attemptId: 'att-1',
      backend: 'claude',
      modelId: 'claude-3-7-sonnet',
      denomination: 'usd',
      quality: 'verified',
      inputTokens: 1200,
      outputTokens: 300,
      cachedTokens: 100,
      costMicrousd: 15_000,
      upperBoundMicrousd: 20_000
    });
    expect(validAttempt.ok).toBe(true);

    const validCheck = validateUsageRecord({
      checkId: 'chk-1',
      backend: 'claude',
      denomination: 'usd',
      quality: 'verified',
      costMicrousd: 0,
      upperBoundMicrousd: 0,
      sharedObservation: true
    });
    expect(validCheck.ok).toBe(true);

    // Reject both attemptId and checkId
    const bothIds = validateUsageRecord({
      attemptId: 'att-1',
      checkId: 'chk-1',
      backend: 'claude',
      denomination: 'usd',
      quality: 'verified'
    });
    expect(bothIds.ok).toBe(false);

    // Reject neither attemptId nor checkId
    const neitherId = validateUsageRecord({
      backend: 'claude',
      denomination: 'usd',
      quality: 'verified'
    });
    expect(neitherId.ok).toBe(false);

    // Reject quality: unavailable with costMicrousd
    const unavailableWithCost = validateUsageRecord({
      attemptId: 'att-2',
      backend: 'codex',
      denomination: 'tokens',
      quality: 'unavailable',
      costMicrousd: 0
    });
    expect(unavailableWithCost.ok).toBe(false);

    // Reject unknown field
    const unknownKey = validateUsageRecord({
      attemptId: 'att-3',
      backend: 'claude',
      denomination: 'usd',
      quality: 'verified',
      extraField: true
    });
    expect(unknownKey.ok).toBe(false);
  });

  it('derives frozen root budget (minimum strict-usd limit across reachable blocks or count-only) and allows live caps to tighten only', () => {
    const derivedStrict = deriveFrozenRootBudget(
      [
        { budgetMode: 'count-only' },
        { budgetMode: 'strict-usd', limitMicrousd: 500_000 },
        { budgetMode: 'strict-usd', limitMicrousd: 250_000 }
      ],
      { liveHostCapMicrousd: 200_000 }
    );
    expect(derivedStrict.budgetMode).toBe('strict-usd');
    expect(derivedStrict.frozenLimitMicrousd).toBe(250_000);
    expect(derivedStrict.effectiveLimitMicrousd).toBe(200_000);

    // Live cap larger than frozen cap never increases the effective cap
    const derivedNoIncrease = resolveRootControlBudgetLimits({
      maxPhaseAttempts: 100,
      budgetMode: 'strict-usd',
      frozenLimitMicrousd: 250_000,
      liveLimitMicrousd: 900_000
    });
    expect(derivedNoIncrease.effectiveLimitMicrousd).toBe(250_000);

    const derivedCountOnly = deriveFrozenRootBudget([
      { budgetMode: 'count-only' }
    ]);
    expect(derivedCountOnly.budgetMode).toBe('count-only');
    expect(derivedCountOnly.frozenLimitMicrousd).toBeUndefined();
  });

  it('enforces strict-usd pre-dispatch admission (spend-unverifiable and spend-limit-reached)', () => {
    const baseRollup = createEmptyRootUsageRollup();
    const strictBudget = {
      version: 1 as const,
      maxPhaseAttempts: 100,
      budgetMode: 'strict-usd' as const,
      maxMicrousd: 100_000
    };

    // Missing upper bound -> spend-unverifiable
    const missingBound = checkStrictUsdAdmission({
      rootBudget: strictBudget,
      rollup: baseRollup
    });
    expect(missingBound.allowed).toBe(false);
    if (!missingBound.allowed) {
      expect(missingBound.pauseReason).toBe('spend-unverifiable');
    }

    // Prior unpriced attempt -> spend-unverifiable
    const withUnpriced = checkStrictUsdAdmission({
      rootBudget: strictBudget,
      rollup: { ...baseRollup, unpricedAttemptCount: 1 },
      upperBoundMicrousd: 10_000,
      upperBoundQuality: 'verified'
    });
    expect(withUnpriced.allowed).toBe(false);
    if (!withUnpriced.allowed) {
      expect(withUnpriced.pauseReason).toBe('spend-unverifiable');
    }

    // Exceeds limit -> spend-limit-reached
    const overLimit = checkStrictUsdAdmission({
      rootBudget: strictBudget,
      rollup: {
        ...baseRollup,
        verifiedMicrousd: 60_000,
        reservedMicrousd: 25_000
      },
      upperBoundMicrousd: 20_000,
      upperBoundQuality: 'verified'
    });
    expect(overLimit.allowed).toBe(false);
    if (!overLimit.allowed) {
      expect(overLimit.pauseReason).toBe('spend-limit-reached');
    }

    // Within limit -> allowed
    const withinLimit = checkStrictUsdAdmission({
      rootBudget: strictBudget,
      rollup: {
        ...baseRollup,
        verifiedMicrousd: 60_000,
        reservedMicrousd: 20_000
      },
      upperBoundMicrousd: 20_000,
      upperBoundQuality: 'verified'
    });
    expect(withinLimit.allowed).toBe(true);
    if (withinLimit.allowed) {
      expect(withinLimit.reservedMicrousd).toBe(20_000);
    }
  });

  it('reconciles attempt usage, never coerces unpriced token usage to 0 verified USD, retains uncertain reservations, and flags spend-bound-exceeded', async () => {
    const ledgerStore = new ControlLedgerStore(makeMemoryMemento());
    const admission = new ControlAttemptAdmissionService({ ledgerStore });
    const accounting = new ControlUsageAccountingService({ ledgerStore });
    const fence = makeFence(1);

    await admission.prepareRootLink({
      ledgerRunId: 'root-u',
      connectedRunId: 'run-u',
      rootWorkflowId: 'wf-1',
      queueId: 'default',
      fence,
      rootBudget: {
        version: 1,
        maxPhaseAttempts: 100,
        budgetMode: 'strict-usd',
        maxMicrousd: 500_000
      }
    });
    await admission.activateRootLink({
      ledgerRunId: 'root-u',
      connectedRunId: 'run-u',
      fence
    });

    // Attempt 1: claude with reserved 50_000 micro-USD, settles at 60_000 micro-USD (spend-bound-exceeded)
    const prep1 = await admission.prepareAttempt({
      ledgerRunId: 'root-u',
      connectedRunId: 'run-u',
      queueId: 'default',
      frameKey: 'root',
      workflowId: 'wf-1',
      invocationId: 'inv-1',
      nodeId: 'node-1',
      attemptId: 'att-1',
      backend: 'claude',
      reservedMicrousd: 50_000,
      fence
    });
    expect(prep1.ok).toBe(true);
    if (prep1.ok) {
      await admission.commitAttempt(prep1.token);
    }

    const rec1 = await accounting.reconcileAttemptUsage({
      rootRunId: 'root-u',
      attemptId: 'att-1',
      fence,
      usageRecord: {
        attemptId: 'att-1',
        backend: 'claude',
        denomination: 'usd',
        quality: 'verified',
        inputTokens: 1000,
        outputTokens: 500,
        costMicrousd: 60_000,
        upperBoundMicrousd: 50_000
      }
    });
    expect(rec1.ok).toBe(true);
    if (rec1.ok) {
      expect(rec1.spendBoundExceeded).toBe(true);
      expect(rec1.pauseReason).toBe('spend-bound-exceeded');
      expect(rec1.rollup.verifiedMicrousd).toBe(60_000);
      expect(rec1.rollup.reservedMicrousd).toBe(0);
    }

    // Attempt 2 on a second active root: codex token-only (quality: unavailable) -> increments unpricedAttemptCount and keeps verifiedMicrousd at 0
    await admission.prepareRootLink({
      ledgerRunId: 'root-u2',
      connectedRunId: 'run-u2',
      rootWorkflowId: 'wf-1',
      queueId: 'default-2',
      fence,
      rootBudget: {
        version: 1,
        maxPhaseAttempts: 100,
        budgetMode: 'count-only'
      }
    });
    await admission.activateRootLink({
      ledgerRunId: 'root-u2',
      connectedRunId: 'run-u2',
      fence
    });

    const prep2 = await admission.prepareAttempt({
      ledgerRunId: 'root-u2',
      connectedRunId: 'run-u2',
      queueId: 'default-2',
      frameKey: 'root',
      workflowId: 'wf-1',
      invocationId: 'inv-1',
      nodeId: 'node-2',
      attemptId: 'att-2',
      backend: 'codex',
      reservedMicrousd: 0,
      fence
    });
    expect(prep2.ok).toBe(true);
    if (prep2.ok) {
      await admission.commitAttempt(prep2.token);
    }

    const rec2 = await accounting.reconcileAttemptUsage({
      rootRunId: 'root-u2',
      attemptId: 'att-2',
      fence,
      usageRecord: {
        attemptId: 'att-2',
        backend: 'codex',
        denomination: 'tokens',
        quality: 'unavailable',
        inputTokens: 2500,
        outputTokens: 800
      }
    });
    expect(rec2.ok).toBe(true);
    if (rec2.ok) {
      expect(rec2.rollup.verifiedMicrousd).toBe(0);
      expect(rec2.rollup.unpricedAttemptCount).toBe(1);
      expect(Object.entries(rec2.rollup.tokensByBackend).find(([k]) => k === 'codex')?.[1].inputTokens).toBe(2500);
    }

    // Preserve spend total helper keeps both USD and token totals across backend switches
    const preserved = preserveSpendTotalAcrossBackendSwitch({
      costUsd: 0.06,
      totalTokens: 4800,
      completeness: { kind: 'complete' },
      countedRowIds: new Set(['r1', 'r2'])
    });
    expect(preserved.costUsd).toBe(0.06);
    expect(preserved.totalTokens).toBe(4800);
    expect(preserved.countedRowIds.size).toBe(2);
  });

  it('sponsors deduplicated availability checks once on the lowest-sequence eligible root and marks other subscribers sharedObservation: true', async () => {
    const ledgerStore = new ControlLedgerStore(makeMemoryMemento());
    const admission = new ControlAttemptAdmissionService({ ledgerStore });
    const accounting = new ControlUsageAccountingService({ ledgerStore });
    const fence = makeFence(1);

    for (const rootId of ['root-a', 'root-b']) {
      await admission.prepareRootLink({
        ledgerRunId: rootId,
        connectedRunId: `run-${rootId}`,
        rootWorkflowId: 'wf-1',
        queueId: `q-${rootId}`,
        fence,
        rootBudget: {
          version: 1,
          maxPhaseAttempts: 100,
          budgetMode: 'strict-usd',
          maxMicrousd: 100_000
        }
      });
      await admission.activateRootLink({
        ledgerRunId: rootId,
        connectedRunId: `run-${rootId}`,
        fence
      });
    }

    const sponsorRes = await accounting.selectSharedCheckSponsor({
      checkId: 'chk-shared-1',
      observationId: 'obs:claude',
      backend: 'claude',
      upperBoundMicrousd: 5_000,
      upperBoundQuality: 'verified',
      subscribers: [
        { rootRunId: 'root-b', sequence: 2, generation: 1 },
        { rootRunId: 'root-a', sequence: 1, generation: 1 }
      ]
    });
    expect(sponsorRes.ok).toBe(true);
    if (sponsorRes.ok) {
      expect(sponsorRes.sponsorRootRunId).toBe('root-a');
      expect(sponsorRes.sharedSubscriberRootIds).toEqual(['root-b']);
      expect(sponsorRes.reservedMicrousd).toBe(5_000);
    }

    const reconciled = await accounting.reconcileSharedCheckUsage({
      checkId: 'chk-shared-1',
      observationId: 'obs:claude',
      sponsorRootRunId: 'root-a',
      sharedSubscriberRootIds: ['root-b'],
      status: 'completed',
      usageRecord: {
        checkId: 'chk-shared-1',
        backend: 'claude',
        denomination: 'usd',
        quality: 'verified',
        costMicrousd: 3_000,
        upperBoundMicrousd: 5_000
      }
    });
    expect(reconciled.ok).toBe(true);

    const rollupA = accounting.getRootUsageRollup('root-a')!;
    const rollupB = accounting.getRootUsageRollup('root-b')!;
    expect(rollupA.verifiedMicrousd).toBe(3_000);
    expect(rollupA.sharedCheckMicrousd).toBe(3_000);
    expect(
      Object.entries(rollupA.usageRecordsByRef).find(([k]) => k === 'check:chk-shared-1')?.[1].sharedObservation
    ).toBe(false);
    expect(rollupB.verifiedMicrousd).toBe(0);
    expect(
      Object.entries(rollupB.usageRecordsByRef).find(([k]) => k === 'check:chk-shared-1')?.[1].sharedObservation
    ).toBe(true);
  });
});
