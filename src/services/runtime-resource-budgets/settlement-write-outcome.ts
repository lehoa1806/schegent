/**
 * FR-R6-F03 — Settlement write-failure classifier and control-ledger matrix feasibility
 * evaluator (FR-005, FR-008, FR-020, SC-008, research R6).
 *
 * Maps a `ControlLedgerStore.mutate()` promise onto F02's `StorageBoundaryOutcome`:
 * - resolved `ok: true` -> `accepted`
 * - resolved `ok: false` with capacity code -> `refused` (`capacity-refusal`)
 * - resolved `ok: false` with other code -> `refused` (`stale-revision`)
 * - rejected promise (e.g., disk full or Memento write failure) -> `uncertain`
 *   (`uncertain-persistence`), never `accepted`.
 *
 * Zero `vscode` imports.
 */

import {
  MAX_LIVE_CONTROL_ROOTS,
  MAX_ROOT_LEDGER_BYTES,
  type ControlLedgerErrorCode
} from '../../contracts/control-ledger';
import {
  buildSharedContractRefusal,
  sanitizeOperatorExplanation,
  type StorageBoundaryOutcome
} from '../../contracts/shared-memory-storage/inventories';
import type { ControlLedgerMutationOutcome } from '../workflow-execution/control-ledger-store';

const CAPACITY_ERROR_CODES = new Set<ControlLedgerErrorCode>([
  'control-root-limit-exceeded',
  'control-ledger-size-exceeded',
  'control-frame-limit-exceeded',
  'control-waiter-limit-exceeded',
  'control-check-limit-exceeded'
]);

export async function classifySettlementWrite<T>(
  operationId: string,
  mutatePromise: Promise<ControlLedgerMutationOutcome<T>>
): Promise<StorageBoundaryOutcome<ControlLedgerMutationOutcome<T> & { readonly ok: true }>> {
  try {
    const outcome = await mutatePromise;
    if (outcome.ok) {
      return {
        status: 'accepted',
        operationId,
        value: outcome
      };
    }
    const category = CAPACITY_ERROR_CODES.has(outcome.code)
      ? 'capacity-refusal'
      : 'stale-revision';
    return buildSharedContractRefusal(
      category,
      outcome.code,
      outcome.message,
      'controlLedger',
      operationId
    );
  } catch (err) {
    const rawDetail = err instanceof Error ? err.message : String(err);
    return {
      status: 'uncertain',
      operationId,
      recoveryObligation: 'reconcile-receipt-before-retry-or-effect',
      error: {
        category: 'uncertain-persistence',
        reasonCode: 'write-failed-unexpectedly',
        operatorExplanation: sanitizeOperatorExplanation(
          `Durable settlement write '${operationId}' failed unexpectedly (${rawDetail}); outcome is uncertain and must be reconciled before retry.`
        )
      }
    };
  }
}

export type MatrixCellFeasibility =
  | {
      readonly status: 'feasible';
      readonly rootCount: number;
      readonly targetRootBytes: number;
      readonly estimatedSerializedBytes: number;
    }
  | {
      readonly status: 'infeasible';
      readonly rootCount: number;
      readonly targetRootBytes: number;
      readonly estimatedSerializedBytes: number;
      readonly reason: string;
    };

/**
 * Evaluate whether a control-ledger matrix cell (`rootCount x targetRootBytes`) is
 * feasible within declared protocol bounds and available host memory. Infeasible
 * combinations are reported explicitly and never silently replaced by a smaller
 * workload (FR-005, US3 scenario 3).
 */
export function evaluateMatrixCellFeasibility(input: {
  readonly rootCount: number;
  readonly targetRootBytes: number;
  readonly availableMemoryBytes?: number;
}): MatrixCellFeasibility {
  const estimatedSerializedBytes = input.rootCount * input.targetRootBytes;
  if (input.rootCount > MAX_LIVE_CONTROL_ROOTS) {
    return {
      status: 'infeasible',
      rootCount: input.rootCount,
      targetRootBytes: input.targetRootBytes,
      estimatedSerializedBytes,
      reason: `Requested rootCount (${input.rootCount}) exceeds MAX_LIVE_CONTROL_ROOTS (${MAX_LIVE_CONTROL_ROOTS}).`
    };
  }
  if (input.targetRootBytes > MAX_ROOT_LEDGER_BYTES) {
    return {
      status: 'infeasible',
      rootCount: input.rootCount,
      targetRootBytes: input.targetRootBytes,
      estimatedSerializedBytes,
      reason: `Requested targetRootBytes (${input.targetRootBytes}) exceeds MAX_ROOT_LEDGER_BYTES (${MAX_ROOT_LEDGER_BYTES}).`
    };
  }
  // Cloning/serializing the ledger requires roughly 4x the aggregate root payload in working memory
  if (
    input.availableMemoryBytes !== undefined &&
    estimatedSerializedBytes * 4 > input.availableMemoryBytes
  ) {
    return {
      status: 'infeasible',
      rootCount: input.rootCount,
      targetRootBytes: input.targetRootBytes,
      estimatedSerializedBytes,
      reason: `Estimated working set (${estimatedSerializedBytes * 4} B) exceeds available host memory (${input.availableMemoryBytes} B).`
    };
  }
  return {
    status: 'feasible',
    rootCount: input.rootCount,
    targetRootBytes: input.targetRootBytes,
    estimatedSerializedBytes
  };
}
