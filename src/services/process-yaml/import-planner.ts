// Feature 084 T029 — the import planner.
//
// Pure, total, and free of I/O: parse and validate happen before it, the write
// happens after it. What it decides is one thing — for the resource a document
// declared, does this installation already claim that id, and if not, what
// would importing it do.
//
// THE PRESENCE ORACLE (FR-030, data-model "PhaseIdPresence"). Presence is
// computed from the STORED ROWS OF EVERY LAYER, whatever each row's
// `PhaseSourceStatus` — `'effective'`, `'shadowed'`, or `'invalid'`. It is NOT
// computed from the resolved effective catalog. A shadowed or malformed row
// still claims its id, so an import cannot take an id the operator is part-way
// through repairing. The rows are the argument, and `PhaseSourceRecord` is the
// only shape this module accepts, so a later change cannot pass
// `resolution.effective` here without failing to typecheck.
//
// Note the deliberate asymmetry with export, which reads the EFFECTIVE catalog
// (FR-014) because it must describe what this installation would actually run.
//
// Decision (084, autonomous): when more than one stored row claims an id, the
// reported claimant is the first in the order the oracle is written in —
// built-in, then user, then workspace. Precedence order was rejected: the
// highest-precedence non-invalid row is always promoted to `'effective'`, which
// would make `presentRowStatus: 'shadowed'` unreachable and turn the field into
// a constant. Presence is a gate, not a routing decision; the reported row is
// evidence for the skip.
//
// Feature 085 T032 extends the same module to packages. A package declares more
// than one resource, so the planner gains a second presence oracle — the stored
// Pipeline rows — and a per-resource walk. It gains nothing else: an included
// Phase is planned by the SAME row builder a standalone Phase document is, so a
// packaged Phase and a standalone one cannot come to plan differently (FR-008).
//
// Dependency resolution is deliberately NOT decided here. `package-resolver.ts`
// owns it (FR-030a) and this module only calls it, because the two oracles must
// never be substituted for one another and keeping them in separate files means
// the wrong argument does not typecheck. T041 is the call: a well-formed
// Pipeline whose references do not resolve becomes `blocked`, which is a change
// to the root's outcome only.
//
// That call forces the one ordering constraint in this module. The root is
// REPORTED first (FR-016, the reader's order) but must be DECIDED last, because
// its outcome depends on what the included Phases planned to — a Phase this same
// document imports resolves the root's reference (FR-035). So the walk is two
// passes over one list, and the reported order is the list's.
//
// Errors are values. Nothing here throws.

import type {
  PipelineDefinition,
  PipelineSourceRecord
} from '../../contracts/pipeline-definitions';
import type {
  PhaseDefinition,
  PhaseDefinitionScope,
  PhaseSourceRecord,
  PhaseSourceStatus
} from '../../contracts/process-definitions';
import { resolvePipelineDependencies } from './package-resolver';
import { phaseDefinitionFromDocument } from './phase-yaml-mapper';
import type { PhaseYamlValidationResult } from './phase-yaml-validator';
import type { PipelinePackageResource, PipelinePackageResult } from './pipeline-document';
import type {
  DocumentRefusal,
  ImportDefect,
  ImportPlan,
  ImportPlanCounts,
  ImportPlanRow,
  PhaseYamlDocument,
  ProcessYamlLayerRevisions,
  ProcessYamlPresenceScope,
  ProcessYamlPresenceStatus,
  ProcessYamlResourceKind
} from './types';

/** The layer order the presence union is written in (data-model). */
const PRESENCE_SCAN_ORDER: readonly PhaseDefinitionScope[] = ['built-in', 'user', 'workspace'];

export interface PhaseIdPresence {
  readonly scope: PhaseDefinitionScope;
  readonly status: PhaseSourceStatus;
}

/** The same evidence for a Pipeline id, from the Pipeline catalog's stored rows. */
export interface PipelineIdPresence {
  readonly scope: ProcessYamlPresenceScope;
  readonly status: ProcessYamlPresenceStatus;
}

/**
 * A document-level refusal carries no plan, not even an empty one, so a partial
 * plan for a document this build refused is unrepresentable (FR-027, FR-029).
 *
 * One shape for both entry points: a Phase document declares one resource and a
 * package declares several, but "refused, or a plan" is the same statement, and
 * two identical declarations would be two things to keep in step.
 */
export type ProcessImportPlanResult =
  | { readonly outcome: 'refused'; readonly refusal: DocumentRefusal }
  | { readonly outcome: 'planned'; readonly plan: ImportPlan };

/**
 * The oracles the package planner consults, kept apart on purpose.
 *
 * `phaseRows` and `pipelineRows` are STORED rows at every status — the presence
 * gate (FR-030). `effectivePhases` is the RESOLVED catalog — dependency
 * resolution (FR-030a). They answer different questions and are never
 * substituted for one another: a shadowed row claims its id but cannot satisfy a
 * reference, and treating either oracle as the other silently breaks one of the
 * two rules.
 */
export interface PackageImportContext {
  readonly phaseRows: readonly PhaseSourceRecord[];
  readonly pipelineRows: readonly PipelineSourceRecord[];
  /** Read by the US4 resolver; carried here so the two oracles arrive together. */
  readonly effectivePhases: readonly PhaseDefinition[];
  /** Phase catalog layer revisions. */
  readonly revisions: ProcessYamlLayerRevisions;
  /**
   * Pipeline catalog layer revisions. Separate because the two layers are
   * independently mutable and a confirmed package is two ordered writes, each
   * gated on its own layer having not moved since this plan was computed
   * (FR-040, FR-043).
   */
  readonly pipelineRevisions: ProcessYamlLayerRevisions;
}

/**
 * Does any stored row in any layer claim `phaseId`?
 *
 * Exported so the rule has a name and a direct test, rather than being an
 * anonymous `.some(...)` inside the planner.
 */
export function findPhaseIdPresence(
  storedRows: readonly PhaseSourceRecord[],
  phaseId: string
): PhaseIdPresence | null {
  for (const scope of PRESENCE_SCAN_ORDER) {
    const claimant = storedRows.find((row) => row.scope === scope && row.phaseId === phaseId);
    if (claimant !== undefined) {
      return Object.freeze({ scope: claimant.scope, status: claimant.status });
    }
  }
  return null;
}

/**
 * The same question of the Pipeline catalog. A separate function rather than a
 * generic one: the two catalogs are separate stores with separate revisions, and
 * a single scan taking "rows and an id accessor" would make it possible to pass
 * one catalog's rows while asking about the other's id.
 */
export function findPipelineIdPresence(
  storedRows: readonly PipelineSourceRecord[],
  pipelineId: string
): PipelineIdPresence | null {
  for (const scope of PRESENCE_SCAN_ORDER) {
    const claimant = storedRows.find((row) => row.scope === scope && row.pipelineId === pipelineId);
    if (claimant !== undefined) {
      return Object.freeze({ scope: claimant.scope, status: claimant.status });
    }
  }
  return null;
}

function countRows(rows: readonly ImportPlanRow[]): ImportPlanCounts {
  let importCount = 0;
  let skipCount = 0;
  let blockedCount = 0;
  let invalidCount = 0;
  for (const row of rows) {
    if (row.outcome === 'import') importCount += 1;
    else if (row.outcome === 'skip') skipCount += 1;
    else if (row.outcome === 'blocked') blockedCount += 1;
    else invalidCount += 1;
  }
  // Derived by walking the same list the operator sees, so the counts cannot
  // describe a different set of rows than the ones reported (FR-028).
  return Object.freeze({
    import: importCount,
    skip: skipCount,
    blocked: blockedCount,
    invalid: invalidCount
  });
}

function planned(
  rows: readonly ImportPlanRow[],
  revisions: ProcessYamlLayerRevisions,
  pipelineRevisions?: ProcessYamlLayerRevisions
): ProcessImportPlanResult {
  return {
    outcome: 'planned',
    plan: Object.freeze({
      rows: Object.freeze(rows),
      counts: countRows(rows),
      computedAgainstRevision: revisions,
      // Omitted rather than duplicated on the Phase path: a plan that cannot
      // write the Pipeline layer has no Pipeline revision to have been computed
      // against, and claiming one would be a fact about a catalog this plan
      // never read (FR-043).
      ...(pipelineRevisions !== undefined
        ? { computedAgainstPipelineRevision: pipelineRevisions }
        : {})
    })
  };
}

/**
 * Every defect the validator collected, in one pass (FR-026, FR-027). The
 * planner adds none of its own: a malformed resource is not also checked for
 * presence, because the id it claims may itself be the defect — and an invalid
 * resource does not claim its id for dependency resolution either (FR-032).
 */
function invalidRow(
  resourceKind: ProcessYamlResourceKind,
  resourceId: string | null,
  defects: readonly ImportDefect[]
): ImportPlanRow {
  return Object.freeze({
    outcome: 'invalid' as const,
    resourceKind,
    resourceId,
    defects,
    totalDefects: defects.length
  });
}

/**
 * The row a well-formed Phase resource plans to.
 *
 * Shared on purpose (FR-008): a Phase declared inside a package carries the
 * same `metadata`/`spec` mappings a standalone Phase document does, so building
 * the row twice would let the two paths drift into planning one definition two
 * different ways.
 */
function phaseSkipOrImportRow(
  document: PhaseYamlDocument,
  storedRows: readonly PhaseSourceRecord[]
): ImportPlanRow {
  const { metadata, spec } = document;
  const presence = findPhaseIdPresence(storedRows, metadata.phaseId);
  if (presence !== null) {
    // Never overwritten, merged, renamed, or versioned (FR-024).
    return Object.freeze({
      outcome: 'skip' as const,
      resourceKind: 'phase' as const,
      resourceId: metadata.phaseId,
      name: metadata.name,
      presentIn: presence.scope,
      presentRowStatus: presence.status
    });
  }

  return Object.freeze({
    outcome: 'import' as const,
    resourceKind: 'phase' as const,
    resourceId: metadata.phaseId,
    name: metadata.name,
    // Advisory only. The capability gate is re-evaluated at commit time and is
    // never answered from this value (FR-012a).
    requiresRetryConditionCapability: spec.retryCondition !== undefined,
    // What the commit writes, exactly as the document authored it (FR-046a).
    // The plan carries it because nothing here is retained past the read that
    // produced it (FR-031); see `ImportPlanRow` for why it is the one field on
    // the row that is not sanitized or bounded.
    definition: phaseDefinitionFromDocument(document)
  });
}

/**
 * The row the root Pipeline plans to: presence first, then dependencies.
 *
 * Presence is checked BEFORE resolution because a skipped Pipeline is not
 * written, and reporting a dependency problem on a resource this import will not
 * touch would send the operator to fix something that is not in their way.
 *
 * No `requiresRetryConditionCapability`: the field is a Phase's, and the
 * capability gate keys on a Phase declaring `retryCondition`. A Pipeline that
 * arrives with Phases needing the capability says so through THEIR rows.
 */
function pipelineRow(
  definition: PipelineDefinition,
  context: PackageImportContext,
  plannedPhaseRows: readonly ImportPlanRow[]
): ImportPlanRow {
  const presence = findPipelineIdPresence(context.pipelineRows, definition.pipelineId);
  if (presence !== null) {
    return Object.freeze({
      outcome: 'skip' as const,
      resourceKind: 'pipeline' as const,
      resourceId: definition.pipelineId,
      name: definition.name,
      presentIn: presence.scope,
      presentRowStatus: presence.status
    });
  }

  const resolution = resolvePipelineDependencies(definition, {
    effectivePhases: context.effectivePhases,
    storedPhases: context.phaseRows,
    plannedPhaseRows
  });

  if (resolution.outcome === 'blocked') {
    // FR-033 — a well-formed Pipeline whose references do not resolve is
    // `blocked`, never `invalid`. Nothing about the resource is wrong; what it
    // needs is somewhere else, and only one of those two is fixed by importing
    // something first.
    return Object.freeze({
      outcome: 'blocked' as const,
      resourceKind: 'pipeline' as const,
      resourceId: definition.pipelineId,
      name: definition.name,
      reason: resolution.reason
    });
  }

  if (resolution.outcome === 'invalid') {
    // A binding defect IS the resource being wrong (FR-046a), so it reports
    // through the same row shape the validator's own defects do.
    return invalidRow('pipeline', definition.pipelineId, resolution.defects);
  }

  return Object.freeze({
    outcome: 'import' as const,
    resourceKind: 'pipeline' as const,
    resourceId: definition.pipelineId,
    name: definition.name,
    definition
  });
}

/**
 * Turn one validated document into the plan an operator confirms or abandons.
 *
 * `revisions` records BOTH writable layers, because the target scope is chosen
 * after preflight; recording one would leave the staleness gate unable to fire
 * for whichever scope the operator actually picks (FR-033).
 */
export function planPhaseImport(
  validation: PhaseYamlValidationResult,
  storedRows: readonly PhaseSourceRecord[],
  revisions: ProcessYamlLayerRevisions
): ProcessImportPlanResult {
  if (!validation.ok && validation.kind === 'document') {
    return { outcome: 'refused', refusal: validation.refusal };
  }

  if (!validation.ok) {
    return planned([invalidRow('phase', validation.resourceId, validation.defects)], revisions);
  }

  return planned([phaseSkipOrImportRow(validation.document, storedRows)], revisions);
}

/** One row per declared resource, whatever that resource turned out to be (FR-024). */
function planPackageResource(
  resource: PipelinePackageResource,
  context: PackageImportContext,
  plannedPhaseRows: readonly ImportPlanRow[]
): ImportPlanRow {
  if (!resource.ok) {
    return invalidRow(resource.resourceKind, resource.resourceId, resource.defects);
  }
  if (resource.resourceKind === 'pipeline') {
    return pipelineRow(resource.definition, context, plannedPhaseRows);
  }
  return phaseSkipOrImportRow(resource.document, context.phaseRows);
}

/**
 * Pass one: the Phase rows the root's outcome depends on (FR-035).
 *
 * A malformed Phase resource is deliberately absent. It claims no id (FR-032),
 * so it can neither satisfy a reference nor be the `skip` that explains one, and
 * including it would only add a row the resolver filters back out. The rows built
 * here are discarded — pass two rebuilds them through the same pure builder — so
 * a Phase row's shape is still decided in exactly one place.
 */
function plannedPhaseRowsOf(
  resources: readonly PipelinePackageResource[],
  storedRows: readonly PhaseSourceRecord[]
): readonly ImportPlanRow[] {
  const rows: ImportPlanRow[] = [];
  for (const resource of resources) {
    if (!resource.ok || resource.resourceKind !== 'phase') continue;
    rows.push(phaseSkipOrImportRow(resource.document, storedRows));
  }
  return rows;
}

/**
 * Turn one read package into the plan an operator confirms or abandons.
 *
 * A document-level refusal passes straight through with no plan attached, not
 * even an empty one, and not a plan of zero rows: a refused document was never
 * classified, so there is nothing to report per resource (FR-029).
 *
 * Row ORDER is the reader's, not the planner's — the root Pipeline first, then
 * the included Phases in first-mention order (FR-016). The planner walks the
 * list it was handed and reorders nothing, so what the operator reads matches
 * the order the document declared.
 *
 * Order of REPORTING is not order of DECIDING. The Phase rows are computed
 * first because the root's outcome reads them, and the reported list is then
 * built in the document's own order. FR-039 falls out of that split rather than
 * being a rule anywhere: a blocked root does not change any other row, so an
 * independently eligible Phase is still `import`.
 */
export function planPipelineImport(
  result: PipelinePackageResult,
  context: PackageImportContext
): ProcessImportPlanResult {
  if (!result.ok) {
    return { outcome: 'refused', refusal: result.refusal };
  }

  const plannedPhaseRows = plannedPhaseRowsOf(result.resources, context.phaseRows);

  return planned(
    result.resources.map((resource) => planPackageResource(resource, context, plannedPhaseRows)),
    context.revisions,
    context.pipelineRevisions
  );
}
