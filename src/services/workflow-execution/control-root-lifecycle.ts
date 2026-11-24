/**
 * FR-R8-01 (01-01, 01-03) — Pure ledger mutation helpers for terminalizing and
 * releasing unstarted control roots, factored out of `control-attempt-admission.ts`
 * to keep that module within its LOC budget. Zero `vscode` imports.
 */

import type {
  ControlLedger,
  ExecutionFence,
  ExecutionPermitRecord,
  RootControlState
} from '../../contracts/control-ledger';
import { lookupRecord, type ControlLedgerStore } from './control-ledger-store';

export function listControlRootRefs(
  store: ControlLedgerStore
): readonly {
  readonly ledgerRunId: string;
  readonly connectedRunId: string;
  readonly queueId: string;
  readonly rootGeneration: number;
}[] {
  const read = store.read();
  if (!read.ok) return [];
  return Object.values(read.ledger.roots).map((r) => ({
    ledgerRunId: r.ledgerRunId,
    connectedRunId: r.connectedRunId,
    queueId: r.queueId,
    rootGeneration: r.fence.rootGeneration
  }));
}

export async function reconcileOrphanedControlLedgerRoots(input: {
  readonly controlAdmission: Pick<
    import('../../contracts/control-ledger').ControlAdmissionPort,
    'listRootRunIds' | 'releaseUnstartedRootLink'
  > & {
    reconcileControlRoot(args: {
      readonly ledgerRunId: string;
      readonly connectedRun: null;
      readonly newFence: ExecutionFence;
      readonly processEvidencePort?: import('../../contracts/control-ledger').ProcessEvidencePort | undefined;
    }): Promise<unknown>;
  };
  readonly knownRunIds: ReadonlySet<string>;
  readonly resolveOrphanFence?: (ref: {
    readonly ledgerRunId: string;
    readonly connectedRunId: string;
    readonly queueId: string;
    readonly rootGeneration?: number | undefined;
  }) => ExecutionFence;
  readonly processEvidencePort?: import('../../contracts/control-ledger').ProcessEvidencePort | undefined;
}): Promise<void> {
  if (input.controlAdmission.listRootRunIds === undefined) return;
  for (const rootRef of input.controlAdmission.listRootRunIds()) {
    if (input.knownRunIds.has(rootRef.connectedRunId)) continue;
    const newFence: ExecutionFence =
      input.resolveOrphanFence !== undefined
        ? input.resolveOrphanFence(rootRef)
        : {
            primacyClaim: `primacy:${rootRef.connectedRunId}`,
            queueClaim: `queue:${rootRef.queueId}`,
            rootGeneration: Math.max(1, rootRef.rootGeneration ?? 1)
          };
    const released = await input.controlAdmission.releaseUnstartedRootLink?.({
      ledgerRunId: rootRef.ledgerRunId,
      connectedRunId: rootRef.connectedRunId,
      fence: newFence,
      allowRecoveryTakeover: true
    });
    if (released === true) continue;
    await input.controlAdmission.reconcileControlRoot({
      ledgerRunId: rootRef.ledgerRunId,
      connectedRun: null,
      newFence,
      ...(input.processEvidencePort !== undefined
        ? { processEvidencePort: input.processEvidencePort }
        : {})
    });
  }
}

export async function markControlRootTerminal(
  store: ControlLedgerStore,
  input: {
    readonly ledgerRunId: string;
    readonly connectedRunId: string;
    readonly status: 'completed' | 'failed' | 'canceled';
    readonly completedAt: number;
    readonly expectedFence?: ExecutionFence | undefined;
    readonly checkFence?: (
      fence: ExecutionFence,
      ledgerRunId: string,
      queueId: string
    ) => Promise<boolean>;
  }
): Promise<boolean> {
  const existing = store.getRoot(input.ledgerRunId);
  if (existing === null || existing.connectedRunId !== input.connectedRunId) return false;
  const effectiveFence = input.expectedFence ?? existing.fence;
  if (input.checkFence !== undefined && !(await input.checkFence(effectiveFence, input.ledgerRunId, existing.queueId))) {
    return false;
  }
  const mutated = await store.mutate<boolean>(
    {
      targetRootId: input.ledgerRunId,
      expectedFence: effectiveFence,
      allowSettlementReserve: true
    },
    ({ ledger }) => {
      const root = lookupRecord(ledger.roots, input.ledgerRunId);
      if (root === undefined || root.connectedRunId !== input.connectedRunId) {
        return {
          commit: false,
          code: 'control-root-not-found',
          message: 'Control root not found.'
        };
      }
      const permits: Record<string, ExecutionPermitRecord> = { ...ledger.permits };
      for (const [permitId, permit] of Object.entries(permits)) {
        if (permit.ledgerRunId === input.ledgerRunId && permit.status === 'active') {
          permits[permitId] = Object.freeze({
            ...permit,
            status: 'released',
            state: 'released',
            releasedAt: input.completedAt
          });
        }
      }
      const settledAttempts: Record<string, RootControlState['attemptsById'][string]> = {
        ...root.attemptsById
      };
      for (const [attId, att] of Object.entries(settledAttempts)) {
        if (att.stage !== 'settled') {
          settledAttempts[attId] = Object.freeze({
            ...att,
            stage: 'settled',
            terminalStatus: input.status,
            settledAt: input.completedAt
          });
        }
      }
      const nextRoot: RootControlState = Object.freeze({
        ...root,
        linkState: 'terminal',
        status: input.status,
        reservedMicrousd: 0,
        attemptsById: Object.freeze(settledAttempts),
        completedAt: root.completedAt ?? input.completedAt,
        updatedAt: input.completedAt
      });
      const waiters = ledger.waiters.filter(
        (w) => (w.rootRunId ?? w.ledgerRunId) !== input.ledgerRunId
      );
      return {
        commit: true,
        plan: {
          nextLedger: {
            ...ledger,
            roots: { ...ledger.roots, [input.ledgerRunId]: nextRoot },
            permits,
            waiters
          },
          targetRootId: input.ledgerRunId,
          allowSettlementReserve: true,
          result: true
        }
      };
    }
  );
  return mutated.ok;
}

export async function releaseUnstartedControlRootLink(
  store: ControlLedgerStore,
  input: {
    readonly ledgerRunId: string;
    readonly connectedRunId: string;
    readonly expectedFence?: ExecutionFence | undefined;
    readonly allowRecoveryTakeover?: boolean | undefined;
    readonly checkFence?: (
      fence: ExecutionFence,
      ledgerRunId: string,
      queueId: string
    ) => Promise<boolean>;
  }
): Promise<boolean> {
  const existing = store.getRoot(input.ledgerRunId);
  if (existing === null || existing.connectedRunId !== input.connectedRunId) return false;
  const effectiveFence = input.expectedFence ?? existing.fence;
  if (input.checkFence !== undefined && !(await input.checkFence(effectiveFence, input.ledgerRunId, existing.queueId))) {
    return false;
  }
  const takeover = input.allowRecoveryTakeover === true && input.expectedFence !== undefined;
  const mutated = await store.mutate<boolean>(
    {
      targetRootId: input.ledgerRunId,
      ...(takeover ? {} : { expectedFence: effectiveFence }),
      allowSettlementReserve: true
    },
    ({ ledger }) => {
      const root = lookupRecord(ledger.roots, input.ledgerRunId);
      if (root === undefined || root.connectedRunId !== input.connectedRunId) {
        return {
          commit: true,
          plan: { nextLedger: ledger, allowSettlementReserve: true, result: false }
        };
      }
      const hasSpawned = Object.values(root.attemptsById).some(
        (a) => a.stage === 'spawn-intent' || a.stage === 'started'
      );
      if (hasSpawned) {
        return {
          commit: false,
          code: 'invalid-attempt-stage',
          message: 'Cannot release root with spawned attempts.'
        };
      }
      const roots: Record<string, RootControlState> = { ...ledger.roots };
      delete roots[input.ledgerRunId];
      const permits: Record<string, ExecutionPermitRecord> = {};
      for (const [permitId, permit] of Object.entries(ledger.permits)) {
        if (permit.ledgerRunId !== input.ledgerRunId) permits[permitId] = permit;
      }
      const waiters = ledger.waiters.filter(
        (w) => (w.rootRunId ?? w.ledgerRunId) !== input.ledgerRunId
      );
      const nextLedger: ControlLedger = { ...ledger, roots, permits, waiters };
      return {
        commit: true,
        plan: { nextLedger, allowSettlementReserve: true, result: true }
      };
    }
  );
  return mutated.ok && mutated.result;
}
