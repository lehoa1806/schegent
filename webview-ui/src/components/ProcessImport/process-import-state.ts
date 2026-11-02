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
// Feature 085 T048 / Feature 086 T054/T055 — a confirmed import carries up to three layers, Phases,
// Pipelines and Workflows, each with its OWN expected revision (FR-043), because they are three
// independently revisioned catalogs. That is also why the outcome has three values rather than two
// (FR-042a) and why a failed layer triggers no compensating delete (FR-042c): what landed is left in
// place, and the recovery is to publish any draft the import left and then import the same document
// again (FR-042b). Which layers landed decides what the operator has to look at next, so the partial
// sentence names them (FR-051).
//
// Feature 254 (FR-R4-F07, FR-013 to FR-020) — the layers travel in ONE `publishPackage` request.
// The host validates the whole document, with every candidate overlaid on the catalog, before it
// writes anything, and orders the passes itself, so this module no longer sends a layer and waits
// for it before the next. What it keeps is the report: the single acknowledgement is fanned out into
// one result per layer (`layerResultsOf`), and the result table reads those exactly as before.
//
// FR-R4-F07 audit G-RECOVERY — the recovery is two steps, because a package publish publishes only
// what its own operation wrote (FR-039a) and the next preflight counts a draft as present: inspecting
// the same document again plans a drafted row as a skip and anything that waits on it as blocked. The
// operator publishes the drafts from the Builder first, and only then does the re-run import what is
// still missing.
//
// Feature 099 (T494a, FR-043/FR-044) — the target scope is gone from every
// function here. "Which layer" and "which kind" were two independent axes: the
// kinds are the KIND axis and are untouched, because the three catalogs are
// still independently revisioned and the host writes them in dependency order
// (Phases, Pipelines, Workflows) inside the one package request. What
// collapsed is the other axis — the operator's choice of destination, the
// per-scope revision lookup, and the layer noun in every sentence a result
// carries.

import type {
  BlockedDependency,
  DocumentRefusalCode,
  ImportPlan,
  ImportPlanRow,
  ProcessYamlResourceKind
} from '../../lib/messages';
import type { SaveModelsImportRequest, SaveModelsImportResult } from '../../lib/save-models';
import type { LifecycleResult } from '../../lib/catalog-lifecycle';
import type {
  SavePhaseRow,
  SaveWorkflowRow
} from '../../lib/definition-rows';
import type {
  PackageLayer,
  PackagePublishRequest
} from '../../../../src/contracts/catalog-lifecycle';
import { formatModelCatalogSaveRejection } from '../PipelineBuilderEditors/model-catalog-state';
import { formatPhaseSaveRejection } from '../PipelineBuilderEditors/phase-catalog-state';
import { formatWorkflowSaveRejection } from '../PipelineBuilderEditors/workflow-catalog-state';
import { OUTCOME_NOT_YET_KNOWN_TEXT, isOutcomeNotYetKnown } from '../../lib/boundary-refusal-text';

/**
 * The definition an `import` plan row carries.
 *
 * Derived from the contract rather than mirrored, because a second declaration
 * of the portable field set is a second thing to keep in step with the host, and
 * FR-046a turns any divergence into a lossy round trip.
 */
export type ImportedPhaseDefinition = Extract<
  ImportPlanRow,
  { outcome: 'import'; resourceKind: 'phase' }
>['definition'];

/** The definition a Workflow `import` plan row carries, derived the same way. */
export type ImportedWorkflowDefinition = Extract<
  ImportPlanRow,
  { outcome: 'import'; resourceKind: 'workflow' }
>['definition'];

type ImportOutcomeRow = Extract<ImportPlanRow, { outcome: 'import'; resourceKind: 'phase' }>;

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

// FR-R4-F05 (I5, FR-024) — `unknown`: the write's wait ran out and the host may still apply it,
// so the row says the outcome is not yet known instead of `failed`.
export type ImportResultOutcome = 'imported' | 'skipped' | 'blocked' | 'invalid' | 'failed' | 'unknown';

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
 * The Workflow `import` rows of a plan, in plan order.
 *
 * Separate from the Phase accessor: the Workflow layer is an
 * independently-revisioned catalog, written after Phases under its own intent
 * (FR-045). Folding it into the Phase list would make the write order — the
 * thing that decides whether a self-contained package resolves — depend on how
 * the plan happened to list its rows.
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
 * not `buildImportPackage`/`runImportCommit` (Implementation Note 1).
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
 * Read from the reason rather than assumed: a Workflow can wait on a Phase or a
 * child Workflow, so a hard-coded "Phase" would misname child Workflow
 * dependencies and send the operator to the wrong catalog.
 */
function dependencyLabel(dependency: BlockedDependency): string {
  return `${dependency.kind === 'workflow' ? 'Workflow' : 'Phase'} ${dependency.resourceId}`;
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
      // "Not published", not "not in the catalog": the presence check sees a draft, so a dependency the
      // catalog holds only as a draft lands here too, and its own row says it IS in the catalog.
      return [`Needs the ${needs}, which is not published and this document does not supply.`];
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
    workflowImportRows(gate.plan).length > 0 &&
    gate.plan.computedAgainstWorkflowRevision === undefined
  ) {
    return 'This plan does not carry the Workflow catalog revision its write has to check. Inspect the document again.';
  }
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
 * The declared Workflow definition as a catalog row.
 *
 * No key name changes at all: `workflowId` is the only identity key a stored
 * Workflow row has ever had. Everything is spread through, for the same reason
 * the Phase row spreads its remainder — a field added to the contract later
 * must not be silently dropped on the import path (FR-046a). The graph itself is
 * carried as declared: a rewritten connection or a reordered node list is
 * precisely the lossy round trip that requirement forbids.
 */
export function saveWorkflowRowFromDefinition(
  definition: ImportedWorkflowDefinition
): SaveWorkflowRow {
  return { ...definition };
}

/** The stored rows of each catalog the commit appends to. */
export interface ImportTargetLayers {
  readonly phases: readonly SavePhaseRow[];
  readonly workflows: readonly SaveWorkflowRow[];
}

export type ImportLayerKey = 'phases' | 'workflows';

/**
 * The one request an import commit sends, and the layer each part of it reports under.
 *
 * Feature 254 (FR-013) — replaces the list of one-layer writes this module used to build. `keys` runs
 * parallel to `request.layers`: one key per layer, in the same order, so the single acknowledgement
 * can be read layer by layer (`layerResultsOf`).
 */
export interface ImportPackage {
  readonly request: PackagePublishRequest;
  readonly keys: readonly ImportLayerKey[];
}

/**
 * The layer keys in dependency order — the one place the order is stated.
 *
 * Read by the outcome sentence to name the layers that landed. `buildImportPackage` spells the order
 * out in code instead, because each arm reads a different revision and builds a differently shaped
 * layer; a loop over this list would have to switch on the key anyway.
 */
const IMPORT_LAYER_ORDER: readonly ImportLayerKey[] = ['phases', 'workflows'];

/** The layer name used when the outcome sentence has to name what landed. */
const IMPORT_LAYER_LABELS: Readonly<Record<ImportLayerKey, string>> = {
  phases: 'Phases',
  workflows: 'Workflows'
};

/** The catalog kind each layer key carries, and back (Feature 254, data-model §6). */
const KIND_OF_LAYER: Readonly<Record<ImportLayerKey, 'phase' | 'workflow'>> = {
  phases: 'phase',
  workflows: 'workflow'
};
const LAYER_OF_KIND: Readonly<Record<'phase' | 'workflow', ImportLayerKey>> = {
  phase: 'phases',
  workflow: 'workflows'
};

export function buildImportPackage(plan: ImportPlan): ImportPackage | null {
  const phases = phaseImportRows(plan);
  const workflows = workflowImportRows(plan);
  const workflowRevision = plan.computedAgainstWorkflowRevision;
  if (workflows.length > 0 && workflowRevision === undefined) return null;

  const keys: ImportLayerKey[] = [];
  const layers: PackageLayer[] = [];
  if (phases.length > 0) {
    keys.push('phases');
    layers.push({
      kind: 'phase',
      expectedRevision: plan.computedAgainstRevision,
      definitions: phases.map((row) => {
        const body = savePhaseRowFromDefinition(row.definition);
        return { id: body.id, body };
      })
    });
  }
  if (workflows.length > 0 && workflowRevision !== undefined) {
    keys.push('workflows');
    layers.push({
      kind: 'workflow',
      expectedRevision: workflowRevision,
      definitions: workflows.map((row) => {
        const body = saveWorkflowRowFromDefinition(row.definition);
        return { id: body.workflowId, body };
      })
    });
  }
  return keys.length === 0 ? null : { request: { layers }, keys };
}

/** What a confirmed import did, taken as a whole (FR-042a). */
export type ImportCommitOutcome = 'imported' | 'partial' | 'failed' | 'unknown';

/** FR-R4-F05 (I5) — an ack the helper synthesised at its timeout, not an answer from the host. */
function isTimedOut(ack: { readonly status: string; readonly reason?: string }): boolean {
  return ack.status === 'rejected' && isOutcomeNotYetKnown(ack.reason);
}

export interface ImportLayerResult {
  readonly key: ImportLayerKey;
  readonly ack: LifecycleResult;
}

/** The reason a layer carries when the package stopped before it was tried (Feature 254, data-model §6). */
const NOT_ATTEMPTED_REASON = 'not-attempted';
const PACKAGE_PARTIAL_REASON = 'package-partial';
const VALIDATION_FAILED_REASON = 'validation-failed';

/**
 * The host's `cause` for a layer whose publish failed on a stale revision is the store's word
 * (`stale`); the operator-facing refusal formatters know it as `stale-catalog`.
 */
function reasonOfCause(cause: string): string {
  if (cause === 'stale') return 'stale-catalog';
  return cause.length > 0 ? cause : PACKAGE_PARTIAL_REASON;
}

/** What a `package-partial` acknowledgement lists, read defensively (the webview trusts no payload). */
interface PartialPackage {
  readonly published: ReadonlySet<'phase' | 'workflow'>;
  readonly draftedOnly: ReadonlySet<'phase' | 'workflow'>;
  readonly failedKind: 'phase' | 'workflow';
  readonly cause: string;
}

const PACKAGE_KINDS: readonly string[] = ['phase', 'workflow'];

function isPackageKind(value: unknown): value is 'phase' | 'workflow' {
  return typeof value === 'string' && PACKAGE_KINDS.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `null` when the payload is not the documented shape, so a caller falls back to the plain reason. */
function readPartialPackage(result: unknown): PartialPackage | null {
  if (!isRecord(result)) return null;
  const { published, draftedOnly, failedKind, cause } = result;
  if (!Array.isArray(published) || !Array.isArray(draftedOnly)) return null;
  if (!isPackageKind(failedKind) || typeof cause !== 'string') return null;
  const publishedKinds = new Set<'phase' | 'workflow'>();
  for (const entry of published) {
    if (!isRecord(entry) || !isPackageKind(entry['kind'])) return null;
    publishedKinds.add(entry['kind']);
  }
  const draftedKinds = new Set<'phase' | 'workflow'>();
  for (const kind of draftedOnly) {
    if (!isPackageKind(kind)) return null;
    draftedKinds.add(kind);
  }
  return { published: publishedKinds, draftedOnly: draftedKinds, failedKind, cause };
}

/**
 * What the failed layer's result carries: the host's own word for the failure, and whether the draft
 * pass had already written the layer (the publish pass then failed on it), in which case it is on disk
 * as a draft and not published.
 */
function failedLayerResult(cause: string, drafted: boolean): { readonly failedCause: string; readonly draftedOnly: boolean } {
  return { failedCause: cause, draftedOnly: drafted };
}

function isDraftedMark(result: unknown): boolean {
  return isRecord(result) && result['draftedOnly'] === true;
}

function readFailedCause(result: unknown): string | null {
  return isRecord(result) && typeof result['failedCause'] === 'string' ? result['failedCause'] : null;
}

/** The facts a drafted-only layer's row states: which layer failed and why. */
function readDraftedInfo(result: unknown): { readonly failedKind: 'phase' | 'workflow'; readonly cause: string } | null {
  if (!isRecord(result)) return null;
  const { failedKind, cause } = result;
  return isPackageKind(failedKind) && typeof cause === 'string' ? { failedKind, cause } : null;
}

/** Whether this layer is on disk as a draft that was not published (FR-016). */
function landedAsDraft(ack: LifecycleResult): boolean {
  if (ack.status !== 'rejected') return false;
  if (ack.reason === PACKAGE_PARTIAL_REASON) return readDraftedInfo(ack.result) !== null;
  return isDraftedMark(ack.result);
}

function partialAckFor(key: ImportLayerKey, partial: PartialPackage): LifecycleResult {
  const kind = KIND_OF_LAYER[key];
  // The failed layer wins over drafted-only: the host lists it in both when the publish pass stopped
  // on a layer the draft pass had written, and the operator needs its cause.
  if (kind === partial.failedKind) {
    return {
      status: 'rejected',
      reason: reasonOfCause(partial.cause),
      result: failedLayerResult(partial.cause, partial.draftedOnly.has(kind))
    };
  }
  if (partial.published.has(kind)) return { status: 'accepted' };
  if (partial.draftedOnly.has(kind)) {
    return {
      status: 'rejected',
      reason: PACKAGE_PARTIAL_REASON,
      result: { failedKind: partial.failedKind, cause: partial.cause }
    };
  }
  return { status: 'rejected', reason: NOT_ATTEMPTED_REASON };
}

/**
 * The one acknowledgement of a package publish, as one result per layer (FR-015, data-model §6).
 *
 * | Acknowledgement | Each key |
 * |---|---|
 * | accepted | accepted |
 * | rejected `package-partial` | published: accepted. Failed: rejected with its cause. Drafted only: rejected, written as a draft. Any other: not attempted |
 * | rejected `validation-failed`, or any other reason | every key rejected with that acknowledgement, defects and all |
 * | a timeout | every key carries the timed-out acknowledgement, so every row reads unknown |
 *
 * Pure, and total over its input: a payload that is not the documented shape falls back to rejecting
 * every layer with the acknowledgement's own reason, which claims nothing about what landed.
 */
export function layerResultsOf(
  keys: readonly ImportLayerKey[],
  ack: LifecycleResult
): readonly ImportLayerResult[] {
  if (ack.status === 'rejected' && ack.reason === PACKAGE_PARTIAL_REASON) {
    const partial = readPartialPackage(ack.result);
    if (partial !== null) return keys.map((key) => ({ key, ack: partialAckFor(key, partial) }));
  }
  return keys.map((key) => ({ key, ack }));
}

/**
 * The three outcomes, read off the results of the one acknowledgement (FR-042a).
 *
 * `partial` exists because the layers are independently revisioned and a package can stop partway:
 * an earlier layer published and a later one failed, which as of feature 086 has two shapes (a Pipeline
 * layer after the Phases, and a Workflow layer after both). Counting accepted results is total over
 * either. It is reported rather than repaired: FR-042c forbids a compensating delete, so the honest
 * report is the only thing this surface owes the operator.
 *
 * Drafts do not count as live. A package that stopped before anything published is `failed` here, as
 * the headless importer reports it for the same package; what the sentence and the rows then say is
 * that the drafted layers are written (FR-016).
 *
 * An empty result list is `failed`, not `imported`. It means the commit sent nothing — a plan
 * `buildImportPackage` refused — and calling that success would put an "imported" line under a
 * document that was never written.
 */
export function commitOutcome(results: readonly ImportLayerResult[]): ImportCommitOutcome {
  if (results.length === 0) return 'failed';
  // FR-R4-F05 (I5) — the package request's wait ran out, so what it did is not yet known;
  // "nothing was written" would be a claim the host may still contradict.
  const last = results.at(-1);
  if (last !== undefined && isTimedOut(last.ack)) return 'unknown';
  const accepted = results.filter((result) => result.ack.status === 'accepted').length;
  if (accepted === results.length) return 'imported';
  return accepted === 0 ? 'failed' : 'partial';
}

/** The row text for a layer the package never reached (unchanged wording, Feature 085 T048). */
const NOT_REACHED_TEXT = 'Not written — the import stopped before this layer.';

/** The row text for a package the host refused whole, when no defect names the row (FR-014, P3). */
const PACKAGE_REFUSED_TEXT = 'Not written: the package was refused';

/** How many of a row's defects its detail line shows before it counts the rest. */
const ROW_DEFECTS_SHOWN = 3;

interface RowDefect {
  readonly kind: string;
  readonly id: string;
  readonly field: string;
  readonly message: string;
}

/** The defects of a `validation-failed` acknowledgement, read defensively. */
function readRowDefects(result: unknown): readonly RowDefect[] {
  if (!isRecord(result) || !Array.isArray(result['defects'])) return [];
  const defects: RowDefect[] = [];
  for (const entry of result['defects']) {
    if (!isRecord(entry)) continue;
    const { kind, id, field, message, code } = entry;
    if (typeof kind !== 'string' || typeof id !== 'string' || typeof field !== 'string') continue;
    defects.push({
      kind,
      id,
      field,
      message: typeof message === 'string' && message.length > 0 ? message : String(code ?? 'invalid value')
    });
  }
  return defects;
}

/**
 * What a refused package says about one row: the defects whose kind and id are the row's own, or that
 * the package was refused when none is (FR-014). Matching on both is what keeps a Phase defect off a
 * Pipeline row that happens to share its id.
 */
function refusedRowDetail(row: { readonly resourceKind: string; readonly resourceId: string | null }, result: unknown): string {
  const own = readRowDefects(result).filter(
    (defect) => defect.kind === row.resourceKind && defect.id === row.resourceId
  );
  if (own.length === 0) return PACKAGE_REFUSED_TEXT;
  const visible = own.slice(0, ROW_DEFECTS_SHOWN).map((defect) => `${defect.field}: ${defect.message}`);
  const remaining = own.length - visible.length;
  return `${VALIDATION_FAILED_REASON} — ${visible.join('; ')}${remaining > 0 ? `; +${remaining} more` : ''}`;
}

/** The row text of a layer that was written as a draft and not published (FR-016). */
function draftedLayerText(result: unknown): string {
  const info = readDraftedInfo(result);
  const failed = info === null ? 'a later' : `the ${IMPORT_LAYER_LABELS[LAYER_OF_KIND[info.failedKind]]}`;
  const cause = info === null || info.cause.length === 0 ? '' : ` (${reasonOfCause(info.cause)})`;
  return `Saved as a draft, not published — ${failed} layer failed${cause}. Publish this draft from the Builder, then inspect the same document again to import what is still missing.`;
}

/**
 * The layer acks, as one result per plan row (FR-042).
 *
 * Total over `plan.rows` by construction. Each `import` row reads the result of ITS OWN layer, which is
 * what lets a partial outcome be reported exactly: the Phases say imported and the Pipeline says why
 * it was not, in the same table. A layer the package never reached says that rather than borrowing
 * another layer's reason, and a refused package says, row by row, which definition the host found a
 * defect in and that the rest were refused with it (FR-014). Rows the commit never addressed keep the
 * outcome and the reason preflight gave them.
 *
 * Feature 099 (T494a, FR-043) — the `imported` detail used to name the scope the operator chose. There
 * is one catalog, so the row says it was imported and the destination is no longer a fact about the row.
 */
export function projectCommitResults(
  plan: ImportPlan,
  results: readonly ImportLayerResult[]
): readonly ImportResultRow[] {
  const failureFor = (key: ImportLayerKey): string | null => {
    const entry = results.find((result) => result.key === key);
    if (entry === undefined) return NOT_REACHED_TEXT;
    if (entry.ack.status === 'accepted') return null;
    if (entry.ack.reason === NOT_ATTEMPTED_REASON) return NOT_REACHED_TEXT;
    const drafted = landedAsDraft(entry.ack);
    // A layer the draft pass wrote and the publish pass then failed on carries its cause; one that was
    // only drafted carries the layer that failed.
    if (entry.ack.reason === PACKAGE_PARTIAL_REASON && drafted) return draftedLayerText(entry.ack.result);
    // One formatter per layer, never a shared one: each reads a differently
    // shaped structured payload, and the Workflow formatter alone reports the
    // suppressed-ancestry note a cycle produces.
    const text =
      key === 'phases'
        ? formatPhaseSaveRejection(entry.ack.reason, entry.ack.result)
        : formatWorkflowSaveRejection(
            entry.ack.reason,
            entry.ack.result as Parameters<typeof formatWorkflowSaveRejection>[1]
          );
    // The host's word for a failure the formatters have no sentence for (an errno, say) still has to
    // reach the operator: the row names the cause as the acknowledgement gave it.
    const cause = readFailedCause(entry.ack.result);
    const named =
      cause !== null && cause.length > 0 && reasonOfCause(cause) === cause && !text.includes(cause)
        ? `${text} (cause: ${cause})`
        : text;
    return drafted ? `${named.replace(/[.\s]+$/, '')}. The layer was saved as a draft and not published.` : named;
  };
  const layerOf = (kind: ProcessYamlResourceKind): ImportLayerKey => {
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
    const layerAck = results.find((result) => result.key === layerOf(row.resourceKind))?.ack;
    if (layerAck !== undefined && isTimedOut(layerAck)) {
      return { resourceId: row.resourceId, outcome: 'unknown' as const, detail: OUTCOME_NOT_YET_KNOWN_TEXT };
    }
    if (layerAck?.status === 'rejected' && layerAck.reason === VALIDATION_FAILED_REASON) {
      return {
        resourceId: row.resourceId,
        outcome: 'failed' as const,
        detail: refusedRowDetail(row, layerAck.result)
      };
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

/** "A", "A and B", "A, B and C". */
function listLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * The whole-commit sentence shown above the result table (FR-042a, FR-042b/c,
 * FR-051).
 *
 * `partial` is the one that has to be written carefully. It states three facts
 * the per-row table cannot: which layers landed, that what landed is still there
 * — no compensating delete was performed and none is offered — and that the
 * recovery is to import the same document again, which is safe precisely because
 * an already-present id is a `skip` (FR-030). A draft counts as present, so when
 * one was left the recovery starts with publishing it (FR-R4-F07 audit G-RECOVERY).
 *
 * With three layers "part of this document" stopped being enough: which part
 * landed decides what the operator has to look at next. The layers are named
 * from the RESULTS rather than from the plan, so only a layer that actually came
 * back accepted can be named as written — a plan-derived list would name a layer
 * the package never reached.
 *
 * Feature 254 (FR-016) — a layer can also be on disk as a draft that was never published, and the
 * sentence says so: validating the whole document first is not a rollback, and "Nothing was written"
 * would be false of a package that drafted the Phases and then stopped.
 */
export function commitOutcomeStatement(
  outcome: ImportCommitOutcome,
  results: readonly ImportLayerResult[]
): string {
  if (outcome === 'imported') return 'Every eligible resource was written to the catalog.';
  if (outcome === 'unknown') return IMPORT_NOT_YET_KNOWN;
  const drafted = IMPORT_LAYER_ORDER.filter((key) =>
    results.some((result) => result.key === key && landedAsDraft(result.ack))
  ).map((key) => IMPORT_LAYER_LABELS[key]);
  const draftedSentence =
    drafted.length === 0
      ? ''
      : `${listLabels(drafted)} were saved as drafts and not published. `;
  const recovery =
    drafted.length === 0
      ? 'What was written is still there. Inspect the same document again to import the rest — anything already in the catalog is skipped.'
      : 'What was written is still there. Publish the drafts from the Builder, then inspect the same document again to import anything still missing — anything already in the catalog, drafts included, is skipped.';
  if (outcome === 'failed') {
    if (drafted.length === 0) return 'Nothing was written.';
    return `${draftedSentence}Nothing is live. ${recovery}`;
  }
  const landed = IMPORT_LAYER_ORDER.filter((key) =>
    results.some((result) => result.key === key && result.ack.status === 'accepted')
  ).map((key) => IMPORT_LAYER_LABELS[key]);
  const written =
    landed.length === 0
      ? 'Part of this document was'
      : `${listLabels(landed)} were`;
  const rest = drafted.length === 0 ? 'the rest of this document was not.' : draftedSentence.trimEnd();
  return `${written} written to the catalog; ${rest} ${recovery}`;
}

/**
 * The send, injected so the commit can be exercised without a host.
 *
 * Feature 101 (T029) — one member where there were three. The three were per-kind only in their
 * argument shape; each translated to the same package publish and returned the same `LifecycleResult`,
 * so the kind now travels in the layer rather than in the choice of function.
 *
 * Feature 254 (FR-013) — called once per commit, with every layer in the request.
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
 * Send the plan as ONE package publication and report what happened (FR-013, FR-015, FR-042,
 * FR-051).
 *
 * Every layer is in the one request. The host validates the whole document, with every candidate
 * overlaid on the catalog, before it writes anything (FR-014), then drafts the layers and publishes
 * them in dependency order. This function therefore sends once and waits once; what used to be a
 * sequence is now the host's two passes, and what the operator sees is the fan-out of its one
 * acknowledgement (`layerResultsOf`). A partial outcome is reported layer by layer and nothing that
 * landed is retracted (FR-016, FR-042c): there is no second request, so there is nothing to undo
 * with.
 *
 * A throw is reported as a rejection of every layer rather than propagated. A sender that threw
 * landed nothing, so it IS a rejection, and letting it escape would discard the caller's own
 * in-flight bookkeeping. `DISPATCH_FAILED` names the one way `publishPackage` can reject rather than
 * resolve.
 *
 * Reports `failed` with no results, and sends nothing, for a plan `buildImportPackage` cannot build a
 * package from.
 */
export async function runImportCommit(
  plan: ImportPlan,
  deps: ImportCommitDeps
): Promise<ImportCommitReport> {
  const built = buildImportPackage(plan);
  if (built === null) return importCommitReport(plan, []);
  let ack: LifecycleResult;
  try {
    ack = await deps.publishPackage(built.request);
  } catch {
    ack = DISPATCH_FAILED;
  }
  return importCommitReport(plan, layerResultsOf(built.keys, ack));
}

/** The report for a set of layer results, on time or with a late answer in place (FR-R4-F05, I6). */
export function importCommitReport(
  plan: ImportPlan,
  results: readonly ImportLayerResult[]
): ImportCommitReport {
  return {
    outcome: commitOutcome(results),
    results,
    rows: projectCommitResults(plan, results)
  };
}

/**
 * The report for the late answer to a commit whose wait ran out (FR-R4-F05 I6, Feature 254 P9).
 *
 * The whole report is re-projected from the one acknowledgement, for every layer the commit sent. The
 * layers are the ones `buildImportPackage` yields for the same plan, so the keys here are the keys the
 * send used. Replacing only the last layer's result, as the sequence's handler had to, would leave the
 * earlier layers' rows reading "unknown" for good.
 */
export function lateImportCommitReport(plan: ImportPlan, late: LifecycleResult): ImportCommitReport {
  const keys = buildImportPackage(plan)?.keys ?? [];
  return importCommitReport(plan, layerResultsOf(keys, late));
}

// ---------------------------------------------------------------------------
// Feature 096 T023 — Model Catalog import commit.
//
// A parallel, deliberately separate track from everything above (Implementation
// Note 1): `buildImportPackage`/`runImportCommit` publish the three store-backed
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
export type ModelCatalogCommitOutcome = 'imported' | 'failed' | 'unknown';

/** FR-R4-F05 (I5, FR-024) — the whole-commit sentence when the last write's wait ran out. */
const IMPORT_NOT_YET_KNOWN =
  'The host has not answered the last write yet, so its outcome is not yet known. This view will update when it does.';

export interface ModelCatalogCommitReport {
  readonly outcome: ModelCatalogCommitOutcome;
  readonly ack: SaveModelsImportResult;
  readonly rows: readonly ImportResultRow[];
}

/**
 * The ack, as one result per plan row (FR-042's Model Catalog analog) — the
 * single-write counterpart to `projectCommitResults`. One ack decides every
 * `import` row's outcome, because Model Catalog is a single write rather than
 * a package of independently-revisioned layers.
 */
export function projectModelCatalogCommitResults(
  plan: ImportPlan,
  ack: SaveModelsImportResult
): readonly ImportResultRow[] {
  const failure = ack.status === 'accepted' ? null : formatModelCatalogSaveRejection(ack.reason);
  const timedOut = isTimedOut(ack);
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
    if (timedOut) {
      return { resourceId: row.resourceId, outcome: 'unknown' as const, detail: OUTCOME_NOT_YET_KNOWN_TEXT };
    }
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
 * write, not a package of layers: FR-015 rules out a mixed document, so there
 * is no second, independently-revisioned layer for this write to depend on or
 * to leave stranded on a rejection.
 *
 * Answers `failed` with no write attempted when the plan carries no Model
 * Catalog revision to gate against — the same "nothing to send" case
 * `buildImportPackage` answers with `null` for the other three kinds. Reachable
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
  return modelCatalogCommitReport(plan, ack);
}

/**
 * The report for one Model Catalog ack, on time or late (FR-R4-F05, I6): `unknown` when the
 * helper's wait ran out, because the host may still add the models.
 */
export function modelCatalogCommitReport(
  plan: ImportPlan,
  ack: SaveModelsImportResult
): ModelCatalogCommitReport {
  return {
    outcome: ack.status === 'accepted' ? 'imported' : isTimedOut(ack) ? 'unknown' : 'failed',
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
  if (outcome === 'unknown') return IMPORT_NOT_YET_KNOWN;
  return outcome === 'imported'
    ? 'Every eligible model was added to the catalog.'
    : 'Nothing was added to the catalog.';
}
