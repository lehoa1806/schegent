// FR-R3-091 — the scan's route surface, derived rather than listed.
//
// The route ids come from `webview-ui/src/dashboard/routes.ts`, so a route added
// later is a COMPILE ERROR here rather than a silently unscanned surface. That is
// the same drift protection the visual suite gained when a route it never named
// went uncovered for a whole feature — and the reason a hand-kept list would be
// the wrong shape.
import type { DashboardRoute } from '../../webview-ui/src/dashboard/routes.js' with { 'resolution-mode': 'import' };

/** Every route, and the landmark that proves it mounted before the scan runs. */
export const ROUTE_MOUNT_TARGETS: Readonly<Record<DashboardRoute, string>> = {
  operations: 'queues-tier',
  runs: 'runs-surface',
  history: 'history-dashboard',
  metrics: 'metrics-section',
  system: 'system-tab',
  builder: 'pipeline-builder-root',
  settings: 'settings-surface-root'
};

/**
 * Routes excluded from the scan, each with its reason.
 *
 * Empty today, and the list is PRINTED on every run — including when it is
 * empty — because an undeclared limit gets read as full coverage.
 */
export const EXCLUDED_ROUTES: ReadonlyArray<{ readonly route: string; readonly reason: string }> = [];
