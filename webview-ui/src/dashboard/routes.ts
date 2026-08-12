// Feature 012 T031 / Feature 064 T014 — flat top-level dashboard route enum.
//
// The Dashboard surface exposes four sibling routes (was three under Feature
// 012). Feature 064 introduced `system` as a peer between `pipeline-builder`
// and `settings` to host the new System tab (audit entries tagged
// `scope === 'system'`). The legacy two-tier nav is gone — every route is a
// flat sibling.
//
// See specs/012-claude-autocompact-override/contracts/dashboard-navigation.md
// and specs/064-system-tab-audit-split/contracts/dashboard-navigation.md for
// the invariants this module pins.

export type DashboardRoute =
  | 'operations'
  | 'history'
  | 'metrics'
  | 'system'
  | 'pipeline-builder'
  | 'settings';

export const DASHBOARD_ROUTES: readonly DashboardRoute[] = [
  'operations',
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
    history: 'History',
    metrics: 'Metrics',
    system: 'System Log',
    'pipeline-builder': 'Process Library',
    settings: 'Settings'
  });
