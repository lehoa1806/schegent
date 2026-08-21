<script lang="ts">
  // Feature 105 (T588h) — everything about rendering the current route: the
  // boundary that contains a mount failure, the load the effect drives, the one
  // error presentation both recovery paths share, and the loading state.
  //
  // Extracted from `App.svelte` under the Feature 078 line budget. The shell kept
  // the chrome, the nav, and the `route` value; this component receives that value
  // and is responsible for what appears beneath it. The split is the reason the
  // outlet renders `operations` too: the boundary has to cover the eager route as
  // well as the lazy ones, and a boundary in the shell would have put the shell
  // back in the business of route rendering.

  // Feature 092 (T112, FR-061) — the `operations` route mounts the drill-down's
  // location owner rather than `Dashboard` directly. Feature 097 retires the
  // `Dashboard` embed tier 2 used to reuse for its chrome — see
  // `QueueDetailTier.svelte`'s own header — so this route no longer touches
  // `Dashboard` at any depth.
  import OperationsSurface from '../components/OperationsSurface.svelte';
  import type { WorkflowSnapshot } from '../lib/snapshot-types';

  import {
    isLazyRoute,
    routeErrorMessage,
    type LazyRoute,
    type LazyRouteComponent,
    type RouteLoader
  } from './route-loader';
  import { DASHBOARD_ROUTE_LABELS, type DashboardRoute } from './routes';

  const {
    route,
    snapshot,
    loader
  }: {
    route: DashboardRoute;
    snapshot: WorkflowSnapshot;
    loader: RouteLoader;
  } = $props();

  /**
   * The mounted component and the route it belongs to, as one value.
   *
   * They are paired rather than held separately because separately they tear.
   * `route` changes the instant the nav button is clicked; the loader effect
   * clears the component a flush later. In between, a markup branch that picks
   * props by `route` while taking the component from a second signal renders the
   * *previous* route's component with the *next* route's props — History with
   * `active={true}` and no `snapshot`, which threw
   * `Cannot read properties of undefined (reading 'history')` inside its
   * `$derived`. The browser route walk caught it (T588b). One value cannot
   * disagree with itself, so the branch below reads `mounted.route`, never
   * `route`.
   */
  type MountedRoute = {
    readonly route: LazyRoute;
    readonly component: LazyRouteComponent;
  };
  let mounted = $state<MountedRoute | null>(null);
  let routeLoadError = $state<string | null>(null);

  // Feature 105 (T582, FR-007, FR-008) — the bound on a load that neither
  // resolves nor rejects. A promise that never settles leaves `aria-busy="true"`
  // in the DOM forever, which is indistinguishable to an operator from a slow
  // network and indistinguishable to a test from a hang. Named here, in the
  // module that owns the loading, and deliberately not reachable from settings:
  // a configurable timeout is a setting whose only correct value is the one that
  // makes the surface appear, so exposing it invites tuning around a bug.
  const ROUTE_LOAD_TIMEOUT_MS = 10_000;

  // Resolved rather than thrown, so the expiry path is a value the race returns
  // instead of an exception the catch has to tell apart from a real rejection.
  // The two outcomes evict for different reasons and only one of them means the
  // chunk is bad, so conflating them would lose that.
  const ROUTE_LOAD_EXPIRED = Symbol('route-load-expired');

  // Feature 105 (T583b, FR-004b) — Retry after a *load* rejection has to ask
  // again, and `route` is already the route being retried, so an assignment to it
  // is a no-op that the loader effect never sees. This nonce is what the effect
  // reads to mean "ask again", and it exists only because the mount-failure path
  // recovers through the boundary's `reset` instead: two recovery actions, one
  // markup (FR-004c).
  let retryNonce = $state(0);

  function retryRoute(): void {
    routeLoadError = null;
    retryNonce += 1;
  }

  /**
   * Feature 105 (T580, FR-005) — loading is driven by the value of `route`.
   *
   * It used to be driven by `navigate`, which meant a load happened because a
   * particular function ran rather than because the route changed. Any other
   * assignment — a restored session, a host-driven navigation, a future deep
   * link — would switch the route and leave the outlet on whatever was mounted.
   * Reading `route` here makes the load a consequence of the state, so there is
   * no path that can set it without one.
   */
  $effect(() => {
    const active = route;
    // Read so a Retry re-runs this effect; the value itself is not used.
    void retryNonce;
    routeLoadError = null;
    mounted = null;
    if (!isLazyRoute(active)) return;

    // Feature 105 (T582a, FR-010) — set by this effect's teardown, which Svelte
    // runs before the next re-run. A slow route A resolving after route B has
    // been activated finds `cancelled` true and leaves B mounted. Comparing
    // `route` inside the callback would work too, but only because the read
    // happens in a microtask where it is untracked; a flag says what it means.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const expiry = new Promise<typeof ROUTE_LOAD_EXPIRED>((resolve) => {
      timer = setTimeout(() => resolve(ROUTE_LOAD_EXPIRED), ROUTE_LOAD_TIMEOUT_MS);
    });

    void Promise.race([loader.load(active), expiry])
      .then((outcome) => {
        if (cancelled) return;
        if (outcome === ROUTE_LOAD_EXPIRED) {
          loader.evict(active);
          routeLoadError = routeErrorMessage(active);
          return;
        }
        mounted = { route: active, component: outcome };
      })
      .catch(() => {
        if (cancelled) return;
        routeLoadError = routeErrorMessage(active);
      })
      .finally(() => {
        clearTimeout(timer);
      });

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });

  /**
   * Feature 105 (T583a, FR-004a, FR-012) — one line, route id and `message` only.
   *
   * The message is not ours to trust: it is whatever the thrown value carried,
   * and a bundler or a `fetch` failure will happily put a `vscode-webview://`
   * URL or an absolute workspace path in it. Scrubbing here rather than asserting
   * good behaviour upstream is the difference between a claim and a guarantee —
   * SC-009c asserts the absence, so the absence has to be produced.
   */
  function reportMountFailure(cause: unknown): void {
    const message = cause instanceof Error ? cause.message : 'non-Error thrown during mount';
    console.error(`[schegent] route mount failed route=${route} message=${withoutPaths(message)}`);
  }

  function withoutPaths(message: string): string {
    // Scheme-qualified URLs, and path-like runs of two or more segments. One
    // segment is left alone so ordinary prose ("and/or") survives.
    return message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+|(?:\/[\w.-]+){2,}/gi, '<path>');
  }
</script>

<!-- Feature 105 (T583, FR-004c) — one definition of the error presentation.
     A `failed` snippet replaces the boundary's children, so it cannot reach
     the markup inside them; without this extraction, "reuse the existing
     markup" would mean a second copy that drifts. The recovery action is the
     only thing the two callers disagree about, so it is the parameter. -->
{#snippet routeError(message: string, recover: () => void)}
  <main class="route-status" data-testid="dashboard-route-error" role="alert">
    <strong>{message}</strong>
    <button type="button" onclick={recover}>Retry</button>
  </main>
{/snippet}

<!-- Feature 105 (T583c, FR-004) — one boundary over the whole outlet, so the
     protection covers `operations` too. `operations` is rendered eagerly and was
     therefore the one route no loader `.catch()` could ever have protected: a
     throw in its mount had nowhere to go but the console, leaving the shell
     rendered and the content silently absent. That is the failure this feature
     was opened to explain, and it is the reason the boundary wraps the `{#if}`
     rather than sitting inside its lazy arm. -->
<svelte:boundary onerror={(error) => reportMountFailure(error)}>
  {#if route === 'operations'}
    <OperationsSurface {snapshot} />
  {:else if mounted}
    <!-- Every test below is on `mounted.route`, not `route`. The two agree
         once the load has settled and disagree for the flush after a nav
         click, and picking props by the one that has already moved is what
         handed History the Metrics props. See `MountedRoute`. -->
    {@const RouteComponent = mounted.component}
    {#if mounted.route === 'metrics'}
      <RouteComponent active={true} />
    {:else if mounted.route === 'builder' || mounted.route === 'settings' || mounted.route === 'runs' || mounted.route === 'history'}
      <!-- Feature 103 (T017) — History moved from `history` + `isPrimary`
           to the whole snapshot. It composes its list from `history` and
           `queues` together, and a route that hand-picks fields has to be
           edited every time the surface reads one more. -->
      <RouteComponent {snapshot} />
    {:else}
      <RouteComponent />
    {/if}
  {:else if routeLoadError}
    {@render routeError(routeLoadError, retryRoute)}
  {:else}
    <main class="route-status" data-testid="dashboard-route-loading" aria-busy="true">
      <span>Loading {DASHBOARD_ROUTE_LABELS[route]}…</span>
    </main>
  {/if}
  <!-- Retry here is the boundary's `reset`, not `retryRoute`: the module
       loaded fine and is still cached, so recovery is a re-render and must
       not re-request the chunk (FR-004b). The message is the same string
       the rejection path uses — the load/mount distinction is a developer's
       and lives in the diagnostic line, not in a second sentence for the
       operator to tell apart. -->
  {#snippet failed(_error, reset)}
    {@render routeError(routeErrorMessage(route), reset)}
  {/snippet}
</svelte:boundary>

<style>
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
</style>
