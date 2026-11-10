/**
 * FR-R6-F08 (research R2, R3, R7, R8) — the deterministic identities of a handoff.
 *
 * Each id is the SHA-256 hex of a tagged JSON array. The tag keeps two kinds with equal
 * inputs apart; the JSON encoding keeps separator characters from colliding. A retried write
 * derives the same id, so it lands on the row the first write made.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { createHash } from 'node:crypto';
import type { HandoffCutoff, HandoffLineage, SessionOwner } from '../../contracts/recovery-handoff/handoff-types';

function taggedDigest(parts: readonly (string | number)[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

/** One handoff per lineage (R2). */
export function handoffIdFor(lineage: HandoffLineage): string {
  return taggedDigest([
    'hof1',
    lineage.workspaceId,
    lineage.rootExecutionId,
    lineage.invocationId,
    lineage.sourceAttemptId
  ]);
}

/** One revision per cutoff within a handoff (R3). */
export function cutoffKeyFor(cutoff: HandoffCutoff): string {
  return taggedDigest(['cut1', cutoff.executionRevision, cutoff.usageRevision, cutoff.factCutoffMs]);
}

/** One delivery intent per target attempt (R7). */
export function intentIdFor(handoffId: string, targetAttemptId: string): string {
  return taggedDigest(['int1', handoffId, targetAttemptId]);
}

/** One decision per operator request. */
export function decisionIdFor(handoffId: string, requestId: string): string {
  return taggedDigest(['dec1', handoffId, requestId]);
}

/** Compares session owners without storing the account scope (R8). */
export function ownerDigestFor(owner: SessionOwner): string {
  return taggedDigest(['own1', owner.agentId, owner.accountScope]);
}
