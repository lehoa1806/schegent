/**
 * FR-R6-F05 US3 (T036, FR-015) — explicit purge of quarantined legacy residue.
 *
 * Quarantined bytes stay until an operator purges them. A purge needs a live
 * purge preview, `confirmation: 'confirmed'` and the mutation authority, in the
 * gate's fixed order. It refuses residue a consumer references and residue
 * whose preservation is still ambiguous or in flight, re-verifies each copy's
 * digest, and removes it through the contained unlink.
 *
 * A purge is its own `preservation_operations` row (preview id, final state).
 * The removed copy is recorded on its quarantine target in
 * `preservation_targets`: the destination key is cleared and the destination
 * digest kept, so the row still says what was quarantined and that the copy is
 * gone. A copy whose bytes no longer match is marked `ambiguous` and left.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { createHash } from 'node:crypto';

import type { LifecycleResult, RetentionPreview } from '../../contracts/artifact-lifecycle/lifecycle-types';
import type { LegacyPurgeRequest, LegacyPurgeResult } from '../../contracts/artifact-lifecycle/legacy-preservation-types';
import { digestOfBytes, refOfSourceKey, residueIdOf } from './legacy-classification';
import {
  auditPreservation,
  preservationSummary,
  segmentsOfKey,
  type LegacyContext
} from './legacy-preservation-context';
import { IN_FLIGHT_PRESERVATION_STATES, type LatestPreservationTarget } from './legacy-preservation-store';
import { inImmediateTransaction, isOpaqueId, ok, refuse } from './lifecycle-results';
import { checkMutationAuthority, checkStandingAuthority } from './mutation-authority';

const PURGE_BASIS_PREFIX = 'purge:';

interface PurgeCandidate {
  readonly residueId: string;
  readonly row: LatestPreservationTarget;
  readonly referenced: boolean;
  readonly unsettled: boolean;
  readonly eligible: boolean;
}

type PurgeVerdict = 'purged' | 'refused' | 'ambiguous';

function candidatesOf(ctx: LegacyContext): ReadonlyMap<string, PurgeCandidate> {
  const found = new Map<string, PurgeCandidate>();
  for (const row of ctx.rows.latestBySourceKey().values()) {
    const ref = refOfSourceKey(ctx.deps.catalogRoot, row.source_key);
    if (ref === null) continue;
    const unsettled = row.outcome === 'ambiguous' || IN_FLIGHT_PRESERVATION_STATES.includes(row.operation_state);
    const eligible = row.outcome === 'quarantined' && row.destination_key !== null;
    if (!unsettled && !eligible) continue;
    const residueId = residueIdOf(ref);
    const referenced = ctx.deps.consumers.consumersOf(ref).length > 0;
    found.set(residueId, { residueId, row, referenced, unsettled, eligible });
  }
  return found;
}

function basisOf(candidates: ReadonlyMap<string, PurgeCandidate>): string {
  const lines = [...candidates.values()]
    .map((c) => [c.residueId, c.row.operation_id, c.row.target_ordinal, c.row.outcome, c.row.destination_digest, c.referenced])
    .sort((left, right) => String(left.at(0)).localeCompare(String(right.at(0))));
  return `${PURGE_BASIS_PREFIX}${createHash('sha256').update(JSON.stringify(lines), 'utf8').digest('hex')}`;
}

const purgeable = (candidate: PurgeCandidate): boolean =>
  candidate.eligible && !candidate.referenced && !candidate.unsettled;

/** A preview of what a purge would remove (FR-015). */
export function previewQuarantinePurge(ctx: LegacyContext): LifecycleResult<RetentionPreview> {
  const found = candidatesOf(ctx);
  const candidates = [...found.values()];
  const affected = candidates.filter(purgeable);
  const summary = preservationSummary({
    affectedCount: affected.length,
    affectedBytes: 0,
    protectedCount: candidates.length - affected.length,
    protectedBytes: 0,
    coverage: 'complete',
    notes: ['purge removes quarantined copies permanently; referenced or ambiguous residue is kept']
  });
  return ok(ctx.deps.previews.create('legacy-quarantine', basisOf(found), summary));
}

function select(
  candidates: ReadonlyMap<string, PurgeCandidate>,
  residueIds: readonly string[] | undefined
): LifecycleResult<readonly PurgeCandidate[]> {
  if (residueIds === undefined) {
    const all = [...candidates.values()].filter(purgeable);
    return all.length === 0 ? refuse('not-found', 'no quarantined residue to purge') : ok(all);
  }
  const chosen = new Map<string, PurgeCandidate>();
  for (const residueId of residueIds) {
    if (!isOpaqueId(residueId)) return refuse('invalid-input', 'residueIds is malformed');
    const candidate = candidates.get(residueId);
    if (candidate === undefined) return refuse('not-found', 'no quarantined copy of that residue');
    if (candidate.referenced) return refuse('protected-reference', 'a consumer still references that residue');
    if (candidate.unsettled) return refuse('ownership-unresolved', 'preservation is ambiguous; reconcile it first');
    chosen.set(residueId, candidate);
  }
  return chosen.size === 0 ? refuse('not-found', 'no quarantined residue to purge') : ok([...chosen.values()]);
}

async function purgeOne(ctx: LegacyContext, row: LatestPreservationTarget): Promise<PurgeVerdict> {
  if (row.destination_key === null) return 'refused';
  const destination = segmentsOfKey(row.destination_key);
  const read = await ctx.deps.files.readBytes(destination);
  if (read.outcome === 'read' && digestOfBytes(read.bytes) !== row.destination_digest) {
    ctx.rows.setOutcome(row.operation_id, row.target_ordinal, 'ambiguous', row.destination_digest);
    return 'ambiguous';
  }
  if (read.outcome === 'failed') return 'refused';
  const removed = read.outcome === 'absent' ? 'absent' : await ctx.deps.files.unlinkContained(destination);
  if (removed === 'removed' || removed === 'absent') {
    ctx.rows.markDestinationPurged(row.operation_id, row.target_ordinal);
    return 'purged';
  }
  if (removed === 'refused') return 'refused';
  ctx.rows.setOutcome(row.operation_id, row.target_ordinal, 'ambiguous', row.destination_digest);
  return 'ambiguous';
}

/** Purge quarantined copies (FR-015): previewed, confirmed, authorized, contained. */
export async function purgeQuarantinedResidue(
  ctx: LegacyContext,
  request: LegacyPurgeRequest
): Promise<LifecycleResult<LegacyPurgeResult>> {
  const standing = checkStandingAuthority(request.authority);
  if (!standing.ok) return standing;
  const candidates = candidatesOf(ctx);
  const gate = checkMutationAuthority(ctx.deps.previews, request, 'legacy-quarantine', basisOf(candidates));
  if (!gate.ok) return gate;
  const selected = select(candidates, request.residueIds);
  if (!selected.ok) return selected;
  const operationId = ctx.newOperationId();
  if (operationId === null) return refuse('unavailable', 'no operation id could be issued');
  ctx.rows.insertOperation(operationId, ctx.workspaceId, request.previewId, []);
  const counts = { purged: 0, refused: 0, ambiguous: 0 };
  for (const candidate of selected.value) {
    counts[await purgeOne(ctx, candidate.row)] += 1;
  }
  const state = counts.ambiguous > 0 ? 'ambiguous' : counts.purged > 0 ? 'completed' : 'refused';
  inImmediateTransaction(ctx.deps.conn, () => ctx.rows.setState(operationId, state));
  auditPreservation(ctx, operationId, counts, counts.purged, selected.value.length);
  return ok({ operationId, state, ...counts });
}
