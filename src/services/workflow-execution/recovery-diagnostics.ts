/**
 * Principal Review F2 — metadata-only recovery diagnostics and startup orchestration helper
 * extracted from `workflow-recovery-service.ts` to keep `workflow-recovery-service.ts` cleanly
 * within its LOC budget margin.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { ConnectedWorkflowRun } from '../../state/connected-workflow-run';
import type { ControlAttemptAdmissionService } from './control-attempt-admission';
import {
  reconcileOrphanedControlLedgerRoots,
  type ControlRootParentPresence
} from './control-root-lifecycle';
import type {
  ControlAdmissionPort,
  ExecutionFence,
  ProcessEvidencePort
} from '../../contracts/control-ledger';

export interface IsolatedRecoveryFailure {
  readonly runId: string;
  readonly reasonCode: string;
}

export interface ReconcileAllRunsSummary {
  readonly isolatedFailureCount: number;
  readonly isolatedFailures: readonly IsolatedRecoveryFailure[];
  readonly preservedRefusedParentCount: number;
}

export const EMPTY_RECONCILE_SUMMARY: ReconcileAllRunsSummary = Object.freeze({
  isolatedFailureCount: 0,
  isolatedFailures: Object.freeze([]),
  preservedRefusedParentCount: 0
});

export function classifyRecoveryFailure(err: unknown): string {
  return err instanceof Error && /^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(err.name)
    ? err.name
    : 'recovery-error';
}

export async function runReconcileAllConnectedRuns<TResult>(params: {
  readonly list: readonly ConnectedWorkflowRun[];
  readonly reconcileOne: (runId: string) => Promise<TResult | undefined>;
  readonly getRun: (runId: string) => ConnectedWorkflowRun | null;
  readonly getPresence?: ((runId: string) => ControlRootParentPresence) | undefined;
  readonly controlAdmission?:
    | (ControlAdmissionPort & Pick<ControlAttemptAdmissionService, 'reconcileControlRoot'>)
    | ControlAttemptAdmissionService
    | undefined;
  readonly resolveOrphanFence?: ((ref: {
    readonly ledgerRunId: string;
    readonly connectedRunId: string;
    readonly queueId: string;
    readonly rootGeneration?: number | undefined;
  }) => ExecutionFence) | undefined;
  readonly processEvidencePort?: ProcessEvidencePort | undefined;
  readonly onIsolatedFailure?: ((failure: IsolatedRecoveryFailure) => void) | undefined;
  readonly onPreservedRefusedParent?: ((ref: {
    readonly ledgerRunId: string;
    readonly connectedRunId: string;
    readonly queueId: string;
  }) => void) | undefined;
}): Promise<{
  readonly results: readonly TResult[];
  readonly summary: ReconcileAllRunsSummary;
}> {
  const results: TResult[] = [];
  const isolatedFailures: IsolatedRecoveryFailure[] = [];
  let preservedRefusedParentCount = 0;

  for (const run of params.list) {
    try {
      const reconciled = await params.reconcileOne(run.connectedRunId);
      if (reconciled !== undefined) results.push(reconciled);
    } catch (err) {
      const failure: IsolatedRecoveryFailure = Object.freeze({
        runId: run.connectedRunId,
        reasonCode: classifyRecoveryFailure(err)
      });
      isolatedFailures.push(failure);
      params.onIsolatedFailure?.(failure);
    }
  }

  if (params.controlAdmission !== undefined) {
    const knownRunIds = new Set(params.list.map((r) => r.connectedRunId));
    const lookupParentPresence = (connectedRunId: string): ControlRootParentPresence => {
      if (params.getPresence !== undefined) {
        return params.getPresence(connectedRunId);
      }
      if (knownRunIds.has(connectedRunId) || params.getRun(connectedRunId) !== null) {
        return 'present';
      }
      return 'absent';
    };
    await reconcileOrphanedControlLedgerRoots({
      controlAdmission: params.controlAdmission,
      knownRunIds,
      lookupParentPresence,
      onPreservedRefusedParent: (ref) => {
        preservedRefusedParentCount += 1;
        params.onPreservedRefusedParent?.(ref);
      },
      ...(params.resolveOrphanFence !== undefined ? { resolveOrphanFence: params.resolveOrphanFence } : {}),
      processEvidencePort: params.processEvidencePort
    });
  }

  return {
    results: Object.freeze(results),
    summary: Object.freeze({
      isolatedFailureCount: isolatedFailures.length,
      isolatedFailures: Object.freeze(isolatedFailures),
      preservedRefusedParentCount
    })
  };
}
