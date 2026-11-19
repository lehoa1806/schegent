import { ALL_RUN_STATUSES, type WorkflowRun, type WorkflowRunStatus } from './workflow-run';
import type { RunUpdateLabel } from './run-update';

/**
 * FR-R7-01 — closed set of actor classes that may write or transition a WorkflowRun.
 *
 * Derived directly from all production `setRun` and `updateRun` callers:
 * - `'driver'`: Run execution driver, phase loop, retry handler, start-failure handler,
 *   liveness recorder, retry-decision sink, and spawn-identity recorder.
 * - `'operator'`: Explicit operator commands and controls (cancel, task deletion, leaf end,
 *   phase controls, manual retry override, queue pause/resume cascade, operator resume).
 * - `'watchdog'`: Autonomous background monitors and unattended wakeups (credit watchdog,
 *   spend-bound pause, unattended resume admission).
 * - `'recovery'`: Crash replay and load-time reconciliation (`TerminalTransitionCoordinator`,
 *   `orphaned-run-reconciler`).
 */
export type RunTransitionActor = 'driver' | 'operator' | 'watchdog' | 'recovery';

export const ALL_RUN_TRANSITION_ACTORS: readonly RunTransitionActor[] = [
  'driver',
  'operator',
  'watchdog',
  'recovery'
] as const;

/**
 * Closed refusal-reason vocabulary returned by `decideRunTransition` and carried
 * by `RunTransitionError`.
 */
export type RunTransitionRefusalReason =
  | 'terminal-status-immutable'
  | 'illegal-transition'
  | 'actor-not-permitted';

export type RunTransitionTable = Readonly<
  Record<WorkflowRunStatus, Readonly<Record<WorkflowRunStatus, readonly RunTransitionActor[]>>>
>;

/**
 * FR-R7-01 — single authoritative Run status transition table.
 *
 * Exhaustively typed over `WorkflowRunStatus` on both axes so adding a new status
 * fails `tsc --noEmit` until every `(from, to)` cell is defined. Same-status cells
 * (`from === to`) are explicitly modelled because most `updateRun` calls patch fields
 * without changing status.
 */
export const RUN_STATUS_TRANSITIONS: RunTransitionTable = {
  running: {
    running: ['driver', 'operator', 'watchdog'],
    paused: ['driver', 'operator'],
    failed: ['driver', 'recovery'],
    completed: ['driver', 'recovery'],
    canceled: ['driver', 'operator', 'recovery']
  },
  paused: {
    running: ['driver', 'operator', 'watchdog'],
    paused: ['driver', 'operator', 'watchdog'],
    failed: ['driver', 'recovery'],
    completed: ['driver', 'recovery'],
    canceled: ['driver', 'operator', 'recovery']
  },
  failed: {
    running: ['operator'],
    paused: [],
    failed: ['driver', 'operator', 'recovery'],
    completed: [],
    canceled: ['operator', 'recovery']
  },
  completed: {
    running: [],
    paused: [],
    failed: [],
    completed: ['driver', 'recovery'],
    canceled: []
  },
  canceled: {
    running: [],
    paused: [],
    failed: [],
    completed: [],
    canceled: ['driver', 'recovery']
  }
} as const;

/**
 * Exhaustive default actor mapping for every closed `RunUpdateLabel`.
 * Callers whose label serves multiple actor classes (e.g. `'resume-admission'` for
 * unattended `'watchdog'` wakeups vs explicit `'operator'` resumes) supply `update.actor`.
 */
export const DEFAULT_ACTOR_BY_RUN_UPDATE_LABEL: Readonly<
  Record<RunUpdateLabel, RunTransitionActor>
> = {
  pause: 'operator',
  resume: 'operator',
  restart: 'operator',
  skip: 'operator',
  disable: 'operator',
  enable: 'operator',
  'set-breakpoint': 'operator',
  'clear-breakpoint': 'operator',
  'remove-phase': 'operator',
  cancel: 'operator',
  'manual-retry-override': 'operator',
  'queue-pause': 'operator',
  'queue-resume': 'operator',
  'resume-prompt': 'operator',
  'resume-admission': 'operator',
  'driver-transition': 'driver',
  liveness: 'driver',
  'retry-decision': 'driver',
  'spawn-identity': 'driver',
  'spend-pause': 'watchdog',
  'credit-window': 'watchdog'
} as const;

export interface RunTransitionDecisionInput {
  readonly current: Pick<WorkflowRun, 'status'> | WorkflowRunStatus;
  readonly targetStatus: WorkflowRunStatus;
  readonly actor: RunTransitionActor;
}

export type RunTransitionDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly from: WorkflowRunStatus;
      readonly to: WorkflowRunStatus;
      readonly actor: RunTransitionActor;
      readonly reasonCode: RunTransitionRefusalReason;
    };

const ALLOWED: RunTransitionDecision = { allowed: true };

/**
 * Pure decision function for Run status transitions.
 *
 * Accepts either a Run (or `{ status }`) or a raw `WorkflowRunStatus`, the requested
 * target status, and the actor class. Returns `{ allowed: true }` or a typed refusal
 * carrying `from`, `to`, `actor`, and `reasonCode`.
 */
export function decideRunTransition(input: RunTransitionDecisionInput): RunTransitionDecision {
  const from: WorkflowRunStatus =
    typeof input.current === 'string' ? input.current : input.current.status;
  const to = input.targetStatus;
  const actor = input.actor;

  const permittedActors = RUN_STATUS_TRANSITIONS[from][to];
  if (permittedActors.includes(actor)) {
    return ALLOWED;
  }

  let reasonCode: RunTransitionRefusalReason;
  if ((from === 'completed' || from === 'canceled') && to !== from) {
    reasonCode = 'terminal-status-immutable';
  } else if (permittedActors.length === 0) {
    reasonCode = 'illegal-transition';
  } else {
    reasonCode = 'actor-not-permitted';
  }

  return {
    allowed: false,
    from,
    to,
    actor,
    reasonCode
  };
}

/**
 * Derive every source status from which `actor` may transition into `target`.
 */
export function allowedSourceStatusesFor(
  target: WorkflowRunStatus,
  actor: RunTransitionActor
): readonly WorkflowRunStatus[] {
  return ALL_RUN_STATUSES.filter((from) => RUN_STATUS_TRANSITIONS[from][target].includes(actor));
}

/**
 * Derive every source status from which `actor` may transition into at least one
 * status in `targets`.
 */
export function allowedSourceStatusesForTargets(
  targets: readonly WorkflowRunStatus[],
  actor: RunTransitionActor
): readonly WorkflowRunStatus[] {
  return ALL_RUN_STATUSES.filter((from) =>
    targets.some((target) => RUN_STATUS_TRANSITIONS[from][target].includes(actor))
  );
}

/**
 * Derive every status on which `actor` may perform a same-status field update.
 */
export function allowedSameStatusFor(actor: RunTransitionActor): readonly WorkflowRunStatus[] {
  return ALL_RUN_STATUSES.filter((status) =>
    RUN_STATUS_TRANSITIONS[status][status].includes(actor)
  );
}
