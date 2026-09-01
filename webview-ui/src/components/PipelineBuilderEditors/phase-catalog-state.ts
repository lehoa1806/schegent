import { AUTHORED_PHASE_FIELDS } from '../../../../src/contracts/process-definitions';
import type { PhaseDefinition, WorkflowSnapshot } from '../../lib/snapshot-types';
import type { SavePhaseRow } from '../../lib/definition-rows';
import type { MutablePhase } from './types';

type PhaseCatalogRecord = NonNullable<WorkflowSnapshot['phaseCatalog']>['records'][number];

/**
 * A declared Phase edit, awaiting a save.
 *
 * Feature 101 (T030) — moved here from the deleted `save-phases.ts`, and renamed
 * from `SavePhasesMutation` for symmetry with `PipelineCatalogMutation` and
 * `WorkflowCatalogMutation`, the two sibling unions it is used beside. The arms
 * are unchanged. What a mutation *is* changed underneath it: it no longer travels
 * to the host at all (100 FR-051 retired the tag from the wire), so this is purely
 * the editor's record of which single row a pending save will write.
 */
export type PhaseCatalogMutation =
  | { readonly kind: 'create'; readonly phaseId: string }
  /**
   * Feature 084 (FR-046a) — a `create` whose row came from a portable document,
   * so its declared `version` is stored as authored instead of being renumbered.
   * A `create` in every other respect, including the gates it passes.
   */
  | { readonly kind: 'import'; readonly phaseId: string }
  /**
   * Feature 085 (FR-043) — the Phase half of a package import: a set of rows
   * added under ONE intent, each keeping the version its document declared.
   */
  | { readonly kind: 'import-package'; readonly phaseIds: readonly string[] }
  | { readonly kind: 'edit'; readonly phaseId: string }
  | {
      readonly kind: 'duplicate';
      readonly sourcePhaseId: string;
      readonly phaseId: string;
    }
  | { readonly kind: 'remove'; readonly phaseId: string }
  | { readonly kind: 'reset' };

export function effectivePhasesToMutable(
  phases: readonly PhaseDefinition[]
): MutablePhase[] {
  return phases.map((phase) => ({
    ...phase,
    version: phase.version ?? 1,
    sourceKey: `effective::${phase.id}`,
    sourceStatus: 'effective',
    sourceErrors: [],
    persisted: true
  }));
}

/**
 * A projected catalog record as an editable row.
 *
 * THE DEFINITION IS WALKED, NOT RESTATED. This read eleven `definition?.x` fields
 * by name while the definition can carry twenty-one, and the difference was not
 * refused — it was dropped. Six of the ten missing names arrived anyway on
 * `display`, which is why the loss went unnoticed: `recognizedDisplay` copies
 * every authored scalar, so `sideEffects` reached the editor by accident rather
 * than by design. `capabilities` is the sole array-valued authored field, so it
 * had no such accident to ride, and `toSavePhaseRow` cannot forward a field the
 * row never received.
 *
 * `display` still comes first and the definition still wins: `display` is the raw
 * fallback for a row that FAILED validation, where there is no definition to read.
 */
export function sourceRecordToMutable(record: PhaseCatalogRecord): MutablePhase {
  const definition = record.definition;
  const display = record.display;
  const displayedFields = Object.fromEntries(
    Object.entries(display).filter(([key]) => key !== 'id' && key !== 'phaseId')
  );
  const declared: Record<string, unknown> = {};
  for (const field of AUTHORED_PHASE_FIELDS) {
    // Identity is the row's `id`, resolved below; `name` and `version` have
    // fallbacks an invalid row depends on, so both are set explicitly.
    if (field === 'id' || field === 'phaseId' || field === 'name' || field === 'version') continue;
    const value = (definition as Record<string, unknown> | null)?.[field];
    if (value === undefined) continue;
    declared[field] = value;
  }
  return {
    ...displayedFields,
    ...declared,
    id: definition?.phaseId ?? record.phaseId,
    name: definition?.name ?? (typeof display.name === 'string' ? display.name : 'Invalid Phase'),
    version: definition?.version ?? (typeof display.version === 'number' ? display.version : 1),
    // A directive is exclusive-or, so an invalid row's raw text is the only thing
    // standing in for a definition that failed to parse.
    ...(definition?.instruction === undefined && typeof display.instruction === 'string'
      ? { instruction: display.instruction }
      : {}),
    ...(definition?.skill === undefined && typeof display.skill === 'string'
      ? { skill: display.skill }
      : {}),
    sourceKey: record.key,
    sourceStatus: record.status,
    sourceErrors: record.errors,
    ...(record.modelAvailable !== undefined ? { modelAvailable: record.modelAvailable } : {}),
    persisted: true
  } as MutablePhase;
}

function targetIndex(
  rows: readonly MutablePhase[], sourceKey: string | null, phaseId: string
): number {
  const exact = rows.findIndex((row) => row.sourceKey === sourceKey);
  if (exact >= 0) return exact;
  const candidates = rows.flatMap((row, index) => (row.id === phaseId ? [index] : []));
  return candidates.length === 1 ? candidates[0] : -1;
}

/** Reapply only the declared local mutation over a freshly projected catalog. */
export function rebasePhaseMutation(
  records: readonly PhaseCatalogRecord[],
  draftRows: readonly MutablePhase[],
  mutation: PhaseCatalogMutation,
  sourceKey: string | null
): MutablePhase[] {
  const fresh = records.map(sourceRecordToMutable);
  // Feature 099 (T494a, FR-043) — a reset empties the catalog. It used to drop
  // only the rows of the scope being reset, leaving a lower layer showing
  // through; there is no lower layer to show through any more.
  if (mutation.kind === 'reset') return [];
  // Feature 085 — a package import owns no draft row in this editor: the import
  // surface holds the plan, and a rejected package is recovered by inspecting the
  // same document again (FR-042b), not by rebasing a draft that does not exist.
  // The fresh projection IS the answer.
  if (mutation.kind === 'import-package') return fresh;
  if (mutation.kind === 'remove') {
    const removal = targetIndex(fresh, sourceKey, mutation.phaseId);
    return removal < 0 ? fresh : fresh.filter((_, index) => index !== removal);
  }
  const draftTarget = targetIndex(draftRows, sourceKey, mutation.phaseId);
  if (draftTarget < 0) return fresh;
  const draft = draftRows[draftTarget];
  if (mutation.kind === 'create' || mutation.kind === 'duplicate') return [...fresh, draft];
  const freshTarget = targetIndex(fresh, sourceKey, mutation.phaseId);
  if (freshTarget < 0) return fresh;
  fresh[freshTarget] = draft;
  return fresh;
}

/**
 * The save body for one edited Phase: every authored field the row carries, and
 * nothing else.
 *
 * BUILT FROM AN ALLOWLIST, WALKED. This was an explicit eleven-field literal
 * while `AUTHORED_PHASE_FIELDS` declared twenty-one, and the ten it did not name
 * were not refused — they were dropped, on a save the operator was told
 * succeeded. `sideEffects` is the one that bites: it resolves to `'workspace'`
 * when omitted, so editing a Phase that declared `sideEffects: 'git'` and saving
 * it wrote back a Phase that no longer writes Git metadata, with `writesGitMetadata()`
 * silently answering differently afterwards. `capabilities` had the same shape of
 * loss in the opposite direction — a narrowed authority widening back to the
 * default on an unrelated edit.
 *
 * Walking the set also replaces the strip-the-view-fields denylist this function
 * used to pair with: an allowlist cannot forward a projection field it has never
 * heard of, where a denylist forwards exactly those.
 *
 * `phaseId` is the single deliberate omission. The row is `id`-keyed and the host
 * refuses a document carrying both spellings as `identity-ambiguous`; the raw-JSON
 * editor declines that name for the same reason, and the seam test pins it.
 */
export function toSavePhaseRow(phase: MutablePhase): SavePhaseRow {
  return authoredPhaseDocument(phase) as unknown as SavePhaseRow;
}

/**
 * The authored fields of one editor row: the save body, and the raw JSON document.
 *
 * ONE PROJECTION, NOT TWO. `PhaseCatalogEditor` built the JSON document with a
 * denylist — a destructure naming the five projection fields it knew of, forwarding
 * everything else — while `RawJsonPhaseEditor` validates against
 * `AUTHORED_PHASE_FIELDS`. `MutablePhase` carries `[key: string]: unknown`, so the
 * two disagreed as soon as any row field appeared that the destructure did not name:
 * the view refused the document it had just serialized, with "field `X` is not
 * author-controlled", and Save stayed dead because the offending key was not one the
 * operator could edit away.
 *
 * An allowlist cannot forward a projection field it has never heard of; a denylist
 * forwards exactly those. Nothing about a new row field needs to be remembered here.
 */
export function authoredPhaseDocument(phase: MutablePhase): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: phase.id,
    name: phase.name,
    version: phase.version
  };
  for (const field of AUTHORED_PHASE_FIELDS) {
    if (field === 'phaseId' || field in row) continue;
    const value = (phase as Record<string, unknown>)[field];
    // `undefined` is how the form clears an optional field, and an explicit
    // `undefined` on the wire is not the same claim as an absent key.
    if (value === undefined) continue;
    // Empty is how the two free-text selects spell "inherit"; the host reads an
    // absent field as inherit and refuses an empty string. The raw-JSON editor
    // refuses it too, so a document carrying `model: ''` would be unsaveable.
    if ((field === 'model' || field === 'effort') && value === '') continue;
    row[field] = value;
  }
  return row;
}

export function makeNewPhaseDraft(phases: readonly MutablePhase[]): MutablePhase {
  let id = 'new-phase';
  let suffix = 1;
  while (phases.some((phase) => phase.id === id)) {
    id = `new-phase-${suffix++}`;
  }
  return {
    id,
    name: 'New Phase',
    version: 1,
    instruction: 'Describe the phase objective here.',
    sourceKey: `draft::${id}`,
    // Feature 099 (T494a, FR-043) — a draft is `effective`, not `shadowed`. The
    // `shadowed` arm is gone with the layer tier, and it never described a draft
    // anyway: `persisted: false` is what says this row has not reached the store.
    sourceStatus: 'effective',
    sourceErrors: [],
    persisted: false
  };
}

export function makeDuplicatePhaseDraft(
  original: MutablePhase,
  phases: readonly MutablePhase[]
): MutablePhase {
  // Svelte state rows are reactive proxies and cannot be passed to
  // structuredClone. Copy the portable scalar fields and the sole nested
  // collection explicitly so duplication also works from live UI state.
  const duplicate: MutablePhase = {
    ...original,
    sourceErrors: original.sourceErrors.map((error) => ({ ...error }))
  };
  let id = `${original.id}-copy`;
  let suffix = 1;
  while (phases.some((phase) => phase.id === id)) id = `${original.id}-copy-${suffix++}`;
  duplicate.id = id;
  duplicate.name = `${original.name || 'Untitled Phase'} (Copy)`;
  duplicate.version = 1;
  duplicate.sourceKey = `draft::${id}`;
  duplicate.sourceStatus = 'effective';
  duplicate.sourceErrors = [];
  duplicate.persisted = false;
  return duplicate;
}

export function phaseTooltip(phases: readonly MutablePhase[], phaseId: string): string {
  const phase = phases.find((candidate) => candidate.id === phaseId);
  if (!phase) return `Unknown phase: ${phaseId}`;
  const directive = phase.instruction ?? (phase.skill ? `Skill: ${phase.skill}` : 'No directive');
  const summary = `${directive.slice(0, 100)}${directive.length > 100 ? '...' : ''}`;
  return `ID: ${phase.id}\nName: ${phase.name}\nModel: ${phase.model || 'Default Backend Model'}\nDirective: ${summary}`;
}

export function formatPhaseSaveRejection(reason: string, result: unknown): string {
  const details = result as {
    dependentPipelineIds?: readonly string[];
    errors?: readonly { phaseId?: string; field?: string; code?: string; message?: string }[];
    total?: number;
  } | undefined;
  if (details?.dependentPipelineIds?.length) {
    return `${reason} — used by pipelines: ${details.dependentPipelineIds.join(', ')}`;
  }
  if (reason === 'phase-validation' && details?.errors?.length) {
    const visible = details.errors.slice(0, 3).map((error) => {
      const location = [error.phaseId, error.field].filter(Boolean).join('.');
      const explanation = error.message ?? error.code ?? 'invalid value';
      return `${location || 'Phase'}: ${explanation}`;
    });
    const remaining = Math.max(0, (details.total ?? details.errors.length) - visible.length);
    return `${reason} — ${visible.join('; ')}${remaining > 0 ? `; +${remaining} more` : ''}`;
  }
  if (reason === 'stale-catalog') return `${reason} — refresh the catalog, then reapply the draft`;
  return reason;
}
