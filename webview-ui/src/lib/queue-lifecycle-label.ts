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

import { isWorkingARun } from './queue-runtime-view';
import type { QueueLifecycle, QueueRuntime } from './snapshot-types';

const LABELS: Readonly<Record<QueueLifecycle, string>> = Object.freeze({
  running: 'Running',
  'operator-paused': 'Paused',
  'idle-pending': 'Idle (pending)',
  'active-empty': 'Active (empty)'
});

export function queueLifecycleLabel(lifecycle: QueueLifecycle): string {
  return LABELS[lifecycle];
}

/**
 * What an unheld queue with work but no Run is called. Deliberately parallel to
 * `Active (empty)` above — same first word, because both are unheld and neither
 * needs the operator's permission to proceed; different parenthetical, because
 * one has nothing to do and the other has work and is waiting for a drain. And
 * deliberately NOT `Idle (…)`, which is the held vocabulary: an operator reading
 * `Idle` should reach for the start affordance, and an operator reading `Active`
 * should not have to.
 */
const UNHELD_WAITING = 'Active (waiting)';

/**
 * Bug "there is no way to start a pending task" (2026-09-02), first finding — the
 * label a badge over a live queue should read.
 *
 * `queueLifecycleLabel` above names the LIFECYCLE, which is a statement about
 * whether the drain is allowed to visit this queue, not about whether it is
 * doing anything. The two coincide often enough that every badge read the
 * lifecycle and nobody noticed they had asked the wrong question — until a queue
 * sat at `'running'` with twenty-one rows pending and nothing executing, and the
 * dashboard said `Running` at it.
 *
 * It gets there legitimately. The host writes `'running'` when the operator
 * starts a queue, as a promise that a start will be attempted, and the attempt is
 * the caller's next statement; a drain that declines — at the workspace
 * concurrency ceiling, on an execution lease another window took, on an admission
 * that threw — writes nothing back, because the promise is still true. The queue
 * remains one the drain may visit. It just is not being visited right now.
 *
 * So the badge asks both questions and says which it means. `isWorkingARun` is
 * the liveness half, already spelled once in `queue-runtime-view.ts` for the
 * affordances that had the same conflation: a Run's presence is its record, and
 * the record outlives the Run.
 *
 * Only the unheld-with-work member is refined. A held queue is held whether or
 * not something executes on it — `operator-paused` with a Run mid-phase is a
 * queue whose current Run finishes and whose successors wait — so `Paused` and
 * `Idle (pending)` are already the whole truth and are passed through unchanged.
 */
export function queueRuntimeLabel(runtime: QueueRuntime): string {
  if (runtime.lifecycle === 'running' && !isWorkingARun(runtime)) return UNHELD_WAITING;
  return queueLifecycleLabel(runtime.lifecycle);
}
