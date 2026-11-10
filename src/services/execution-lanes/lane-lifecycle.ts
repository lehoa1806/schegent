/**
 * FR-R6-F10 (contract §5; data-model, lane lifecycle): the operator's lane transitions.
 *
 *   active -> paused (pause); paused -> active (resume);
 *   active | paused -> completed (complete), refused `lane-busy` while a request of the lane is
 *     `verifying` or `landing`, or a Git-mutating operation on it is in flight in this host;
 *   completed -> retained (release `retain`);
 *   completed | retained | preparation-failed -> cleanup-eligible (release `eligible`).
 * Every other transition refuses `lane-state-invalid`. Pinning changes no state. Each operation is
 * one fenced write, so a superseded host refuses `ownership-superseded` with nothing written.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { laneRefused, type LaneResult, type LaneState } from '../../contracts/execution-lanes';
import { LANE_BUSY_STATES } from './candidate-freezer';
import type { IntegrationStore } from './integration-store';
import type { LaneStore } from './lane-store';
import type { LaneRecord } from './lane-store-rows';

export type ReleaseDisposition = 'retain' | 'eligible';

export interface LifecycleContext {
  readonly lanes: LaneStore;
  readonly integrations: IntegrationStore;
  readonly workspaceId: string;
  readonly generation: number;
  readonly now: () => string;
  /** Whether this host holds a Git-mutating operation on the lane. */
  readonly inFlight: (laneId: string) => boolean;
}

interface Move {
  readonly from: readonly LaneState[];
  readonly to: LaneState;
}

const PAUSE: Move = { from: ['active'], to: 'paused' };
const RESUME: Move = { from: ['paused'], to: 'active' };
const COMPLETE: Move = { from: ['active', 'paused'], to: 'completed' };
const RELEASE: Readonly<Record<ReleaseDisposition, Move>> = {
  retain: { from: ['completed'], to: 'retained' },
  eligible: { from: ['completed', 'retained', 'preparation-failed'], to: 'cleanup-eligible' }
};

/** One fenced transition; `busy` is asked only of a lane already in a `from` state. */
function move(ctx: LifecycleContext, laneId: string, step: Move, busy: () => boolean = () => false): LaneResult<LaneRecord> {
  return ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => {
    const lane = ctx.lanes.getLane(ctx.workspaceId, laneId);
    if (lane === null) return laneRefused<LaneRecord>('lane-not-found');
    if (!step.from.includes(lane.state)) return laneRefused<LaneRecord>('lane-state-invalid');
    if (busy()) return laneRefused<LaneRecord>('lane-busy');
    return ctx.lanes.transitionLane(ctx.workspaceId, laneId, step.from, step.to, {
      reason: null,
      now: ctx.now(),
      generation: ctx.generation
    });
  });
}

/** Refuses `lane-busy` while this host freezes or cleans the lane, so no candidate lands on a paused lane (review R9). */
export function pauseLane(ctx: LifecycleContext, laneId: string): LaneResult<LaneRecord> {
  return move(ctx, laneId, PAUSE, () => ctx.inFlight(laneId));
}

export function resumeLane(ctx: LifecycleContext, laneId: string): LaneResult<LaneRecord> {
  return move(ctx, laneId, RESUME);
}

export function completeLane(ctx: LifecycleContext, laneId: string): LaneResult<LaneRecord> {
  return move(ctx, laneId, COMPLETE, () => ctx.inFlight(laneId) || ctx.integrations.countLaneRequests(laneId, LANE_BUSY_STATES) > 0);
}

export function releaseLane(ctx: LifecycleContext, laneId: string, disposition: ReleaseDisposition): LaneResult<LaneRecord> {
  return move(ctx, laneId, RELEASE[disposition]);
}

/** Changes no state; a `removed` lane may be pinned too, which only its records show. */
export function setLanePinned(ctx: LifecycleContext, laneId: string, pinned: boolean): LaneResult<LaneRecord> {
  return ctx.lanes.fenced(ctx.workspaceId, ctx.generation, () => ctx.lanes.setPinned(ctx.workspaceId, laneId, pinned, ctx.now()));
}
