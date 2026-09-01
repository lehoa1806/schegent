// Feature 100 (FR-R3-016) T508b — the impure half of the `DefinitionSemantics` port.
//
// The lifecycle service decides *when* a definition may move between states; it
// deliberately does not know what a definition **means**. That knowledge is the
// three resolvers, and every one of them reaches `node:child_process` through
// `pipeline-definition-validator.ts` → `src/runner/backend-runner-factory.ts`. A
// bare specifier anywhere in the value-import closure of `src/catalog/` is what
// `tests/lint/catalog-purity.test.ts` forbids (099 FR-057, FR-058), so the
// knowledge arrives as a port and this module is the adapter that satisfies it.
//
// **This is a wire, not a second oracle** (FR-017). Every answer below comes from
// the same exported validators the Builder and the loader already call —
// `resolvePhaseCatalog`, `resolvePipelineCatalog`, `resolveWorkflowCatalog`. A
// definition that publishes here is a definition that resolves there, because it
// is literally the same code deciding.
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

/**
 * The revision passed to the resolvers when this module drives them.
 *
 * Resolution carries a revision so a surface can tell one snapshot from the next.
 * Nothing here is a surface: these resolutions are the projection FR-018 describes,
 * alive for one call and persisted nowhere, so the field is given a name that says
 * so rather than a real revision that could be mistaken for one.
 */
const PROJECTION_REVISION = 'lifecycle-projection';

export interface DefinitionSemanticsOptions {
  /**
   * `schegent.defaultPipelineId`, or `''` where none is set.
   *
   * Read by the caller rather than here: this module resolves definitions and
   * takes no `vscode` import. It is the only configured default the platform has,
   * and FR-059 is emphatic that a lifecycle operation reports it and never edits
   * it.
   *
   * A getter rather than a value (T509c) because the semantics object is built
   * once at activation and the setting changes under it. Captured as a string, a
   * default set after the window opened would never produce the advisory FR-059
   * requires — the deactivation would succeed silently and the operator would
   * discover the broken default at launch instead. Read per call, it cannot go
   * stale; there is nothing to invalidate and no second construction site.
   */
  readonly defaultPipelineId: () => string;
}

export function createDefinitionSemantics(
  options: DefinitionSemanticsOptions
): DefinitionSemantics {
  return {
    defectsOf: (snapshot, candidates) => defectsOf(snapshot, candidates),
    referencesTo: (snapshot, kind, id) => referencesTo(snapshot, kind, id),
    advisoriesFor: (snapshot, kind, id) =>
      advisoriesFor(snapshot, kind, id, options.defaultPipelineId())
  };
}

// ---------------------------------------------------------------------------
// Validation (FR-016, FR-017, FR-019)
// ---------------------------------------------------------------------------

/**
 * The active rows of one kind with the candidates overlaid on them.
 *
 * A candidate replaces the active row of the same id and is appended where there
 * is none, which is what makes the union carve-out of FR-017 work: a Pipeline
 * binding a Phase that arrives in the same package validates against what the
 * publication is about to make live, not against what is live now. Persisted
 * nowhere (FR-018) — the array exists for the length of one call.
 */
function overlaidRows(
  snapshot: CatalogSnapshot,
  kind: CatalogKind,
  candidates: readonly CandidateDefinition[]
): readonly unknown[] {
  const overlay = new Map<string, unknown>();
  for (const candidate of candidates) {
    if (candidate.kind === kind) overlay.set(candidate.id, candidate.body);
  }
  if (overlay.size === 0) return storedRows(snapshot, kind);

  const rows: unknown[] = [];
  const taken = new Set<string>();
  for (const definition of snapshot.definitions) {
    if (definition.kind !== kind) continue;
    if (overlay.has(definition.id)) {
      rows.push(overlay.get(definition.id));
      taken.add(definition.id);
      continue;
    }
    // Same rule `storedRows` applies: a definition with no active body
    // contributes no row, and neither way of having none is an error here.
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

/** Resolve all three kinds in dependency order over one row set. */
function resolveAll(rowsOf: (kind: CatalogKind) => readonly unknown[]): ResolvedProjection {
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
    pipelineCatalog: { effective: pipeline.effective, records: pipeline.records }
  });
  return { phase, pipeline, workflow };
}

/**
 * Every defect the candidate set carries, across every candidate (FR-019).
 *
 * Not first-defect-wins: an operator fixing an imported document wants the whole
 * list in one pass (SC-003), and a nine-definition document reported one defect at
 * a time is nine round trips.
 *
 * Only the candidates' own defects are reported. A pre-existing invalid definition
 * elsewhere in the catalog is a real problem and not this publication's, and
 * naming it here would refuse a correct publication for someone else's mistake.
 */
function defectsOf(
  snapshot: CatalogSnapshot,
  candidates: readonly CandidateDefinition[]
): readonly ValidationDefect[] {
  if (candidates.length === 0) return [];
  const resolved = resolveAll((kind) => overlaidRows(snapshot, kind, candidates));

  const defects: ValidationDefect[] = [];
  for (const candidate of candidates) {
    defects.push(...defectsOfCandidate(resolved, candidate));
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

/**
 * A candidate the resolver produced no record for at all.
 *
 * A body malformed enough that the parser cannot even recover an id — a string, an
 * array, an object with no id field. The resolvers quarantine per row and would
 * otherwise report it under a synthetic id the operator has never seen, so it is
 * named here under the id the store knows it by.
 */
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
// References (FR-025, FR-025a, FR-025b)
// ---------------------------------------------------------------------------

/**
 * Where `phaseId` sits in one stored Pipeline body, or `-1`.
 *
 * Read from the authored body rather than from a parsed `PipelineDefinition`,
 * because an `invalid` Pipeline still holds a reference that blocks: its defects
 * are corrected and the reference goes live, and a Phase deleted out from under it
 * in the meantime would leave it permanently unfixable.
 *
 * Both authored spellings are searched, and the reason is at
 * `authoredPhasePosition`. This function read only the legacy `phases` key before,
 * so a Pipeline authored the portable way blocked nothing.
 */
function authoredPhaseIdPosition(record: PipelineSourceRecord, phaseId: string): number {
  if (record.definition !== null) return record.definition.phaseIds.indexOf(phaseId);
  return authoredPhasePosition(record.display, phaseId);
}

/**
 * Direct references only (FR-025b).
 *
 * A Phase is blocked by the Pipelines that bind it and never by the Workflows
 * above them: the Pipeline is what the operator has to fix, and fixing it
 * revalidates the Workflow at its next publication. Reporting the Workflow too
 * would name something the operator cannot act on.
 *
 * Every blocker is **active** (FR-025a): the row set is the active projection, so a
 * reference held solely by a Draft is not here. It surfaces as an advisory instead.
 */
function referencesTo(
  snapshot: CatalogSnapshot,
  kind: CatalogKind,
  id: string
): readonly ReferenceBlocker[] {
  if (kind === 'workflow') return [];
  return blockersIn(resolveAll((rowKind) => storedRows(snapshot, rowKind)), kind, id);
}

/** The references one already-resolved projection holds to `(kind, id)`. */
function blockersIn(
  resolved: ResolvedProjection,
  kind: CatalogKind,
  id: string
): readonly ReferenceBlocker[] {
  if (kind === 'workflow') return [];
  return kind === 'phase'
    ? phaseBlockers(resolved.pipeline.records, id)
    : pipelineBlockers(resolved.workflow.records, id);
}

function phaseBlockers(
  records: readonly PipelineSourceRecord[],
  phaseId: string
): readonly ReferenceBlocker[] {
  const blockers: ReferenceBlocker[] = [];
  for (const record of records) {
    const position = authoredPhaseIdPosition(record, phaseId);
    if (position === -1) continue;
    blockers.push({ kind: 'pipeline', id: record.pipelineId, field: `phaseIds[${position}]` });
  }
  return blockers;
}

function pipelineBlockers(
  records: readonly WorkflowSourceRecord[],
  pipelineId: string
): readonly ReferenceBlocker[] {
  const blockers: ReferenceBlocker[] = [];
  for (const record of records) {
    const position = record.nodePipelineIds.indexOf(pipelineId);
    if (position === -1) continue;
    blockers.push({ kind: 'workflow', id: record.workflowId, field: `nodes[${position}].pipelineId` });
  }
  return blockers;
}

// ---------------------------------------------------------------------------
// Advisories (FR-025a, FR-059, FR-060, FR-061)
// ---------------------------------------------------------------------------

/**
 * What the operator should know that does not stop the operation.
 *
 * Two sources, both non-blocking by construction:
 *
 *   `draft-reference`    — a Draft that names this definition. It cannot be
 *                          triggered, so it cannot block; and the publish gate
 *                          catches its missing reference at the moment that
 *                          matters rather than now (FR-025a).
 *   `configured-default` — `schegent.defaultPipelineId` naming it. Reported and
 *                          never edited: silently rewriting operator-owned
 *                          configuration in a different store is a surprising side
 *                          effect, and refusing would let a stale setting pin a
 *                          definition in service forever (FR-059, FR-060).
 */
function advisoriesFor(
  snapshot: CatalogSnapshot,
  kind: CatalogKind,
  id: string,
  defaultPipelineId: string
): readonly LifecycleAdvisory[] {
  const advisories: LifecycleAdvisory[] = [];

  if (kind !== 'workflow') {
    const drafted = draftProjection(snapshot);
    if (drafted !== null) {
      const referencing = blockersIn(drafted, kind, id);
      const active = new Set(
        referencesTo(snapshot, kind, id).map((blocker) => blocker.id)
      );
      for (const reference of referencing) {
        // A definition that is both active and drafted, both referencing, is a
        // blocker and not an advisory. Reporting it twice would tell the operator
        // to look at one thing in two places.
        if (active.has(reference.id)) continue;
        advisories.push({ advisory: 'draft-reference', kind: reference.kind, id: reference.id });
      }
    }
  }

  if (kind === 'pipeline' && defaultPipelineId !== '' && defaultPipelineId === id) {
    advisories.push({ advisory: 'configured-default', kind: null, id });
  }

  return advisories;
}

/**
 * The catalog as its Drafts describe it: every definition's draft body where it has
 * one, its active body where it does not.
 *
 * `null` when nothing is drafted at all, which lets the common deactivation skip a
 * second resolution of the whole catalog.
 *
 * A draft is resolved against the *active* catalog of the other kinds, not against
 * their drafts. The question this answers is narrow — does some Draft name the
 * definition being taken out of service — and a reference is a reference whether or
 * not the rest of that Draft resolves.
 */
function draftProjection(snapshot: CatalogSnapshot): ResolvedProjection | null {
  if (!snapshot.definitions.some((definition) => definition.draftBody !== null)) return null;
  return resolveAll((kind) => draftedRows(snapshot, kind));
}

function draftedRows(snapshot: CatalogSnapshot, kind: CatalogKind): readonly unknown[] {
  const rows: unknown[] = [];
  for (const definition of snapshot.definitions) {
    if (definition.kind !== kind) continue;
    const body = bodyOf(definition);
    if (body === null) continue;
    rows.push(body);
  }
  return rows;
}

function bodyOf(definition: StoredDefinition): unknown {
  return definition.draftBody !== null ? definition.draftBody : definition.body;
}
