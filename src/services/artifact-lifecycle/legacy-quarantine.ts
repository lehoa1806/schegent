/**
 * FR-R6-F05 US3 (T034, FR-014) — opt-in quarantine of legacy catalog residue,
 * and reconciliation of a quarantine an interruption cut short.
 *
 * Residue stays where it is unless an operator previews and confirms a
 * quarantine. Each target is copied with an exclusive create, the copy is
 * re-read and its digest compared with the source's, and only then is the
 * source removed through the contained unlink. A destination that already
 * exists is never overwritten: it is inspected and the target becomes
 * `ambiguous`. A crash between the steps leaves the operation in flight;
 * `reconcilePreservation` inspects both sides and records what it finds,
 * moving nothing.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { versionSegments } from '../../catalog/catalog-paths';
import type {
  LifecycleResult,
  PreservationOperationState,
  PreservationTargetOutcome,
  SourcePreservationOperation
} from '../../contracts/artifact-lifecycle/lifecycle-types';
import type {
  LegacyCatalogClassification,
  LegacyCatalogResidue,
  LegacyQuarantineRequest
} from '../../contracts/artifact-lifecycle/legacy-preservation-types';
import { classifyLegacyCatalogResidue, digestOfBytes, recordSegments } from './legacy-classification';
import { auditPreservation, keyOfSegments, segmentsOfKey, type LegacyContext } from './legacy-preservation-context';
import { IN_FLIGHT_PRESERVATION_STATES, type PreservationTargetRow } from './legacy-preservation-store';
import { inImmediateTransaction, isOpaqueId, ok, refuse } from './lifecycle-results';
import { checkMutationAuthority, checkStandingAuthority } from './mutation-authority';

export function classify(ctx: LegacyContext): Promise<LegacyCatalogClassification> {
  return classifyLegacyCatalogResidue(ctx.deps.catalogRoot, ctx.deps.files, ctx.deps.consumers);
}

/** Source keys whose last preservation is ambiguous or still in flight. */
function unsettledSourceKeys(ctx: LegacyContext): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const row of ctx.rows.latestBySourceKey().values()) {
    if (row.outcome === 'ambiguous' || IN_FLIGHT_PRESERVATION_STATES.includes(row.operation_state)) {
      keys.add(row.source_key);
    }
  }
  return keys;
}

const sourceKeyOf = (ctx: LegacyContext, residue: LegacyCatalogResidue): string =>
  keyOfSegments(recordSegments(ctx.deps.catalogRoot, residue));

function selectResidue(
  ctx: LegacyContext,
  classification: LegacyCatalogClassification,
  residueIds: readonly string[] | undefined
): LifecycleResult<readonly LegacyCatalogResidue[]> {
  const unsettled = unsettledSourceKeys(ctx);
  if (residueIds === undefined) {
    const all = classification.residue.filter(
      (entry) => entry.disposition === 'unresolved' && entry.digest !== null && !unsettled.has(sourceKeyOf(ctx, entry))
    );
    return all.length === 0 ? refuse('not-found', 'no unreferenced residue to quarantine') : ok(all);
  }
  const byId = new Map(classification.residue.map((entry) => [entry.residueId, entry]));
  const chosen = new Map<string, LegacyCatalogResidue>();
  for (const residueId of residueIds) {
    if (!isOpaqueId(residueId)) return refuse('invalid-input', 'residueIds is malformed');
    const entry = byId.get(residueId);
    if (entry === undefined) return refuse('not-found', 'no such residue');
    if (entry.disposition === 'protected') return refuse('protected-reference', 'a pointer or consumer references that residue');
    if (unsettled.has(sourceKeyOf(ctx, entry))) {
      return refuse('ownership-unresolved', 'an earlier preservation of that residue is ambiguous; reconcile it first');
    }
    if (entry.digest === null) return refuse('unavailable', 'that residue could not be read');
    chosen.set(residueId, entry);
  }
  return chosen.size === 0 ? refuse('not-found', 'no residue named') : ok([...chosen.values()]);
}

/** Inspect an existing destination: an absent one means nothing was copied; anything else is ambiguous. */
async function afterBlockedWrite(ctx: LegacyContext, destination: readonly string[]): Promise<PreservationTargetOutcome> {
  const existing = await ctx.deps.files.readBytes(destination);
  return existing.outcome === 'absent' ? 'refused' : 'ambiguous';
}

async function quarantineOne(
  ctx: LegacyContext,
  operationId: string,
  ordinal: number,
  residue: LegacyCatalogResidue
): Promise<PreservationTargetOutcome> {
  const source = recordSegments(ctx.deps.catalogRoot, residue);
  const destination = [...ctx.quarantineSegments, operationId, ...versionSegments(residue.kind, residue.id, residue.versionId)];
  ctx.rows.setState(operationId, 'copying');
  const read = await ctx.deps.files.readBytes(source);
  if (read.outcome !== 'read' || digestOfBytes(read.bytes) !== residue.digest) return 'refused';
  const written = await ctx.deps.files.writeExclusive(destination, read.bytes);
  if (written === 'refused') return 'refused';
  if (written !== 'written') return afterBlockedWrite(ctx, destination);
  ctx.rows.setState(operationId, 'verifying');
  const copy = await ctx.deps.files.readBytes(destination);
  if (copy.outcome !== 'read' || digestOfBytes(copy.bytes) !== residue.digest) return 'ambiguous';
  ctx.rows.setOutcome(operationId, ordinal, 'preserved-in-place', residue.digest);
  const removed = await ctx.deps.files.unlinkContained(source);
  return removed === 'removed' || removed === 'absent' ? 'quarantined' : 'ambiguous';
}

function finalState(outcomes: readonly PreservationTargetOutcome[]): PreservationOperationState {
  if (outcomes.includes('ambiguous')) return 'ambiguous';
  return outcomes.includes('quarantined') ? 'completed' : 'refused';
}

/** Quarantine residue (FR-014): previewed, confirmed, authorized; copy, verify, then remove. */
export async function quarantineLegacyResidue(
  ctx: LegacyContext,
  request: LegacyQuarantineRequest
): Promise<LifecycleResult<SourcePreservationOperation>> {
  const standing = checkStandingAuthority(request.authority);
  if (!standing.ok) return standing;
  const classification = await classify(ctx);
  const gate = checkMutationAuthority(ctx.deps.previews, request, 'legacy-quarantine', classification.basisRevision);
  if (!gate.ok) return gate;
  if (classification.manifestState === 'faulted') return refuse('unavailable', 'the legacy manifest is unreadable');
  const selected = selectResidue(ctx, classification, request.residueIds);
  if (!selected.ok) return selected;
  const operationId = ctx.newOperationId();
  if (operationId === null) return refuse('unavailable', 'no operation id could be issued');
  const targets = selected.value.map((residue) => ({
    sourceKey: sourceKeyOf(ctx, residue),
    destinationKey: keyOfSegments([
      ...ctx.quarantineSegments,
      operationId,
      ...versionSegments(residue.kind, residue.id, residue.versionId)
    ]),
    sourceDigest: residue.digest
  }));
  inImmediateTransaction(ctx.deps.conn, () => {
    ctx.rows.insertOperation(operationId, ctx.workspaceId, request.previewId, targets);
  });
  const outcomes: PreservationTargetOutcome[] = [];
  for (const [ordinal, residue] of selected.value.entries()) {
    const outcome = await quarantineOne(ctx, operationId, ordinal, residue);
    ctx.rows.setOutcome(operationId, ordinal, outcome, outcome === 'refused' ? null : residue.digest);
    outcomes.push(outcome);
  }
  ctx.rows.setState(operationId, finalState(outcomes));
  const count = (outcome: PreservationTargetOutcome): number => outcomes.filter((entry) => entry === outcome).length;
  const counts = { quarantined: count('quarantined'), ambiguous: count('ambiguous'), refused: count('refused') };
  auditPreservation(ctx, operationId, counts, counts.quarantined, outcomes.length);
  const projection = ctx.rows.projection(operationId);
  return projection === null ? refuse('unavailable', 'the operation record is missing') : ok(projection);
}

async function inspect(ctx: LegacyContext, row: PreservationTargetRow): Promise<PreservationTargetOutcome> {
  if (row.destination_key === null) return 'ambiguous';
  const source = await ctx.deps.files.readBytes(segmentsOfKey(row.source_key));
  const destination = await ctx.deps.files.readBytes(segmentsOfKey(row.destination_key));
  if (destination.outcome === 'absent' && source.outcome === 'read') return 'preserved-in-place';
  const copied = destination.outcome === 'read' && digestOfBytes(destination.bytes) === row.source_digest;
  return copied && source.outcome === 'absent' ? 'quarantined' : 'ambiguous';
}

function needsInspection(state: PreservationOperationState, row: PreservationTargetRow): boolean {
  if (row.outcome === 'ambiguous') return true;
  return row.outcome === 'preserved-in-place' && IN_FLIGHT_PRESERVATION_STATES.includes(state);
}

/**
 * Resolve an interrupted or ambiguous quarantine by inspection (FR-014). It
 * records what both sides hold and moves, copies and removes nothing, so it
 * needs no preview and writes no audit record.
 */
export async function reconcilePreservation(
  ctx: LegacyContext,
  operationId: string
): Promise<LifecycleResult<SourcePreservationOperation>> {
  if (!isOpaqueId(operationId)) return refuse('invalid-input', 'operationId is malformed');
  const before = ctx.rows.projection(operationId);
  if (before === null) return refuse('not-found', 'no such preservation operation');
  if (!IN_FLIGHT_PRESERVATION_STATES.includes(before.state) && before.state !== 'ambiguous') return ok(before);
  const updates: { readonly row: PreservationTargetRow; readonly outcome: PreservationTargetOutcome }[] = [];
  for (const row of ctx.rows.targets(operationId)) {
    const outcome = needsInspection(before.state, row) ? await inspect(ctx, row) : row.outcome;
    updates.push({ row, outcome });
  }
  inImmediateTransaction(ctx.deps.conn, () => {
    for (const { row, outcome } of updates) {
      if (outcome === row.outcome) continue;
      const destinationDigest = outcome === 'preserved-in-place' ? null : row.source_digest;
      ctx.rows.setOutcome(operationId, row.target_ordinal, outcome, destinationDigest);
    }
    ctx.rows.setState(operationId, finalState(updates.map((update) => update.outcome)));
  });
  const after = ctx.rows.projection(operationId);
  return after === null ? refuse('unavailable', 'the operation record is missing') : ok(after);
}
