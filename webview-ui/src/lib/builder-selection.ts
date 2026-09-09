// BUG-002 (101) — what the Builder's selection survives, and what it does not.
//
// The three definition tabs replace their visible rows when the host's catalog
// revision moves, and each of them expressed the selection as a position in the
// list it was replacing: an index for Phases and Pipelines, a `sourceKey` for
// Workflows. Neither survives the replacement. An index can point at a
// different definition afterwards, and a `sourceKey` carries the record's
// position in the manifest listing (`${id}::${index}`), so a sibling published
// ahead of the open row re-keys it. So all three dropped the selection on every
// adopt, which closed the pane the operator was working in on every lifecycle
// write — including the save that had just been asked for, and including the
// Publish that only that pane offers.
//
// Dropping it was not arbitrary: a stale index is worse than none, because it
// silently retargets the operator's next edit. The mistake was answering the
// question with a position at all. This module answers it with identity, and
// keeps the containment the drop provided — a definition the projection no
// longer carries does not come back selected.

/**
 * What names a definition across a projection change: the record key it was
 * last seen under, and the authored id underneath it.
 *
 * Both, because neither is sufficient. The key is exact and disambiguates two
 * records claiming one id, which the catalog admits and the Builder renders as
 * two rows; the id is what survives the key changing.
 */
export interface DefinitionIdentity {
  readonly sourceKey: string;
  readonly id: string;
}

/**
 * Where the definition that was open sits in the freshly adopted rows, or
 * `null` when it is no longer unambiguously among them.
 *
 * Three outcomes, in order:
 *
 * 1. A row with the same `sourceKey` — the ordinary case, and exact. An edit to
 *    a published definition writes a draft without moving the manifest
 *    listing, so the key the operator selected is still the key it has.
 * 2. Exactly one row with the same authored id — a definition whose key moved.
 *    A newly created draft is re-keyed by definition (the editor holds it as
 *    `draft::${id}` and the projection returns it as `draft::${id}::${index}`),
 *    and a stored row is re-keyed whenever a sibling changes the listing order.
 * 3. `null` — nothing claims the id, or more than one row does. Zero means the
 *    definition was deactivated or removed and there is nothing to reopen. More
 *    than one means the id is ambiguous, and choosing between them would open a
 *    definition the operator did not select; deselecting is the honest answer
 *    and is what this surface did before, in every case rather than only this
 *    one.
 */
export function reselectIndex<T>(
  rows: readonly T[],
  open: DefinitionIdentity | null,
  identityOf: (row: T) => DefinitionIdentity
): number | null {
  if (open === null) return null;
  const byKey = rows.findIndex((row) => identityOf(row).sourceKey === open.sourceKey);
  if (byKey !== -1) return byKey;
  let byId = -1;
  for (const [index, row] of rows.entries()) {
    if (identityOf(row).id !== open.id) continue;
    // A second claimant makes the id ambiguous; stop rather than pick.
    if (byId !== -1) return null;
    byId = index;
  }
  return byId === -1 ? null : byId;
}

/** The identity of the row at `index`, or `null` when nothing is selected. */
export function identityAt<T>(
  rows: readonly T[],
  index: number | null,
  identityOf: (row: T) => DefinitionIdentity
): DefinitionIdentity | null {
  if (index === null) return null;
  const row = rows.at(index);
  return row === undefined ? null : identityOf(row);
}
