// Feature 099 (FR-R3-015) T489 — the two selectors every consumer of a
// `CatalogSnapshot` needs, defined once.
//
// Three call sites read a snapshot for different reasons and would otherwise each
// write their own filter: the Phase/Pipeline loader wants bodies to resolve, the
// Workflow resolution wants the same for its kind, and the import planner wants
// ids alone (FR-048). Two of those three would be spelled
// `definitions.filter(d => d.kind === k)`, and the third differs in exactly the
// way that matters — presence is a claim on an id at *every* status, so it must
// not be derived from the row list, which drops the statuses that carry no body.
//
// Pure by construction: no `vscode`, no Node built-in, no I/O. The purity lint of
// FR-058 walks this module's closure along with the rest of `src/catalog/`.

import { definitionStateOf } from '../contracts/catalog-lifecycle';
import type { CatalogKind, CatalogSnapshot } from '../contracts/catalog-store';

/**
 * The stored rows of one kind, in manifest order, ready for a resolver.
 *
 * A definition contributes a row only when it has a body to contribute. Both ways
 * to have none are skipped and neither is an error here: an `invalid` definition
 * is already reported as an integrity fault on the snapshot (FR-027), and an entry
 * naming no active version is FR-R3-016's draft-only case, which this feature's
 * save path never writes (FR-009).
 *
 * Resolution then treats these rows exactly as it treated a configuration array:
 * a malformed body is quarantined per row by the resolver's own validator, never
 * here. The store does not validate (FR-010).
 */
export function storedRows(
  snapshot: CatalogSnapshot,
  kind: CatalogKind
): readonly unknown[] {
  const rows: unknown[] = [];
  for (const definition of snapshot.definitions) {
    if (definition.kind !== kind) continue;
    if (definition.body === null) continue;
    rows.push(definition.body);
  }
  return rows;
}

/**
 * The **draft** bodies of the definitions that have nothing else, in manifest order.
 *
 * BUG-001 (101) — the second half of what the Builder's Library has to list. `storedRows`
 * above is bodies that are ACTIVE, which is the whole effective catalog and is
 * deliberately all of it (FR-007); a definition saved once and never published has
 * no active body, so it contributed no row, no source record, and no projected
 * record. The Builder listed nothing for it, and because a draft write moves the
 * kind's derived revision, the surface re-read the catalog and replaced the row the
 * operator had just saved with nothing at all.
 *
 * `'draft'` only, never `'active-with-draft'`: a definition with both bodies
 * already produces a row from its active one, and emitting a second row for its
 * draft would show one definition twice. `deriveDefinitionState`'s two-pointer form
 * is the oracle for that (100 FR-006) rather than a local `activeVersionId === null`
 * — one mapping, so this selector and the lifecycle badge cannot disagree about
 * which state a row is in.
 *
 * A `null` `draftBody` is skipped for the reason `storedRows` skips a null `body`:
 * the record was unreadable, which is already an integrity fault on the snapshot
 * (FR-027), and there is no body to resolve.
 *
 * These rows are kept **separate** from `storedRows` all the way down. They reach
 * the three resolvers as `draftOnlyRows` and come back as `draftOnlyRecords`, which
 * only the Builder projections read; nothing that decides what runs sees them
 * (FR-008, FR-009).
 */
export function storedDraftOnlyRows(
  snapshot: CatalogSnapshot,
  kind: CatalogKind
): readonly unknown[] {
  const rows: unknown[] = [];
  for (const definition of snapshot.definitions) {
    if (definition.kind !== kind) continue;
    if (definitionStateOf(definition.draftVersionId, definition.activeVersionId) !== 'draft') {
      continue;
    }
    if (definition.draftBody === null) continue;
    rows.push(definition.draftBody);
  }
  return rows;
}

/**
 * Every id of one kind the manifest holds an entry for, at any status (FR-048).
 *
 * This is the import presence rule. It deliberately does **not** go through
 * `storedRows`: an id whose record is unreadable, or which holds a draft and no
 * active version, is still a claim on that id, and an import that treated it as
 * absent would create a second definition under a name already taken (FR-050).
 */
export function storedIds(snapshot: CatalogSnapshot, kind: CatalogKind): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const definition of snapshot.definitions) {
    if (definition.kind === kind) ids.add(definition.id);
  }
  return ids;
}
