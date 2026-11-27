// Feature 101 (US1, T035, FR-010) — the row's derived view.
//
// Everything here is presentation, and the list of what it deliberately does not
// derive is as much the point as the list of what it does (data-model.md §6):
//
//   the state badge's label     from `state`             — not the state itself
//   Created / Modified strings  from `createdAt`/`updatedAt` — no comparison, no ordering
//   the active-version cell     from `activeVersionId` presence — not which version is active
//   which actions to offer      from `state`             — not whether one would succeed
//   Restore on a history entry  from `state`, `versions` — never a guess at the draft's entry
//
// Formatting epoch milliseconds is not state computation: it is the display
// concern the store deliberately refused, and no string this module produces is
// ever sent back over IPC. Nothing here imports the transport, which is the
// enforceable form of that.

import type { BuilderLifecycle, DefinitionState } from '../../lib/snapshot-types';
import { formatAbsoluteTime } from '../../lib/format';

/**
 * What a cell shows when the value behind it is absent (FR-014) or unusable.
 *
 * One character for two jobs, because both read the same way to an operator:
 * "there is nothing here". The alternative — a sentinel like `'none'`, or worse
 * the stringified `undefined` — reads as content.
 */
export const EM_DASH = '—';

/**
 * The three lifecycle actions offered inside the Summary / Inspector panel and
 * version history (`publish`, `discard-draft`, `restore`). `Deactivate…` lives
 * exclusively in the editor header `⋯` menu and list row `⋯` menus (Feature 326).
 */
export type DefinitionRowAction = 'publish' | 'discard-draft' | 'restore';

/**
 * Validity as the host projects it.
 *
 * `PhaseSourceStatus`, `PipelineSourceStatus`, and `WorkflowSourceStatus` are
 * the same closed pair. One row component serves all three kinds, so it names
 * the set once rather than picking one kind's alias and implying the other two
 * follow it.
 */
export type DefinitionValidity = 'effective' | 'invalid';

/** One projected defect, in the shape all three catalogs report (FR-015). */
export interface DefinitionDefect {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface DefinitionRowView {
  readonly stateBadge: string;
  readonly createdDisplay: string;
  readonly modifiedDisplay: string;
  readonly activeVersionCell: string;
  readonly actions: readonly DefinitionRowAction[];
}

const STATE_BADGE_LABELS: Readonly<Record<DefinitionState, string>> = Object.freeze({
  draft: 'Draft',
  active: 'Active',
  'active-with-draft': 'Active with draft'
});

/**
 * Each state's status colour, as the sg-core tone class its chip takes: a draft
 * is work in progress, a published definition is done, and a published one with
 * unpublished changes on top asks for attention.
 *
 * Shared, because two surfaces draw the state chip: every list row
 * (`DefinitionLifecycleRow`) and the Workflow editor's head, which cannot mount
 * the row component while the Library list beside it renders the same ids.
 */
export const STATE_TONE_CLASSES: Readonly<Record<DefinitionState, string>> = Object.freeze({
  draft: 's-draft',
  active: 's-ok',
  'active-with-draft': 's-warn'
});

/**
 * The offer matrix from quickstart.md §3, as a table rather than a chain of
 * conditions: a table has one row per state, so a state added to the union
 * without an offer decided for it fails to type-check instead of falling
 * through to a default that silently offers nothing.
 */
const STATE_ACTIONS: Readonly<Record<DefinitionState, readonly DefinitionRowAction[]>> =
  Object.freeze({
    draft: Object.freeze<DefinitionRowAction[]>(['publish', 'discard-draft']),
    active: Object.freeze<DefinitionRowAction[]>([]),
    'active-with-draft': Object.freeze<DefinitionRowAction[]>([
      'publish',
      'discard-draft'
    ])
  });

/**
 * The largest instant `Date` represents. Beyond it `toISOString` throws.
 *
 * Wider than it looks like it needs to be, because the value arriving here has
 * already passed the manifest's `isEpochMs` — a *safe integer* test, whose
 * ceiling is `Number.MAX_SAFE_INTEGER`, about 367,000 years past this one. Every
 * instant in that gap parses out of a manifest and then throws when rendered.
 */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

/**
 * One epoch-millisecond instant as an absolute local time.
 *
 * `formatAbsoluteTime` is the webview's one absolute-time formatter and takes an
 * ISO string, so the epoch is widened to one here rather than a second formatter
 * being grown beside it. A non-finite instant is a broken projection; it renders
 * as absent, because a cell reading "NaN" is machinery leaking into the surface.
 *
 * An out-of-range instant renders as absent for the same reason and one sharper
 * one: `new Date(9e15).toISOString()` throws a `RangeError`, and this runs inside
 * the row's derivation, so the throw takes down the whole tab rather than the one
 * cell it belongs to. A hand-edited manifest is the reachable case — the store's
 * own reader validates ids against traversal on exactly that ground.
 */
export function formatDefinitionTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs) || Math.abs(epochMs) > MAX_EPOCH_MS) return EM_DASH;
  return formatAbsoluteTime(new Date(epochMs).toISOString());
}

const RESTORE_ONLY: readonly DefinitionRowAction[] = Object.freeze<DefinitionRowAction[]>([
  'restore'
]);
const NO_ACTIONS: readonly DefinitionRowAction[] = Object.freeze<DefinitionRowAction[]>([]);

/**
 * What one history entry offers: Restore this version (FR-019), except on an
 * entry that has nothing to bring back.
 *
 * That entry is a Draft's only one. A Draft always holds a draft pointer, and
 * the pointer always names a retained version, so with one retained the entry is
 * the draft itself, and restoring it copies the draft onto itself. Every other
 * entry offers Restore, a never-published one included: an earlier draft, or one
 * a restore replaced, stays in history to be brought back (feature 100, FR-029b).
 *
 * Past that one case the surface cannot tell which entry the draft holds, and
 * does not guess. The raw pointer is not projected, and the newest entry is not
 * always the draft: deactivation aims the pointer at the version that was active
 * without writing an entry (feature 100, FR-024a).
 */
export function historyEntryActions(
  lifecycle: BuilderLifecycle,
  versionId: string | undefined
): readonly DefinitionRowAction[] {
  if (!versionId) return NO_ACTIONS;
  const { state, versions } = lifecycle;
  const isTheDraft =
    state === 'draft' && versions.length === 1 && versions[0].versionId === versionId;
  return isTheDraft ? NO_ACTIONS : RESTORE_ONLY;
}

export function deriveDefinitionRowView(lifecycle: BuilderLifecycle): DefinitionRowView {
  return {
    stateBadge: STATE_BADGE_LABELS[lifecycle.state],
    createdDisplay: formatDefinitionTimestamp(lifecycle.createdAt),
    modifiedDisplay: formatDefinitionTimestamp(lifecycle.updatedAt),
    // Presence, not identity. The empty string is not a version id, and a host
    // that sent one instead of omitting the field (FR-006) must still not have
    // it rendered as though something were published.
    activeVersionCell: lifecycle.activeVersionId ? lifecycle.activeVersionId : EM_DASH,
    actions: STATE_ACTIONS[lifecycle.state]
  };
}
