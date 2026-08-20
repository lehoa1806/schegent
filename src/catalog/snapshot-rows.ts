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
