// Feature 084 T037–T040 — every decision the import surface makes, as pure
// functions the component only renders.
//
// Split out of `ProcessImportPreflight.svelte` because the same reason strings
// are needed twice: once by the plan table before the commit, and once by the
// result table after it (FR-042). One copy means the two cannot disagree about
// why a row was skipped.
//
// Nothing here posts, reads, or retains anything. The commit itself is the
// existing package publish — import adds no mutating IPC command (research R2)
// — so this module's job ends at building its request and reading its ack.
//
// Feature 085 T035 — the plan is now kind-tagged. Preflight takes no kind from
// the request (FR-055a), so one plan can carry Phase rows and Pipeline rows at
// once, and every question this module answers had to be re-asked per kind:
// which rows the operator is being shown (FR-056), which rows are eligible
// (FR-057), and which of those THIS commit can write.
//
// Feature 085 T048 — the commit is now two ordered layer writes: the Phase layer
// first, then the Pipeline layer (FR-038), each carrying its OWN expected
// revision (FR-043) and its own single mutation intent. They are two writes and
// not one because they are two independently-revisioned catalogs; that is also
// why the outcome has three values rather than two (FR-042a) and why a failed
// second write triggers no compensating delete (FR-042c) — what landed is left
// in place, and importing the same document again finishes the job (FR-042b).
//
// Feature 086 T054/T055 — a third ordered write, the Workflow layer, sent last
// for the same dependency reason the Pipeline layer is sent second (FR-045,
// FR-050). The stopping rule and the outcome arithmetic were already total over
// any number of layers, so neither changed; what did change is the partial
// sentence, which now names WHICH layers landed (FR-051), because with three of
// them "part of this document" no longer tells the operator where to look.
//
// Feature 099 (T494a, FR-043/FR-044) — the target scope is gone from every
// function here. "Which layer" and "which kind" were two independent axes: the
// three ordered writes are the KIND axis and are untouched, because the three
// catalogs are still independently revisioned and a Pipeline still cannot be
// validated before its Phases exist. What collapsed is the other axis — the
// operator's choice of destination, the per-scope revision lookup, and the layer
// noun in every sentence a result carries.

import type {
  BlockedDependency,
  DocumentRefusalCode,
  ImportPlan,
  ImportPlanRow,
  ProcessYamlResourceKind
} from '../../lib/messages';
import type { SaveModelsImportRequest, SaveModelsImportResult } from '../../lib/save-models';
import type { LifecycleResult } from '../../lib/catalog-lifecycle';
import { pipelineRowId } from '../../lib/definition-rows';
import type {
  SavePhaseRow,
  SavePipelineRow,
  SaveWorkflowRow
} from '../../lib/definition-rows';
import type {
  PackageLayer,
  PackagePublishRequest
} from '../../../../src/contracts/catalog-lifecycle';
import { formatModelCatalogSaveRejection } from '../PipelineBuilderEditors/model-catalog-state';
import { formatPhaseSaveRejection } from '../PipelineBuilderEditors/phase-catalog-state';
import { formatPipelineSaveRejection } from '../PipelineBuilderEditors/pipeline-catalog-state';
import { formatWorkflowSaveRejection } from '../PipelineBuilderEditors/workflow-catalog-state';

/**
 * The definition an `import` plan row carries.
 *
 * Derived from the contract rather than mirrored, because a second declaration
 * of the portable field set is a second thing to keep in step with the host, and
 * FR-046a turns any divergence into a lossy round trip.
 *
 * Narrowed to the `'phase'` arm as of feature 085, which widened the row union
 * with a Pipeline arm; `ImportedPipelineDefinition` is its counterpart.
 */
export type ImportedPhaseDefinition = Extract<
  ImportPlanRow,
  { outcome: 'import'; resourceKind: 'phase' }
>['definition'];

/** The definition a Pipeline `import` plan row carries, derived the same way. */
export type ImportedPipelineDefinition = Extract<
  ImportPlanRow,
  { outcome: 'import'; resourceKind: 'pipeline' }
>['definition'];

/** The definition a Workflow `import` plan row carries, derived the same way. */
export type ImportedWorkflowDefinition = Extract<
  ImportPlanRow,
  { outcome: 'import'; resourceKind: 'workflow' }
>['definition'];

type ImportOutcomeRow = Extract<ImportPlanRow, { outcome: 'import'; resourceKind: 'phase' }>;

type PipelineImportOutcomeRow = Extract<
  ImportPlanRow,
  { outcome: 'import'; resourceKind: 'pipeline' }
>;

type WorkflowImportOutcomeRow = Extract<
  ImportPlanRow,
  { outcome: 'import'; resourceKind: 'workflow' }
>;

/**
 * A fourth import-row shape, structurally apart from the other three: there
 * is no `PhaseDefinition`/`PipelineDefinition`/`WorkflowDefinition` analog for
 * a model id, so this carries `backend`/`modelId` instead of `definition`
 * (contracts §6, data-model.md "ImportPlanRow — new arms").
 */
type ModelCatalogImportOutcomeRow = Extract<
  ImportPlanRow,
  { outcome: 'import'; resourceKind: 'modelCatalog' }
>;

// Feature 099 (T494a, FR-043) — `IMPORT_TARGET_SCOPES` is gone. It enumerated
// the scopes an import could target so the preflight could offer a choice; there
// is one target, so there is no choice to offer and no list to enumerate it.

/** Which states the surface can be in when the operator reaches for Confirm. */
export type ImportSurfaceState =
  | 'idle'
  | 'validating'
  | 'canceled'
  | 'refused'
  | 'failed'
  | 'planned'
  | 'committing';

export interface ConfirmGate {
  readonly state: ImportSurfaceState;
  readonly plan: ImportPlan | null;
}

export type ImportResultOutcome = 'imported' | 'skipped' | 'blocked' | 'invalid' | 'failed';

export interface ImportResultRow {
  readonly resourceId: string | null;
  readonly outcome: ImportResultOutcome;
  readonly detail: string;
}

/**
 * Every row a confirmed import would write, in plan order (FR-057).
 *
 * Eligibility is the PLAN's property and reads no kind: a references-only
 * package whose single writable row is the Pipeline is a plan with something to
 * do, and answering "nothing to import" for it would describe a different
 * document. What this surface can currently express is a separate, narrower
 * question — see `confirmBlockedReason`.
 */
export function eligibleRows(plan: ImportPlan): readonly ImportPlanRow[] {
  return plan.rows.filter((row) => row.outcome === 'import');
}

/** The Phase `import` rows of a plan, in plan order. */
export function phaseImportRows(plan: ImportPlan): readonly ImportOutcomeRow[] {
  return plan.rows.filter(
    (row): row is ImportOutcomeRow => row.outcome === 'import' && row.resourceKind === 'phase'
  );
}

/**
 * The Pipeline `import` rows of a plan, in plan order.
 *
 * Separate from the Phase accessor rather than a filter at the call site,
 * because the two are written by different layer saves under different intents,
 * in a fixed order (FR-038). A single list would make the ordering an accident
 * of how the plan happened to arrive.
 */
export function pipelineImportRows(plan: ImportPlan): readonly PipelineImportOutcomeRow[] {
  return plan.rows.filter(
    (row): row is PipelineImportOutcomeRow =>
      row.outcome === 'import' && row.resourceKind === 'pipeline'
  );
}

/**
 * The Workflow `import` rows of a plan, in plan order.
 *
 * A third accessor for the same reason there is a second: the Workflow layer is
 * a third independently-revisioned catalog, written last under its own intent
 * (FR-045). Folding it into either of the others would make the write order —
 * the thing that decides whether a self-contained package resolves — depend on
 * how the plan happened to list its rows.
 */
export function workflowImportRows(plan: ImportPlan): readonly WorkflowImportOutcomeRow[] {
  return plan.rows.filter(
    (row): row is WorkflowImportOutcomeRow =>
      row.outcome === 'import' && row.resourceKind === 'workflow'
  );
}

/**
 * The Model Catalog `import` rows of a plan, in plan order.
 *
 * A fourth accessor, structurally apart from the other three rather than a
 * peer sharing their machinery: FR-015 guarantees a plan never mixes Model
 * Catalog rows with Phase/Pipeline/Workflow rows, so this and the other three
 * are never both non-empty for the same plan, and Model Catalog commits
 * through its own single-write path (`runModelCatalogImportCommit`) below,
 * not `buildImportWrites`/`runImportCommit` (Implementation Note 1).
 */
export function modelCatalogImportRows(plan: ImportPlan): readonly ModelCatalogImportOutcomeRow[] {
  return plan.rows.filter(
    (row): row is ModelCatalogImportOutcomeRow =>
      row.outcome === 'import' && row.resourceKind === 'modelCatalog'
  );
}

/**
 * Feature 096 T024 — whether `plan` came from a Model Catalog document, the
 * single signal `ProcessImportPreflight.svelte` reads to choose its single-write
 * rendering and commit branch over the Phase/Pipeline/Workflow one.
 *
 * `computedAgainstModelsRevision` is present on a plan exactly when the
 * document declared a ModelCatalog (`ImportPlan`'s own doc comment), and
 * FR-015's homogeneity guarantee makes that the same fact as "every row in
 * this plan is a Model Catalog row" — there is no plan that is partly one and
 * partly the other, so a single plan-level check is enough; no per-row scan
 * needed.
 */
export function isModelCatalogPlan(plan: ImportPlan): boolean {
  return plan.computedAgainstModelsRevision !== undefined;
}

/**
 * The kind word shown in a row's own column (FR-056).
 *
 * Shown per row rather than once for the document, because a package declares
 * every kind and the same outcome means different things for each: a `skip` on a
 * Phase is a dependency the catalog already holds, a `skip` on the root resource
 * is the thing the operator opened the file for not happening.
 *
 * A total lookup rather than a chain of tests with a fallback (086 T038). With
 * three kinds a fallback is no longer a missing label, it is a wrong statement:
 * it would name a Workflow row "Phase" and send the operator to the wrong
 * catalog to fix it. Keyed on the kind union, so a fourth kind added to the
 * contract fails to typecheck here instead of silently inheriting a default.
 */
const RESOURCE_KIND_LABELS: Readonly<Record<ProcessYamlResourceKind, string>> = {
  phase: 'Phase',
  pipeline: 'Pipeline',
  workflow: 'Workflow',
  modelCatalog: 'Model Catalog'
};

export function resourceKindLabel(row: ImportPlanRow): string {
  return RESOURCE_KIND_LABELS[row.resourceKind];
}

/** The outcome word shown in a row's own column. */
export function outcomeLabel(row: ImportPlanRow): string {
  if (row.outcome === 'import') return 'Import';
  if (row.outcome === 'skip') return 'Skip';
  if (row.outcome === 'blocked') return 'Blocked';
  return 'Invalid';
}

/**
 * A blocked row's dependency, named with its own kind.
 *
 * Read from the reason rather than assumed: as of feature 086 a Pipeline waits
 * on a Phase and a Workflow waits on a Pipeline, so a hard-coded "Phase" would
 * misname half the cases and send the operator to the wrong catalog.
 */
function dependencyLabel(dependency: BlockedDependency): string {
  return `${dependency.kind === 'pipeline' ? 'Pipeline' : 'Phase'} ${dependency.resourceId}`;
}

/**
 * FR-054 — `skip`, `blocked`, and `invalid` must state the reason without the
 * operator opening the file. An `import` row has no reason to state beyond the
 * advisory that it declares a retry condition, whose capability gate is
 * re-evaluated at commit time (FR-012a), so it must not read as already granted
 * here.
 *
 * `blocked` and `invalid` are deliberately different sentences: 085 FR-033
 * separates a resource that is defective from one that is well-formed and whose
 * dependency is not available, because only the second is fixed by importing
 * something else first.
 */
export function reasonLines(row: ImportPlanRow): readonly string[] {
  if (row.outcome === 'import') {
    // Feature 096 (contracts §6) — a Model Catalog row's "Resource" cell shows
    // the model id alone; nothing else on the row names the backend it would
    // join, so that fact belongs here.
    if (row.resourceKind === 'modelCatalog') {
      return [`Add \`${row.modelId}\` to ${row.backend}`];
    }
    if (row.resourceKind === 'phase' && row.requiresRetryConditionCapability) {
      return ['Declares a retry condition, which the commit checks separately.'];
    }
    return [];
  }
  if (row.outcome === 'skip') {
    // A distinct arm (`ModelCatalogSkipRow`), not the presence reason below:
    // Model Catalog is not in the store (FR-056), so it is not scanned the way
    // a stored row is, and its two reasons are `already-exists` and
    // `unrecognized-backend` (contracts §6).
    if (row.resourceKind === 'modelCatalog') {
      return row.reason === 'already-exists'
        ? [`\`${row.modelId}\` already exists under ${row.backend} — skipped`]
        : [`Unrecognized backend \`${row.backend}\` — \`${row.modelId}\` skipped`];
    }
    // Feature 099 (T494a, FR-049) — the sentence used to open with which layer
    // already held the id. There is one, so what remains is the fact that decides
    // the skip: a stored row exists, and at what status. The presence PROPERTY is
    // unchanged — a scan of stored rows at every status, never the effective
    // catalog — so an `invalid` row still skips and still says so.
    return [
      `Already present in the catalog as a ${row.presentRowStatus} row, so this import would not change it.`
    ];
  }
  if (row.outcome === 'blocked') {
    const needs = dependencyLabel(row.reason.dependency);
    if (row.reason.code === 'dependency-absent') {
      return [`Needs the ${needs}, which is not in the catalog and this document does not supply.`];
    }
    if (row.reason.code === 'dependency-unresolvable') {
      return [`Needs the ${needs}, which the catalog holds but does not currently resolve.`];
    }
    // The propagated arm (086 T046, FR-039/FR-040). Two lines, not one: line one
    // answers the column's own question — what does THIS row wait on — and line
    // two traces the chain to its origin, because the first sentence alone says
    // the dependency is blocked without saying what would unblock it. The
    // operator would then open the Pipeline row, find it blocked too, and walk
    // the table by hand for something the plan already knows.
    //
    // The chain is exactly three links deep and cannot be more: `via` is the
    // blocked Pipeline's OWN dependency, a Pipeline waits only on a Phase, and a
    // Phase waits on nothing. So `via` is always the root cause, and this renders
    // a complete trace rather than one hop of an open-ended walk.
    //
    // Every string here is the host's already-sanitized, already-bounded value
    // (`cmd-preflight-process-yaml.ts` caps an identifier at 64 and passes both
    // `dependency` and `via` through the same bound). Nothing is re-bounded: a
    // second cap would disagree with the first and truncate an identifier the
    // operator has to find in the catalog.
    return [
      `Needs the ${needs}, which is itself blocked.`,
      `Chain: ${resourceKindLabel(row)} ${row.resourceId} needs the ${needs}, which needs the ${dependencyLabel(row.reason.via)}. Resolve the ${dependencyLabel(row.reason.via)} first.`
    ];
  }
  if (row.outcome === 'invalid') {
    const lines = row.defects.map((defect) => `${defect.field}: ${defect.message}`);
    if (row.totalDefects > row.defects.length) {
      lines.push(`and ${row.totalDefects - row.defects.length} more not shown.`);
    }
    return lines;
  }
  return [];
}

/**
 * What each refusal class means, in the operator's own terms.
 *
 * The host's message is the specific detail — which construct, which version,
 * which bound. These are the classes, because a code like `disallowed-syntax` is
 * a support string rather than a stated reason (FR-057). Both are shown: the
 * sentence so the operator knows what to change, the code so a bug report names
 * something exact.
 */
const REFUSAL_HEADLINES: Readonly<Record<DocumentRefusalCode, string>> = {
  unreadable: 'This file could not be read as text.',
  'too-large': 'This document is larger than an import will read.',
  'unsupported-version': 'This document declares a format version this build does not read.',
  'unsupported-kind': 'This document declares a different kind of resource.',
  // Kind-neutral on purpose. The scanner refuses a construct before anything
  // has read which kind the document declares, and features 086/087 made
  // Pipeline and Workflow documents reachable through the same path — so naming
  // one kind here would misreport the other two. The host's own message
  // ('Document declares no resource') is neutral for the same reason.
  'disallowed-syntax': 'This document uses YAML the exchange format does not accept.',
  'multi-document': 'This file holds more than one document, and an import reads exactly one.',
  'duplicate-id': 'This document declares the same id twice, so which one was meant is unclear.',
  // Feature 086 FR-026 — a document-level refusal, not a row defect: a cycle is a
  // property of the graph as a whole, so there is no one node to blame and no
  // partial plan to show.
  'graph-cycle': 'This document declares a Workflow whose nodes form a cycle.',
  empty: 'This document declares no resource.'
};

/**
 * The refusal in operator-facing prose (FR-057).
 *
 * An unrecognized code — a host newer than this bundle — still renders as a
 * refusal with the host's own message beside it, rather than as a blank panel.
 * The code itself is never dropped.
 */
export function refusalHeadline(code: DocumentRefusalCode): string {
  return REFUSAL_HEADLINES[code] ?? 'This document was not accepted.';
}

/**
 * Why Confirm is unavailable, or `null` when it is available.
 *
 * Every branch returns prose (FR-057) — a disabled control that does not say why
 * reads as a broken one. The order is the order the operator hits them: a commit
 * already in flight, then a preflight still in flight, then not having a plan at
 * all, then having one with nothing to do, then not having chosen where to write.
 */
export function confirmBlockedReason(gate: ConfirmGate): string | null {
  if (gate.state === 'committing') return 'A commit is already in progress.';
  if (gate.state === 'validating') return 'The document is still being read and validated.';
  if (gate.state === 'refused') {
    return 'This document was refused, so there is no plan to confirm.';
  }
  if (gate.state === 'canceled') return 'No document was chosen.';
  if (gate.state === 'failed') return 'The document could not be read.';
  if (gate.state === 'idle' || gate.plan === null) {
    return 'Inspect a document first.';
  }
  // FR-057 — the eligibility question, asked of the plan and of no kind.
  if (eligibleRows(gate.plan).length === 0) return 'This plan has nothing to import.';
  // Model Catalog branches out here, before the revision checks below: FR-015
  // guarantees a plan with any Model Catalog row has ONLY Model Catalog rows,
  // and its revision comes from a different authority (FR-056), so none of the
  // Pipeline/Workflow checks below apply to it.
  if (modelCatalogImportRows(gate.plan).length > 0) {
    return gate.plan.computedAgainstModelsRevision === undefined
      ? 'This plan does not carry the Model Catalog revision its write has to check. Inspect the document again.'
      : null;
  }
  // The writability question, asked once per layer that has rows to write
  // (T048, T054). A row whose plan carries no revision for its own layer has no
  // gate for its write to present, so writing it would drop FR-040 for that layer
  // — a plan computed against a catalog that has since moved would be applied
  // silently. Held closed instead; re-inspecting the document rebuilds a plan
  // that carries it.
  if (
    pipelineImportRows(gate.plan).length > 0 &&
    gate.plan.computedAgainstPipelineRevision === undefined
  ) {
    return 'This plan does not carry the Pipeline catalog revision its write has to check. Inspect the document again.';
  }
  if (
    workflowImportRows(gate.plan).length > 0 &&
    gate.plan.computedAgainstWorkflowRevision === undefined
  ) {
    return 'This plan does not carry the Workflow catalog revision its write has to check. Inspect the document again.';
  }
  // Feature 099 (T494a, FR-043) — a fourth refusal, "Choose the scope to import
  // into", used to sit here. There is one target, so an operator can no longer
  // fail to have chosen it.
  return null;
}

/**
 * What confirming would do, stated before the click (FR-058).
 *
 * The one fact the operator cannot read off the table quickly: that the write is
 * limited to the eligible rows. Stated even while Confirm is unavailable, so a
 * blocked Confirm is never merely "something is missing".
 *
 * Feature 099 (T494a, FR-043) — the second fact this stated was WHERE the rows
 * land, taken from a scope the operator had chosen or had yet to choose. There
 * is one catalog, so naming it would be naming the only place a write can go.
 */
export function commitStatement(plan: ImportPlan): string {
  const eligible = eligibleRows(plan).length;
  if (eligible === 0) return 'No row here is eligible, so confirming would write nothing.';
  const others = plan.rows.length - eligible;
  const subject = eligible === 1 ? '1 resource' : `${eligible} resources`;
  const rest =
    others === 0
      ? ''
      : ` The other ${others === 1 ? 'row is' : `${others} rows are`} left unchanged.`;
  return `Confirming writes ${subject} into the catalog, and nothing else.${rest}`;
}

/**
 * What confirming a Model Catalog import would do, stated before the click
 * (FR-058) — the Model Catalog counterpart to `commitStatement` (Implementation
 * Note 1). It stays separate because its destination is VS Code configuration
 * rather than the store (FR-056), which is a different authority and a different
 * revision, not merely a different noun in the same sentence.
 */
export function modelCatalogCommitStatement(plan: ImportPlan): string {
  const eligible = modelCatalogImportRows(plan).length;
  if (eligible === 0) return 'No row here is eligible, so confirming would write nothing.';
  const others = plan.rows.length - eligible;
  const subject = eligible === 1 ? '1 model' : `${eligible} models`;
  const rest =
    others === 0
      ? ''
      : ` The other ${others === 1 ? 'row is' : `${others} rows are`} left unchanged.`;
  return `Confirming adds ${subject} to the model catalog, and nothing else.${rest}`;
}

/**
 * The declared definition as a catalog row.
 *
 * Only the identity key's NAME changes: stored rows key identity as `id`, while
 * the portable document and the host contract use `phaseId`. Every other field
 * is spread through rather than enumerated, so a field added to the contract
 * later cannot be silently dropped here — dropping one is exactly the rewrite
 * FR-046a forbids.
 */
export function savePhaseRowFromDefinition(definition: ImportedPhaseDefinition): SavePhaseRow {
  const { phaseId, ...declared } = definition;
  return { id: phaseId, ...declared };
}

/**
 * The declared Pipeline definition as a catalog row.
 *
 * Two key names change rather than one — stored rows key identity as `id` and
 * the sequence as `phases`, while the portable document and the host contract
 * use `pipelineId` and `phaseIds`. Every other field spreads through, for the
 * same reason as the Phase row: a field added to the contract later must not be
 * silently dropped on the import path (FR-046a). `phaseIds` is copied rather
 * than aliased so the row does not share an array with the plan.
 */
export function savePipelineRowFromDefinition(
  definition: ImportedPipelineDefinition
): SavePipelineRow {
  const { pipelineId, phaseIds, ...declared } = definition;
  return { id: pipelineId, phases: [...phaseIds], ...declared };
}

/**
 * The declared Workflow definition as a catalog row.
 *
 * No key name changes at all, unlike the Phase and Pipeline rows: the Workflow
 * catalog arrived with feature 083, after the `id` spelling was retired, so
 * `workflowId` is the only identity key a stored Workflow row has ever had.
 * Everything is spread through, for the same reason the other two spread their
 * remainder — a field added to the contract later must not be silently dropped
 * on the import path (FR-046a). The graph itself is carried as declared: a
 * rewritten connection or a reordered node list is precisely the lossy round
 * trip that requirement forbids.
 */
export function saveWorkflowRowFromDefinition(
  definition: ImportedWorkflowDefinition
): SaveWorkflowRow {
  return { ...definition };
}

/** The stored rows of each catalog the commit appends to. */
export interface ImportTargetLayers {
  readonly phases: readonly SavePhaseRow[];
  readonly pipelines: readonly SavePipelineRow[];
  readonly workflows: readonly SaveWorkflowRow[];
}

export type ImportLayerKey = 'phases' | 'pipelines' | 'workflows';

/**
 * One layer write. The key says which catalog it reports against.
 *
 * Feature 101 (T029) — a `PackageLayer` rather than one of three whole-array
 * request shapes. The three shapes were already translated into exactly this
 * layer before dispatch by the retired `save*` shims; naming it directly removes
 * the translation without changing a byte of what is sent. One layer per write,
 * still: the writes are ordered and each is conditional on the last, so they
 * cannot be collapsed into a single package (see `runImportCommit`).
 */
export interface ImportLayerWrite {
  readonly key: ImportLayerKey;
  readonly layer: PackageLayer;
}

/**
 * The layer keys in write order — the one place the order is stated.
 *
 * Read by the outcome sentence to name the layers that landed. `buildImportWrites`
 * spells the order out in code instead, because each arm reads a different
 * revision map and builds a differently-shaped request; a loop over this list
 * would have to switch on the key anyway.
 */
const IMPORT_LAYER_ORDER: readonly ImportLayerKey[] = ['phases', 'pipelines', 'workflows'];

/** The layer name used when the outcome sentence has to name what landed. */
const IMPORT_LAYER_LABELS: Readonly<Record<ImportLayerKey, string>> = {
  phases: 'Phases',
  pipelines: 'Pipelines',
  workflows: 'Workflows'
};

/**
 * The writes that apply a plan, in the order they must be sent (FR-038, FR-043,
 * FR-045, FR-050).
 *
 * The order is fixed by dependency, and each write must not precede the one it
 * depends on: a Pipeline that references a Phase this same document supplies
 * does not validate until that Phase is in the catalog, and a Workflow's nodes
 * do not resolve until its Pipelines are, so any other order would refuse a
 * package that is internally consistent. Each write carries the revision the
 * PLAN was computed against — its own, from its own catalog — because that is
 * what makes a catalog written since preflight refuse as `stale-catalog`
 * (FR-040) rather than overwrite an operator's work. Reading any of the three
 * revisions live at this moment would leave that gate unable to fire.
 *
 * Feature 101 (T029) — the `import`/`import-package` mutation intent is gone. It
 * was already dropped before dispatch: feature 100 rewired every one of these
 * writes onto the package publish, which carries layers and ids and no intent at
 * all, so the standalone/package distinction has not reached the host since. It
 * is not recorded here as a comment either, because a field nothing reads is a
 * claim nothing checks.
 *
 * Returns nothing at all — not a partial list — when a Pipeline or Workflow
 * row's plan carries no revision for that layer. Half a package is the one
 * outcome no requirement here admits, so a caller that ignores
 * `confirmBlockedReason` writes nothing rather than the layers it happens to
 * have a gate for.
 *
 * **Feature 100 (T511, FR-039a, FR-039b) — the document's own rows, and nothing
 * else.** Each layer used to carry the stored rows too, because the whole-array
 * command it went to treated an id the request did not name as a removal. A
 * package publish is a merge: an id it does not name is left exactly as it is, so
 * the stored rows no longer need carrying and must not be carried. Sending them
 * would name every stored definition in a publication, and publishing an id
 * publishes its head — so an operator's pending, deliberately unpublished draft
 * of an untouched definition would go live as a side effect of importing a
 * document that says nothing about it. That is the one thing FR-039a forbids by
 * name, and dropping the concatenation is what makes it true of this surface as
 * well as of the headless one.
 */
export function buildImportWrites(plan: ImportPlan): readonly ImportLayerWrite[] {
  const phases = phaseImportRows(plan);
  const pipelines = pipelineImportRows(plan);
  const workflows = workflowImportRows(plan);
  const pipelineRevision = plan.computedAgainstPipelineRevision;
  const workflowRevision = plan.computedAgainstWorkflowRevision;
  if (pipelines.length > 0 && pipelineRevision === undefined) return [];
  if (workflows.length > 0 && workflowRevision === undefined) return [];

  const writes: ImportLayerWrite[] = [];
  if (phases.length > 0) {
    writes.push({
      key: 'phases',
      layer: {
        kind: 'phase',
        expectedRevision: plan.computedAgainstRevision,
        definitions: phases.map((row) => {
          const body = savePhaseRowFromDefinition(row.definition);
          return { id: body.id, body };
        })
      }
    });
  }
  if (pipelines.length > 0 && pipelineRevision !== undefined) {
    writes.push({
      key: 'pipelines',
      layer: {
        kind: 'pipeline',
        expectedRevision: pipelineRevision,
        // `pipelineRowId` rather than `body.id` for the same reason the Builder
        // uses it: `id` and `pipelineId` are both accepted spellings. A row from
        // this path always carries `id`, because the contract requires
        // `pipelineId` and the translation above renames it — the shared reader
        // is what keeps the two paths from disagreeing if that ever changes.
        definitions: pipelines.map((row) => {
          const body = savePipelineRowFromDefinition(row.definition);
          return { id: pipelineRowId(body), body };
        })
      }
    });
  }
  if (workflows.length > 0 && workflowRevision !== undefined) {
    writes.push({
      key: 'workflows',
      layer: {
        kind: 'workflow',
        expectedRevision: workflowRevision,
        definitions: workflows.map((row) => {
          const body = saveWorkflowRowFromDefinition(row.definition);
          return { id: body.workflowId, body };
        })
      }
    });
  }
  return writes;
}

/** What a confirmed import did, taken as a whole (FR-042a). */
export type ImportCommitOutcome = 'imported' | 'partial' | 'failed';

export interface ImportLayerResult {
  readonly key: ImportLayerKey;
  readonly ack: LifecycleResult;
}

/**
 * The three outcomes, read off the acks that actually came back (FR-042a).
 *
 * `partial` exists because the writes are independently gated and an earlier one
 * can succeed while a later one is refused — which as of feature 086 has two
 * shapes, a refused Pipeline write after a Phase write and a refused Workflow
 * write after both. Counting acks is total over either, so nothing here changes.
 * It is reported rather than repaired: FR-042c forbids a compensating delete, so
 * the honest report is the only thing this surface owes the operator.
 *
 * An empty result list is `failed`, not `imported`. It means the commit sent
 * nothing — a plan `buildImportWrites` refused — and calling that success would
 * put an "imported" line under a document that was never written.
 */
export function commitOutcome(results: readonly ImportLayerResult[]): ImportCommitOutcome {
  if (results.length === 0) return 'failed';
  const accepted = results.filter((result) => result.ack.status === 'accepted').length;
  if (accepted === results.length) return 'imported';
  return accepted === 0 ? 'failed' : 'partial';
}

/**
 * The layer acks, as one result per plan row (FR-042).
 *
 * Total over `plan.rows` by construction. Each `import` row reads the ack of ITS
 * OWN layer, which is what lets a partial outcome be reported exactly: the
 * Phases say imported and the Pipeline says why it was not, in the same table.
 * A row whose layer was never reached — the sequence stopped at the first
 * rejection — says that rather than borrowing the other layer's reason. Rows the
 * commit never addressed keep the outcome and the reason preflight gave them.
 *
 * Feature 099 (T494a, FR-043) — the `imported` detail used to name the scope the
 * operator chose. There is one catalog, so the row says it was imported and the
 * destination is no longer a fact about the row.
 */
export function projectCommitResults(
  plan: ImportPlan,
  results: readonly ImportLayerResult[]
): readonly ImportResultRow[] {
  const failureFor = (key: ImportLayerKey): string | null => {
    const entry = results.find((result) => result.key === key);
    if (entry === undefined) return 'Not written — the import stopped before this layer.';
    if (entry.ack.status === 'accepted') return null;
    // One formatter per layer, never a shared one: each reads a differently
    // shaped structured payload, and the Workflow formatter alone reports the
    // suppressed-ancestry note a cycle produces.
    if (key === 'phases') return formatPhaseSaveRejection(entry.ack.reason, entry.ack.result);
    if (key === 'pipelines') return formatPipelineSaveRejection(entry.ack.reason, entry.ack.result);
    return formatWorkflowSaveRejection(
      entry.ack.reason,
      entry.ack.result as Parameters<typeof formatWorkflowSaveRejection>[1]
    );
  };
  const layerOf = (kind: ProcessYamlResourceKind): ImportLayerKey => {
    if (kind === 'pipeline') return 'pipelines';
    if (kind === 'workflow') return 'workflows';
    return 'phases';
  };
  return plan.rows.map((row) => {
    if (row.outcome === 'skip') {
      return { resourceId: row.resourceId, outcome: 'skipped' as const, detail: reasonLines(row).join(' ') };
    }
    if (row.outcome === 'blocked') {
      return { resourceId: row.resourceId, outcome: 'blocked' as const, detail: reasonLines(row).join(' ') };
    }
    if (row.outcome === 'invalid') {
      return { resourceId: row.resourceId, outcome: 'invalid' as const, detail: reasonLines(row).join(' ') };
    }
    const failure = failureFor(layerOf(row.resourceKind));
    return failure === null
      ? {
          resourceId: row.resourceId,
          outcome: 'imported' as const,
          detail: 'Imported into the catalog.'
        }
      : { resourceId: row.resourceId, outcome: 'failed' as const, detail: failure };
  });
}

/**
 * The whole-commit sentence shown above the result table (FR-042a, FR-042b/c,
 * FR-051).
 *
 * `partial` is the one that has to be written carefully. It states three facts
 * the per-row table cannot: which layers landed, that what landed is still there
 * — no compensating delete was performed and none is offered — and that the
 * recovery is to import the same document again, which is safe precisely because
 * an already-present id is a `skip` (FR-030).
 *
 * With three layers "part of this document" stopped being enough: which part
 * landed decides what the operator has to look at next. The layers are named
 * from the ACKS rather than from the plan, so only a layer that actually came
 * back accepted can be named — a plan-derived list would name a layer the
 * sequence never reached.
 */
export function commitOutcomeStatement(
  outcome: ImportCommitOutcome,
  results: readonly ImportLayerResult[]
): string {
  if (outcome === 'imported') return 'Every eligible resource was written to the catalog.';
  if (outcome === 'failed') return 'Nothing was written.';
  const landed = IMPORT_LAYER_ORDER.filter((key) =>
    results.some((result) => result.key === key && result.ack.status === 'accepted')
  ).map((key) => IMPORT_LAYER_LABELS[key]);
  const written =
    landed.length === 0
      ? 'Part of this document was'
      : `${landed.length === 1 ? landed[0] : `${landed.slice(0, -1).join(', ')} and ${landed[landed.length - 1]}`} were`;
  return `${written} written to the catalog; the rest of this document was not. What was written is still there. Inspect the same document again to finish the import — anything already in the catalog is skipped.`;
}

/**
 * The send, injected so the commit can be exercised without a host.
 *
 * Feature 101 (T029) — one member where there were three. The three were
 * per-kind only in their argument shape; each translated to the same package
 * publish and returned the same `LifecycleResult`, so the kind now travels in
 * the layer rather than in the choice of function.
 */
export interface ImportCommitDeps {
  readonly publishPackage: (request: PackagePublishRequest) => Promise<LifecycleResult>;
}

/**
 * The send threw instead of answering, at either commit track's boundary.
 *
 * `dispatch` in `lib/catalog-lifecycle.ts` resolves on every path it reaches,
 * including its own ack timeout, so a rejected promise can only come from a throw
 * inside its promise executor — `postCommand`'s `postMessage` (a `DataCloneError`
 * when the payload holds something structured clone cannot carry),
 * `markPending`, or `onceAck`. Each of those throws BEFORE the timeout is armed,
 * so nothing will ever settle that promise: an awaiting caller waits forever
 * unless the throw is turned back into the rejection shape it already handles.
 *
 * A fixed reason rather than the thrown message, for the reason the host's own
 * read failure is generic: this string is rendered, and a transport `Error` can
 * carry a path or a fragment of the payload. The detail stays in the console the
 * throw already reached.
 *
 * Declared here rather than beside `dispatch` on purpose — this module holds no
 * value import from `lib/catalog-lifecycle`, only a type one, and taking one
 * would pull the snapshot store and the host transport into a pure state module.
 */
const DISPATCH_FAILED_REASON = 'dispatch-failed';

const DISPATCH_FAILED: LifecycleResult = Object.freeze({
  status: 'rejected',
  reason: DISPATCH_FAILED_REASON
});

export interface ImportCommitReport {
  readonly outcome: ImportCommitOutcome;
  readonly results: readonly ImportLayerResult[];
  readonly rows: readonly ImportResultRow[];
}

/**
 * Send the plan's writes in order and report what happened (FR-038, FR-042,
 * FR-045, FR-051).
 *
 * Sequential and short-circuiting by design: each write is only sent once the one
 * it depends on has been accepted, because a Pipeline referencing a Phase from
 * the same document — or a Workflow referencing such a Pipeline — would otherwise
 * be validated against a catalog that never received it. A rejection therefore
 * stops the sequence — and stopping is all it does. Nothing already written is
 * retracted (FR-042c), at whatever depth the sequence stopped.
 */
export async function runImportCommit(
  plan: ImportPlan,
  deps: ImportCommitDeps
): Promise<ImportCommitReport> {
  const results: ImportLayerResult[] = [];
  for (const write of buildImportWrites(plan)) {
    // Awaited inside the loop deliberately, and one layer per publish: the writes
    // are ordered and each is conditional on the one before it. A single package
    // carrying all three would send the Pipeline before its Phases exist, and the
    // Workflow before its Pipelines do — and would report one verdict where the
    // per-row table needs one per layer (FR-042).
    //
    // A throw is reported as this layer's rejection rather than propagated. The
    // loop's contract is "stop at the first rejection and report what did land",
    // and a sender that threw landed nothing — so it IS a rejection, and letting
    // it escape would discard the layers that already succeeded along with the
    // caller's own in-flight bookkeeping. `DISPATCH_FAILED` names the one way
    // `publishPackage` can reject rather than resolve.
    let ack: LifecycleResult;
    try {
      ack = await deps.publishPackage({ layers: [write.layer] });
    } catch {
      ack = DISPATCH_FAILED;
    }
    results.push({ key: write.key, ack });
    if (ack.status !== 'accepted') break;
  }
  return {
    outcome: commitOutcome(results),
    results,
    rows: projectCommitResults(plan, results)
  };
}

// ---------------------------------------------------------------------------
// Feature 096 T023 — Model Catalog import commit.
//
// A parallel, deliberately separate track from everything above (Implementation
// Note 1): `buildImportWrites`/`runImportCommit` write the three store-backed
// kinds, each independently revisioned by the catalog store, while the Model
// Catalog is not in the store at all (FR-056) — it is VS Code configuration,
// with its own authority and its own revision. Forcing it into that shape would
// mean a 4th `ImportLayerKey` gated on a revision the store never issued, so
// instead it gets its own small, single-write path below, built from the same
// primitives (`ImportPlan`, `ImportPlanRow`, `reasonLines`, `ImportResultRow`)
// rather than the layer machinery.
// ---------------------------------------------------------------------------

/**
 * The delta a Model Catalog commit sends: only the `import`-outcome rows,
 * grouped by backend (contracts §4 Implementation Note 2) — never a
 * pre-merged catalog, because the host re-derives classification and merges
 * server-side (FR-016). Mirrors `modelsDeltaByBackend` in
 * `src/headless/process-yaml-api.ts`, duplicated rather than imported: that
 * module is headless-only and this is a separate webview bundle.
 */
export function modelCatalogImportDelta(plan: ImportPlan): Record<string, readonly string[]> {
  const delta: Record<string, string[]> = {};
  for (const row of modelCatalogImportRows(plan)) {
    (delta[row.backend] ??= []).push(row.modelId);
  }
  return delta;
}

/** The Model Catalog save, injected so the commit can be exercised without a host. */
export interface ModelCatalogCommitDeps {
  readonly saveModels: (request: SaveModelsImportRequest) => Promise<SaveModelsImportResult>;
}

/**
 * What a confirmed Model Catalog import did (FR-042a's Model Catalog analog).
 * Binary rather than `ImportCommitOutcome`'s three values: a single write has
 * nothing in between imported and failed, so there is no `partial` to report.
 */
export type ModelCatalogCommitOutcome = 'imported' | 'failed';

export interface ModelCatalogCommitReport {
  readonly outcome: ModelCatalogCommitOutcome;
  readonly ack: SaveModelsImportResult;
  readonly rows: readonly ImportResultRow[];
}

/**
 * The ack, as one result per plan row (FR-042's Model Catalog analog) — the
 * single-write counterpart to `projectCommitResults`. One ack decides every
 * `import` row's outcome, because Model Catalog is a single write rather than
 * an ordered sequence of independently-gated layers.
 */
export function projectModelCatalogCommitResults(
  plan: ImportPlan,
  ack: SaveModelsImportResult
): readonly ImportResultRow[] {
  const failure = ack.status === 'accepted' ? null : formatModelCatalogSaveRejection(ack.reason);
  return plan.rows.map((row) => {
    if (row.outcome === 'skip') {
      return {
        resourceId: row.resourceId,
        outcome: 'skipped' as const,
        detail: reasonLines(row).join(' ')
      };
    }
    if (row.outcome === 'blocked') {
      return {
        resourceId: row.resourceId,
        outcome: 'blocked' as const,
        detail: reasonLines(row).join(' ')
      };
    }
    if (row.outcome === 'invalid') {
      return {
        resourceId: row.resourceId,
        outcome: 'invalid' as const,
        detail: reasonLines(row).join(' ')
      };
    }
    // Every row `runModelCatalogImportCommit` is given is a Model Catalog row
    // (FR-015 homogeneity; the caller only reaches here via
    // `modelCatalogImportRows`), so `backend` is always present in practice —
    // the null fallback covers what the row union still permits at the type
    // level.
    const backend = row.resourceKind === 'modelCatalog' ? row.backend : null;
    return failure === null
      ? {
          resourceId: row.resourceId,
          outcome: 'imported' as const,
          detail: backend === null ? 'Added to the catalog.' : `Added to ${backend}.`
        }
      : { resourceId: row.resourceId, outcome: 'failed' as const, detail: failure };
  });
}

/**
 * Send a Model Catalog plan's delta and report what happened — the
 * single-write counterpart to `runImportCommit` (Implementation Note 1). One
 * write, not an ordered sequence: FR-015 rules out a mixed document, so there
 * is no second, independently-revisioned layer for this write to depend on or
 * to leave stranded on a rejection.
 *
 * Answers `failed` with no write attempted when the plan carries no Model
 * Catalog revision to gate against — the same "nothing to send" case
 * `buildImportWrites` answers with `[]` for the other three kinds. Reachable
 * only if called against a plan `confirmBlockedReason` would not have let
 * through Confirm.
 */
export async function runModelCatalogImportCommit(
  plan: ImportPlan,
  deps: ModelCatalogCommitDeps
): Promise<ModelCatalogCommitReport> {
  const expectedRevision = plan.computedAgainstModelsRevision;
  if (expectedRevision === undefined) {
    const ack: SaveModelsImportResult = { status: 'rejected', reason: 'no-plan-revision' };
    return { outcome: 'failed', ack, rows: projectModelCatalogCommitResults(plan, ack) };
  }
  // Turned into this track's rejection for the reason `runImportCommit` does the
  // same with its publish: the sender can throw before anything settles its
  // promise, and an escaping rejection would strand the caller's in-flight flag.
  let ack: SaveModelsImportResult;
  try {
    ack = await deps.saveModels({
      models: modelCatalogImportDelta(plan),
      expectedRevision,
      mutation: { kind: 'import-package' }
    });
  } catch {
    ack = { status: 'rejected', reason: DISPATCH_FAILED_REASON };
  }
  return {
    outcome: ack.status === 'accepted' ? 'imported' : 'failed',
    ack,
    rows: projectModelCatalogCommitResults(plan, ack)
  };
}

/**
 * The whole-commit sentence for a Model Catalog import (FR-042a's Model
 * Catalog analog) — the single-write counterpart to `commitOutcomeStatement`.
 * Binary rather than three-way, and names no layer: a single write has
 * nothing to report between imported and failed.
 */
export function modelCatalogCommitOutcomeStatement(outcome: ModelCatalogCommitOutcome): string {
  return outcome === 'imported'
    ? 'Every eligible model was added to the catalog.'
    : 'Nothing was added to the catalog.';
}
