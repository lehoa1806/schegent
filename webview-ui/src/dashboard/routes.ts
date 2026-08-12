// Feature 012 T031 / Feature 064 T014 / Feature 091 T019 — flat top-level
// dashboard route enum.
//
// The Dashboard surface exposes seven sibling routes (was three under Feature
// 012). Feature 064 introduced `system` as a peer between `pipeline-builder`
// and `settings` to host the new System tab (audit entries tagged
// `scope === 'system'`). Feature 091 added `runs` directly after `operations`
// to mount the connected-run view and the Run composer, which shipped with no
// entry point able to reach them (FR-018). The legacy two-tier nav is gone —
// every route is a flat sibling.
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
  | 'pipeline-builder'
  | 'settings';

export const DASHBOARD_ROUTES: readonly DashboardRoute[] = [
  'operations',
  'runs',
  'history',
  'metrics',
  'system',
  'pipeline-builder',
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
    'pipeline-builder': 'Process Library',
    settings: 'Settings'
  });
