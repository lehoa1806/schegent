// Feature 101 (T002, Phase 1) — the Phase tab's row mutations, moved off
// `PipelineBuilder.svelte`.
//
// This is a pure extraction: every function below is the body that stood in the
// component, with the state it read taken as a parameter and the state it wrote
// returned. Nothing about what the Phase tab does changed here, and nothing
// should — the Builder's lifecycle chrome lands on top of this file, and the
// component was six lines under a 500-line ceiling that has no allowlist and no
// per-file override (`tests/lint/svelte-component-loc-budget.test.ts`).
//
// The one shape decision worth recording: these return a *result* rather than
// taking a store. `workflow-catalog-actions.ts` builds a request and lets the
// caller send it, and `model-catalog-state.ts` returns the next catalog and lets
// the caller assign it; both keep the rune declarations in the component that
// renders them, so there is one place to read what the Phase tab's state is. A
// class store — the shape `pipeline-catalog-store.svelte.ts` uses — would move
// six `$state` declarations out with the logic, which is a larger change than
// "make room" and not one this phase is allowed to make.
//
// A `null` return means the edit was refused and the caller changes nothing.

import {
  makeDuplicatePhaseDraft,
  makeNewPhaseDraft,
  sourceRecordToMutable,
  type PhaseCatalogMutation
} from './phase-catalog-state';
import type { PhaseCatalogSourceRecord } from '../../lib/snapshot-types';
import type { MutablePhase, PhaseEditState } from './types';

/** The rows and pending-mutation state an edit leaves behind. */
export interface PhaseMutationEdit {
  readonly phases: MutablePhase[];
  readonly mutation: PhaseCatalogMutation | null;
  readonly mutationSourceKey: string | null;
}

/** A `PhaseMutationEdit` that also moves the selected row. */
export interface PhaseRowsEdit extends PhaseMutationEdit {
  readonly selectedIndex: number | null;
}

/** The undo/redo stack after recording one step. */
export interface PhaseHistoryEdit {
  readonly history: MutablePhase[][];
  readonly index: number;
}

/**
 * The edit-state record with `id`'s raw-JSON mode flipped, seeding an entry for
 * a row that has never been touched. The seed and the flip were two functions
 * in the component (`ensureEditState`, `toggleRawJson`) because the seed had a
 * second caller; it no longer does.
 */
export function withRawJsonToggled(
  editStateById: Record<string, PhaseEditState>,
  id: string
): Record<string, PhaseEditState> {
  return { ...editStateById, [id]: { rawJsonMode: !(editStateById[id]?.rawJsonMode ?? false) } };
}

/** A new draft row appended and selected. */
export function addPhaseRow(phases: readonly MutablePhase[]): PhaseRowsEdit {
  const draft = makeNewPhaseDraft(phases);
  return {
    phases: [...phases, draft],
    selectedIndex: phases.length,
    mutation: { kind: 'create', phaseId: draft.id },
    mutationSourceKey: draft.sourceKey
  };
}

/** A copy of the row at `index`, inserted directly below it and selected. */
export function duplicatePhaseRow(
  phases: readonly MutablePhase[],
  index: number
): PhaseRowsEdit | null {
  const original = phases[index];
  if (!original) return null;
  const duplicate = makeDuplicatePhaseDraft(original, phases);
  const next = [...phases];
  next.splice(index + 1, 0, duplicate);
  return {
    phases: next,
    selectedIndex: index + 1,
    mutation: { kind: 'duplicate', sourcePhaseId: original.id, phaseId: duplicate.id },
    mutationSourceKey: duplicate.sourceKey
  };
}

/**
 * The rows with `index` and `target` swapped, the selection following whichever
 * of the two it was on.
 *
 * One function for both directions, with the neighbour named rather than
 * derived: the up and down handlers differed only in `index - 1` versus
 * `index + 1`, and their two bounds checks (`index <= 0`,
 * `index >= phases.length - 1`) are the same check on the neighbour.
 */
export function movePhaseRow(
  phases: readonly MutablePhase[],
  index: number,
  target: number,
  selectedIndex: number | null
): PhaseRowsEdit | null {
  const moved = phases[index];
  if (!moved || target < 0 || target >= phases.length) return null;
  const next = [...phases];
  next[target] = moved;
  next[index] = phases[target];
  return {
    phases: next,
    selectedIndex:
      selectedIndex === index ? target : selectedIndex === target ? index : selectedIndex,
    mutation: { kind: 'edit', phaseId: moved.id },
    mutationSourceKey: moved.sourceKey
  };
}

/**
 * The row at `index` returned to what the catalog holds, or dropped when the
 * catalog holds nothing for it — a draft that was never saved has no stored
 * state to return to, so discarding the edit discards the row.
 */
export function resetPhaseRow(
  phases: readonly MutablePhase[],
  index: number,
  records: readonly PhaseCatalogSourceRecord[] | undefined
): PhaseRowsEdit {
  const sourceKey = phases[index]?.sourceKey;
  const original = records?.find((record) => record.key === sourceKey);
  return {
    phases: original
      ? phases.map((phase, rowIndex) => (rowIndex === index ? sourceRecordToMutable(original) : phase))
      : phases.filter((_, rowIndex) => rowIndex !== index),
    selectedIndex: null,
    mutation: null,
    mutationSourceKey: null
  };
}

/**
 * The rows with `patch` applied at `index`.
 *
 * Refuses when another row already owns the pending mutation: one edit is in
 * flight at a time, and the source key is what says which row it belongs to. A
 * row that is not yet persisted takes a `draft::` source key, because its id is
 * still being typed and the key has to survive the rename.
 */
export function updatePhaseRow(
  phases: readonly MutablePhase[],
  index: number,
  patch: Partial<MutablePhase>,
  mutation: PhaseCatalogMutation | null,
  mutationSourceKey: string | null
): PhaseMutationEdit | null {
  const current = phases[index];
  if (!current || (mutationSourceKey && current.sourceKey !== mutationSourceKey)) return null;
  const next = phases.map((phase, i) => (i === index ? { ...phase, ...patch } : phase));
  const updated = next[index];
  if (updated.persisted) {
    return {
      phases: next,
      mutation: { kind: 'edit', phaseId: current.id },
      mutationSourceKey: updated.sourceKey
    };
  }
  updated.sourceKey = `draft::${updated.id}`;
  let nextMutation = mutation;
  if (mutation?.kind === 'create' && typeof patch.id === 'string') {
    nextMutation = { kind: 'create', phaseId: patch.id };
  } else if (mutation?.kind === 'duplicate' && typeof patch.id === 'string') {
    nextMutation = { ...mutation, phaseId: patch.id };
  }
  return { phases: next, mutation: nextMutation, mutationSourceKey: updated.sourceKey };
}

/** Whether the row carries a retry condition at all; `''` counts as carrying one. */
export function isRetryEnabled(phase: MutablePhase): boolean {
  return typeof phase.retryCondition === 'string';
}

/**
 * The patch that flips a row's retry condition on or off. Enabling seeds `''`
 * rather than a sample expression so the editor appears with nothing in it —
 * the operator authors the expression, and a seeded one would be a condition
 * nobody wrote becoming a condition that runs.
 */
export function retryConditionToggle(phase: MutablePhase): Partial<MutablePhase> {
  return { retryCondition: isRetryEnabled(phase) ? undefined : '' };
}

/**
 * The undo stack with the current rows recorded as a new step, or `null` when
 * they are identical to the step already on top. Redo steps above the cursor
 * are dropped, which is what makes an edit after an undo a new branch.
 *
 * Takes the rows already serialized because the caller is a `$effect` and the
 * `JSON.stringify(phases)` that produces this string is also what registers the
 * effect's dependency on the rows. Serializing in here instead would move that
 * read behind this call, and the caller skips the call on an undo — so the
 * effect would stop tracking `phases` the first time one was performed.
 */
export function withPhaseHistoryEntry(
  history: readonly MutablePhase[][],
  index: number,
  serializedPhases: string
): PhaseHistoryEdit | null {
  const top = index >= 0 ? JSON.stringify(history[index]) : null;
  if (serializedPhases === top) return null;
  return {
    history: [...history.slice(0, index + 1), JSON.parse(serializedPhases)],
    index: index + 1
  };
}

/**
 * A deep copy of the rows at `step`. Copied rather than handed out by
 * reference: the stack holds the rows the editor is about to bind to, and a
 * shared reference would let the next keystroke edit the history entry it came
 * from.
 */
export function phasesAtHistoryStep(
  history: readonly MutablePhase[][],
  step: number
): MutablePhase[] {
  return JSON.parse(JSON.stringify(history[step]));
}
