// Feature 059 — shared helpers for the per-capability trust gate.
// Contract: specs/059-fine-grained-trust-scopes/contracts/save-command-trust-gate-contract.md
//
// Feature 100 (T513b) — the three save commands this was written for are gone
// with the whole-array save (T509). The callers are now
// `cmd-catalog-lifecycle.ts` and `cmd-save-models.ts`. The contract above is
// unchanged and is why this module moved rather than being rewritten: the gate's
// terms are per-capability, not per-command, and the lifecycle asks the same
// question about the same capabilities. What did change is when it is asked —
// `cmd-catalog-lifecycle.ts` checks the staleness token first, so a stale
// untrusted write reports `stale-draft` rather than `trust-denied`.

import * as path from 'node:path';
import { getResolvedScope } from '../../../state/capability-trust-resolver';
import { getCanonicalWorkspaceRoot } from '../../../state/workspace-folder-picker';
import {
  TRUST_DENIED_REASONS,
  type TrustCapability,
  type TrustDeniedError,
  type TrustDeniedReason,
  type ResolvedScope
} from '../../../contracts/sidebar-ipc';
import type { TrustCapabilityDeniedPayload } from '../../../contracts/audit-events';
import type { HandlerContext } from './handler-contract';
import { ack } from './handler-helpers';

export function reasonFor(
  capability: TrustCapability,
  scope: ResolvedScope
): TrustDeniedReason {
  if (scope === 'workspace-trust') return TRUST_DENIED_REASONS.workspaceTrust;
  switch (capability) {
    case 'phases':
      return scope === 'workspace'
        ? TRUST_DENIED_REASONS.phasesWorkspace
        : TRUST_DENIED_REASONS.phasesUser;
    case 'retryConditions':
      return scope === 'workspace'
        ? TRUST_DENIED_REASONS.retryConditionsWorkspace
        : TRUST_DENIED_REASONS.retryConditionsUser;
  }
}

// I-6: `workspaceBasename` is computed via the canonical-folder picker so
// the full workspace root path is never serialized into the audit log.
// Spec 058's `getCanonicalWorkspaceRoot()` is the only first-folder
// accessor (CLAUDE.md hard rule).
export function workspaceBasename(): string {
  const root = getCanonicalWorkspaceRoot();
  if (!root) return '';
  return path.basename(root.uri.fsPath);
}

async function emitTrustDeniedAudit(
  ctx: HandlerContext,
  payload: TrustCapabilityDeniedPayload
): Promise<void> {
  if (!ctx.deps.audit) return;
  try {
    await ctx.deps.audit.append({
      runId: 'trust-gate',
      phase: 'settings',
      iteration: 0,
      eventType: 'trust.capability-denied',
      payload: payload as unknown as Record<string, unknown>,
      outcome: 'failure',
      correlationId: ctx.correlationId
    });
  } catch (err) {
    // I-5: rejection is returned regardless of audit-write failure.
    ctx.deps.logger.warn(
      `Failed to append trust.capability-denied audit event: ${(err as Error).message}`
    );
  }
}

/**
 * Emit the `trust.capability-denied` audit event for `capability` (with
 * an optional `rowIndex` for the row-granularity retry-condition gate),
 * then reply to the IPC caller with `trust-denied` and a
 * `TrustDeniedError` envelope. The audit write is best-effort — a
 * failure is logged but does not affect the reply, per I-5.
 */
export async function denyAndAudit(
  ctx: HandlerContext,
  capability: TrustCapability,
  rowIndex?: number
): Promise<void> {
  const resolvedScope = getResolvedScope(capability);
  const reason = reasonFor(capability, resolvedScope);
  const auditPayload: TrustCapabilityDeniedPayload = {
    capability,
    resolvedScope,
    workspaceBasename: workspaceBasename(),
    reason,
    ...(rowIndex !== undefined ? { rowIndex } : {})
  };
  await emitTrustDeniedAudit(ctx, auditPayload);
  const err: TrustDeniedError = {
    kind: 'trust-denied',
    capability,
    resolvedScope,
    reason,
    ...(rowIndex !== undefined ? { rowIndex } : {})
  };
  await ack(ctx, 'rejected', 'trust-denied', err);
}
