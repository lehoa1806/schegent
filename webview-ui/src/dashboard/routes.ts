// Feature 012 T031 — flat top-level dashboard route enum.
//
// The Dashboard surface exposes exactly three sibling routes. The legacy
// two-tier nav (a parent "Operations" route containing inner "Operations |
// Pipeline Builder" sub-tabs) is gone — `pipeline-builder` is now a peer.
//
// See specs/012-claude-autocompact-override/contracts/dashboard-navigation.md
// for the invariants this module pins.

export type DashboardRoute = 'operations' | 'pipeline-builder' | 'settings';

export const DASHBOARD_ROUTES: readonly DashboardRoute[] = [
  'operations',
  'pipeline-builder',
  'settings'
] as const;

export const DEFAULT_DASHBOARD_ROUTE: DashboardRoute = 'operations';

export const DASHBOARD_ROUTE_LABELS: Readonly<Record<DashboardRoute, string>> =
  Object.freeze({
    operations: 'Operations',
    'pipeline-builder': 'Pipeline Builder',
    settings: 'Settings'
  });
