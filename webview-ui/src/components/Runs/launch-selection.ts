// Feature 102 (T020, US2 — FR-013, FR-014) — the three questions the surface
// asks about its one selection.
//
// These are pure functions over the projection rather than methods on a store
// because the selection has no life of its own: it is a pointer into the last
// projection the host sent, and every question about it is answered by looking
// there. A store would have to be told when the projection changed; a function
// cannot be told anything, so it cannot be told late.
//
// `(kind, id)` is the identity (FR-014). The Pipeline and Workflow catalogs are
// separate documents with separate id spaces, so the same id in both is legal and
// says nothing about the two definitions being related. Comparing ids alone
// highlights the wrong row and opens the wrong form.

import type { Launchable, LaunchProjection, LaunchSection } from '../../lib/snapshot-types';

/** What the operator has chosen, or nothing. Held once, by `RunsSurface`. */
export type LaunchSelection = {
  readonly kind: 'pipeline' | 'workflow';
  readonly id: string;
} | null;

type Identity = Pick<Launchable, 'kind' | 'id'>;

function offered(section: LaunchSection): readonly Launchable[] {
  return section.state === 'entries' ? section.entries : [];
}

/** Whether this entry is the selected one. Both halves of the identity, always. */
export function isSelected(entry: Identity, selection: LaunchSelection): boolean {
  return selection !== null && selection.kind === entry.kind && selection.id === entry.id;
}

/**
 * The entry the selection names, read out of the projection on every call
 * (FR-017). Nothing is cached: a definition republished under a live selection
 * changes its ports and its active version, and the panel must show the version
 * the next run would freeze rather than the one that was on screen when the
 * operator clicked.
 */
export function selectedEntry(
  projection: LaunchProjection | undefined,
  selection: LaunchSelection
): Launchable | undefined {
  if (projection === undefined || selection === null) return undefined;
  const section = selection.kind === 'pipeline' ? projection.pipelines : projection.workflows;
  return offered(section).find((entry) => isSelected(entry, selection));
}

/**
 * The selection the next projection admits (FR-013).
 *
 * The predicate is absence from the projection and nothing else. A definition
 * drops out because it was deactivated, or because a Workflow lost a member
 * Pipeline and can no longer be composed — the surface is told neither, and
 * waiting to be told would leave a selection pointing at something an operator
 * can no longer start.
 *
 * An absent projection is not that predicate. The host omits `launchables` until
 * both catalogs resolve (FR-006), and a host that has not looked yet has not
 * said the definition is gone; clearing here would drop the operator's choice on
 * every reload.
 */
export function reconcileSelection(
  projection: LaunchProjection | undefined,
  selection: LaunchSelection
): LaunchSelection {
  if (selection === null) return null;
  if (projection === undefined) return selection;
  return selectedEntry(projection, selection) === undefined ? null : selection;
}
