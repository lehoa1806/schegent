// Queue task composition lives under operations; route state is local and needs no migration.

export type DashboardRoute =
  | 'operations'
  | 'history'
  | 'metrics'
  | 'system'
  | 'builder'
  | 'settings';

export const DASHBOARD_ROUTES: readonly DashboardRoute[] = [
  'operations',
  'history',
  'metrics',
  'system',
  'builder',
  'settings'
] as const;

export const DEFAULT_DASHBOARD_ROUTE: DashboardRoute = 'operations';

export const DASHBOARD_ROUTE_LABELS: Readonly<Record<DashboardRoute, string>> =
  Object.freeze({
    operations: 'Queues',
    history: 'History',
    metrics: 'Metrics',
    system: 'System Log',
    builder: 'Builder',
    settings: 'Settings'
  });

// Feature 092 (T106, US5 — FR-061, plan.md D8) — the drill-down's three tiers.
//
// Queue and execution detail are sub-locations beneath operations, not navigation peers.
// Task composition belongs to Queue detail.
//
// A location carries **exactly** the ids its tier displays and nothing else, so
// a destination is fully described by where it points. Tier 3 keeps the
// `queueId` alongside the `runId`: a Run is addressed *within* its queue, which
// makes back-navigation a field read rather than a lookup that can fail.

export interface QueuesLocation {
  readonly route: 'queues';
}

export interface QueueDetailLocation {
  readonly route: 'queue-detail';
  readonly queueId: string;
}

export interface RunDetailLocation {
  readonly route: 'run-detail';
  readonly queueId: string;
  readonly runId: string;
  /**
   * Feature 265 BUG-001 (FR-009): the Workflow run a member Task was opened
   * from. Present only on that route, so Back returns to the run's topology;
   * a Task opened from Queue Detail carries no such key.
   */
  readonly parentRunId?: string;
}

export type DashboardLocation = QueuesLocation | QueueDetailLocation | RunDetailLocation;

export const DEFAULT_DASHBOARD_LOCATION: QueuesLocation = Object.freeze({
  route: 'queues'
} as const);

// Each constructor returns its own member, not the union: a caller that just
// built a tier-3 destination should be able to read its `runId` without first
// narrowing a union it already knows the shape of.

export function queueDetailLocation(queueId: string): QueueDetailLocation {
  return Object.freeze({ route: 'queue-detail', queueId } as const);
}

export function runDetailLocation(queueId: string, runId: string, parentRunId?: string): RunDetailLocation {
  if (parentRunId === undefined) return Object.freeze({ route: 'run-detail', queueId, runId } as const);
  return Object.freeze({ route: 'run-detail', queueId, runId, parentRunId } as const);
}

/**
 * The tier a back-navigation lands on (FR-060). Tier 1 is the root and is its
 * own parent, so a caller can apply this without first checking whether there is
 * anywhere left to go.
 */
export function parentLocation(location: DashboardLocation): DashboardLocation {
  switch (location.route) {
    case 'run-detail':
      return location.parentRunId === undefined
        ? queueDetailLocation(location.queueId)
        : runDetailLocation(location.queueId, location.parentRunId);
    case 'queue-detail':
      return DEFAULT_DASHBOARD_LOCATION;
    case 'queues':
      return DEFAULT_DASHBOARD_LOCATION;
  }
}
