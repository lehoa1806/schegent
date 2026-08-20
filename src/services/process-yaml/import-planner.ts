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
// Decision (084, autonomous; restated for 099 T496f, FR-042): when more than one
// stored row claims an id, the reported claimant is the first in stored order.
// The layer ordering this used to describe — built-in, then user, then workspace —
// is deleted with the tier, and so is the `shadowed` status that made the choice
// of claimant observable. One catalog invalidates BOTH rows of a duplicate pair
// instead, so the reported status is `'invalid'` whichever row is read first.
// Presence is a gate, not a routing decision; the reported row is evidence for
// the skip.
//
// Feature 085 T032 extends the same module to packages. A package declares more
// than one resource, so the planner gains a second presence oracle — the stored
// Pipeline rows — and a per-resource walk. It gains nothing else: an included
// Phase is planned by the SAME row builder a standalone Phase document is, so a
// packaged Phase and a standalone one cannot come to plan differently (FR-008).
//
// Feature 086 T036 adds the third catalog on the same terms: a third stored-row
// presence oracle, a third layer revision, and one more row builder. Everything
// below the root is untouched — a Pipeline included in a Workflow package is
// planned by the SAME builder a Pipeline package's is, and its Phases by the same
// one again, so a resource cannot come to plan differently according to which kind
// of document shipped it (FR-008).
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
  PhaseSourceRecord,
  PhaseSourceStatus
} from '../../contracts/process-definitions';
import type { WorkflowDefinition, WorkflowSourceRecord } from '../../contracts/workflow-definitions';
import { resolvePipelineDependencies, resolveWorkflowDependencies } from './package-resolver';
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
  ProcessYamlCatalogRevision,
  ProcessYamlPresenceStatus,
  ProcessYamlResourceKind
} from './types';
import type { WorkflowPackageResource, WorkflowPackageResult } from './workflow-document';

// Feature 099 (T490, FR-049) — `PRESENCE_SCAN_ORDER` is deleted, not reduced to a
// one-element list. It named the order `built-in`, `user`, `workspace` were
// searched and which claim won; with one layer there is no order to state, and a
// single-element iteration would be the scan order kept alive as a loop nobody
// can see is vestigial. The presence *property* is untouched: a scan of stored
// rows at every status, never the effective catalog (FR-050).

export interface PhaseIdPresence {
  readonly status: PhaseSourceStatus;
}

/** The same evidence for a Pipeline id, from the Pipeline catalog's stored rows. */
export interface PipelineIdPresence {
  readonly status: ProcessYamlPresenceStatus;
}

/** The same evidence for a Workflow id, from the Workflow catalog's stored rows. */
export interface WorkflowIdPresence {
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
  /** The Phase kind's store revision (FR-044a). */
  readonly revision: ProcessYamlCatalogRevision;
  /**
   * The Pipeline kind's store revision. Separate because the two kinds are
   * independently mutable and a confirmed package is two ordered writes, each
   * gated on its own kind having not moved since this plan was computed
   * (FR-040, FR-043).
   */
  readonly pipelineRevision: ProcessYamlCatalogRevision;
}

/**
 * What a Workflow package adds: the third presence oracle and the third layer
 * revision (FR-030, FR-036).
 *
 * It EXTENDS the Pipeline context rather than replacing it, because a Workflow
 * package's included Pipelines and Phases are planned by the very same builders a
 * Pipeline package's are — so the oracles they read have to arrive in the same
 * shape, and a Workflow-specific copy would be a second place for the Phase and
 * Pipeline rules to live.
 */
export interface WorkflowPackageImportContext extends PackageImportContext {
  /** STORED Workflow rows at every status — presence, never resolution. */
  readonly workflowRows: readonly WorkflowSourceRecord[];
  /**
   * The RESOLVED Pipeline catalog — pass 3's resolution oracle (FR-036), the twin
   * of `effectivePhases` one level up. Separate from `pipelineRows` for the reason
   * those two are separate at the Phase level: a shadowed Pipeline row claims its
   * id but cannot satisfy a node, and substituting either oracle for the other
   * breaks exactly one of the two rules.
   */
  readonly effectivePipelines: readonly PipelineDefinition[];
  /**
   * `pipelineId` → short cause, for ids that resolve to an *invalid* Pipeline
   * record rather than being absent. Supplied by the caller from the catalog's own
   * `invalidPipelineCauses`, and carried through to `validateWorkflowGraph` so a
   * transitive cause can be named; deriving it here would be a second answer to a
   * question the catalog already answers.
   */
  readonly invalidPipelines: ReadonlyMap<string, string>;
  /**
   * The Workflow kind's store revision. A third field for the reason there is a
   * second: three independently mutable kinds cannot share one staleness gate,
   * and a confirmed package is three ordered writes each carrying its own
   * `expectedRevision`.
   */
  readonly workflowRevision: ProcessYamlCatalogRevision;
}

/**
 * Does any stored row claim `phaseId`?
 *
 * Exported so the rule has a name and a direct test, rather than being an
 * anonymous `.some(...)` inside the planner. Still every stored row at every
 * status, never the effective catalog (FR-050) — a row that is `invalid` claims
 * its id just as firmly as one that resolves, which is the whole point.
 */
export function findPhaseIdPresence(
  storedRows: readonly PhaseSourceRecord[],
  phaseId: string
): PhaseIdPresence | null {
  const claimant = storedRows.find((row) => row.phaseId === phaseId);
  return claimant === undefined ? null : Object.freeze({ status: claimant.status });
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
  const claimant = storedRows.find((row) => row.pipelineId === pipelineId);
  return claimant === undefined ? null : Object.freeze({ status: claimant.status });
}

/**
 * And the same question of the Workflow catalog — a third scan, for the third
 * store, for the reason the second one is separate rather than generic.
 *
 * A Workflow id is not a Pipeline id and not a Phase id: the three catalogs are
 * independent stores with independent revisions, so a Pipeline named
 * `ship-it-flow` claims nothing about the Workflow of that name. One scan
 * parameterized over "rows and an id accessor" would make it possible to pass one
 * catalog's rows while asking about another catalog's id, and the mistake would
 * typecheck.
 */
export function findWorkflowIdPresence(
  storedRows: readonly WorkflowSourceRecord[],
  workflowId: string
): WorkflowIdPresence | null {
  const claimant = storedRows.find((row) => row.workflowId === workflowId);
  return claimant === undefined ? null : Object.freeze({ status: claimant.status });
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

/**
 * The kinds beyond Phases this plan can write, each named at the call site.
 *
 * An object rather than two more positional parameters: a Workflow package may
 * declare a Workflow and no Pipeline, so positional arguments would put a bare
 * `undefined` in the middle of the call, which is exactly how the wrong kind's
 * revision comes to gate the wrong write.
 */
interface OptionalKindRevisions {
  readonly pipelineRevision?: ProcessYamlCatalogRevision;
  readonly workflowRevision?: ProcessYamlCatalogRevision;
}

function planned(
  rows: readonly ImportPlanRow[],
  revision: ProcessYamlCatalogRevision,
  optional: OptionalKindRevisions = {}
): ProcessImportPlanResult {
  return {
    outcome: 'planned',
    plan: Object.freeze({
      rows: Object.freeze(rows),
      counts: countRows(rows),
      computedAgainstRevision: revision,
      // Omitted rather than duplicated on the Phase path: a plan that cannot
      // write the Pipeline layer has no Pipeline revision to have been computed
      // against, and claiming one would be a fact about a catalog this plan
      // never read (FR-043). The same holds a layer up (FR-036) — the webview
      // reads each field's PRESENCE as "this plan can write that layer".
      ...(optional.pipelineRevision !== undefined
        ? { computedAgainstPipelineRevision: optional.pipelineRevision }
        : {}),
      ...(optional.workflowRevision !== undefined
        ? { computedAgainstWorkflowRevision: optional.workflowRevision }
        : {})
    })
  };
}

/**
 * Every defect the validator collected, in one pass (FR-026, FR-027). The
 * planner adds none of its own: a malformed resource is not also checked for
 * presence, because the id it claims may itself be the defect — and an invalid
 * resource does not claim its id for dependency resolution either (085's FR-032,
 * which 086 restates as the first step of the FR-025a order below; 086's own
 * FR-032 is the status a skip row names — the layer half went with the tier).
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
 * `revision` is the Phase kind's store revision at the moment the preview was
 * computed. Feature 099 (T490, FR-043) — it recorded both writable layers,
 * because the target scope was chosen after preflight and one revision could not
 * gate a choice not yet made. There is one target, so there is one revision.
 */
export function planPhaseImport(
  validation: PhaseYamlValidationResult,
  storedRows: readonly PhaseSourceRecord[],
  revision: ProcessYamlCatalogRevision
): ProcessImportPlanResult {
  if (!validation.ok && validation.kind === 'document') {
    return { outcome: 'refused', refusal: validation.refusal };
  }

  if (!validation.ok) {
    return planned([invalidRow('phase', validation.resourceId, validation.defects)], revision);
  }

  return planned([phaseSkipOrImportRow(validation.document, storedRows)], revision);
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
    context.revision,
    { pipelineRevision: context.pipelineRevision }
  );
}

/**
 * The row the root Workflow plans to: presence first, then its node Pipelines.
 *
 * Presence before resolution (FR-025a), for the reason the Pipeline row checks it
 * first: a skipped Workflow is not written, and reporting a dependency problem on
 * a resource this import will not touch sends the operator to fix something that
 * is not in their way. `planWorkflowPackageResource` states the whole order.
 *
 * `plannedPipelineRows` is how pass 2's verdicts reach pass 3 (T045) — the same
 * mechanism `plannedPhaseRows` is for pass 1 to pass 2, and deliberately not a
 * separate verdict map: the planner already records a pass-2-blocked Pipeline as a
 * `blocked` ROW, so reading the rows means the two passes cannot disagree about a
 * Pipeline's fate.
 *
 * No `requiresRetryConditionCapability` here either. The field is a Phase's, and
 * a Workflow that arrives with Phases needing the capability says so through
 * THEIR rows — two layers down, and still exactly once.
 */
function workflowRow(
  definition: WorkflowDefinition,
  context: WorkflowPackageImportContext,
  plannedPhaseRows: readonly ImportPlanRow[],
  plannedPipelineRows: readonly ImportPlanRow[]
): ImportPlanRow {
  const presence = findWorkflowIdPresence(context.workflowRows, definition.workflowId);
  if (presence !== null) {
    // Never overwritten, merged, renamed, or versioned (FR-024). FR-025b is the
    // other half and needs no code: a skipped root is one row, so the resources it
    // shipped are still planned on their own merits.
    return Object.freeze({
      outcome: 'skip' as const,
      resourceKind: 'workflow' as const,
      resourceId: definition.workflowId,
      name: definition.name,
      presentRowStatus: presence.status
    });
  }

  const resolution = resolveWorkflowDependencies(definition, {
    effectivePhases: context.effectivePhases,
    storedPhases: context.phaseRows,
    plannedPhaseRows,
    effectivePipelines: context.effectivePipelines,
    storedPipelines: context.pipelineRows,
    plannedPipelineRows,
    invalidPipelines: context.invalidPipelines
  });

  if (resolution.outcome === 'blocked') {
    // FR-037 — a well-formed Workflow whose nodes do not resolve is `blocked`,
    // never `invalid`. The reason may be propagated (`dependency-blocked`), which
    // is the one thing this row can say that a Pipeline row cannot: a Pipeline's
    // dependency failure is always a root cause, a Workflow's need not be.
    return Object.freeze({
      outcome: 'blocked' as const,
      resourceKind: 'workflow' as const,
      resourceId: definition.workflowId,
      name: definition.name,
      reason: resolution.reason
    });
  }

  if (resolution.outcome === 'invalid') {
    // Every node resolved and the GRAPH is wrong — an endpoint that addresses no
    // port, a cycle's port pass, an incompatible pair. That is the resource being
    // wrong, so it reports through the same row shape the field pass's defects do.
    return invalidRow('workflow', definition.workflowId, resolution.defects);
  }

  return Object.freeze({
    outcome: 'import' as const,
    resourceKind: 'workflow' as const,
    resourceId: definition.workflowId,
    name: definition.name,
    definition
  });
}

/**
 * One row per declared resource, across all three kinds now (FR-024).
 *
 * This is the classification site, and the order it decides in is normative:
 * **invalid, then skip, then blocked, then import** (FR-025a). The first step is
 * the `!resource.ok` gate right below; the other three live in the per-kind
 * builders, each of which checks presence before it resolves anything. Read
 * top to bottom the two skipped reads are the whole rule:
 *
 *   - **An invalid resource never consults presence.** The id it claims may
 *     itself be the defect, so a presence answer would be about some other
 *     resource — and "you already have this" tells an operator to do nothing
 *     about a document that is broken. It claims no id for resolution either, so
 *     it can neither satisfy a reference nor be the `skip` that explains one.
 *   - **A skipped resource never consults resolution.** This import will not
 *     write it, so a dependency problem found on it is not in the operator's
 *     way; reporting one would send them to fix something that does not block
 *     anything they asked for. Its included copy is dropped rather than compared
 *     against the catalog's copy (FR-036a) for the same reason — the catalog's
 *     copy is what runs.
 *
 * Both omissions are absences, which is exactly what makes them easy to
 * "restore" as an improvement, so the order is stated here rather than left to
 * be inferred from three builders. What the order does NOT do is propagate:
 * every resource is classified on its own merits, so a skipped or blocked root
 * demotes nothing it shipped (FR-025b), and a skip row and a blocked row naming
 * the same id both stand (FR-038a).
 */
function planWorkflowPackageResource(
  resource: WorkflowPackageResource,
  context: WorkflowPackageImportContext,
  plannedPhaseRows: readonly ImportPlanRow[],
  plannedPipelineRows: readonly ImportPlanRow[]
): ImportPlanRow {
  if (!resource.ok) {
    return invalidRow(resource.resourceKind, resource.resourceId, resource.defects);
  }
  if (resource.resourceKind === 'workflow') {
    return workflowRow(resource.definition, context, plannedPhaseRows, plannedPipelineRows);
  }
  if (resource.resourceKind === 'pipeline') {
    // The Pipeline builder a Pipeline PACKAGE uses, unchanged and uncopied: an
    // included Pipeline is planned identically whichever kind of document shipped
    // it, so `plannedPhaseRows` resolves its references here for the same reason
    // it does there (FR-008, FR-035).
    return pipelineRow(resource.definition, context, plannedPhaseRows);
  }
  return phaseSkipOrImportRow(resource.document, context.phaseRows);
}

/**
 * Pass one, a layer up: the Phase rows the included Pipelines' outcomes depend on.
 *
 * A separate walk from `plannedPhaseRowsOf` only because the two resource unions
 * are different types; the row it collects is built by the same one builder, so a
 * packaged Phase cannot plan differently here than anywhere else. A malformed
 * Phase resource is deliberately absent — it claims no id (FR-032), so it can
 * neither satisfy a reference nor be the `skip` that explains one.
 */
function workflowPackagePhaseRows(
  resources: readonly WorkflowPackageResource[],
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
 * Pass two: the Pipeline rows the root Workflow's outcome depends on (T045).
 *
 * Built through `pipelineRow` — the same builder pass three reports with — so an
 * included Pipeline cannot be judged one way for the root's benefit and another
 * way for the operator's. It takes `plannedPhaseRows` because a Pipeline's own
 * outcome depends on pass one, which is exactly why this is a third pass and not
 * a second: `import`, `skip`, `blocked`, and `invalid` are all reachable here, and
 * only the first two let a node resolve.
 *
 * A malformed Pipeline resource is deliberately absent, for `plannedPhaseRowsOf`'s
 * reason: it claims no id (FR-032), so it can neither satisfy a node reference nor
 * be the `skip` that explains one. The root then reports the node as
 * `dependency-absent`, which is what the document actually says — the id it names
 * is nowhere, and the malformed resource has its own row saying why.
 *
 * These rows are discarded and rebuilt by the reporting pass, as `plannedPhaseRowsOf`
 * describes; the builder is pure, so rebuilding costs a walk and buys one definition
 * of a Pipeline row.
 */
function workflowPackagePipelineRows(
  resources: readonly WorkflowPackageResource[],
  context: WorkflowPackageImportContext,
  plannedPhaseRows: readonly ImportPlanRow[]
): readonly ImportPlanRow[] {
  const rows: ImportPlanRow[] = [];
  for (const resource of resources) {
    if (!resource.ok || resource.resourceKind !== 'pipeline') continue;
    rows.push(pipelineRow(resource.definition, context, plannedPhaseRows));
  }
  return rows;
}

/** Did the document declare a resource of this kind, well-formed or not? */
function declaresKind(
  resources: readonly WorkflowPackageResource[],
  kind: ProcessYamlResourceKind
): boolean {
  return resources.some((resource) => resource.resourceKind === kind);
}

/**
 * Turn one read Workflow package into the plan an operator confirms or abandons.
 *
 * Row ORDER is the reader's — the root Workflow, then `included.pipelines`, then
 * `included.phases` (FR-016, `WORKFLOW_INCLUDED_KEY_ORDER`). The planner walks the
 * list it was handed and reorders nothing.
 *
 * Order of REPORTING is again not order of DECIDING: the Phase rows are computed
 * first because the included Pipelines' outcomes read them, and the reported list
 * is then built in the document's own order. From T045 the root reads the Pipeline
 * rows the same way, which is why the root is reported first and decided last.
 */
export function planWorkflowImport(
  result: WorkflowPackageResult,
  context: WorkflowPackageImportContext
): ProcessImportPlanResult {
  if (!result.ok) {
    return { outcome: 'refused', refusal: result.refusal };
  }

  const plannedPhaseRows = workflowPackagePhaseRows(result.resources, context.phaseRows);
  const plannedPipelineRows = workflowPackagePipelineRows(
    result.resources,
    context,
    plannedPhaseRows
  );

  return planned(
    result.resources.map((resource) =>
      planWorkflowPackageResource(resource, context, plannedPhaseRows, plannedPipelineRows)
    ),
    context.revision,
    {
      // One revision per layer this plan can WRITE, which is one per layer the
      // document declared a resource for. A references-only Workflow claims no
      // Pipeline revision, because offering that write would offer a write with
      // nothing in it.
      ...(declaresKind(result.resources, 'pipeline')
        ? { pipelineRevision: context.pipelineRevision }
        : {}),
      ...(declaresKind(result.resources, 'workflow')
        ? { workflowRevision: context.workflowRevision }
        : {})
    }
  );
}
