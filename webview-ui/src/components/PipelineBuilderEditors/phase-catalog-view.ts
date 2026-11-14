// The Phases tab's list page: which rows the status filter and the search keep, the count under
// the list, and when the tab shows the open Phase's editor page instead of the list.
// The editor page's form and its Summary share one fact from here too: the id of the error list.
//
// Presentation only. The filter changes which rows are drawn, never their order: the list stays
// the authored order, and every move and save still addresses the whole list by index.

import type { DefinitionState } from '../../lib/snapshot-types';
import type { DefinitionValidity } from '../Builder/definition-row-state';

/** The status views of the list toolbar. */
export type PhaseStatusView = 'all' | 'active' | 'draft' | 'invalid';

/** The views in the order the toolbar shows them. */
export const PHASE_STATUS_VIEWS: readonly { readonly id: PhaseStatusView; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'draft', label: 'Draft' },
  { id: 'invalid', label: 'Invalid' }
];

/** The lifecycle states each lifecycle view keeps. A Phase with a draft on top of its published
 *  version is both: it runs, and it has unpublished changes. */
const VIEW_STATES: Readonly<Record<'active' | 'draft', readonly DefinitionState[]>> = {
  active: ['active', 'active-with-draft'],
  draft: ['draft', 'active-with-draft']
};

/** What the filter reads from a row. `state` is absent for a row with no stored lifecycle yet. */
export interface PhaseRowFacts {
  readonly name: string;
  readonly id: string;
  readonly description?: string;
  readonly sourceStatus: DefinitionValidity;
  readonly state?: DefinitionState;
}

function matchesView(row: PhaseRowFacts, view: PhaseStatusView): boolean {
  if (view === 'all') return true;
  if (view === 'invalid') return row.sourceStatus === 'invalid';
  return row.state !== undefined && VIEW_STATES[view].includes(row.state);
}

function matchesQuery(row: PhaseRowFacts, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [row.name, row.id, row.description ?? ''].some((text) =>
    text.toLowerCase().includes(needle)
  );
}

/**
 * Whether a row is drawn under `view` with `query` in the search box. The search ignores case and
 * the spaces around it, and matches the Phase's name, id or description; an empty search matches.
 */
export function phaseRowVisible(row: PhaseRowFacts, view: PhaseStatusView, query: string): boolean {
  return matchesView(row, view) && matchesQuery(row, query);
}

/** What decides whether the Phases tab shows the editor page. */
export interface PhaseEditorOpenFacts {
  /** The Phase catalog's state; absent while it loads. */
  readonly catalogState: 'ready' | 'error' | undefined;
  readonly selectedIndex: number | null;
  readonly phaseCount: number;
}

/**
 * Whether the Phases tab shows the open Phase's editor page rather than the list. The Builder reads
 * this too: the editor page replaces the Builder's title and tabs with its breadcrumb.
 */
export function phaseEditorOpen(facts: PhaseEditorOpenFacts): boolean {
  if (facts.catalogState !== 'ready') return false;
  const index = facts.selectedIndex;
  return index !== null && index >= 0 && index < facts.phaseCount;
}

/**
 * The id of the open Phase's error list, which each invalid field names with `aria-describedby`.
 * `undefined` while the Phase has no defects, so no field points at a list that is not drawn.
 */
export function phaseErrorId(phase: {
  readonly id: string;
  readonly sourceErrors: readonly unknown[];
}): string | undefined {
  return phase.sourceErrors.length > 0 ? `phase-errors-${phase.id}` : undefined;
}

/**
 * The line under the list: how many Phases it holds, or, while the search or the status filter
 * hides some, how many of them it keeps.
 */
export function phaseCountLine(shown: number, total: number): string {
  const noun = total === 1 ? 'phase' : 'phases';
  return shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`;
}
