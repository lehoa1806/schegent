// Feature 084 T066 — what the Phase manager has to decide before it can offer
// the exchange controls (FR-052, FR-053, FR-057).
//
// Three decisions, none of which the components can make for themselves: whether
// a given row can be exported at all, whether an import can be started right
// now, and what the catalog currently holds. Each is a pure function here rather
// than an expression in the template, because each has a wrong answer that would
// be invisible in markup.
//
// Feature 099 (T494a, FR-040/FR-043) — the third decision used to be "what the
// two writable layers hold", keyed per scope. There is one layer, so it is one
// projection and the key is gone.

import type {
  PhaseCatalogSourceRecord,
  WorkflowCatalogSourceProjection
} from '../../lib/snapshot-types';
import type {
  SavePhaseRow,
  SaveWorkflowRow
} from '../../lib/definition-rows';
import {
  confirmTargetBlockedReason,
  type ImportTargetGate,
  type ImportTargetLayers
} from './process-import-state';

export { confirmTargetBlockedReason, type ImportTargetGate };

/**
 * Top-level Builder Import button gate (Feature 326).
 *
 * Only window primacy blocks starting an import from the Builder header:
 * untrusted primary windows still admit Model Catalog imports (FR-056), and
 * per-catalog trust / unsaved-edits checks run at Confirm once preflight
 * identifies which catalog(s) the document writes.
 */
export function topLevelImportDisabledReason(isPrimary: boolean): string | null {
  return isPrimary ? null : 'Only the primary window can import.';
}

/**
 * Why a Workflow cannot be exported, or `null` when it can.
 *
 * Unsaved drafts are not in the catalog yet; stored Workflows remain exportable
 * even with missing references so broken graphs stay portable (FR-016).
 */
export function workflowExportDisabledReason(
  row: { readonly persisted: boolean } | null
): string | null {
  return row === null || row.persisted
    ? null
    : 'Save this Workflow first. Export writes the definition the catalog holds, not an unsaved draft.';
}

/** Whatever a row can be asked about. The list rows are a superset of this. */
export interface ExportableRow {
  readonly sourceStatus: 'effective' | 'invalid';
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
 * an id the catalog does not hold — which is exactly an unsaved draft.
 *
 * Feature 099 (T494a, FR-040) — this used to carry a third paragraph explaining
 * why a `shadowed` row stayed enabled. The status is gone with the layer tier, so
 * the two refusals below are the whole rule: an unsaved draft, and a row that
 * carries no valid definition.
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

/** The tab the import is started from, which is the catalog the gate observes. */
export type ImportEntryCatalog = 'phase' | 'workflow';

export interface ImportEntryGate {
  /** Whose save and whose edits `savePending` and `mutationActive` report. */
  readonly catalog: ImportEntryCatalog;
  readonly trusted: boolean;
  readonly savePending: boolean;
  /** True while an undeclared local edit to that catalog is outstanding. */
  readonly mutationActive: boolean;
}

const IMPORT_CATALOG_NAMES: Readonly<Record<ImportEntryCatalog, string>> = Object.freeze({
  phase: 'Phase',
  workflow: 'Workflow'
});

/**
 * Why an import cannot be started, or `null` when it can (FR-053, FR-057).
 *
 * The pending-mutation case is the one that matters. A commit sends the whole
 * target layer, and the layer this surface supplies is the PERSISTED one — so
 * starting an import with a draft outstanding would ask the operator to confirm a
 * write that silently excludes the edit they are in the middle of making. The
 * existing catalog toolbar already holds Add, Undo, and Redo closed for the same
 * reason: one declared mutation at a time.
 *
 * Feature 085 T035 — this gates the SINGLE import entry point (FR-055a), which
 * opens documents of either kind. The trust sentence names no kind: the
 * document is not classified before it is read, so naming one there would be a
 * claim about a file nobody has opened yet. The other two name the catalog the
 * caller says it observes, because that is literally what they report — that
 * tab's save, that tab's draft. The Phases and Workflows tabs both mount the
 * entry point, and each feeds the gate its own state, so a fixed "Phase" told
 * the Workflows tab about a catalog it had not touched.
 */
export function importDisabledReason(gate: ImportEntryGate): string | null {
  if (!gate.trusted) {
    return 'This workspace is not trusted, so an imported resource could not be saved.';
  }
  const name = IMPORT_CATALOG_NAMES[gate.catalog];
  if (gate.savePending) return `A ${name} save is still in progress.`;
  if (gate.mutationActive) {
    return `Save or discard your pending ${name} changes before importing.`;
  }
  return null;
}

/**
 * All three catalogs as they are STORED — what the commit appends to.
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
 *
 * Feature 085 T048 — the Pipeline catalog is read the same way and for the same
 * reason: a confirmed package writes both layers, and each write sends its whole
 * layer. Two record lists rather than one call per catalog, because the pair is
 * what a single commit consumes; splitting them would make it possible to supply
 * one and forget the other.
 *
 * Feature 086 T054 — the Workflow catalog joins them on exactly those terms, and
 * the "forget one" failure is why it must: the Workflow write sends its whole
 * layer, so a commit handed an empty projection would not add a Workflow to the
 * catalog, it would replace the catalog with that one Workflow.
 *
 * Feature 099 (T494a, FR-043) — no per-scope keying. The three filters this held
 * each asked which layer a stored row belonged to, and with one layer the answer
 * is "this one" for every row: the projection IS the record list, so the filters
 * are gone rather than left comparing a field against a constant.
 */
export function storedWritableLayers(
  phaseRecords: readonly PhaseCatalogSourceRecord[],
  workflowRecords: readonly WorkflowCatalogSourceProjection[] = []
): ImportTargetLayers {
  // `display` carries the identity key under whichever name the row used, so the
  // spread is the whole row. The assertion is the boundary this module owns: the
  // host re-validates every row it is handed, and a row that does not satisfy the
  // shape is precisely one it must keep refusing.
  return {
    phases: phaseRecords.map((record) => ({ ...record.display }) as unknown as SavePhaseRow),
    workflows: workflowRecords.map(
      (record) => ({ ...record.display }) as unknown as SaveWorkflowRow
    )
  };
}
