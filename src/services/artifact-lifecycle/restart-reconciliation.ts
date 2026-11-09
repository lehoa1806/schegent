/**
 * FR-R6-F05 (FR-010, FR-014) — the activation-time reconciliation the host
 * invokes before any sweep (contract `lifecycle-service.md`, `reconcileAfterRestart`).
 *
 * Every unfinished deletion resumes under its own operation id through the
 * same path a caller would take; one whose lease another holder still owns is
 * left to that holder and reported as deferred. Every in-flight or ambiguous
 * preservation is settled by inspection; without a legacy catalog it cannot be
 * inspected, so it is counted ambiguous and left untouched.
 *
 * Diagnostics carry operation states and refusal codes only, never a path.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type {
  LifecycleDiagnostic,
  LifecycleResult,
  MutationAuthority,
  SourcePreservationOperation
} from '../../contracts/artifact-lifecycle/lifecycle-types';
import { reconcileDeletionOperation } from './deletion-operations';
import { workspaceIdOf, type LifecycleContext } from './lifecycle-context';
import { ok } from './lifecycle-results';
import { checkStandingAuthority } from './mutation-authority';

export interface RestartReconciliation {
  readonly resumedOperations: readonly string[];
  /** Preservation targets still ambiguous after this pass, plus operations that could not be inspected. */
  readonly ambiguous: number;
  readonly diagnostics: readonly LifecycleDiagnostic[];
}

/** Settles one preservation operation by inspection; refuses `unavailable` when no catalog is configured. */
export type PreservationReconciler = (operationId: string) => Promise<LifecycleResult<SourcePreservationOperation>>;

const UNFINISHED_DELETION_STATES = `('planned', 'executing')`;
const UNSETTLED_PRESERVATION_STATES = `('planned', 'copying', 'verifying', 'ambiguous')`;

function diagnostic(code: LifecycleDiagnostic['code'], detail: string): LifecycleDiagnostic {
  return { code, artifactId: null, detail };
}

function operationIds(ctx: LifecycleContext, table: string, states: string): readonly string[] {
  return ctx.deps.conn
    .all<{ operation_id: string }>(
      `SELECT operation_id FROM ${table} WHERE workspace_id = ? AND state IN ${states}
       ORDER BY created_at_ms, operation_id`,
      workspaceIdOf(ctx)
    )
    .map((row) => row.operation_id);
}

export async function reconcileAfterRestart(
  ctx: LifecycleContext,
  authority: MutationAuthority,
  reconcilePreservation: PreservationReconciler,
  signal?: AbortSignal
): Promise<LifecycleResult<RestartReconciliation>> {
  const standing = checkStandingAuthority(authority);
  if (!standing.ok) return standing;
  const resumedOperations: string[] = [];
  const diagnostics: LifecycleDiagnostic[] = [];
  let ambiguous = 0;

  for (const operationId of operationIds(ctx, 'deletion_operations', UNFINISHED_DELETION_STATES)) {
    if (signal?.aborted === true) break;
    const resumed = await reconcileDeletionOperation(ctx, operationId, authority, signal);
    if (resumed.ok) {
      resumedOperations.push(operationId);
      diagnostics.push(diagnostic('reconciled-operation', `deletion operation resumed: ${resumed.value.state}`));
    } else {
      diagnostics.push(diagnostic('reconciled-operation', `deletion operation deferred: ${resumed.refusal.code}`));
    }
  }

  for (const operationId of operationIds(ctx, 'preservation_operations', UNSETTLED_PRESERVATION_STATES)) {
    if (signal?.aborted === true) break;
    const settled = await reconcilePreservation(operationId);
    if (!settled.ok) {
      ambiguous += 1;
      diagnostics.push(diagnostic('ambiguous-preservation', `preservation operation unreconciled: ${settled.refusal.code}`));
      continue;
    }
    resumedOperations.push(operationId);
    const left = settled.value.targets.filter((target) => target.outcome === 'ambiguous').length;
    ambiguous += left;
    const code = left > 0 ? 'ambiguous-preservation' : 'reconciled-operation';
    diagnostics.push(diagnostic(code, `preservation operation reconciled: ${settled.value.state}`));
  }

  return ok({ resumedOperations, ambiguous, diagnostics });
}
