<script lang="ts">
  import { setContext, tick } from 'svelte';

  import IncompatibleSnapshotNotice from '../components/IncompatibleSnapshotNotice.svelte';
  import SgSprite from '../components/sg/SgSprite.svelte';
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import { statusLine } from '../lib/status-line.svelte';

  import type { SettingsSectionId } from '../components/settings/settings-page.svelte';
  import { DASHBOARD_NAVIGATION, type DashboardNavigation } from './navigation-context';
  import { createRouteLoader } from './route-loader';
  import RouteOutlet from './RouteOutlet.svelte';
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

  // Feature 105 (T588h) — the loader is created here and handed down because both
  // sides of the split need the same cache: the nav warms it on hover, the outlet
  // consumes it on navigation. A module-level cache would have made the sharing
  // implicit and the tests order-dependent — see `route-loader.ts`.
  const loader = createRouteLoader();

  function preloadRoute(next: DashboardRoute): void {
    loader.preload(next);
  }

  // The section the Settings route opens on. The Settings page mounts afresh each time its route
  // is opened and reads this once, at mount: the top navigation opens it on Backends, the Queues
  // list's "Queue defaults" on Queues. Which section is shown after that is the page's own state.
  // `showRoute` below sets it before `navigate`, which stays the one assignment Feature 105 holds
  // it to (`App.route-loading.test.ts`).
  const OPENING_SETTINGS_SECTION: SettingsSectionId = 'backends';
  let settingsSection = $state<SettingsSectionId>(OPENING_SETTINGS_SECTION);

  function navigate(next: DashboardRoute): void {
    route = next;
  }

  // FR-R4-F06 (FR-008; D5) -- "Review in Settings" from a launch surface. Webview-local: it
  // posts no command, names no setting key and persists nothing. The Settings route mounts
  // fresh on its Backends section, which holds the "Installed backends" heading
  // (`SettingsSurface.test.ts` holds the heading to it), and its surface loads lazily, so the
  // heading may not exist after one tick; the scroll waits for it for a bounded number of frames
  // and then gives up quietly rather than throwing.
  const BACKEND_HEALTH_HEADING_ID = 'backend-health-heading';
  const SCROLL_WAIT_FRAMES = 120;

  async function scrollToBackendHealth(): Promise<void> {
    await tick();
    for (let frame = 0; frame < SCROLL_WAIT_FRAMES; frame += 1) {
      const heading = document.getElementById(BACKEND_HEALTH_HEADING_ID);
      if (heading !== null) {
        heading.scrollIntoView({ block: 'start' });
        return;
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }

  // Each page's icon in the sprite. A reference is written whole, never assembled, so a search
  // for it finds every use (`SgSprite.test.ts` holds the sprite to that).
  const ROUTE_ICONS: Record<DashboardRoute, string> = {
    operations: '#i-queue',
    history: '#i-history',
    metrics: '#i-chart',
    system: '#i-pulse',
    builder: '#i-build',
    settings: '#i-gear'
  };

  /** Says in the status line which page is showing. */
  function announceRoute(next: DashboardRoute): void {
    statusLine.announce(`Showing ${DASHBOARD_ROUTE_LABELS[next]}.`);
  }

  // Opening a page from the navigation also moves focus to the page's heading, so a keyboard or
  // screen-reader user lands on the page they asked for. The page may load lazily, so the heading
  // is waited for the way the scroll above waits: a bounded number of frames, then a quiet end.
  const PAGE_HEADING_SELECTOR = '#dashboard-content h1';
  const HEADING_WAIT_FRAMES = 120;
  let headingRequest = 0;

  async function focusPageHeading(): Promise<void> {
    headingRequest += 1;
    const request = headingRequest;
    const origin = document.activeElement;
    // After this tick the page being left is gone, so its heading cannot be taken for the new one.
    await tick();
    for (let frame = 0; frame < HEADING_WAIT_FRAMES; frame += 1) {
      if (request !== headingRequest) return;
      const heading = document.querySelector<HTMLElement>(PAGE_HEADING_SELECTOR);
      if (heading !== null) {
        // Someone who has moved on in the meantime is not pulled back.
        const focused = document.activeElement;
        const focusMoved = focused !== origin && focused !== document.body;
        if (focusMoved) return;
        heading.tabIndex = -1;
        heading.focus();
        return;
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }

  /**
   * Shows a page and names it in the status line. Every opener goes through here and must say
   * which section the Settings page opens on, so none inherits the section the last one asked for.
   */
  function showRoute(next: DashboardRoute, section: SettingsSectionId): void {
    settingsSection = section;
    navigate(next);
    announceRoute(next);
  }

  function openRoute(
    next: DashboardRoute,
    section: SettingsSectionId = OPENING_SETTINGS_SECTION
  ): void {
    showRoute(next, section);
    void focusPageHeading();
  }

  const navigation: DashboardNavigation = {
    openBackendSettings: () => {
      showRoute('settings', OPENING_SETTINGS_SECTION);
      void scrollToBackendHealth();
    },
    // The Queues list's "Queue defaults": the page opens on Queues and lands focus on its heading,
    // as a page opened from the top navigation does. Webview-local, like the link above.
    openQueueSettings: () => {
      openRoute('settings', 'queues');
    }
  };
  setContext(DASHBOARD_NAVIGATION, navigation);
</script>

<div class="sg dash" data-testid="dashboard-app-root">
  <SgSprite />
  <IncompatibleSnapshotNotice />
  {#if ready && snapshot}
    <a class="skip-link" href="#dashboard-content">Skip to dashboard content</a>
    <header class="topbar">
      <span class="brand">
        <svg class="i" aria-hidden="true"><use href="#i-logo"></use></svg>
        <span class="brand-name">Schegent</span>
      </span>
      <nav class="nav" aria-label="Primary">
        {#each DASHBOARD_ROUTES as r (r)}
          <button
            type="button"
            class:active={route === r}
            aria-current={route === r ? 'page' : undefined}
            data-testid="dashboard-route-{r}"
            title={DASHBOARD_ROUTE_LABELS[r]}
            onpointerenter={() => preloadRoute(r)}
            onfocus={() => preloadRoute(r)}
            onclick={() => openRoute(r)}
          >
            <svg class="i" aria-hidden="true"><use href={ROUTE_ICONS[r]}></use></svg>
            <span class="nav-label">{DASHBOARD_ROUTE_LABELS[r]}</span>
          </button>
        {/each}
      </nav>
      <!-- A second window differs by its icon as well as its colour: below the narrowest
           breakpoint the text is hidden and the mark is all that shows. -->
      <span
        class="push chip {snapshot.isPrimary ? 's-ok' : 's-warn'}"
        data-testid="dashboard-workspace-state"
        aria-live="polite"
      >
        {#if snapshot.isPrimary}
          <span class="dot" aria-hidden="true"></span>
        {:else}
          <svg class="i" aria-hidden="true"><use href="#i-warn"></use></svg>
        {/if}
        <span class="state-text">{snapshot.isPrimary ? 'Workspace Connected' : 'Read-only Window'}</span>
      </span>
    </header>
    <div id="dashboard-content" class="content" data-testid="dashboard-route">
      <RouteOutlet {route} {snapshot} {loader} {settingsSection} />
    </div>
    <div class="statusline" role="status" aria-live="polite" data-testid="dashboard-status-line">
      {statusLine.message}
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
  /* The shell's look is the shared sheet's (`lib/sg/sg-pages.css`, under "Shell"). What is here is
     what the sheet leaves to the product: the frame it sits in, the skip link, the first-snapshot
     wait, and how the top bar gives way when the window is narrow or the pointer is coarse. Rules
     that adjust a sheet class name the root too, so they win whatever order the two load in. */
  .dash {
    height: 100%;
    overflow: hidden;
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
  /* The navigation is the part of the bar that gives way: it shrinks and scrolls sideways. */
  .dash .nav {
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .dash .nav::-webkit-scrollbar {
    display: none;
  }
  .dash .nav button {
    position: relative;
    flex: 0 0 auto;
    white-space: nowrap;
  }
  /* A page keeps to its own area and scrolls inside it, so it never covers the status line. */
  .dash .content {
    overflow: hidden;
  }
  .dashboard-loading {
    display: grid;
    width: min(720px, calc(100% - 48px));
    margin: auto;
    gap: 24px;
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

  /* Text that no longer fits is hidden from sight only: it still names its control.
     The bar with its labels measured 847px wide at a 13px editor font and 883px at 14px, a
     read-only window's chip being about 14px narrower, and each font pixel adds about 36px: 960
     keeps every label whole up to a 16px font. Past that the navigation scrolls sideways. */
  @media (max-width: 960px) {
    .nav-label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  }

  @media (max-width: 560px) {
    .brand-name,
    .state-text {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  }

  /* A coarse pointer makes every button at least 44px tall, one more than the bar's inner height. */
  @media (pointer: coarse) {
    .dash .topbar,
    .dash .nav {
      height: auto;
    }
  }
</style>
