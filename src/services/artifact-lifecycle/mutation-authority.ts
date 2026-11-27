/**
 * FR-R6-F05 (FR-021, AC-09) — the one gate every mutating lifecycle operation
 * passes. Refusal order is fixed: untrusted workspace, not the primary window,
 * unhealthy audit, missing/expired/stale preview, missing confirmation.
 *
 * An accepted mutation emits exactly one metadata-only audit record: the
 * operation kind, an opaque operation id, counts and the result. No host path,
 * display name or content enters it (rules 21, 22).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type {
  LifecycleResult,
  MutationAuthority,
  MutationRequestBase,
  PreviewKind,
  RetentionPreview
} from '../../contracts/artifact-lifecycle/lifecycle-types';
import { ok, refuse } from './lifecycle-results';
import type { PreviewStore } from './previews';

export type LifecycleMutationResult = 'completed' | 'partial' | 'refused' | 'resumed';

export interface LifecycleAuditRecord {
  readonly operationKind: PreviewKind;
  readonly operationId: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly result: LifecycleMutationResult;
}

export interface LifecycleAuditSink {
  recordLifecycleMutation(record: LifecycleAuditRecord): void;
}

export interface MutationEffectOutcome<T> {
  readonly operationId: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly result: LifecycleMutationResult;
  readonly value: T;
}

export interface MutationGateDependencies {
  readonly previews: PreviewStore;
  readonly audit: LifecycleAuditSink;
}

/**
 * The first three gate steps, which need no preview. Reconciling an operation
 * the caller already confirmed runs only these (FR-010).
 */
export function checkStandingAuthority(authority: MutationAuthority): LifecycleResult<true> {
  if (authority.trusted !== true) {
    return refuse('untrusted-workspace', 'lifecycle changes need a trusted workspace');
  }
  if (authority.primary !== true) {
    return refuse('not-primary-window', 'lifecycle changes run in the primary window only');
  }
  if (authority.auditHealthy !== true) {
    return refuse('audit-unhealthy', 'the audit log is unavailable; no lifecycle change is made');
  }
  return ok(true);
}

export function checkMutationAuthority(
  previews: PreviewStore,
  request: MutationRequestBase,
  kind: PreviewKind,
  currentBasis: string
): LifecycleResult<RetentionPreview> {
  const standing = checkStandingAuthority(request.authority);
  if (!standing.ok) return standing;
  const preview = previews.requireLive(request.previewId, kind, currentBasis);
  if (!preview.ok) return preview;
  if (request.confirmation !== 'confirmed') {
    return refuse('confirmation-required', 'confirm the previewed change to proceed');
  }
  return preview;
}

/** Gate, run the effect, then emit one audit record. A refusal runs nothing and audits nothing. */
export function runAuthorizedMutation<T>(
  deps: MutationGateDependencies,
  request: MutationRequestBase,
  kind: PreviewKind,
  currentBasis: string,
  effect: (preview: RetentionPreview) => MutationEffectOutcome<T>
): LifecycleResult<T> {
  const gate = checkMutationAuthority(deps.previews, request, kind, currentBasis);
  if (!gate.ok) return gate;
  const outcome = effect(gate.value);
  deps.audit.recordLifecycleMutation({
    operationKind: kind,
    operationId: outcome.operationId,
    counts: { ...outcome.counts },
    result: outcome.result
  });
  return ok(outcome.value);
}
