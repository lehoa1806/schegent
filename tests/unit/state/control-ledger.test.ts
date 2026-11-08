import { describe, expect, it } from 'vitest';
import {
  CONTROL_LEDGER_VERSION,
  MAX_ACTIVE_AVAILABILITY_CHECKS,
  MAX_FRAMES_PER_ROOT,
  MAX_LIVE_CONTROL_ROOTS,
  MAX_QUOTA_WAITERS,
  MAX_ROOT_LEDGER_BYTES,
  ROOT_SETTLEMENT_RESERVE_BYTES,
  type ControlFrame,
  type ExecutionFence
} from '../../../src/contracts/control-ledger';
import { ControlAttemptAdmissionService } from '../../../src/services/workflow-execution/control-attempt-admission';
import {
  ControlLedgerStore,
  lookupRecord,
  measureRootLedgerBytes
} from '../../../src/services/workflow-execution/control-ledger-store';
import { KEYS, WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';

function createMemoryMemento(seed: Record<string, unknown> = {}): Memento & {
  readonly rawMap: Map<string, unknown>;
} {
  const rawMap = new Map<string, unknown>(Object.entries(seed));
  return {
    rawMap,
    get<T>(key: string): T | undefined {
      return rawMap.get(key) as T | undefined;
    },
    update(key: string, value: unknown): Thenable<void> {
      if (value === undefined) {
        rawMap.delete(key);
      } else {
        rawMap.set(key, JSON.parse(JSON.stringify(value)));
      }
      return Promise.resolve();
    }
  };
}

const DEFAULT_FENCE: ExecutionFence = {
  primacyClaim: 'primacy-win-1',
  queueClaim: 'queue-claim-1',
  rootGeneration: 1
};

describe('ControlLedgerStore & ControlAttemptAdmissionService (FR-R5-F26 / SPEC-04)', () => {
  it('initializes an empty v1 ledger on first read and clears schegent.controlLedger on WorkspaceStateStore.reset()', async () => {
    const m = createMemoryMemento();
    const wsStore = new WorkspaceStateStore(m);
    const ledgerStore = new ControlLedgerStore(wsStore);
    const admission = new ControlAttemptAdmissionService({ ledgerStore });

    const initial = ledgerStore.read();
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    expect(initial.ledger.version).toBe(CONTROL_LEDGER_VERSION);
    expect(initial.ledger.revision).toBe(0);

    const preparedRoot = await admission.prepareRootLink({
      ledgerRunId: 'ledger-1',
      connectedRunId: 'crun-1',
      rootWorkflowId: 'wf-main',
      queueId: 'default',
      fence: DEFAULT_FENCE
    });
    expect(preparedRoot.ok).toBe(true);
    expect(m.rawMap.has(KEYS.controlLedger)).toBe(true);

    await wsStore.reset();
    expect(m.rawMap.has(KEYS.controlLedger)).toBe(false);
  });

  it('keeps prepareAttempt side-effect-free and commits counters, attempt stage, candidate selection, permit, and waiter removal in one atomic write', async () => {
    const m = createMemoryMemento();
    const ledgerStore = new ControlLedgerStore(m);
    let nowMs = 10_000;
    const admission = new ControlAttemptAdmissionService({
      ledgerStore,
      clock: {
        nowWallMs: () => nowMs,
        nowMonotonicMs: () => nowMs
      }
    });

    await admission.prepareRootLink({
      ledgerRunId: 'ledger-1',
      connectedRunId: 'crun-1',
      rootWorkflowId: 'wf-main',
      queueId: 'default',
      fence: DEFAULT_FENCE,
      rootBudget: {
        version: 1,
        maxPhaseAttempts: 10,
        strictUsdBudget: { mode: 'strict-usd', limitMicrousd: 500_000 }
      }
    });
    await admission.activateRootLink({
      ledgerRunId: 'ledger-1',
      connectedRunId: 'crun-1',
      fence: DEFAULT_FENCE
    });

    // Seed a waiter to verify atomic waiter removal during commitAttempt
    await ledgerStore.mutate({}, ({ ledger }) => ({
      commit: true,
      plan: {
        nextLedger: {
          ...ledger,
          waiters: [
            {
              waiterId: 'waiter-1',
              waitSequence: 1,
              ledgerRunId: 'ledger-1',
              connectedRunId: 'crun-1',
              queueId: 'default',
              frameKey: 'cand-frame-1',
              invocationId: 'crun-1:child-1',
              nodeId: 'cand-node-a',
              candidateId: 'cand-a',
              quotaKeys: ['quota:claude'],
              status: 'waiting',
              enqueuedAt: 9_500,
              updatedAt: 9_500
            }
          ]
        },
        result: undefined
      }
    }));

    const beforePrep = ledgerStore.read();
    expect(beforePrep.ok).toBe(true);
    if (!beforePrep.ok) return;
    const revisionBeforePrep = beforePrep.ledger.revision;

    const prep = await admission.prepareAttempt({
      ledgerRunId: 'ledger-1',
      connectedRunId: 'crun-1',
      queueId: 'default',
      frameKey: 'cand-frame-1',
      frameKind: 'candidate-block',
      workflowId: 'wf-cand',
      invocationId: 'crun-1:child-1',
      nodeId: 'cand-node-a',
      candidateId: 'cand-a',
      backend: 'claude',
      reservedMicrousd: 120_000,
      fence: DEFAULT_FENCE,
      quotaKeys: ['quota:claude'],
      satisfiedWaiterId: 'waiter-1',
      maxDispatches: 4,
      candidateMaxAttempts: 2
    });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;

    // Verify zero side effects after prepareAttempt
    const afterPrep = ledgerStore.read();
    expect(afterPrep.ok).toBe(true);
    if (!afterPrep.ok) return;
    expect(afterPrep.ledger.revision).toBe(revisionBeforePrep);
    expect(lookupRecord(afterPrep.ledger.roots, 'ledger-1')?.dispatchedAttempts).toBe(0);
    expect(afterPrep.ledger.waiters).toHaveLength(1);
    expect(Object.keys(afterPrep.ledger.permits)).toHaveLength(0);

    nowMs = 10_500;
    const committed = await admission.commitAttempt(prep.token);
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    expect(committed.ledger.revision).toBe(revisionBeforePrep + 1);
    expect(committed.root.dispatchedAttempts).toBe(1);
    expect(committed.root.reservedMicrousd).toBe(120_000);
    expect(committed.frame.dispatchedCount).toBe(1);
    expect(committed.frame.selectedCandidateId).toBe('cand-a');
    expect(committed.attempt.stage).toBe('pending-dispatch');
    expect(committed.attempt.candidateId).toBe('cand-a');
    expect(committed.permit?.status).toBe('active');
    expect(committed.ledger.waiters).toHaveLength(0);

    // Reusing the same prepare token must be rejected
    const replayCommit = await admission.commitAttempt(prep.token);
    expect(replayCommit.ok).toBe(false);
    if (!replayCommit.ok) {
      expect(replayCommit.code).toBe('prepare-token-consumed');
    }
  });

  it('preserves unknown top-level ledger versions and unknown per-root versions without resetting state', async () => {
    const futureLedger = {
      version: 2,
      revision: 9,
      futureField: 'keep-me'
    };
    const m = createMemoryMemento({ [KEYS.controlLedger]: futureLedger });
    const ledgerStore = new ControlLedgerStore(m);

    const readFuture = ledgerStore.read();
    expect(readFuture.ok).toBe(false);
    if (!readFuture.ok) {
      expect(readFuture.code).toBe('unsupported-control-ledger-version');
    }

    const mutateFuture = await ledgerStore.mutate({}, ({ ledger }) => ({
      commit: true,
      plan: { nextLedger: ledger, result: undefined }
    }));
    expect(mutateFuture.ok).toBe(false);
    if (!mutateFuture.ok) {
      expect(mutateFuture.code).toBe('unsupported-control-ledger-version');
    }
    expect(m.rawMap.get(KEYS.controlLedger)).toEqual(futureLedger);

    // Unknown per-root version inside a v1 ledger survives unrelated root writes
    const mixedLedger = {
      version: 1,
      revision: 3,
      nextWaitSequence: 1,
      roots: {
        'future-root': {
          version: 99,
          ledgerRunId: 'future-root',
          customPayload: 'do-not-delete'
        }
      },
      quotaObservations: {},
      checks: {},
      waiters: [],
      permits: {}
    };
    const mMixed = createMemoryMemento({ [KEYS.controlLedger]: mixedLedger });
    const mixedStore = new ControlLedgerStore(mMixed);
    const admission = new ControlAttemptAdmissionService({ ledgerStore: mixedStore });

    const prepNew = await admission.prepareRootLink({
      ledgerRunId: 'v1-root',
      connectedRunId: 'crun-v1',
      rootWorkflowId: 'wf-1',
      queueId: 'default',
      fence: DEFAULT_FENCE
    });
    expect(prepNew.ok).toBe(true);

    const persistedMixed = mMixed.rawMap.get(KEYS.controlLedger) as {
      roots: Record<string, unknown>;
    };
    expect(persistedMixed.roots['future-root']).toEqual({
      version: 99,
      ledgerRunId: 'future-root',
      customPayload: 'do-not-delete'
    });
  });

  it('enforces MAX_LIVE_CONTROL_ROOTS (evicting oldest terminal roots first), MAX_FRAMES_PER_ROOT, MAX_QUOTA_WAITERS, MAX_ACTIVE_AVAILABILITY_CHECKS, and ROOT_SETTLEMENT_RESERVE_BYTES', async () => {
    const m = createMemoryMemento();
    const ledgerStore = new ControlLedgerStore(m);
    const admission = new ControlAttemptAdmissionService({ ledgerStore });

    // Create 20 roots: mark the first 2 as terminal ('completed') and 18 as active ('in-flight')
    for (let i = 1; i <= MAX_LIVE_CONTROL_ROOTS; i += 1) {
      const rootId = `root-${String(i).padStart(2, '0')}`;
      const prep = await admission.prepareRootLink({
        ledgerRunId: rootId,
        connectedRunId: `crun-${i}`,
        rootWorkflowId: 'wf-1',
        queueId: 'default',
        fence: DEFAULT_FENCE
      });
      expect(prep.ok).toBe(true);
      if (i <= 2) {
        await ledgerStore.mutate({ targetRootId: rootId }, ({ ledger }) => {
          const r = ledger.roots[rootId]!;
          return {
            commit: true,
            plan: {
              nextLedger: {
                ...ledger,
                roots: {
                  ...ledger.roots,
                  [rootId]: {
                    ...r,
                    linkState: 'terminal',
                    status: 'completed',
                    completedAt: i * 100
                  }
                }
              },
              targetRootId: rootId,
              result: undefined
            }
          };
        });
      } else {
        await admission.activateRootLink({
          ledgerRunId: rootId,
          connectedRunId: `crun-${i}`,
          fence: DEFAULT_FENCE
        });
      }
    }

    // Adding a 21st root evicts the oldest terminal root ('root-01')
    const root21 = await admission.prepareRootLink({
      ledgerRunId: 'root-21',
      connectedRunId: 'crun-21',
      rootWorkflowId: 'wf-1',
      queueId: 'default',
      fence: DEFAULT_FENCE
    });
    expect(root21.ok).toBe(true);
    expect(ledgerStore.getRoot('root-01')).toBeNull();
    expect(ledgerStore.getRoot('root-02')).not.toBeNull();

    // Adding a 22nd root evicts 'root-02'
    const root22 = await admission.prepareRootLink({
      ledgerRunId: 'root-22',
      connectedRunId: 'crun-22',
      rootWorkflowId: 'wf-1',
      queueId: 'default',
      fence: DEFAULT_FENCE
    });
    expect(root22.ok).toBe(true);
    expect(ledgerStore.getRoot('root-02')).toBeNull();

    // Now all 20 roots are non-terminal: adding a 23rd root must fail with 'control-root-limit-exceeded'
    const root23 = await admission.prepareRootLink({
      ledgerRunId: 'root-23',
      connectedRunId: 'crun-23',
      rootWorkflowId: 'wf-1',
      queueId: 'default',
      fence: DEFAULT_FENCE
    });
    expect(root23.ok).toBe(false);
    if (!root23.ok) {
      expect(root23.code).toBe('control-root-limit-exceeded');
    }

    // Check MAX_FRAMES_PER_ROOT (1024)
    const manyFrames: Record<string, ControlFrame> = {};
    for (let f = 0; f <= MAX_FRAMES_PER_ROOT; f += 1) {
      manyFrames[`f-${f}`] = {
        frameKey: `f-${f}`,
        parentFrameKey: f === 0 ? null : 'f-0',
        invocationId: `inv-${f}`,
        workflowId: 'wf-1',
        kind: 'child-workflow',
        status: 'in-flight',
        createdAt: 1,
        updatedAt: 1,
        dispatchedCount: 0
      };
    }
    const overFrames = await ledgerStore.mutate(
      { targetRootId: 'root-03' },
      ({ ledger }) => {
        const r = ledger.roots['root-03']!;
        return {
          commit: true,
          plan: {
            nextLedger: {
              ...ledger,
              roots: {
                ...ledger.roots,
                'root-03': { ...r, framesByKey: manyFrames }
              }
            },
            targetRootId: 'root-03',
            result: undefined
          }
        };
      }
    );
    expect(overFrames.ok).toBe(false);
    if (!overFrames.ok) {
      expect(overFrames.code).toBe('control-frame-limit-exceeded');
    }

    // Check MAX_ACTIVE_AVAILABILITY_CHECKS (3)
    const overChecks = await ledgerStore.mutate({}, ({ ledger }) => ({
      commit: true,
      plan: {
        nextLedger: {
          ...ledger,
          checks: Object.fromEntries(
            Array.from({ length: MAX_ACTIVE_AVAILABILITY_CHECKS + 1 }, (_, idx) => [
              `chk-${idx}`,
              {
                checkId: `chk-${idx}`,
                quotaKey: `q-${idx}`,
                backend: 'claude' as const,
                sponsorLedgerRunId: 'root-03',
                status: 'running' as const,
                startedAt: 100,
                deadlineAt: 200
              }
            ])
          )
        },
        result: undefined
      }
    }));
    expect(overChecks.ok).toBe(false);
    if (!overChecks.ok) {
      expect(overChecks.code).toBe('control-check-limit-exceeded');
    }

    // Check MAX_QUOTA_WAITERS (160)
    const overWaiters = await ledgerStore.mutate({}, ({ ledger }) => ({
      commit: true,
      plan: {
        nextLedger: {
          ...ledger,
          waiters: Array.from({ length: MAX_QUOTA_WAITERS + 1 }, (_, idx) => ({
            waiterId: `w-${idx}`,
            waitSequence: idx + 1,
            ledgerRunId: 'root-03',
            connectedRunId: 'crun-3',
            queueId: 'default',
            frameKey: 'root',
            invocationId: 'inv-1',
            nodeId: 'n-1',
            quotaKeys: ['q-1'],
            status: 'waiting' as const,
            enqueuedAt: 100,
            updatedAt: 100
          }))
        },
        result: undefined
      }
    }));
    expect(overWaiters.ok).toBe(false);
    if (!overWaiters.ok) {
      expect(overWaiters.code).toBe('control-waiter-limit-exceeded');
    }

    // Check MAX_ROOT_LEDGER_BYTES (2 MiB) & ROOT_SETTLEMENT_RESERVE_BYTES (16 KiB):
    // First admit one attempt on root-03, then pad root-03 close to the non-settlement ceiling
    const firstPrep = await admission.prepareAttempt({
      ledgerRunId: 'root-03',
      connectedRunId: 'crun-3',
      queueId: 'default',
      frameKey: 'root',
      workflowId: 'wf-1',
      invocationId: 'crun-3:root',
      nodeId: 'node-1',
      attemptId: 'att-settle-me',
      backend: 'claude',
      fence: DEFAULT_FENCE
    });
    expect(firstPrep.ok).toBe(true);
    if (!firstPrep.ok) return;
    const firstCommit = await admission.commitAttempt(firstPrep.token);
    expect(firstCommit.ok).toBe(true);

    // Pad root-03 with frames so its serialized size is inside the 16 KiB settlement reserve
    // (between MAX_ROOT_LEDGER_BYTES - ROOT_SETTLEMENT_RESERVE_BYTES and MAX_ROOT_LEDGER_BYTES)
    const padChunk = 'x'.repeat(2_000);
    const paddedFrames: Record<string, ControlFrame> = {
      ...ledgerStore.getRoot('root-03')!.framesByKey
    };
    for (let i = 0; i < 950; i += 1) {
      const k = `pad-${String(i).padStart(4, '0')}`;
      paddedFrames[k] = {
        frameKey: k,
        parentFrameKey: 'root',
        invocationId: `inv-${k}-${padChunk}`,
        workflowId: 'wf-1',
        kind: 'child-workflow',
        status: 'completed',
        createdAt: 1,
        updatedAt: 1,
        dispatchedCount: 1
      };
    }

    const paddedWrite = await ledgerStore.mutate(
      { targetRootId: 'root-03', allowSettlementReserve: true },
      ({ ledger }) => {
        const r = ledger.roots['root-03']!;
        const candidate: typeof r = { ...r, framesByKey: paddedFrames };
        return {
          commit: true,
          plan: {
            nextLedger: {
              ...ledger,
              roots: { ...ledger.roots, 'root-03': candidate }
            },
            targetRootId: 'root-03',
            allowSettlementReserve: true,
            result: measureRootLedgerBytes(candidate)
          }
        };
      }
    );
    expect(paddedWrite.ok).toBe(true);
    if (!paddedWrite.ok) return;
    expect(paddedWrite.result).toBeGreaterThan(
      MAX_ROOT_LEDGER_BYTES - ROOT_SETTLEMENT_RESERVE_BYTES
    );
    expect(paddedWrite.result).toBeLessThan(MAX_ROOT_LEDGER_BYTES);

    // Non-settlement prepareAttempt must now be rejected with 'control-ledger-size-exceeded'
    const blockedPrep = await admission.prepareAttempt({
      ledgerRunId: 'root-03',
      connectedRunId: 'crun-3',
      queueId: 'default',
      frameKey: 'root',
      workflowId: 'wf-1',
      invocationId: 'crun-3:root',
      nodeId: 'node-1',
      attemptId: 'att-blocked',
      backend: 'claude',
      fence: DEFAULT_FENCE
    });
    expect(blockedPrep.ok).toBe(false);
    if (!blockedPrep.ok) {
      expect(blockedPrep.code).toBe('control-ledger-size-exceeded');
    }

    // Terminal settlement of the existing in-flight attempt must still succeed using the 16 KiB reserve!
    const settled = await admission.settleAttempt({
      ledgerRunId: 'root-03',
      attemptId: 'att-settle-me',
      fence: DEFAULT_FENCE,
      terminalStatus: 'completed',
      settledMicrousd: 500
    });
    expect(settled.ok).toBe(true);
  });
});
