<script lang="ts">
  import type { Component } from 'svelte';
  // Feature 092 (T112, FR-061) — the `operations` route now mounts the
  // drill-down's location owner rather than `Dashboard` directly. Feature 097
  // retires the `Dashboard` embed tier 2 used to reuse for its chrome — see
  // `QueueDetailTier.svelte`'s own header — so this route no longer touches
  // `Dashboard` at any depth.
  import OperationsSurface from '../components/OperationsSurface.svelte';
  import type { WorkflowSnapshot } from '../lib/snapshot-types';
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import {
    DASHBOARD_ROUTES,
    DASHBOARD_ROUTE_LABELS,
    DEFAULT_DASHBOARD_ROUTE,
    type DashboardRoute
  } from './routes';

  const ready = $derived(snapshotStore.isReady);
  const snapshot = $derived(snapshotStore.snapshot);

  // Feature 012 — flat three-route top-level nav. Replaces the legacy
  // `'operations' | 'settings'` shape; the inner two-tier `Operations |
  // Pipeline Builder` pair under `Dashboard.svelte` is gone (T033).
  let route = $state<DashboardRoute>(DEFAULT_DASHBOARD_ROUTE);
  type LazyRoute = Exclude<DashboardRoute, 'operations'>;
  // Feature 103 (T017) dropped `history` and `isPrimary` from here: the History
  // route was their only consumer and it now takes the whole snapshot like the
  // other multi-field routes.
  type LazyRouteProps = {
    active?: boolean;
    snapshot?: WorkflowSnapshot;
  };
  type LazyRouteComponent = Component<LazyRouteProps>;

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
  const routeCache = new Map<LazyRoute, Promise<LazyRouteComponent>>();
  let ActiveRouteComponent = $state<LazyRouteComponent | null>(null);
  let routeLoadError = $state<string | null>(null);

  function isLazyRoute(next: DashboardRoute): next is LazyRoute {
    return next !== 'operations';
  }

  function loadRoute(next: LazyRoute): Promise<LazyRouteComponent> {
    const cached = routeCache.get(next);
    if (cached) return cached;
    const pending = routeLoaders[next]().then((module) => {
      const loaded = module as { default: LazyRouteComponent };
      return loaded.default;
    });
    routeCache.set(next, pending);
    return pending;
  }

  function preloadRoute(next: DashboardRoute): void {
    if (!isLazyRoute(next)) return;
    void loadRoute(next).catch(() => {
      routeCache.delete(next);
    });
  }

  function navigate(next: DashboardRoute): void {
    route = next;
    routeLoadError = null;
    ActiveRouteComponent = null;
    if (!isLazyRoute(next)) return;
    void loadRoute(next)
      .then((component) => {
        if (route === next) ActiveRouteComponent = component;
      })
      .catch(() => {
        routeCache.delete(next);
        if (route === next) routeLoadError = `Could not load ${DASHBOARD_ROUTE_LABELS[next]}.`;
      });
  }
</script>

<div class="dashboard-root" data-testid="dashboard-app-root">
  {#if ready && snapshot}
    <a class="skip-link" href="#dashboard-content">Skip to dashboard content</a>
    <header class="dashboard-topbar">
      <div class="brand-lockup" aria-label="Schegent dashboard">
        <span class="brand-mark" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
            <path d="m12 3 8 4-8 4-8-4 8-4Z"></path>
            <path d="m4 11 8 4 8-4"></path>
            <path d="m4 15 8 4 8-4"></path>
          </svg>
        </span>
        <span class="brand-name">Schegent</span>
      </div>
      <nav class="dashboard-nav" aria-label="Primary">
        {#each DASHBOARD_ROUTES as r (r)}
          <button
            type="button"
            class="nav-btn {route === r ? 'active' : ''}"
            aria-current={route === r ? 'page' : undefined}
            data-testid="dashboard-route-{r}"
            title={DASHBOARD_ROUTE_LABELS[r]}
            onpointerenter={() => preloadRoute(r)}
            onfocus={() => preloadRoute(r)}
            onclick={() => navigate(r)}
          >
            <svg class="nav-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              {#if r === 'operations'}
                <path d="m12 3 8 4-8 4-8-4 8-4Z"></path><path d="m4 11 8 4 8-4"></path><path d="m4 15 8 4 8-4"></path>
              {:else if r === 'runs'}
                <path d="M5 3v18"></path><path d="M19 3v18"></path><path d="M5 8h14"></path><path d="M5 16h14"></path>
              {:else if r === 'history'}
                <path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 4v5h5"></path><path d="M12 7v5l3 2"></path>
              {:else if r === 'metrics'}
                <path d="M4 19V9"></path><path d="M10 19V5"></path><path d="M16 19v-7"></path><path d="M22 19V3"></path>
              {:else if r === 'system'}
                <path d="m4 6 5 5-5 5"></path><path d="M11 18h9"></path>
              {:else if r === 'builder'}
                <circle cx="5" cy="6" r="2"></circle><circle cx="19" cy="6" r="2"></circle><circle cx="12" cy="18" r="2"></circle><path d="M7 6h10"></path><path d="m6.5 8 4.5 8"></path><path d="m17.5 8-4.5 8"></path>
              {:else}
                <circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"></path>
              {/if}
            </svg>
            <span class="nav-label">{DASHBOARD_ROUTE_LABELS[r]}</span>
          </button>
        {/each}
      </nav>
      <div class:read-only={!snapshot.isPrimary} class="workspace-state" aria-live="polite">
        <span class="workspace-dot" aria-hidden="true"></span>
        <span>{snapshot.isPrimary ? 'Workspace Connected' : 'Read-only Window'}</span>
      </div>
    </header>
    <div id="dashboard-content" class="dashboard-route" data-testid="dashboard-route">
      {#if route === 'operations'}
        <OperationsSurface {snapshot} />
      {:else if ActiveRouteComponent}
        {#if route === 'metrics'}
          <ActiveRouteComponent active={true} />
        {:else if route === 'builder' || route === 'settings' || route === 'runs' || route === 'history'}
          <!-- Feature 103 (T017) — History moved from `history` + `isPrimary`
               to the whole snapshot. It composes its list from `history` and
               `queues` together, and a route that hand-picks fields has to be
               edited every time the surface reads one more. -->
          <ActiveRouteComponent {snapshot} />
        {:else}
          <ActiveRouteComponent />
        {/if}
      {:else if routeLoadError}
        <main class="route-status" data-testid="dashboard-route-error" role="alert">
          <strong>{routeLoadError}</strong>
          <button type="button" onclick={() => navigate(route)}>Retry</button>
        </main>
      {:else}
        <main class="route-status" data-testid="dashboard-route-loading" aria-busy="true">
          <span>Loading {DASHBOARD_ROUTE_LABELS[route]}…</span>
        </main>
      {/if}
    </div>
  {:else}
    <main class="dashboard-loading" data-testid="dashboard-empty-state" role="status">
      <div class="loading-copy">
        <strong>Connecting to workspace</strong>
        <span>Waiting for the first Schegent state snapshot.</span>
      </div>
      <div class="loading-skeleton" aria-hidden="true">
        <span></span><span></span><span></span>
      </div>
    </main>
  {/if}
</div>

<style>
  .dashboard-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    color: var(--schegent-fg);
    background: var(--schegent-bg);
  }
  .skip-link {
    position: fixed;
    top: 8px;
    left: 8px;
    z-index: var(--schegent-z-tooltip);
    padding: 7px 10px;
    border: 1px solid var(--schegent-focus-border);
    border-radius: var(--schegent-radius-sm);
    background: var(--schegent-surface-raised);
    color: var(--schegent-fg);
    transform: translateY(-150%);
    transition: transform var(--schegent-duration-fast) var(--schegent-ease-out);
  }
  .skip-link:focus {
    transform: translateY(0);
  }
  .route-status {
    display: grid;
    flex: 1;
    min-height: 160px;
    place-content: center;
    justify-items: center;
    gap: 12px;
    padding: 24px;
    color: var(--schegent-muted-fg);
    text-align: center;
  }
  .route-status button {
    min-height: 32px;
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    background: var(--schegent-button-bg);
    color: var(--schegent-button-fg);
    padding: 0 12px;
    cursor: pointer;
  }
  .dashboard-topbar {
    position: relative;
    z-index: var(--schegent-z-sticky);
    display: flex;
    min-height: 52px;
    align-items: stretch;
    gap: 0;
    padding: 0 16px 0 0;
    border-bottom: 1px solid var(--schegent-border);
    background: var(--schegent-shell-bg);
  }
  .brand-lockup {
    display: flex;
    align-items: center;
    width: 190px;
    gap: 9px;
    flex: 0 0 190px;
    padding: 0 16px;
    border-right: 1px solid var(--schegent-divider);
  }
  .brand-mark {
    display: inline-flex;
    width: 22px;
    height: 22px;
    align-items: center;
    justify-content: center;
    color: var(--schegent-color-active);
  }
  .brand-name {
    color: var(--schegent-fg);
    font-size: 0.82rem;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }
  .dashboard-nav {
    display: flex;
    min-width: 0;
    flex: 1 1 auto;
    align-items: stretch;
    gap: 2px;
    padding-left: 6px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .dashboard-nav::-webkit-scrollbar {
    display: none;
  }
  .nav-btn {
    position: relative;
    min-height: 51px;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: transparent;
    border: none;
    color: var(--schegent-muted-fg);
    padding: 0 12px;
    cursor: pointer;
    font-weight: 500;
    font-size: var(--schegent-text-secondary);
  }
  .nav-btn::after {
    position: absolute;
    right: 12px;
    bottom: -1px;
    left: 12px;
    height: 2px;
    background: transparent;
    content: '';
  }
  .nav-btn:hover {
    color: var(--schegent-fg);
    background: var(--schegent-surface-hover);
  }
  .nav-btn.active {
    color: var(--schegent-color-active);
    background: var(--schegent-surface-active);
  }
  .nav-btn.active::after {
    background: var(--schegent-color-active);
  }
  .nav-icon {
    flex: 0 0 auto;
  }
  .workspace-state {
    display: flex;
    align-items: center;
    gap: 7px;
    flex: 0 0 auto;
    color: var(--schegent-color-completed);
    font-size: var(--schegent-text-caption);
    white-space: nowrap;
  }
  .workspace-state.read-only {
    color: var(--schegent-color-warning);
  }
  .workspace-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  .dashboard-route {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .dashboard-loading {
    display: grid;
    width: min(720px, calc(100% - 48px));
    margin: auto;
    gap: 24px;
    color: var(--schegent-fg);
  }
  .loading-copy {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .loading-copy strong {
    font-size: 1.1rem;
  }
  .loading-copy span {
    color: var(--schegent-muted-fg);
  }
  .loading-skeleton {
    display: grid;
    gap: 10px;
  }
  .loading-skeleton span {
    display: block;
    height: 44px;
    border-radius: var(--schegent-radius);
    background: var(--schegent-surface);
  }
  .loading-skeleton span:nth-child(2) {
    width: 82%;
  }
  .loading-skeleton span:nth-child(3) {
    width: 64%;
  }

  @media (max-width: 860px) {
    .dashboard-topbar {
      padding-right: 10px;
    }
    .brand-lockup {
      width: auto;
      flex-basis: auto;
      padding: 0 12px;
    }
    .nav-btn {
      padding: 0 10px;
    }
    .nav-label {
      display: none;
    }
    .nav-btn::after {
      right: 8px;
      left: 8px;
    }
  }

  @media (max-width: 560px) {
    .brand-name,
    .workspace-state span:last-child {
      display: none;
    }
    .dashboard-topbar {
      padding-right: 8px;
    }
    .brand-lockup {
      gap: 0;
    }
  }
</style>
