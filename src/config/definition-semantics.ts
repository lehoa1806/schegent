// Feature 100 (FR-R3-016) T508b, updated by FR-R5-F01 (T05) — the impure half of
// the `DefinitionSemantics` port for the two-kind (`phase` + `workflow`) catalog.
//
// Synchronous throughout, which the port requires: a `CatalogSnapshot` is the
// store read once into memory (099 FR-027a), so everything here is a projection
// over data already in hand.

import { storedRows } from '../catalog';
import { authoredPhasePosition } from '../contracts/pipeline-definitions';
import { resolvePhaseCatalog } from './process-catalog';
import { resolvePipelineCatalog } from './pipeline-catalog';
import { resolveWorkflowCatalog } from './workflow-catalog';
import type {
  CandidateDefinition,
  DefinitionSemantics
} from '../catalog';
import type {
  LifecycleAdvisory,
  ReferenceBlocker,
  ValidationDefect
} from '../contracts/catalog-lifecycle';
import type {
  CatalogKind,
  CatalogSnapshot,
  StoredDefinition
} from '../contracts/catalog-store';
import type { PipelineSourceRecord } from '../contracts/pipeline-definitions';
import type { WorkflowSourceRecord } from '../contracts/workflow-definitions';

const PROJECTION_REVISION = 'lifecycle-projection';

export interface DefinitionSemanticsOptions {
  /**
   * The resolved default Workflow ID (`schegent.defaultWorkflowId`, Feature 285), or `''`
   * where none is set. Read per call, so the FR-059 advisory sees the value in force.
   */
  readonly defaultWorkflowId: () => string;
}

export function createDefinitionSemantics(
  options: DefinitionSemanticsOptions
): DefinitionSemantics {
  return {
    defectsOf: (snapshot, candidates) => defectsOf(snapshot, candidates),
    referencesTo: (snapshot, kind, id) => referencesTo(snapshot, kind, id),
    advisoriesFor: (snapshot, kind, id) =>
      advisoriesFor(snapshot, kind, id, options.defaultWorkflowId())
  };
}

// ---------------------------------------------------------------------------
// Validation (FR-016, FR-017, FR-019, FR-R5-F01 FR-013)
// ---------------------------------------------------------------------------

function overlaidRows(
  snapshot: CatalogSnapshot,
  kind: CatalogKind | 'pipeline',
  candidates: readonly CandidateDefinition[]
): readonly unknown[] {
  const overlay = new Map<string, unknown>();
  for (const candidate of candidates) {
    if ((candidate.kind as string) === kind) overlay.set(candidate.id, candidate.body);
  }
  if (overlay.size === 0) return storedRows(snapshot, kind);

  const rows: unknown[] = [];
  const taken = new Set<string>();
  for (const definition of snapshot.definitions) {
    if ((definition.kind as string) !== kind) continue;
    if (overlay.has(definition.id)) {
      rows.push(overlay.get(definition.id));
      taken.add(definition.id);
      continue;
    }
    if (definition.body === null) continue;
    rows.push(definition.body);
  }
  for (const [id, body] of overlay) {
    if (!taken.has(id)) rows.push(body);
  }
  return rows;
}

interface ResolvedProjection {
  readonly phase: ReturnType<typeof resolvePhaseCatalog>;
  readonly pipeline: ReturnType<typeof resolvePipelineCatalog>;
  readonly workflow: ReturnType<typeof resolveWorkflowCatalog>;
}

function resolveAll(
  rowsOf: (kind: CatalogKind | 'pipeline') => readonly unknown[]
): ResolvedProjection {
  const phase = resolvePhaseCatalog({
    rows: rowsOf('phase'),
    revision: PROJECTION_REVISION
  });
  const pipeline = resolvePipelineCatalog({
    rows: rowsOf('pipeline'),
    revision: PROJECTION_REVISION,
    phaseCatalog: phase.effective
  });
  const workflow = resolveWorkflowCatalog({
    rows: rowsOf('workflow'),
    revision: PROJECTION_REVISION,
    phaseCatalog: { effective: phase.effective, records: phase.records },
    pipelineCatalog: { effective: pipeline.effective, records: pipeline.records }
  });
  return { phase, pipeline, workflow };
}

/**
 * Every defect the candidate set carries, across every candidate (FR-019), plus any
 * active reverse-dependent parent Workflow broken by an incompatible candidate edit
 * (FR-R5-F01, FR-013, hard rule 38).
 *
 * Pre-existing invalid definitions elsewhere in the catalog are NOT reported; only
 * a parent Workflow that was `effective` in the baseline snapshot and becomes
 * `invalid` under the candidate overlay is reported as a reverse-dependent defect.
 */
function defectsOf(
  snapshot: CatalogSnapshot,
  candidates: readonly CandidateDefinition[]
): readonly ValidationDefect[] {
  if (candidates.length === 0) return [];
  const baseline = resolveAll((kind) => storedRows(snapshot, kind));
  const resolved = resolveAll((kind) => overlaidRows(snapshot, kind, candidates));

  const defects: ValidationDefect[] = [];
  const candidateWorkflowIds = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.kind === 'workflow') {
      candidateWorkflowIds.add(candidate.id);
    }
    defects.push(...defectsOfCandidate(resolved, candidate));
  }

  const previouslyEffectiveWorkflowIds = new Set(
    baseline.workflow.records
      .filter((r) => r.status === 'effective')
      .map((r) => r.workflowId)
  );

  for (const record of resolved.workflow.records) {
    if (candidateWorkflowIds.has(record.workflowId)) continue;
    if (!previouslyEffectiveWorkflowIds.has(record.workflowId)) continue;
    if (record.status !== 'invalid') continue;
    for (const error of record.errors) {
      defects.push({
        kind: 'workflow',
        id: record.workflowId,
        field: error.field,
        code: error.code,
        message: error.message
      });
    }
  }

  return defects;
}

function defectsOfCandidate(
  resolved: ResolvedProjection,
  candidate: CandidateDefinition
): readonly ValidationDefect[] {
  switch (candidate.kind) {
    case 'phase': {
      const records = resolved.phase.records.filter(
        (record) => record.phaseId === candidate.id
      );
      if (records.length === 0) return [unresolvable(candidate)];
      return records.flatMap((record) =>
        record.errors.map((error) => ({
          kind: 'phase' as const,
          id: candidate.id,
          field: error.field,
          code: error.code,
          message: error.message
        }))
      );
    }
    case 'pipeline': {
      const records = resolved.pipeline.records.filter(
        (record) => record.pipelineId === candidate.id
      );
      if (records.length === 0) return [unresolvable(candidate)];
      return records.flatMap((record) =>
        record.errors.map((error) => ({
          kind: 'pipeline' as const,
          id: candidate.id,
          field: error.field,
          code: error.code,
          message: error.message
        }))
      );
    }
    case 'workflow': {
      const records = resolved.workflow.records.filter(
        (record) => record.workflowId === candidate.id
      );
      if (records.length === 0) return [unresolvable(candidate)];
      return records.flatMap((record) =>
        record.errors.map((error) => ({
          kind: 'workflow' as const,
          id: candidate.id,
          field: error.field,
          code: error.code,
          message: error.message
        }))
      );
    }
  }
}

function unresolvable(candidate: CandidateDefinition): ValidationDefect {
  return {
    kind: candidate.kind,
    id: candidate.id,
    field: 'id',
    code: 'unresolvable-body',
    message: `The ${candidate.kind} body does not parse as a definition of '${candidate.id}'`
  };
}

// ---------------------------------------------------------------------------
// References (FR-025, FR-025a, FR-025b, FR-R5-F01 FR-011)
// ---------------------------------------------------------------------------

function authoredPhaseIdPosition(record: PipelineSourceRecord, phaseId: string): number {
  if (record.definition !== null) return record.definition.phaseIds.indexOf(phaseId);
  return authoredPhasePosition(record.display, phaseId);
}

function authoredWorkflowNodePosition(
  record: WorkflowSourceRecord,
  field: 'phaseId' | 'workflowId' | 'pipelineId',
  targetId: string
): number {
  if (record.definition !== null) {
    const idx = record.definition.nodes.findIndex((n) => n[field] === targetId);
    if (idx !== -1) return idx;
  }
  const nodes = record.display.nodes;
  if (Array.isArray(nodes)) {
    const idx = nodes.findIndex(
      (n) =>
        typeof n === 'object' &&
        n !== null &&
        !Array.isArray(n) &&
        typeof (n as Record<string, unknown>)[field] === 'string' &&
        ((n as Record<string, unknown>)[field] as string).trim() === targetId
    );
    if (idx !== -1) return idx;
  }
  const fallbackList =
    field === 'phaseId'
      ? (record.nodePhaseIds ?? [])
      : field === 'workflowId'
        ? (record.nodeWorkflowIds ?? [])
        : record.nodePipelineIds;
  return fallbackList.indexOf(targetId);
}

/**
 * Direct references held by active definitions (FR-025a, FR-R5-F01 FR-011).
 *
 * Both `phase` and `workflow` definitions can be referenced by active Workflows
 * (including active records that are currently `invalid`, via `nodePhaseIds` /
 * `nodeWorkflowIds`).
 */
function referencesTo(
  snapshot: CatalogSnapshot,
  kind: CatalogKind,
  id: string
): readonly ReferenceBlocker[] {
  return blockersIn(resolveAll((rowKind) => storedRows(snapshot, rowKind)), kind, id);
}

function blockersIn(
  resolved: ResolvedProjection,
  kind: CatalogKind,
  id: string
): readonly ReferenceBlocker[] {
  if (kind === 'phase') {
    return [
      ...phaseWorkflowBlockers(resolved.workflow.records, id),
      ...phasePipelineBlockers(resolved.pipeline.records, id)
    ];
  }
  if (kind === 'pipeline') {
    return pipelineWorkflowBlockers(resolved.workflow.records, id);
  }
  return childWorkflowBlockers(resolved.workflow.records, id);
}

function phaseWorkflowBlockers(
  records: readonly WorkflowSourceRecord[],
  phaseId: string
): readonly ReferenceBlocker[] {
  const blockers: ReferenceBlocker[] = [];
  for (const record of records) {
    const position = authoredWorkflowNodePosition(record, 'phaseId', phaseId);
    if (position === -1) continue;
    blockers.push({
      kind: 'workflow',
      id: record.workflowId,
      field: `nodes[${position}].phaseId`
    });
  }
  return blockers;
}

function phasePipelineBlockers(
  records: readonly PipelineSourceRecord[],
  phaseId: string
): readonly ReferenceBlocker[] {
  const blockers: ReferenceBlocker[] = [];
  for (const record of records) {
    const position = authoredPhaseIdPosition(record, phaseId);
    if (position === -1) continue;
    blockers.push({
      kind: 'pipeline',
      id: record.pipelineId,
      field: `phaseIds[${position}]`
    });
  }
  return blockers;
}

function pipelineWorkflowBlockers(
  records: readonly WorkflowSourceRecord[],
  pipelineId: string
): readonly ReferenceBlocker[] {
  const blockers: ReferenceBlocker[] = [];
  for (const record of records) {
    const position = authoredWorkflowNodePosition(record, 'pipelineId', pipelineId);
    if (position === -1) continue;
    blockers.push({
      kind: 'workflow',
      id: record.workflowId,
      field: `nodes[${position}].pipelineId`
    });
  }
  return blockers;
}

function childWorkflowBlockers(
  records: readonly WorkflowSourceRecord[],
  workflowId: string
): readonly ReferenceBlocker[] {
  const blockers: ReferenceBlocker[] = [];
  for (const record of records) {
    if (record.workflowId === workflowId) continue;
    const position = authoredWorkflowNodePosition(record, 'workflowId', workflowId);
    if (position === -1) continue;
    blockers.push({
      kind: 'workflow',
      id: record.workflowId,
      field: `nodes[${position}].workflowId`
    });
  }
  return blockers;
}

// ---------------------------------------------------------------------------
// Advisories (FR-025a, FR-059, FR-060, FR-061)
// ---------------------------------------------------------------------------

function advisoriesFor(
  snapshot: CatalogSnapshot,
  kind: CatalogKind,
  id: string,
  defaultWorkflowId: string
): readonly LifecycleAdvisory[] {
  const advisories: LifecycleAdvisory[] = [];

  const drafted = draftProjection(snapshot);
  if (drafted !== null) {
    const referencing = blockersIn(drafted, kind, id);
    const active = new Set(
      referencesTo(snapshot, kind, id).map((blocker) => blocker.id)
    );
    const seenDraftRefs = new Set<string>();
    for (const reference of referencing) {
      if (active.has(reference.id) || seenDraftRefs.has(reference.id)) continue;
      seenDraftRefs.add(reference.id);
      advisories.push({ advisory: 'draft-reference', kind: reference.kind, id: reference.id });
    }
  }

  // Feature 285 (FR-006b): the configured default names a Workflow, so only a Workflow can be it.
  if (kind === 'workflow' && defaultWorkflowId !== '' && defaultWorkflowId === id) {
    advisories.push({ advisory: 'configured-default', kind: null, id });
  }

  return advisories;
}

function draftProjection(snapshot: CatalogSnapshot): ResolvedProjection | null {
  if (!snapshot.definitions.some((definition) => definition.draftBody !== null)) return null;
  return resolveAll((kind) => draftedRows(snapshot, kind));
}

function draftedRows(
  snapshot: CatalogSnapshot,
  kind: CatalogKind | 'pipeline'
): readonly unknown[] {
  const rows: unknown[] = [];
  for (const definition of snapshot.definitions) {
    if ((definition.kind as string) !== kind) continue;
    const body = bodyOf(definition);
    if (body === null) continue;
    rows.push(body);
  }
  return rows;
}

function bodyOf(definition: StoredDefinition): unknown {
  return definition.draftBody !== null ? definition.draftBody : definition.body;
}
