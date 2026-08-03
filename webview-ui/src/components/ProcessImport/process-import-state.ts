// Feature 084 T037–T040 — every decision the import surface makes, as pure
// functions the component only renders.
//
// Split out of `ProcessImportPreflight.svelte` because the same reason strings
// are needed twice: once by the plan table before the commit, and once by the
// result table after it (FR-042). One copy means the two cannot disagree about
// why a row was skipped.
//
// Nothing here posts, reads, or retains anything. The commit itself is the
// existing `savePhases` helper — import adds no mutating IPC command (research
// R2) — so this module's job ends at building its request and reading its ack.
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

import type { DocumentRefusalCode, ImportPlan, ImportPlanRow } from '../../lib/messages';
import type { SavePhaseRow, SavePhasesRequest, SavePhasesResult } from '../../lib/save-phases';
import type {
  SavePipelineRow,
  SavePipelinesRequest,
  SavePipelinesResult
} from '../../lib/save-pipelines';
import type { WritablePhaseDefinitionScope } from '../../lib/snapshot-types';
import { formatPhaseSaveRejection } from '../PipelineBuilderEditors/phase-catalog-state';
import { formatPipelineSaveRejection } from '../PipelineBuilderEditors/pipeline-catalog-state';

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

type ImportOutcomeRow = Extract<ImportPlanRow, { outcome: 'import'; resourceKind: 'phase' }>;

type PipelineImportOutcomeRow = Extract<
  ImportPlanRow,
  { outcome: 'import'; resourceKind: 'pipeline' }
>;

/**
 * The scopes an import may target. Built-in is absent, and unrepresentable in
 * the element type as well, so it cannot be offered (FR-035).
 */
export const IMPORT_TARGET_SCOPES: readonly WritablePhaseDefinitionScope[] = ['user', 'workspace'];

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
  /** `null` until the operator picks one. There is no default (FR-056). */
  readonly scope: WritablePhaseDefinitionScope | null;
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
 * The kind word shown in a row's own column (FR-056).
 *
 * Shown per row rather than once for the document, because a package declares
 * both kinds and the same outcome means different things for each: a `skip` on
 * a Phase is a dependency the catalog already holds, a `skip` on the Pipeline is
 * the thing the operator opened the file for not happening.
 */
export function resourceKindLabel(row: ImportPlanRow): string {
  return row.resourceKind === 'pipeline' ? 'Pipeline' : 'Phase';
}

/** The outcome word shown in a row's own column. */
export function outcomeLabel(row: ImportPlanRow): string {
  if (row.outcome === 'import') return 'Import';
  if (row.outcome === 'skip') return 'Skip';
  if (row.outcome === 'blocked') return 'Blocked';
  return 'Invalid';
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
  if (row.outcome === 'skip') {
    return [
      `Already present in the ${row.presentIn} layer as a ${row.presentRowStatus} row, so this import would not change it.`
    ];
  }
  if (row.outcome === 'blocked') {
    return [
      row.reason.code === 'dependency-absent'
        ? `Needs the Phase ${row.reason.phaseId}, which is in no catalog layer and this document does not supply.`
        : `Needs the Phase ${row.reason.phaseId}, which a catalog layer claims but does not currently resolve.`
    ];
  }
  if (row.outcome === 'invalid') {
    const lines = row.defects.map((defect) => `${defect.field}: ${defect.message}`);
    if (row.totalDefects > row.defects.length) {
      lines.push(`and ${row.totalDefects - row.defects.length} more not shown.`);
    }
    return lines;
  }
  if (row.resourceKind === 'phase' && row.requiresRetryConditionCapability) {
    return ['Declares a retry condition, which the commit checks separately.'];
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
  'disallowed-syntax': 'This document uses YAML the Phase format does not accept.',
  'multi-document': 'This file holds more than one document, and an import reads exactly one.',
  'duplicate-id': 'This document declares the same id twice, so which one was meant is unclear.',
  empty: 'This document declares no Phase.'
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
  // The writability question, now narrow enough to have exactly one case left
  // (T048). A Pipeline row whose plan carries no Pipeline revision has no gate
  // for its own write to present, so writing it would drop FR-040 for that layer
  // — a plan computed against a Pipeline catalog that has since moved would be
  // applied silently. Held closed instead; re-inspecting the document rebuilds a
  // plan that carries it.
  if (
    pipelineImportRows(gate.plan).length > 0 &&
    gate.plan.computedAgainstPipelineRevision === undefined
  ) {
    return 'This plan does not carry the Pipeline catalog revision its write has to check. Inspect the document again.';
  }
  if (gate.scope === null) return 'Choose the scope to import into.';
  return null;
}

/**
 * What confirming would do, stated before the click (FR-058).
 *
 * Two facts the operator cannot read off the table quickly: that the write is
 * limited to the eligible rows, and where it lands. Both are stated even while
 * Confirm is unavailable, because the reason it is unavailable is often exactly
 * the second one — an operator who has not chosen a scope needs to know a scope
 * is what confirming needs, not merely that something is missing.
 *
 * The scope is named as the operator's choice (FR-046): the document has no say
 * in where it is written, so nothing here is derived from it.
 */
export function commitStatement(
  plan: ImportPlan,
  scope: WritablePhaseDefinitionScope | null
): string {
  const eligible = eligibleRows(plan).length;
  if (eligible === 0) return 'No row here is eligible, so confirming would write nothing.';
  const others = plan.rows.length - eligible;
  const subject = eligible === 1 ? '1 resource' : `${eligible} resources`;
  const target = scope === null ? 'the scope you choose' : `the ${scope} layer`;
  const rest =
    others === 0
      ? ''
      : ` The other ${others === 1 ? 'row is' : `${others} rows are`} left unchanged.`;
  return `Confirming writes ${subject} into ${target}, and nothing else.${rest}`;
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

/** The stored rows of each catalog the commit appends to, for one scope. */
export interface ImportTargetLayers {
  readonly phases: readonly SavePhaseRow[];
  readonly pipelines: readonly SavePipelineRow[];
}

export type ImportLayerKey = 'phases' | 'pipelines';

/** One layer write. The key says which catalog, and so which save sends it. */
export type ImportLayerWrite =
  | { readonly key: 'phases'; readonly request: SavePhasesRequest }
  | { readonly key: 'pipelines'; readonly request: SavePipelinesRequest };

/**
 * The writes that apply a plan, in the order they must be sent (FR-038, FR-043).
 *
 * The Phase layer is first and unconditionally so: a Pipeline that references a
 * Phase this same document supplies does not validate until that Phase is in the
 * catalog, so the reverse order would refuse a package that is internally
 * consistent. Each write carries the revision the PLAN was computed against for
 * the chosen scope — its own, from its own catalog — because that is what makes
 * a layer written since preflight refuse as `stale-catalog` (FR-040) rather than
 * overwrite an operator's work. Reading either revision live at this moment
 * would leave that gate unable to fire.
 *
 * The intent is `import` only for the shipped single-Phase standalone case, and
 * `import-package` for everything else. The distinction is observable: the host
 * returns different legal actions on a `stale-catalog` rejection per kind, so
 * relabelling the standalone path would change an operator's recovery
 * affordances for no gain.
 *
 * Returns nothing at all — not a partial list — when a Pipeline row's plan
 * carries no Pipeline revision. Half a package is the one outcome no requirement
 * here admits, so a caller that ignores `confirmBlockedReason` writes nothing
 * rather than the Phase half.
 *
 * Each `existingLayer` is passed through in the order given, so a row the
 * catalog could not parse is carried across rather than dropped by an import.
 */
export function buildImportWrites(
  plan: ImportPlan,
  scope: WritablePhaseDefinitionScope,
  layers: ImportTargetLayers
): readonly ImportLayerWrite[] {
  const phases = phaseImportRows(plan);
  const pipelines = pipelineImportRows(plan);
  const pipelineRevisions = plan.computedAgainstPipelineRevision;
  if (pipelines.length > 0 && pipelineRevisions === undefined) return [];

  const writes: ImportLayerWrite[] = [];
  if (phases.length > 0) {
    const standalone = phases.length === 1 && pipelines.length === 0;
    writes.push({
      key: 'phases',
      request: {
        scope,
        expectedRevision: plan.computedAgainstRevision[scope],
        mutation: standalone
          ? { kind: 'import', phaseId: phases[0].resourceId }
          : { kind: 'import-package', phaseIds: phases.map((row) => row.resourceId) },
        phases: [
          ...layers.phases,
          ...phases.map((row) => savePhaseRowFromDefinition(row.definition))
        ]
      }
    });
  }
  if (pipelines.length > 0 && pipelineRevisions !== undefined) {
    writes.push({
      key: 'pipelines',
      request: {
        scope,
        expectedRevision: pipelineRevisions[scope],
        mutation: {
          kind: 'import-package',
          pipelineIds: pipelines.map((row) => row.resourceId)
        },
        pipelines: [
          ...layers.pipelines,
          ...pipelines.map((row) => savePipelineRowFromDefinition(row.definition))
        ]
      }
    });
  }
  return writes;
}

/** What a confirmed import did, taken as a whole (FR-042a). */
export type ImportCommitOutcome = 'imported' | 'partial' | 'failed';

export interface ImportLayerResult {
  readonly key: ImportLayerKey;
  readonly ack: SavePhasesResult | SavePipelinesResult;
}

/**
 * The three outcomes, read off the acks that actually came back (FR-042a).
 *
 * `partial` exists because the two writes are independently gated and the first
 * can succeed while the second is refused. It is reported rather than repaired:
 * FR-042c forbids a compensating delete, so the honest report is the only thing
 * this surface owes the operator.
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
 * The scope named in an `imported` detail is the one the operator chose, which is
 * by FR-046 the resolution origin — never anything the document claimed.
 */
export function projectCommitResults(
  plan: ImportPlan,
  scope: WritablePhaseDefinitionScope,
  results: readonly ImportLayerResult[]
): readonly ImportResultRow[] {
  const failureFor = (key: ImportLayerKey): string | null => {
    const entry = results.find((result) => result.key === key);
    if (entry === undefined) return 'Not written — the import stopped before this layer.';
    if (entry.ack.status === 'accepted') return null;
    return key === 'phases'
      ? formatPhaseSaveRejection(entry.ack.reason, entry.ack.result)
      : formatPipelineSaveRejection(entry.ack.reason, entry.ack.result);
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
    const failure = failureFor(row.resourceKind === 'pipeline' ? 'pipelines' : 'phases');
    return failure === null
      ? {
          resourceId: row.resourceId,
          outcome: 'imported' as const,
          detail: `Imported into the ${scope} layer.`
        }
      : { resourceId: row.resourceId, outcome: 'failed' as const, detail: failure };
  });
}

/**
 * The whole-commit sentence shown above the result table (FR-042a, FR-042b/c).
 *
 * `partial` is the one that has to be written carefully. It states two facts the
 * per-row table cannot: that what landed is still there — no compensating delete
 * was performed and none is offered — and that the recovery is to import the
 * same document again, which is safe precisely because an already-present id is
 * a `skip` (FR-030).
 */
export function commitOutcomeStatement(
  outcome: ImportCommitOutcome,
  scope: WritablePhaseDefinitionScope
): string {
  if (outcome === 'imported') return `Every eligible resource was written to the ${scope} layer.`;
  if (outcome === 'failed') return 'Nothing was written.';
  return `Part of this document was written to the ${scope} layer and part was not. What was written is still there. Inspect the same document again to finish the import — anything already in the catalog is skipped.`;
}

/** The two saves, injected so the commit can be exercised without a host. */
export interface ImportCommitDeps {
  readonly savePhases: (request: SavePhasesRequest) => Promise<SavePhasesResult>;
  readonly savePipelines: (request: SavePipelinesRequest) => Promise<SavePipelinesResult>;
}

export interface ImportCommitReport {
  readonly outcome: ImportCommitOutcome;
  readonly results: readonly ImportLayerResult[];
  readonly rows: readonly ImportResultRow[];
}

/**
 * Send the plan's writes in order and report what happened (FR-038, FR-042).
 *
 * Sequential and short-circuiting by design: the Pipeline write is only sent
 * once the Phase write has been accepted, because a Pipeline referencing a Phase
 * from the same document would otherwise be validated against a catalog that
 * never received it. A rejection therefore stops the sequence — and stopping is
 * all it does. Nothing already written is retracted (FR-042c).
 */
export async function runImportCommit(
  plan: ImportPlan,
  scope: WritablePhaseDefinitionScope,
  layers: ImportTargetLayers,
  deps: ImportCommitDeps
): Promise<ImportCommitReport> {
  const results: ImportLayerResult[] = [];
  for (const write of buildImportWrites(plan, scope, layers)) {
    // Awaited inside the loop deliberately: the writes are ordered, and the
    // second is conditional on the first. Issuing them together would send the
    // Pipeline before its Phases exist.
    const ack =
      write.key === 'phases'
        ? await deps.savePhases(write.request)
        : await deps.savePipelines(write.request);
    results.push({ key: write.key, ack });
    if (ack.status !== 'accepted') break;
  }
  return {
    outcome: commitOutcome(results),
    results,
    rows: projectCommitResults(plan, scope, results)
  };
}
