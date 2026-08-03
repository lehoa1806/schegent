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

import type { DocumentRefusalCode, ImportPlan, ImportPlanRow } from '../../lib/messages';
import type { SavePhaseRow, SavePhasesRequest, SavePhasesResult } from '../../lib/save-phases';
import type { WritablePhaseDefinitionScope } from '../../lib/snapshot-types';
import { formatPhaseSaveRejection } from '../PipelineBuilderEditors/phase-catalog-state';

/**
 * The definition an `import` plan row carries.
 *
 * Derived from the contract rather than mirrored, because a second declaration
 * of the portable field set is a second thing to keep in step with the host, and
 * FR-046a turns any divergence into a lossy round trip.
 */
export type ImportedPhaseDefinition = Extract<
  ImportPlanRow,
  { outcome: 'import' }
>['definition'];

type ImportOutcomeRow = Extract<ImportPlanRow, { outcome: 'import' }>;

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

export type ImportResultOutcome = 'imported' | 'skipped' | 'invalid' | 'failed';

export interface ImportResultRow {
  readonly resourceId: string | null;
  readonly outcome: ImportResultOutcome;
  readonly detail: string;
}

/** The `import` rows of a plan, in plan order. */
export function importRows(plan: ImportPlan): readonly ImportOutcomeRow[] {
  return plan.rows.filter((row): row is ImportOutcomeRow => row.outcome === 'import');
}

/** The outcome word shown in a row's own column. */
export function outcomeLabel(row: ImportPlanRow): string {
  if (row.outcome === 'import') return 'Import';
  if (row.outcome === 'skip') return 'Skip';
  return 'Invalid';
}

/**
 * FR-054 — `skip` and `invalid` must state the reason without the operator
 * opening the file. An `import` row has no reason to state beyond the advisory
 * that it declares a retry condition, whose capability gate is re-evaluated at
 * commit time (FR-012a), so it must not read as already granted here.
 */
export function reasonLines(row: ImportPlanRow): readonly string[] {
  if (row.outcome === 'skip') {
    return [
      `Already present in the ${row.presentIn} layer as a ${row.presentRowStatus} row, so this import would not change it.`
    ];
  }
  if (row.outcome === 'invalid') {
    const lines = row.defects.map((defect) => `${defect.field}: ${defect.message}`);
    if (row.totalDefects > row.defects.length) {
      lines.push(`and ${row.totalDefects - row.defects.length} more not shown.`);
    }
    return lines;
  }
  if (row.requiresRetryConditionCapability) {
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
  const rows = importRows(gate.plan);
  if (rows.length === 0) return 'This plan has nothing to import.';
  if (rows.length > 1) {
    // FR-044 — one Phase per document. A plan with more rows is a sibling
    // package feature's shape, and the save intent cannot declare two added
    // identities, so it fails closed rather than importing part of the plan.
    return 'This plan declares more than one Phase, which this import cannot apply.';
  }
  if (gate.scope === null) return 'Choose the scope to import into.';
  return null;
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
 * The save that applies a plan, or `null` when the plan cannot be applied.
 *
 * Written as a fold over the plan's `import` rows rather than around a single
 * resource (FR-044), so a sibling package feature driving many rows reuses this
 * merge instead of writing a second one. What is single here is the declared
 * mutation: the shared intent algebra admits exactly one added identity per
 * save, so a plan with more than one `import` row is refused rather than applied
 * in part. `confirmBlockedReason` states that to the operator before the click.
 *
 * `expectedRevision` is the revision the PLAN was computed against for the
 * chosen scope, not the catalog's current one (FR-038) — that is what makes a
 * layer written since preflight refuse as `stale-catalog`.
 *
 * `existingLayer` is passed through in the order given, so a row the catalog
 * could not parse is carried across rather than dropped by an import.
 */
export function buildImportSave(
  plan: ImportPlan,
  scope: WritablePhaseDefinitionScope,
  existingLayer: readonly SavePhaseRow[]
): SavePhasesRequest | null {
  const rows = importRows(plan);
  if (rows.length !== 1) return null;
  const merged = rows.reduce<readonly SavePhaseRow[]>(
    (layer, row) => [...layer, savePhaseRowFromDefinition(row.definition)],
    existingLayer
  );
  return {
    scope,
    expectedRevision: plan.computedAgainstRevision[scope],
    mutation: { kind: 'import', phaseId: rows[0].resourceId },
    phases: merged
  };
}

/**
 * The save's single ack, as one result per plan row (FR-042).
 *
 * Total over `plan.rows` by construction, and because the commit is
 * all-or-nothing (FR-044a) the projection cannot report a mixed outcome that did
 * not happen: on `accepted` every `import` row is `imported`, on `rejected`
 * every one is `failed` with the same reason. Rows the commit never addressed
 * keep the outcome and the reason preflight gave them.
 *
 * The scope named in an `imported` detail is the one the operator chose, which is
 * by FR-046 the resolution origin — never anything the document claimed.
 */
export function projectSaveAck(
  plan: ImportPlan,
  ack: SavePhasesResult,
  scope: WritablePhaseDefinitionScope
): readonly ImportResultRow[] {
  const failure =
    ack.status === 'rejected' ? formatPhaseSaveRejection(ack.reason, ack.result) : null;
  return plan.rows.map((row) => {
    if (row.outcome === 'skip') {
      return { resourceId: row.resourceId, outcome: 'skipped' as const, detail: reasonLines(row).join(' ') };
    }
    if (row.outcome === 'invalid') {
      return { resourceId: row.resourceId, outcome: 'invalid' as const, detail: reasonLines(row).join(' ') };
    }
    return failure === null
      ? {
          resourceId: row.resourceId,
          outcome: 'imported' as const,
          detail: `Imported into the ${scope} layer.`
        }
      : { resourceId: row.resourceId, outcome: 'failed' as const, detail: failure };
  });
}
