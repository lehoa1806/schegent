// Feature 012 T031 / Feature 064 T014 / Feature 091 T019 — flat top-level
// dashboard route enum.
//
// The Dashboard surface exposes seven sibling routes (was three under Feature
// 012). Feature 064 introduced `system` as a peer between the Builder route
// and `settings` to host the new System tab (audit entries tagged
// `scope === 'system'`). Feature 091 added `runs` directly after `operations`
// to mount the connected-run view and the Run composer, which shipped with no
// entry point able to reach them (FR-018). The legacy two-tier nav is gone —
// every route is a flat sibling.
//
// Feature 101 (US8, T072, FR-035/FR-036) — `pipeline-builder` became `builder`,
// labelled "Builder". The route is not persisted anywhere: `App.svelte` holds it
// in component state and every session opens on `operations`, so the rename
// needs no migration. The stylesheet `pipeline-builder.css` and the
// `pipeline-builder-root` test id keep their names on purpose (T073) — neither
// is a route id nor a navigation target.
//
// `DEFAULT_DASHBOARD_ROUTE` stays `operations` through every such addition: a
// new surface earns its place in the nav, not on someone's landing page.
//
// See specs/012-claude-autocompact-override/contracts/dashboard-navigation.md
// and specs/064-system-tab-audit-split/contracts/dashboard-navigation.md for
// the invariants this module pins.

export type DashboardRoute =
  | 'operations'
  | 'runs'
  | 'history'
  | 'metrics'
  | 'system'
  | 'builder'
  | 'settings';

export const DASHBOARD_ROUTES: readonly DashboardRoute[] = [
  'operations',
  'runs',
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
    runs: 'Runs',
    history: 'History',
    metrics: 'Metrics',
    system: 'System Log',
    builder: 'Builder',
    settings: 'Settings'
  });

// Feature 092 (T106, US5 — FR-061, plan.md D8) — the drill-down's three tiers.
//
// Deliberately *not* three more `DashboardRoute` members. Tiers 2 and 3 are
// sub-locations beneath `operations`, which is already labelled 'Queues' and is
// therefore already tier 1; promoting them to nav siblings would put a
// single-queue view and a single-run view next to Settings, and would contradict
// what this module says about itself two paragraphs up. `DashboardRoute`,
// `DASHBOARD_ROUTES` and `DEFAULT_DASHBOARD_ROUTE` are unchanged by this
// feature.
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

export function runDetailLocation(queueId: string, runId: string): RunDetailLocation {
  return Object.freeze({ route: 'run-detail', queueId, runId } as const);
}

/**
 * The tier a back-navigation lands on (FR-060). Tier 1 is the root and is its
 * own parent, so a caller can apply this without first checking whether there is
 * anywhere left to go.
 */
export function parentLocation(location: DashboardLocation): DashboardLocation {
  switch (location.route) {
    case 'run-detail':
      return queueDetailLocation(location.queueId);
    case 'queue-detail':
      return DEFAULT_DASHBOARD_LOCATION;
    case 'queues':
      return DEFAULT_DASHBOARD_LOCATION;
  }
}
