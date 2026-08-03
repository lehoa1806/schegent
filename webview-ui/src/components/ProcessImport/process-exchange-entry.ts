// Feature 084 T066 — what the Phase manager has to decide before it can offer
// the exchange controls (FR-052, FR-053, FR-057).
//
// Three decisions, none of which the components can make for themselves: whether
// a given row can be exported at all, whether an import can be started right
// now, and what the two writable layers currently hold. Each is a pure function
// here rather than an expression in the template, because each has a wrong answer
// that would be invisible in markup.

import type {
  PhaseCatalogSourceRecord,
  WritablePhaseDefinitionScope
} from '../../lib/snapshot-types';
import type { SavePhaseRow } from '../../lib/save-phases';

/** Whatever a row can be asked about. The list rows are a superset of this. */
export interface ExportableRow {
  readonly sourceStatus: 'effective' | 'shadowed' | 'invalid';
  /** False for a draft that has never been saved. */
  readonly persisted: boolean;
}

export interface ExportAvailability {
  readonly resolves: boolean;
  /** Shown when `resolves` is false (FR-057). Always a sentence, never a code. */
  readonly disabledReason: string;
}

/**
 * Whether the row's id resolves to a definition the host can serialize.
 *
 * Mirrors the two absences `cmd-export-process-yaml` distinguishes, so a control
 * that would fail is disabled before the click rather than after it (FR-015):
 * `'does-not-resolve'` for a row carrying no valid definition, `'not-found'` for
 * an id no layer holds — which is exactly an unsaved draft.
 *
 * A `shadowed` row stays ENABLED. Export is of the effective catalog by FR-014,
 * so what it writes is the definition this installation would run; the row's own
 * `shadowed` badge already says that is not this row. Disabling it would invent a
 * restriction the spec does not state and would leave the operator with no way to
 * obtain the definition that actually resolves.
 */
export function phaseExportAvailability(row: ExportableRow): ExportAvailability {
  if (!row.persisted) {
    return {
      resolves: false,
      disabledReason: 'Save this Phase before exporting it.'
    };
  }
  if (row.sourceStatus === 'invalid') {
    return {
      resolves: false,
      disabledReason: 'This Phase has errors, so there is nothing valid to export.'
    };
  }
  return { resolves: true, disabledReason: '' };
}

export interface ImportEntryGate {
  readonly trusted: boolean;
  readonly savePending: boolean;
  /** True while an undeclared local Phase edit is outstanding. */
  readonly mutationActive: boolean;
}

/**
 * Why an import cannot be started, or `null` when it can (FR-053, FR-057).
 *
 * The pending-mutation case is the one that matters. A commit sends the whole
 * target layer, and the layer this surface supplies is the PERSISTED one — so
 * starting an import with a draft outstanding would ask the operator to confirm a
 * write that silently excludes the edit they are in the middle of making. The
 * existing catalog toolbar already holds Add, Undo, and Redo closed for the same
 * reason: one declared mutation at a time.
 */
export function importDisabledReason(gate: ImportEntryGate): string | null {
  if (!gate.trusted) {
    return 'This workspace is not trusted, so an imported Phase could not be saved.';
  }
  if (gate.savePending) return 'A Phase save is still in progress.';
  if (gate.mutationActive) {
    return 'Save or discard your pending Phase changes before importing.';
  }
  return null;
}

/**
 * The two writable layers as they are STORED, for the commit to append to.
 *
 * Taken from each record's `display` — the host's bounded projection of the row
 * as authored — and not rebuilt from the parsed definition. The difference only
 * shows on a row the catalog could not parse, and there it is the whole point: a
 * rebuild reads a missing `name` as `'Invalid Phase'` and a missing `version` as
 * `1`, so an import into that layer would quietly rewrite an unrelated broken row
 * into a valid-looking one. Passing the stored fields through means the host's own
 * validation gate sees the same defect it saw before and refuses the save, which
 * is the outcome the operator can act on.
 *
 * Rows of every status are carried, in catalog order, because the layer is the
 * stored array — dropping one would delete it (FR-025).
 */
export function storedWritableLayers(
  records: readonly PhaseCatalogSourceRecord[]
): Readonly<Record<WritablePhaseDefinitionScope, readonly SavePhaseRow[]>> {
  const layerFor = (scope: WritablePhaseDefinitionScope): readonly SavePhaseRow[] =>
    records
      .filter((record) => record.scope === scope)
      // `display` carries the identity key under whichever name the row used, so
      // the spread is the whole row. The assertion is the boundary this module
      // owns: the host re-validates every row it is handed, and a row that does
      // not satisfy the shape is precisely one it must keep refusing.
      .map((record) => ({ ...record.display }) as unknown as SavePhaseRow);
  return { user: layerFor('user'), workspace: layerFor('workspace') };
}
