// Feature 105 (T588h) — the route loading policy, extracted from `App.svelte`.
//
// It moved because the Feature 078 budget said so: the boundary, the loader, and
// the error presentation took `App.svelte` from 404 physical lines to 570 against
// a 500-line cap. The cap is what it is for, and the two responsibilities it
// separated here were genuinely separate — the shell owns chrome, the nav, and
// which route is current; this module owns how a route's module is fetched and
// cached; `RouteOutlet.svelte` owns what is rendered while that happens and when
// it fails.
//
// The cache is created per loader rather than held at module scope. A module-level
// Map would be equivalent in production, where exactly one dashboard is mounted,
// and would quietly couple tests: a later test would find a route another test had
// already resolved, and every gated-load assertion depends on the gate still being
// closed when its own test reaches it.

import type { Component } from 'svelte';

import type { WorkflowSnapshot } from '../lib/snapshot-types';

import { DASHBOARD_ROUTE_LABELS, type DashboardRoute } from './routes';

/** Every route except `operations`, which the shell renders eagerly. */
export type LazyRoute = Exclude<DashboardRoute, 'operations'>;

// Feature 103 (T017) dropped `history` and `isPrimary` from here: the History
// route was their only consumer and it now takes the whole snapshot like the
// other multi-field routes.
export type LazyRouteProps = {
  active?: boolean;
  snapshot?: WorkflowSnapshot;
};

export type LazyRouteComponent = Component<LazyRouteProps>;

export type RouteLoader = {
  /** Resolve this route's component, from cache when one is already in flight. */
  load(next: LazyRoute): Promise<LazyRouteComponent>;
  /** Warm the cache for a route the operator is only pointing at. */
  preload(next: DashboardRoute): void;
  /** Drop a cache entry. The only removal path — see `createRouteLoader`. */
  evict(next: LazyRoute): void;
};

const routeLoaders: Record<LazyRoute, () => Promise<unknown>> = {
  // Feature 091 T020 (FR-014, FR-017, FR-022) — the mount for the connected-run
  // view and the Run composer. Loaded on demand like every other non-default
  // route, which also makes the reachability walker's dynamic-import support
  // exercised by production code rather than only by a fixture.
  runs: () => import('../components/RunsSurface.svelte'),
  history: () => import('../components/HistoryDashboard.svelte'),
  metrics: () => import('../components/MetricsDashboard/MetricsDashboard.svelte'),
  system: () => import('../components/SystemTab.svelte'),
  builder: () => import('../components/PipelineBuilder.svelte'),
  settings: () => import('../components/SettingsSurface.svelte')
};

export function isLazyRoute(next: DashboardRoute): next is LazyRoute {
  return next !== 'operations';
}

export function routeErrorMessage(next: DashboardRoute): string {
  return `Could not load ${DASHBOARD_ROUTE_LABELS[next]}.`;
}

/**
 * Feature 105 (T581, FR-006) — a loader whose cache heals itself.
 *
 * Before this, `preloadRoute` and `navigate` each deleted on their own failure
 * path, which is how a preload that failed could leave `navigate` with nothing to
 * invalidate and vice versa. `load` now evicts its own rejection, so every caller
 * inherits a self-healing cache without doing anything. `evict` is exported for
 * the one case the loader cannot see: a load that has neither resolved nor
 * rejected by the outlet's deadline, where the underlying promise is still
 * pending and may yet resolve into a cache entry nothing is waiting on.
 */
export function createRouteLoader(): RouteLoader {
  const routeCache = new Map<LazyRoute, Promise<LazyRouteComponent>>();

  function evict(next: LazyRoute): void {
    routeCache.delete(next);
  }

  function load(next: LazyRoute): Promise<LazyRouteComponent> {
    const cached = routeCache.get(next);
    if (cached) return cached;
    const pending = routeLoaders[next]()
      .then((module) => {
        const loaded = module as { default: LazyRouteComponent };
        return loaded.default;
      })
      .catch((cause: unknown) => {
        evict(next);
        throw cause;
      });
    routeCache.set(next, pending);
    return pending;
  }

  function preload(next: DashboardRoute): void {
    if (!isLazyRoute(next)) return;
    // The rejection is already handled by `load`'s eviction; this `catch` exists
    // so a hover over a broken route is not an unhandled rejection. A preload has
    // no surface to report to — the navigation that follows does.
    void load(next).catch(() => {});
  }

  return { load, preload, evict };
}
