// Feature 092 (T107, T108, FR-055) — the operator-facing name of a queue's
// lifecycle, for the drill-down tiers.
//
// One module rather than a `switch` inside each tier: tiers 1, 2 and 3 all badge
// the same queue, and three copies of the mapping is three places a new lifecycle
// value can be forgotten. Exhaustive over `QueueLifecycle`, so adding a member to
// the union fails the build here instead of rendering a blank badge.
//
// Feature 097 removes the sidebar's `QueueListView.svelte`, which is the
// surface this module was deliberately NOT shared with (it kept its own
// shorter strings for a header row bound by width in a way these cards are
// not). This module is now the drill-down's only lifecycle-label surface.
//
// This file is on the `no-running-state-literal` allowlist for the same reason
// every lifecycle module feature 065 added is: `'running'` here is the
// `QueueLifecycle` discriminator, not the pinned per-task status projection.

import type { QueueLifecycle } from './snapshot-types';

const LABELS: Readonly<Record<QueueLifecycle, string>> = Object.freeze({
  running: 'Running',
  'operator-paused': 'Paused',
  'idle-pending': 'Idle (pending)',
  'active-empty': 'Active (empty)'
});

export function queueLifecycleLabel(lifecycle: QueueLifecycle): string {
  return LABELS[lifecycle];
}
