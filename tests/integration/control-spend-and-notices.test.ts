import { describe, expect, it } from 'vitest';
import type { Memento } from '../../src/state/workspace-state';
import {
  CONTROL_FLOW_EVENT_TYPES,
  isKnownAuditEventType,
  type ControlFlowAuditPayload
} from '../../src/contracts/audit-events';
import { projectAuditPayload } from '../../src/audit/audit-payload';
import type { ExecutionFence } from '../../src/contracts/control-ledger';
import { ControlAttemptAdmissionService } from '../../src/services/workflow-execution/control-attempt-admission';
import { CandidateBlockExecutor } from '../../src/services/workflow-execution/candidate-block-executor';
import { ControlLedgerStore } from '../../src/services/workflow-execution/control-ledger-store';
import {
  ControlNotificationService,
  MAX_DECISION_SUMMARIES_PER_ROOT,
  MAX_SETTLED_CHECK_SUMMARIES_PER_ROOT,
  enforceBoundedRootHistory
} from '../../src/services/workflow-execution/control-notification-service';
import { ControlUsageAccountingService } from '../../src/services/workflow-execution/control-usage-accounting';

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

describe('Control spend, notifications, bounded history, and audit integration tests (FR-R5-F30 / SPEC-08)', () => {
  it('pauses strict-usd candidate dispatch when next attempt is unpriced or over limit and emits at-most-once notifications across restart and poll intervals', async () => {
    const memento = makeMemoryMemento();
    const ledgerStore = new ControlLedgerStore(memento);
    const emittedToasts: string[] = [];

    const notificationService = new ControlNotificationService({
      ledgerStore,
      emitToast: (n) => {
        emittedToasts.push(n.notificationId);
      }
    });
    const admissionService = new ControlAttemptAdmissionService({
      ledgerStore
    });
    const usageAccounting = new ControlUsageAccountingService({
      ledgerStore
    });
    const executor = new CandidateBlockExecutor({
      ledgerStore,
      admissionService,
      usageAccounting,
      notificationService
    });

    const fence = makeFence(1);
    await admissionService.prepareRootLink({
      ledgerRunId: 'root-spend',
      connectedRunId: 'run-spend',
      rootWorkflowId: 'wf-spend',
      queueId: 'default',
      fence,
      rootBudget: {
        version: 1,
        maxPhaseAttempts: 100,
        budgetMode: 'strict-usd',
        maxMicrousd: 50_000
      }
    });
    await admissionService.activateRootLink({
      ledgerRunId: 'root-spend',
      connectedRunId: 'run-spend',
      fence
    });

    await executor.initializeCandidateBlock({
      rootRunId: 'root-spend',
      workflowId: 'wf-spend',
      frameKey: 'frame:strict',
      invocationId: 'inv-strict',
      nodeId: 'node-strict',
      candidates: [
        {
          candidateId: 'cand-unpriced',
          nodeId: 'phase-unpriced',
          backend: 'codex',
          priority: 1,
          authoredOrder: 0,
          maxAttempts: 2
        }
      ],
      fence
    });

    // Attempting to dispatch under strict-usd without a qualified upperBoundMicrousd pauses with spend-unverifiable
    const stepUnpriced = await executor.stepCandidateBlock({
      rootRunId: 'root-spend',
      frameKey: 'frame:strict',
      fence,
      candidateSpecsById: {
        'cand-unpriced': {
          candidateId: 'cand-unpriced',
          nodeId: 'phase-unpriced',
          backend: 'codex',
          priority: 1,
          authoredOrder: 0,
          upperBoundQuality: 'unavailable'
        }
      }
    });
    expect(stepUnpriced.ok).toBe(false);
    expect(stepUnpriced.action.kind).toBe('pause-intervention');
    if (stepUnpriced.action.kind === 'pause-intervention') {
      expect(stepUnpriced.action.pauseCause).toBe('spend-unverifiable');
    }

    // Toast was emitted exactly once for deterministic notificationId
    expect(emittedToasts).toEqual([
      'root-spend/inv-strict/1/spend-unverifiable'
    ]);

    // Recording or flushing the same notification again across poll intervals / restart does NOT re-emit toast
    await notificationService.recordNotification({
      rootRunId: 'root-spend',
      invocationId: 'inv-strict',
      frameKey: 'frame:strict',
      generation: 1,
      reason: 'spend-unverifiable'
    });
    await notificationService.flushPendingNotifications('root-spend');
    expect(emittedToasts).toEqual([
      'root-spend/inv-strict/1/spend-unverifiable'
    ]);

    // Durable notice remains readable in editor / headless reads
    const notices = notificationService.getNotificationsForRoot('root-spend');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.delivery).toBe('claimed');
  });

  it('archives older settled/claimed history beyond 256 decision summaries and 64 settled-check summaries with an opaque archivedHistoryCursor while preserving pending notifications', () => {
    const decisionSummaries = Array.from({ length: 300 }, (_, i) => ({
      summaryId: `sum-${i + 1}`,
      rootRunId: 'root-hist',
      invocationId: 'inv-hist',
      frameKey: 'frame-hist',
      generation: 1,
      eventKind: 'candidate-selected' as const,
      candidateId: 'cand-1',
      createdAt: 1000 + i
    }));

    const settledCheckSummaries = Array.from({ length: 80 }, (_, i) => ({
      checkId: `chk-${i + 1}`,
      observationId: 'obs:claude',
      backend: 'claude' as const,
      sponsorRootRunId: 'root-hist',
      sharedObservation: false,
      status: 'completed' as const,
      costMicrousd: 0,
      settledAt: 2000 + i
    }));

    const pendingNotice = {
      notificationId: 'root-hist/inv-hist/1/waiting-availability',
      rootRunId: 'root-hist',
      invocationId: 'inv-hist',
      generation: 1,
      reason: 'waiting-availability' as const,
      createdAt: 5000,
      delivery: 'pending' as const
    };

    const bounded = enforceBoundedRootHistory({
      version: 1,
      ledgerRunId: 'root-hist',
      connectedRunId: 'run-hist',
      rootWorkflowId: 'wf-hist',
      queueId: 'default',
      linkState: 'active',
      status: 'in-flight',
      fence: makeFence(1),
      rootBudget: { version: 1, maxPhaseAttempts: 100 },
      dispatchedAttempts: 5,
      settledMicrousd: 0,
      reservedMicrousd: 0,
      framesByKey: {},
      attemptsById: {},
      decisionSummaries,
      settledCheckSummaries,
      notificationsById: {
        [pendingNotice.notificationId]: pendingNotice
      },
      createdAt: 1000,
      updatedAt: 5000
    });

    expect(bounded.decisionSummaries).toHaveLength(
      MAX_DECISION_SUMMARIES_PER_ROOT
    );
    expect(bounded.decisionSummaries?.[0]?.summaryId).toBe('sum-45');
    expect(bounded.settledCheckSummaries).toHaveLength(
      MAX_SETTLED_CHECK_SUMMARIES_PER_ROOT
    );
    expect(bounded.settledCheckSummaries?.[0]?.checkId).toBe('chk-17');
    expect(bounded.archivedHistoryCursor).toBeDefined();
    expect(bounded.archivedSummaryCount).toBe(44 + 16);
    // Pending notification is never discarded!
    expect(
      bounded.notificationsById?.[pendingNotice.notificationId]?.delivery
    ).toBe('pending');
  });

  it('registers all 6 metadata-only control-flow audit event types and projects them without leaking paths or free-form content', () => {
    expect(CONTROL_FLOW_EVENT_TYPES).toEqual([
      'control-decision',
      'control-attempt-admitted',
      'control-wait',
      'control-return',
      'control-notice',
      'control-command'
    ]);

    for (const eventType of CONTROL_FLOW_EVENT_TYPES) {
      expect(isKnownAuditEventType(eventType)).toBe(true);
      const samplePayload: ControlFlowAuditPayload = {
        rootRunId: 'root-1',
        invocationId: 'inv-1',
        frameKey: 'frame:cand-1',
        generation: 1,
        candidateId: 'cand-1',
        attemptId: 'att-1',
        attemptOrdinal: 1,
        backend: 'claude',
        reasonCode: 'candidate-switched',
        timestampMs: 1_234_567
      };
      const projected = projectAuditPayload(eventType, {
        ...samplePayload,
        prompt: 'should be omitted',
        stdout: 'should be omitted'
      });
      expect(projected.rootRunId).toBe('root-1');
      expect(projected.prompt).toBeUndefined();
      expect(projected.stdout).toBeUndefined();
    }
  });
});

