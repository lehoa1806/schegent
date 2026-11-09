import { describe, expect, it } from 'vitest';
import {
  MAX_LIVE_CONTROL_ROOTS,
  MAX_ROOT_LEDGER_BYTES,
  ROOT_SETTLEMENT_RESERVE_BYTES,
  type ControlFrame,
  type ExecutionFence
} from '../../../src/contracts/control-ledger';
import {
  classifySettlementWrite,
  evaluateMatrixCellFeasibility
} from '../../../src/services/runtime-resource-budgets/settlement-write-outcome';
import { ControlAttemptAdmissionService } from '../../../src/services/workflow-execution/control-attempt-admission';
import {
  ControlLedgerStore,
  measureRootLedgerBytes
} from '../../../src/services/workflow-execution/control-ledger-store';
import type { Memento } from '../../../src/state/workspace-state';

function createMemoryMemento(options?: { failUpdates?: boolean }): Memento & {
  readonly rawMap: Map<string, unknown>;
  failUpdates: boolean;
} {
  const rawMap = new Map<string, unknown>();
  const state = {
    rawMap,
    failUpdates: options?.failUpdates ?? false,
    get<T>(key: string): T | undefined {
      return rawMap.get(key) as T | undefined;
    },
    update(key: string, value: unknown): Thenable<void> {
      if (state.failUpdates) {
        return Promise.reject(new Error('ENOSPC: no space left on device'));
      }
      if (value === undefined) {
        rawMap.delete(key);
      } else {
        rawMap.set(key, JSON.parse(JSON.stringify(value)));
      }
      return Promise.resolve();
    }
  };
  return state;
}

const DEFAULT_FENCE: ExecutionFence = {
  primacyClaim: 'primacy-win-1',
  queueClaim: 'queue-claim-1',
  rootGeneration: 1
};

function buildFramesForTargetBytes(
  existingFrames: Readonly<Record<string, ControlFrame>>,
  targetBytes: number
): Record<string, ControlFrame> {
  const frames: Record<string, ControlFrame> = { ...existingFrames };
  const perFramePayload = 'x'.repeat(2_000);
  const frameApproxBytes = 2_202;
  const neededFrames = Math.min(948, Math.max(1, Math.floor(targetBytes / frameApproxBytes)));
  for (let i = 0; i < neededFrames; i += 1) {
    const k = `pad-${String(i).padStart(4, '0')}`;
    frames[k] = {
      frameKey: k,
      parentFrameKey: 'root',
      invocationId: `inv-${k}-${perFramePayload}`,
      workflowId: 'wf-matrix',
      kind: 'child-workflow',
      status: 'completed',
      createdAt: 1,
      updatedAt: 1,
      dispatchedCount: 1
    };
  }
  return frames;
}

describe('Control-ledger matrix and settlement write outcomes (T014, T015, FR-005, FR-008, FR-020, SC-008)', () => {
  it.each([
    { rootCount: 1, targetBytes: 64 * 1024 },
    { rootCount: 1, targetBytes: 512 * 1024 },
    { rootCount: 1, targetBytes: MAX_ROOT_LEDGER_BYTES - ROOT_SETTLEMENT_RESERVE_BYTES },
    { rootCount: 5, targetBytes: 64 * 1024 },
    { rootCount: 5, targetBytes: 512 * 1024 },
    { rootCount: 20, targetBytes: 64 * 1024 },
    { rootCount: 20, targetBytes: 512 * 1024 }
  ])(
    'builds matrix cell rootCount=$rootCount targetBytes=$targetBytes and preserves active roots',
    async ({ rootCount, targetBytes }) => {
      const feasibility = evaluateMatrixCellFeasibility({
        rootCount,
        targetRootBytes: targetBytes
      });
      expect(feasibility.status).toBe('feasible');

      const memento = createMemoryMemento();
      const ledgerStore = new ControlLedgerStore(memento);
      const admission = new ControlAttemptAdmissionService({ ledgerStore });

      for (let i = 1; i <= rootCount; i += 1) {
        const rootId = `root-${String(i).padStart(2, '0')}`;
        const prep = await admission.prepareRootLink({
          ledgerRunId: rootId,
          connectedRunId: `crun-${i}`,
          rootWorkflowId: 'wf-matrix',
          queueId: 'default',
          fence: DEFAULT_FENCE
        });
        expect(prep.ok).toBe(true);
        await admission.activateRootLink({
          ledgerRunId: rootId,
          connectedRunId: `crun-${i}`,
          fence: DEFAULT_FENCE
        });

        const padded = buildFramesForTargetBytes(
          ledgerStore.getRoot(rootId)!.framesByKey,
          Math.min(targetBytes, 512 * 1024)
        );
        const wr = await ledgerStore.mutate({ targetRootId: rootId }, ({ ledger }) => {
          const r = ledger.roots[rootId]!;
          const nextRoot = { ...r, framesByKey: padded };
          return {
            commit: true,
            plan: {
              nextLedger: {
                ...ledger,
                roots: { ...ledger.roots, [rootId]: nextRoot }
              },
              targetRootId: rootId,
              result: measureRootLedgerBytes(nextRoot)
            }
          };
        });
        expect(wr.ok).toBe(true);
      }

      const finalRead = ledgerStore.read();
      expect(finalRead.ok).toBe(true);
      if (finalRead.ok) {
        expect(Object.keys(finalRead.ledger.roots)).toHaveLength(rootCount);
      }
    }
  );

  it('refuses a 21st live root before spawn and leaves all 20 active roots unchanged (US3 scenario 1)', async () => {
    const memento = createMemoryMemento();
    const ledgerStore = new ControlLedgerStore(memento);
    const admission = new ControlAttemptAdmissionService({ ledgerStore });

    for (let i = 1; i <= MAX_LIVE_CONTROL_ROOTS; i += 1) {
      const rootId = `root-${String(i).padStart(2, '0')}`;
      await admission.prepareRootLink({
        ledgerRunId: rootId,
        connectedRunId: `crun-${i}`,
        rootWorkflowId: 'wf-matrix',
        queueId: 'default',
        fence: DEFAULT_FENCE
      });
      await admission.activateRootLink({
        ledgerRunId: rootId,
        connectedRunId: `crun-${i}`,
        fence: DEFAULT_FENCE
      });
    }

    const beforeRead = ledgerStore.read();
    expect(beforeRead.ok).toBe(true);
    if (!beforeRead.ok) return;
    const snapshotBefore = JSON.parse(JSON.stringify(beforeRead.ledger.roots));

    // Limit-plus-one (21st active root)
    const refused21 = await admission.prepareRootLink({
      ledgerRunId: 'root-21',
      connectedRunId: 'crun-21',
      rootWorkflowId: 'wf-matrix',
      queueId: 'default',
      fence: DEFAULT_FENCE
    });
    expect(refused21.ok).toBe(false);
    if (!refused21.ok) {
      expect(refused21.code).toBe('control-root-limit-exceeded');
    }

    const afterRead = ledgerStore.read();
    expect(afterRead.ok).toBe(true);
    if (!afterRead.ok) return;
    expect(afterRead.ledger.roots).toEqual(snapshotBefore);
    expect(ledgerStore.getRoot('root-21')).toBeNull();
  });

  it('refuses non-settlement writes crossing the admission ceiling while preserving the 16 KiB settlement reserve (US3 scenario 2)', async () => {
    const memento = createMemoryMemento();
    const ledgerStore = new ControlLedgerStore(memento);
    const admission = new ControlAttemptAdmissionService({ ledgerStore });

    await admission.prepareRootLink({
      ledgerRunId: 'root-near-limit',
      connectedRunId: 'crun-1',
      rootWorkflowId: 'wf-matrix',
      queueId: 'default',
      fence: DEFAULT_FENCE
    });
    await admission.activateRootLink({
      ledgerRunId: 'root-near-limit',
      connectedRunId: 'crun-1',
      fence: DEFAULT_FENCE
    });

    const prepAttempt = await admission.prepareAttempt({
      ledgerRunId: 'root-near-limit',
      connectedRunId: 'crun-1',
      queueId: 'default',
      frameKey: 'root',
      workflowId: 'wf-matrix',
      invocationId: 'crun-1:root',
      nodeId: 'node-1',
      attemptId: 'att-active',
      backend: 'claude',
      fence: DEFAULT_FENCE
    });
    expect(prepAttempt.ok).toBe(true);
    if (!prepAttempt.ok) return;
    await admission.commitAttempt(prepAttempt.token);

    // Pad into the settlement reserve band: > (MAX_ROOT_LEDGER_BYTES - ROOT_SETTLEMENT_RESERVE_BYTES) and < MAX_ROOT_LEDGER_BYTES
    const frames = buildFramesForTargetBytes(
      ledgerStore.getRoot('root-near-limit')!.framesByKey,
      2_085_000
    );
    const padOut = await ledgerStore.mutate(
      { targetRootId: 'root-near-limit', allowSettlementReserve: true },
      ({ ledger }) => {
        const r = ledger.roots['root-near-limit']!;
        const candidate = { ...r, framesByKey: frames };
        return {
          commit: true,
          plan: {
            nextLedger: {
              ...ledger,
              roots: { ...ledger.roots, 'root-near-limit': candidate }
            },
            targetRootId: 'root-near-limit',
            allowSettlementReserve: true,
            result: measureRootLedgerBytes(candidate)
          }
        };
      }
    );
    expect(padOut.ok).toBe(true);
    if (!padOut.ok) return;
    expect(padOut.result).toBeGreaterThan(
      MAX_ROOT_LEDGER_BYTES - ROOT_SETTLEMENT_RESERVE_BYTES
    );
    expect(padOut.result).toBeLessThan(MAX_ROOT_LEDGER_BYTES);

    // Limit-plus-one non-settlement attempt must be refused before spawn
    const refusedAttempt = await admission.prepareAttempt({
      ledgerRunId: 'root-near-limit',
      connectedRunId: 'crun-1',
      queueId: 'default',
      frameKey: 'root',
      workflowId: 'wf-matrix',
      invocationId: 'crun-1:root',
      nodeId: 'node-1',
      attemptId: 'att-overflow',
      backend: 'claude',
      fence: DEFAULT_FENCE
    });
    expect(refusedAttempt.ok).toBe(false);
    if (!refusedAttempt.ok) {
      expect(refusedAttempt.code).toBe('control-ledger-size-exceeded');
    }

    // Settlement of the active attempt succeeds using the preserved 16 KiB reserve
    const settled = await admission.settleAttempt({
      ledgerRunId: 'root-near-limit',
      attemptId: 'att-active',
      fence: DEFAULT_FENCE,
      terminalStatus: 'completed',
      settledMicrousd: 100
    });
    expect(settled.ok).toBe(true);
  });

  it('reports infeasible matrix combinations explicitly and classifies unexpected write failures as uncertain (US3 scenarios 3 & 4)', async () => {
    const infeasibleMemory = evaluateMatrixCellFeasibility({
      rootCount: 20,
      targetRootBytes: 2_000_000,
      availableMemoryBytes: 32 * 1024 * 1024 // 32 MiB host budget < 4 * 40 MiB working set
    });
    expect(infeasibleMemory.status).toBe('infeasible');

    const infeasibleRoots = evaluateMatrixCellFeasibility({
      rootCount: 21,
      targetRootBytes: 64 * 1024
    });
    expect(infeasibleRoots.status).toBe('infeasible');

    const memento = createMemoryMemento();
    const ledgerStore = new ControlLedgerStore(memento);
    const admission = new ControlAttemptAdmissionService({ ledgerStore });
    await admission.prepareRootLink({
      ledgerRunId: 'root-1',
      connectedRunId: 'crun-1',
      rootWorkflowId: 'wf-matrix',
      queueId: 'default',
      fence: DEFAULT_FENCE
    });

    // Simulate full disk during settlement write
    memento.failUpdates = true;
    const writeOutcome = await classifySettlementWrite(
      'op-settle-root-1',
      ledgerStore.mutate({ targetRootId: 'root-1', allowSettlementReserve: true }, ({ ledger }) => ({
        commit: true,
        plan: {
          nextLedger: ledger,
          targetRootId: 'root-1',
          allowSettlementReserve: true,
          result: 'settled'
        }
      }))
    );

    expect(writeOutcome.status).toBe('uncertain');
    if (writeOutcome.status === 'uncertain') {
      expect(writeOutcome.error.category).toBe('uncertain-persistence');
      expect(writeOutcome.recoveryObligation).toBe('reconcile-receipt-before-retry-or-effect');
    }
  });
});
