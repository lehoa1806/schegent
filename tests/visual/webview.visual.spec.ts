import { expect, test, type Locator, type Page } from '@playwright/test';
import metricsJson from './fixtures/metrics-response.json';
import phaseLogJson from './fixtures/phase-log-response.json';
import { workflowSnapshot } from './fixtures/workflow-snapshot';
import { themeCss, type ThemeName } from './theme-palette';
import type { WorkflowSnapshot } from '../../src/ui/sidebar/snapshot';
// The webview's route union, imported across the CJS/ESM line that was thought
// to block it. `tests/` is type-checked as Node16/CJS and `webview-ui` is
// `"type": "module"`, which raises TS1541 for a bare type-only import — but
// `resolution-mode` resolves it, and the `.js` extension is not optional (drop
// it and the diagnostic is TS2835, which is what made this look unreachable).
// Type-only, so nothing survives to runtime and Playwright's transform erases it.
import type { DashboardRoute } from '../../webview-ui/src/dashboard/routes.js' with { 'resolution-mode': 'import' };

type SurfaceName =
  | 'sidebar'
  | 'queues'
  | 'builder'
  | 'metrics'
  | 'activity-feed'
  // FR-R3-143 (T046) — Settings was named by `ROUTE_MOUNT_TARGETS` below and by
  // `tests/a11y/routes.ts`, so both the route walk and the a11y sweep activated
  // it; neither photographs. `SurfaceName` is the photographed set, and nothing
  // relates the two lists, so the surface could be reordered, emptied, or
  // restyled with every gate green. It is the surface this feature rebuilt, and
  // it was the only route in `ROUTE_MOUNT_TARGETS` with no baseline.
  | 'settings';

/** The one queue `fixtures/workflow-snapshot.ts` registers. */
const FIXTURE_QUEUE_ID = 'default';

interface SurfaceContract {
  /** Content landmarks that together make up what the screenshot photographs. */
  readonly present: readonly string[];
  /** Empty/loading/error fallbacks that would stand in for that content. */
  readonly absent: readonly string[];
}

/**
 * The structural contract each surface must satisfy before it is photographed.
 *
 * The `absent` half carries most of the value, and it exists because of a real
 * failure: making `cumulative` and `coverage` required on `ReadMetricsResponse`
 * invalidated `fixtures/metrics-response.json`, so `isValidReadMetricsResponse`
 * rejected it, `fetchMetrics()` returned early, and the dashboard rendered an
 * empty table. An empty state is a perfectly stable thing to photograph — it
 * would have been adopted by the next `--update-snapshots` run without comment.
 * Pixel comparison cannot distinguish "renders correctly" from "renders a
 * plausible fallback"; a named testid can, and it fails with the landmark's name
 * instead of a diff ratio.
 *
 * These are landmarks, not an inventory. Add a row when a surface grows a
 * section a reader would notice the absence of, not for every element.
 */
const SURFACE_CONTRACTS: Readonly<Record<SurfaceName, SurfaceContract>> = {
  // `app-root` is the wrapper on both arms of App.svelte's `{#if ready}`, so it
  // stays visible when the snapshot never arrives and the whole sidebar falls
  // back to "Connecting". These four are the ready arm.
  sidebar: {
    present: [
      'sidebar-status-row',
      'sidebar-stats-strip',
      'sidebar-current-task',
      'sidebar-open-dashboard-button'
    ],
    absent: ['empty-state']
  },
  queues: {
    present: ['queues-tier', `queue-card-${FIXTURE_QUEUE_ID}`, 'queue-create'],
    absent: ['queues-empty']
  },
  // The Workflow editor head shows Save as its one button and keeps Revert,
  // Duplicate, Export and Deactivate in the "More workflow actions" menu. A
  // closed menu's items are hidden, and `toBeVisible` fails on a hidden
  // element, so the menu's trigger is the landmark for that group.
  builder: {
    present: [
      'pipeline-builder-root',
      'workflows-save-all',
      'workflows-menu'
    ],
    absent: [
      'workflow-catalog-error',
      'workflow-catalog-loading',
      'workflows-no-phases',
      'workflow-save-error-banner'
    ]
  },
  metrics: {
    present: [
      'metrics-toolbar',
      'metrics-summary-cards',
      'metrics-task-table',
      'metrics-cumulative',
      'metrics-phase-analytics-table',
      'metrics-cost-trend-svg'
    ],
    absent: ['metrics-empty', 'metrics-loading']
  },
  'activity-feed': {
    present: ['phase-log-selectors', 'phase-log-reading-pane', 'phase-log-entry-list'],
    absent: ['phase-log-loading', 'run-detail-missing']
  },
  // FR-R3-143 (T046) — the `settings-group-*` landmarks are the grouping this
  // feature imposed on what was one flat field list, so a row that fell out of
  // its group fails by name rather than as a diff ratio. The page lands on its
  // Backends section and hides the others, so this row holds the Backends
  // landmarks, and `SETTINGS_SECTION_LANDMARKS` below holds each other section's.
  // `effective-environment-policy` reports a HOST decision rather than a draft
  // value: what the three environment controls actually resolve to. It renders
  // unconditionally, so its absence means the group above it stopped rendering
  // — which is the fallback a screenshot cannot distinguish.
  //
  // `absent` names the route-level branches rather than a settings-specific
  // empty state, because there is no settings-specific one: `GeneralSettingsTab`
  // falls back to `IDLE_GENERAL_SETTINGS` when no projection arrives and renders
  // a complete, plausible form out of it. What the pixels would then differ by is
  // field values, which is exactly what `--update-snapshots` absorbs silently;
  // what cannot be absorbed is `RouteOutlet`'s error or loading branch standing
  // in for the surface entirely.
  settings: {
    present: [
      'general-settings-tab',
      'settings-section-backends',
      'settings-group-backend-environment',
      'effective-environment-policy'
    ],
    absent: ['dashboard-route-error', 'dashboard-route-loading']
  }
};

async function assertSurfaceContract(page: Page, surface: SurfaceName): Promise<void> {
  for (const testId of SURFACE_CONTRACTS[surface].present) {
    await expect(
      page.getByTestId(testId),
      `${surface}: landmark '${testId}' did not render, so the screenshot is not of this surface`
    ).toBeVisible();
  }
  for (const testId of SURFACE_CONTRACTS[surface].absent) {
    await expect(
      page.getByTestId(testId),
      `${surface}: fallback '${testId}' rendered — the screenshot would capture an empty state`
    ).toHaveCount(0);
  }
}

/**
 * Every dashboard route and the landmark that proves it mounted.
 *
 * The single source for the browser suite. It replaces a hand-maintained literal
 * that was missing `runs` — uncovered since Feature 091 introduced the route
 * (FR-R3-018) — and nothing in the suite could say so, because a route the walk
 * never names is a route the walk cannot fail on.
 *
 * The `Record<DashboardRoute, string>` annotation is the gate, not documentation.
 * It makes both drift directions compiler errors that name the route: a route
 * with no target is `TS2741: Property 'runs' is missing`, and a target for a
 * retired route is `TS2353: '"pipeline-builder"' does not exist`. Both observed.
 * `tests/lint/visual-route-coverage.test.ts` carries what a type cannot say —
 * that no two routes share a target — and stands as a second formulation that
 * does not depend on this import surviving a tooling change.
 *
 * Keys are route ids; values are testids already present in the components. The
 * `runs` value is the `<main>` landmark `RunsSurface.svelte` already carries, so
 * closing this gap needed no new testid.
 */
const ROUTE_MOUNT_TARGETS: Readonly<Record<DashboardRoute, string>> = {
  // The operations route lands on the Queues tier since Feature 092; the pane
  // that used to be here is a click deeper and is covered by the `queues`
  // surface below.
  operations: 'queues-tier',
  history: 'history-dashboard',
  metrics: 'metrics-section',
  system: 'system-tab',
  builder: 'pipeline-builder-root',
  settings: 'settings-surface-root'
} as const;

interface CapturedError {
  readonly kind: 'pageerror' | 'console.error';
  readonly text: string;
}

/**
 * What the page reported, per page, drained at each checkpoint.
 *
 * Both channels are guarded and neither is redundant. FR-R3-021's defect was an
 * uncaught `TypeError` thrown while a route mounted: nothing caught it, so it
 * arrived as `pageerror` — and the only thing this suite noticed was a locator
 * timing out on a testid the crashed surface never got far enough to render.
 * Now that a `<svelte:boundary>` catches that throw, the same defect arrives as
 * a `console.error` and never reaches `pageerror` at all. A guard on either
 * channel alone would catch the defect only in one of those two eras.
 */
const capturedErrors = new WeakMap<Page, CapturedError[]>();

function installErrorCapture(page: Page): void {
  const captured: CapturedError[] = [];
  capturedErrors.set(page, captured);
  page.on('pageerror', (error) => {
    captured.push({ kind: 'pageerror', text: `${error.name}: ${error.message}` });
  });
  page.on('console', (message) => {
    if (message.type() === 'error') captured.push({ kind: 'console.error', text: message.text() });
  });
}

/**
 * A checkpoint-scoped opt-out. Both fields are required: an allowance with no
 * stated reason is how a suite-wide relaxation arrives one test at a time, and
 * a `match` narrower than "everything" is what keeps an expected error from
 * excusing an unexpected one alongside it.
 */
interface ErrorAllowance {
  readonly reason: string;
  readonly match: RegExp;
}

/**
 * Fail if the page reported an error since the last checkpoint, naming `step`.
 *
 * `step` is the identity a failure has to carry to be actionable: the surface
 * name for a screenshot test, the route id inside a route walk. It has to
 * resolve for every caller — a route walk has no "surface under test" — so it
 * is a plain string the caller supplies rather than a `SurfaceName`.
 *
 * Draining is deliberate. Inside a walk, each route is its own checkpoint, so
 * one route's allowed error cannot excuse the next route's real one.
 */
function assertNoPageErrors(page: Page, step: string, allowance?: ErrorAllowance): void {
  const captured = capturedErrors.get(page);
  if (captured === undefined) {
    throw new Error(`${step}: error capture was never installed on this page`);
  }
  const drained = captured.splice(0, captured.length);
  const unexpected = allowance ? drained.filter((e) => !allowance.match.test(e.text)) : drained;
  expect(
    unexpected.map((e) => `${e.kind}: ${e.text}`),
    allowance
      ? `${step}: the page reported an error outside the allowance "${allowance.reason}"`
      : `${step}: the page reported an error`
  ).toEqual([]);
}

const MOUNT_TIMEOUT_MS = 10_000;
const MOUNT_POLL_MS = 50;

/**
 * Wait for a route's mount target, surrendering to a page error the moment one
 * arrives rather than running the locator's clock down.
 *
 * This is the entire difference between the report that left FR-R3-021's defect
 * unexplained for a round and one that names it. `toBeVisible()` on a surface
 * that threw during mount reports "testid never became visible" after its
 * timeout: true, useless, and indistinguishable from a chunk that never loaded.
 * Checking the error channel first reports the `TypeError`.
 */
async function assertRouteMounted(page: Page, route: string, target: string): Promise<void> {
  const locator = page.getByTestId(target);
  const deadline = Date.now() + MOUNT_TIMEOUT_MS;
  for (;;) {
    assertNoPageErrors(page, route);
    if (await locator.isVisible()) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `${route}: mount target '${target}' never became visible within ` +
          `${MOUNT_TIMEOUT_MS} ms, and the page reported no error explaining why`
      );
    }
    await page.waitForTimeout(MOUNT_POLL_MS);
  }
}

const metricsResponse: unknown = metricsJson;
const phaseLogResponse: unknown = phaseLogJson;

async function installDeterministicHost(page: Page): Promise<void> {
  // Installed here rather than per test so no test can forget it: every test in
  // this file reaches the page through this function.
  installErrorCapture(page);
  await page.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === 'http://127.0.0.1:4173') {
      await route.continue();
      return;
    }
    if (requestUrl.hostname === 'fonts.googleapis.com') {
      await route.fulfill({ status: 200, contentType: 'text/css', body: '' });
      return;
    }
    await route.abort();
  });
  const fixtures = inlineJson({ metrics: metricsResponse, phaseLog: phaseLogResponse });
  await page.addInitScript({
    content: `(() => {
      const fixtures = ${fixtures};
      let persistedState;
      const emit = (data) => window.dispatchEvent(new MessageEvent('message', { data }));
      const api = {
        postMessage(message) {
          if (!message || typeof message !== 'object') return;
          if (typeof message.correlationId !== 'string') return;
          let result;
          if (message.type === 'CMD_READ_METRICS') result = fixtures.metrics;
          if (message.type === 'CMD_READ_PHASE_LOG') result = fixtures.phaseLog;
          if (message.type === 'CMD_START_PHASE_LOG_TAIL') {
            result = { outcome: 'success', sessionId: 'visual-tail-session', mechanism: 'polling' };
          }
          if (message.type === 'CMD_STOP_PHASE_LOG_TAIL') {
            result = { outcome: 'success', sessionId: 'visual-tail-session' };
          }
          window.setTimeout(() => emit({
            type: 'CMD_ACK',
            correlationId: message.correlationId,
            status: 'accepted',
            result
          }), 0);
        },
        setState(state) { persistedState = state; },
        getState() { return persistedState; }
      };
      Object.defineProperty(window, 'acquireVsCodeApi', {
        configurable: false,
        enumerable: false,
        value: () => api
      });
    })();`
  });
}

async function publishSnapshot(page: Page): Promise<void> {
  const snapshot = inlineJson(workflowSnapshot);
  await page.evaluate(
    `window.dispatchEvent(new MessageEvent('message', { data: { type: 'STATE_SNAPSHOT', payload: ${snapshot} } }))`
  );
}

/**
 * The original defect, re-created on purpose: `history[0]` without `queueId`.
 *
 * `docs/operations/built-artifact-route-diagnosis.md` records this as the one
 * omission that crashes the History route — `labelFor` returns `undefined`, the
 * queue facet stores an entry with an undefined label, and `byLabel` reads
 * `.localeCompare` off it. Reproducing it here is what gives T587d a real mount
 * failure to recover from, rather than a stub that throws on cue.
 *
 * Built with a rest destructure and passed through `inlineJson`'s `unknown`
 * parameter, so no cast is involved: this is the payload a broken producer would
 * emit, and asserting on it must not require suppressing the type system that
 * makes such a producer impossible in the first place (SC-007).
 */
async function publishSnapshotMissingHistoryQueueId(page: Page): Promise<void> {
  const [firstEntry, ...restHistory] = workflowSnapshot.history;
  const { queueId: _queueId, ...entryWithoutQueueId } = firstEntry;
  const snapshot = inlineJson({
    ...workflowSnapshot,
    history: [entryWithoutQueueId, ...restHistory]
  });
  await page.evaluate(
    `window.dispatchEvent(new MessageEvent('message', { data: { type: 'STATE_SNAPSHOT', payload: ${snapshot} } }))`
  );
}

/** The chunk the History route is code-split into (`chunkFileNames: 'chunks/[name].js'`). */
const HISTORY_CHUNK_PATH = '/chunks/HistoryDashboard.js';

/**
 * How long to let a Retry settle before counting what it did.
 *
 * A fixed wait, not a poll, because the assertion is about something that does
 * *not* happen — `expect.poll` on an absence returns immediately on the first
 * look and proves nothing about the interval after it.
 */
const RETRY_SETTLE_MS = 2_000;

/**
 * Count every chunk request the page makes, by path.
 *
 * The counter exists because the unit suite cannot hold this observation:
 * vitest serves a mocked module out of its own registry, so a re-import and a
 * cache hit are indistinguishable from inside a jsdom test. A chunk request is
 * only a real, countable event in a real browser.
 */
function countChunkRequests(page: Page): () => readonly string[] {
  const requested: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/chunks/')) requested.push(path);
  });
  return () => requested;
}

function inlineJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Visual fixture is not JSON-serializable');
  return encoded.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

async function openSurface(page: Page, surface: SurfaceName, theme: ThemeName): Promise<Locator> {
  await page.setViewportSize(surface === 'sidebar' ? { width: 360, height: 720 } : { width: 1440, height: 960 });
  await page.emulateMedia({
    colorScheme: theme === 'light' ? 'light' : 'dark',
    reducedMotion: 'reduce',
    forcedColors: 'none'
  });
  await installDeterministicHost(page);
  await page.goto(surface === 'sidebar' ? '/index.html' : '/dashboard.html');
  const themeClass =
    theme === 'light'
      ? 'vscode-light'
      : theme === 'dark'
        ? 'vscode-dark'
        : 'vscode-high-contrast';
  await page.evaluate(`
    document.body.classList.remove(
      'vscode-light',
      'vscode-dark',
      'vscode-high-contrast',
      'vscode-high-contrast-light'
    );
    document.body.classList.add(${JSON.stringify(themeClass)});
  `);
  await page.addStyleTag({ content: themeCss(theme) });
  await publishSnapshot(page);

  if (surface === 'sidebar') {
    const sidebar = page.getByTestId('app-root');
    await expect(sidebar).toBeVisible();
    return sidebar;
  }

  if (surface === 'metrics') {
    await page.getByTestId('dashboard-route-metrics').click();
    const metrics = page.getByTestId('metrics-section');
    await expect(metrics).toBeVisible();
    return metrics;
  }

  if (surface === 'builder') {
    await page.getByTestId('dashboard-route-builder').click();
    const builder = page.getByTestId('pipeline-builder-root');
    await expect(builder).toBeVisible();
    await page.getByRole('tab', { name: 'Workflows' }).click();
    const picker = page.getByTestId('workflow-picker-toggle');
    if ((await picker.getAttribute('aria-expanded')) !== 'true') await picker.click();
    await expect(picker).toHaveAttribute('aria-expanded', 'true');
    await page.getByTestId('workflows-list-item-dev-new-feature').click();
    await expect(page.getByTestId('workflow-field-name')).toBeVisible();
    return builder;
  }

  if (surface === 'settings') {
    await page.getByTestId('dashboard-route-settings').click();
    const settings = page.getByTestId('settings-surface-root');
    await expect(settings).toBeVisible();
    // The page lands on its Backends section (`SETTINGS_SECTIONS[0]`), so no
    // click is needed — and that is asserted rather than assumed. The Builder
    // arm above had to ask for its tab after Feature 180 moved the landing tab
    // out from under it; the same move here would otherwise photograph another
    // section and be adopted by the next baseline refresh.
    await expect(page.getByTestId('settings-nav-backends')).toHaveAttribute(
      'aria-current',
      'true'
    );
    return settings;
  }

  await page.getByTestId('dashboard-route-operations').click();

  if (surface === 'queues') {
    const queues = page.getByTestId('queues-tier');
    await expect(queues).toBeVisible();
    await expect(page.getByTestId(`queue-card-${FIXTURE_QUEUE_ID}`)).toBeVisible();
    return queues;
  }

  // Feature 092 (FR-057) turned the operations route into a three-tier
  // drill-down, so the activity feed is no longer the route's landing view —
  // it now lives in the Run Detail tier, reached one click past Queue
  // Detail. Feature 097 (T013) deleted `Dashboard.svelte` outright; the Run
  // Detail tier renders the feed natively via `PhaseLogFeed.svelte` rather
  // than embedding a pane, so 'activity-feed' below drills to that tier and
  // targets the feed's own testid.
  await page.getByTestId(`queue-card-${FIXTURE_QUEUE_ID}`).click();
  await expect(page.getByTestId('queue-detail-tier')).toBeVisible();

  // `visual-task-active` is the fixture's in-flight Task — the one row whose
  // currentPipelineId/currentPhase are populated, so the Run Detail tier has
  // a complete selection tuple to load the feed with.
  await page.getByTestId('queue-task-row-visual-task-active').click();
  await expect(page.getByTestId('run-detail-tier')).toBeVisible();

  // 'activity-feed' is the last surface reachable from here — every other
  // SurfaceName arm returns earlier in this function.
  const feed = page.getByTestId('phase-log-feed');
  await expect(page.getByTestId('phase-log-entry').first()).toBeVisible();
  return feed;
}

const volatileMasks = (page: Page): readonly Locator[] => [
  page.locator('[data-testid^="metrics-task-row-"] > td:nth-child(3)'),
  page.locator('[data-testid^="metrics-task-row-"] > td:nth-child(4)'),
  page.locator('[data-testid="metrics-coverage-window"]'),
  page.locator('time.ts'),
  page.getByTestId('sidebar-telemetry-row')
];

/**
 * The surfaces the screenshot loop below walks.
 *
 * Named rather than inlined so it can be compared against `SURFACE_CONTRACTS`.
 * FR-R3-143 (T046) — Settings had a mount target, an a11y route, and a contract
 * row's worth of landmarks, and no baseline, because this list is the only thing
 * that decides what is photographed and nothing checked it against anything. The
 * `readonly SurfaceName[]` annotation rejects a typo; it cannot reject an
 * omission, which is the direction that fails silently.
 */
const PHOTOGRAPHED_SURFACES: readonly SurfaceName[] = [
  'sidebar',
  'queues',
  'builder',
  'metrics',
  'activity-feed',
  'settings'
];

// The omission check the annotation cannot make. `SURFACE_CONTRACTS` is
// `Record<SurfaceName, SurfaceContract>`, so its keys are the union itself at
// runtime: a surface added to `SurfaceName` is a compiler error until it has a
// contract row, and this is a failure until it has baselines. Both halves of
// "photographed, not only mounted" then hold by construction rather than by
// someone remembering. No `page` fixture, so this costs no browser.
test('Workflow tasks are composed inside their Queue', async ({ page }) => {
  await installDeterministicHost(page);
  await page.goto('/dashboard.html');
  const workflow = workflowSnapshot.workflowCatalog.effective[0];
  const snapshot = inlineJson({
    ...workflowSnapshot,
    launchables: {
      pipelines: { state: 'no-definitions' },
      workflows: {
        state: 'entries',
        entries: [{
          kind: 'workflow',
          id: workflow.workflowId,
          name: workflow.name,
          activeVersionId: 'v1',
          inputs: [],
          outputs: [],
          startNodeIds: workflow.startNodeIds
        }]
      }
    }
  });
  await page.evaluate(
    `window.dispatchEvent(new MessageEvent('message', { data: { type: 'STATE_SNAPSHOT', payload: ${snapshot} } }))`
  );
  await expect(page.getByTestId('dashboard-route-runs')).toHaveCount(0);
  await page.getByTestId(`queue-card-${FIXTURE_QUEUE_ID}`).click();
  await page.getByTestId('queue-composer-open').click();
  await page.getByTestId(`launchable-select-workflow-${workflow.workflowId}`).click();
  await expect(page.getByTestId('run-supplemental-instruction')).toBeVisible();
  await expect(page.getByTestId('workflow-trigger-submit')).toHaveText('Add task');
  await expect(page.getByTestId('queue-detail-title')).toBeVisible();
  await expect(page.locator('main')).toHaveCount(1);
  await page.getByTestId('queue-composer-cancel').click();
  await expect(page.getByTestId('queue-task-composer')).toHaveCount(0);
  assertNoPageErrors(page, 'Queue task composition');
});

test('every surface with a contract is photographed', () => {
  expect(
    [...PHOTOGRAPHED_SURFACES].sort(),
    'a surface has a structural contract but no screenshot, so nothing compares its pixels'
  ).toEqual(Object.keys(SURFACE_CONTRACTS).sort());
});

for (const theme of ['light', 'dark', 'high-contrast'] as const) {
  for (const surface of PHOTOGRAPHED_SURFACES) {
    test(`${surface} remains visually stable in ${theme}`, async ({ page }) => {
      const target = await openSurface(page, surface, theme);
      // Structural gate before the pixel gate: prove the surface rendered its
      // own content, so a green screenshot cannot mean "photographed a
      // fallback" or "photographed a baseline nobody re-generated".
      await assertSurfaceContract(page, surface);
      // Before the pixel gate, not after: a surface that reported an error on
      // the way to a stable-looking screenshot is the failure mode
      // `SURFACE_CONTRACTS` was written for, arriving through a channel it
      // cannot see.
      assertNoPageErrors(page, surface);
      await expect(target).toHaveScreenshot(`${surface}-${theme}.png`, {
        mask: [...volatileMasks(page)],
        maskColor: theme === 'light' ? '#e5e7eb' : '#334155'
      });
    });
  }
}

/**
 * The Settings page shows one section at a time, Backends on arrival, so the `settings` shots
 * above photograph Backends only. Each other section is photographed in the light theme, after
 * the landmarks that prove it is the section on screen. Keyed by the section's id, as its
 * navigation button and its section carry it.
 */
const SETTINGS_SECTION_LANDMARKS: Readonly<Record<string, readonly string[]>> = {
  execution: ['settings-group-execution-retry'],
  // `queue-config-cap-disclosure` is the sentence the cap may not be shown without
  // (FR-R3-124): that concurrent Runs share one working tree. It renders with the cap row,
  // whatever the cap is.
  queues: ['queue-defaults-cap-row', 'queue-config-cap-disclosure'],
  logging: ['settings-group-audit-logging'],
  privacy: ['privacy-profiles', 'session-artifact-usage'],
  // `trust-disclosure` reports a host decision rather than a draft value: what
  // Workspace Trust allows. It renders unconditionally, as
  // `effective-environment-policy` does in `SURFACE_CONTRACTS.settings`.
  trust: ['settings-group-ui-trust', 'trust-disclosure'],
  signatures: ['settings-fatal-signatures-tab']
};

/** Shows a Settings section by its navigation button and proves it is the one on screen. */
async function showSettingsSection(page: Page, section: string): Promise<void> {
  const button = page.getByTestId(`settings-nav-${section}`);
  await button.click();
  await expect(button).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('[data-testid^="settings-section-"]:visible')).toHaveCount(1);
  await expect(page.getByTestId(`settings-section-${section}`)).toBeVisible();
}

/**
 * Every section the Settings navigation lists, by id, in its order. Read from the page, so a
 * section added to the page is walked, and must be photographed, without this file naming it.
 */
async function settingsSections(page: Page): Promise<string[]> {
  return page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button')
    .evaluateAll((buttons) =>
      buttons.map((button) => (button.getAttribute('data-testid') ?? '').replace(/^settings-nav-/, ''))
    );
}

/**
 * Shows each Settings section in turn and runs `visit` on it. A control in a hidden section has
 * no box, so a measurement of the page is a measurement of each section.
 */
async function eachSettingsSection(
  page: Page,
  visit: (section: string) => Promise<void>
): Promise<void> {
  const sections = await settingsSections(page);
  expect(sections.length, 'the Settings navigation lists its sections').toBeGreaterThan(1);
  for (const section of sections) {
    await showSettingsSection(page, section);
    await visit(section);
  }
}

test('every settings section is photographed', async ({ page }) => {
  await openSurface(page, 'settings', 'light');
  expect(
    (await settingsSections(page)).sort(),
    'a Settings section has no screenshot, so nothing compares its pixels'
  ).toEqual(['backends', ...Object.keys(SETTINGS_SECTION_LANDMARKS)].sort());
  assertNoPageErrors(page, 'settings sections');
});

for (const [section, landmarks] of Object.entries(SETTINGS_SECTION_LANDMARKS)) {
  test(`settings ${section} section remains visually stable in light`, async ({ page }) => {
    const settings = await openSurface(page, 'settings', 'light');
    await showSettingsSection(page, section);
    for (const testId of landmarks) {
      await expect(
        page.getByTestId(testId),
        `settings ${section}: landmark '${testId}' did not render, so the screenshot is not of this section`
      ).toBeVisible();
    }
    assertNoPageErrors(page, `settings ${section}`);
    await expect(settings).toHaveScreenshot(`settings-${section}-light.png`, {
      mask: [...volatileMasks(page)],
      maskColor: '#e5e7eb'
    });
  });
}

/**
 * A search in progress is a page none of the shots above takes: every section that holds a match
 * is on screen at once, each under its name, and what does not match is hidden. This query finds
 * three sections that begin differently (a setting, a note, a lead over two headed lists), and
 * what it finds fits the viewport, so the shot holds all of it.
 */
const SETTINGS_SEARCH = {
  query: 'retry',
  sections: ['execution', 'trust', 'signatures']
} as const;

/**
 * Types `query` into the Settings search field and leaves the field. The field's description is
 * on screen for as long as the field has focus, so a page measured or photographed with the
 * focus still there has the description over it.
 */
async function searchSettings(page: Page, query: string): Promise<void> {
  const field = page.getByTestId('settings-search');
  await field.fill(query);
  await field.blur();
  await expect(page.locator('.hover-text-portal-host')).toHaveCount(0);
}

/** The Settings sections on screen, by id, in the page's order. */
async function shownSettingsSections(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="settings-section-"]:visible')
    .evaluateAll((sections) =>
      sections.map((section) =>
        (section.getAttribute('data-testid') ?? '').replace(/^settings-section-/, '')
      )
    );
}

test('a settings search in progress remains visually stable in light', async ({ page }) => {
  const settings = await openSurface(page, 'settings', 'light');
  await searchSettings(page, SETTINGS_SEARCH.query);
  await expect
    .poll(() => shownSettingsSections(page), 'the search shows the sections this shot is of')
    .toEqual([...SETTINGS_SEARCH.sections]);
  assertNoPageErrors(page, 'settings search');
  await expect(settings).toHaveScreenshot('settings-search-light.png', {
    mask: [...volatileMasks(page)],
    maskColor: '#e5e7eb'
  });
});

/**
 * The widths the Settings header is measured at. They are close together round the widths where
 * the row of actions stops fitting beside the title: a row that grows by one item moves to a
 * line of its own somewhere there. Where exactly follows the text size, so no one width is
 * named.
 */
const SETTINGS_HEADER_WIDTHS = [
  1440, 1200, 1000, 980, 960, 940, 920, 900, 880, 860, 840, 820, 800, 760, 700, 640, 600, 561, 560,
  520, 480, 440, 400, 360, 320
] as const;

/**
 * Where the header's two buttons and the section navigation stand, each from the corner of the
 * page title. The page is put at its top first: the navigation sticks to the top of a scrolled
 * page, so its place would follow the scroll and not the header.
 */
async function settingsHeaderPlaces(settings: Locator): Promise<string> {
  return settings.evaluate((surface) => {
    const scroller = surface.querySelector('.page');
    if (scroller) scroller.scrollTop = 0;
    const title = surface.querySelector('h1')?.getBoundingClientRect();
    const place = (name: string, selector: string): string => {
      const box = surface.querySelector(selector)?.getBoundingClientRect();
      if (!title || !box) return `${name} not found`;
      return `${name} ${(box.left - title.left).toFixed(1)}, ${(box.top - title.top).toFixed(1)}`;
    };
    return [
      place('Revert', '[data-testid="settings-revert"]'),
      place('Save', '[data-testid="settings-save"]'),
      place('navigation', 'nav')
    ].join('; ');
  });
}

/** The count of unsaved changes the Settings header shows, and none where it shows no count. */
async function unsavedSettingsCount(page: Page): Promise<number> {
  const count = page.getByTestId('settings-unsaved');
  return (await count.count()) === 0 ? 0 : Number.parseInt(await count.innerText(), 10);
}

/**
 * Edits number fields, a section at a time, until the page counts `target` unsaved changes. A
 * field takes the value one above its own, or one below where its own is already the largest.
 */
async function editSettingsUntil(page: Page, target: number): Promise<void> {
  for (const section of await settingsSections(page)) {
    await showSettingsSection(page, section);
    const fields = page
      .getByTestId(`settings-section-${section}`)
      .locator('input[type="number"]:enabled:visible');
    const count = await fields.count();
    for (let index = 0; index < count; index += 1) {
      if ((await unsavedSettingsCount(page)) >= target) return;
      const field = fields.nth(index);
      const value = Number(await field.inputValue());
      const largest = await field.getAttribute('max');
      const atLargest = largest !== null && value >= Number(largest);
      await field.fill(String(atLargest ? value - 1 : value + 1));
      await field.blur();
    }
  }
}

/**
 * The count of unsaved changes joins the header's row of actions on the first edit. A row that
 * grows by one item stops fitting beside the title at some widths, and there it would take a
 * line of its own and push the whole page down, under the pointer of whoever made the edit. So
 * the header is measured with nothing to save, with one change and with a count of two digits,
 * at each width: the two buttons and what starts under the header stand where they stood.
 */
test('the settings header stays put when the unsaved count appears', async ({ page }) => {
  const settings = await openSurface(page, 'settings', 'light');
  const placesAtEachWidth = async (): Promise<string[]> => {
    const places: string[] = [];
    for (const width of SETTINGS_HEADER_WIDTHS) {
      await page.setViewportSize({ width, height: 960 });
      await expect.poll(() => page.evaluate('window.innerWidth')).toBe(width);
      places.push(`${width}px: ${await settingsHeaderPlaces(settings)}`);
    }
    // Back to the width the fields are edited at.
    await page.setViewportSize({ width: 1440, height: 960 });
    return places;
  };
  const unsaved = page.getByTestId('settings-unsaved');

  await expect(unsaved, 'the page arrives with nothing to save').toHaveCount(0);
  const none = await placesAtEachWidth();
  expect(none.join('\n'), 'the header and the navigation were found').not.toContain('not found');

  await editSettingsUntil(page, 1);
  await expect(unsaved).toHaveText('1 unsaved change');
  const one = await placesAtEachWidth();

  await editSettingsUntil(page, 10);
  await expect(unsaved, 'the count has two digits').toHaveText(/^\d\d unsaved changes$/);
  const many = await placesAtEachWidth();

  expect(one, 'the first unsaved change moved the header or the page under it').toEqual(none);
  expect(many, 'a count of two digits moved the header or the page under it').toEqual(none);
  assertNoPageErrors(page, 'settings header');
});

/** What `orphanedRules` looked at, and what it found. */
interface RuleAudit {
  /** How many rules were looked at. */
  readonly examined: number;
  /** Each rule with nothing shown beyond it, by the element that draws it. */
  readonly orphans: readonly string[];
}

/**
 * Finds the rules under `root` that part nothing. A rule here is a border drawn on one side
 * only, above or below: the line under a settings row or a table row, the line that opens a
 * block under a list. It parts its element from the next thing shown in the same parent (from
 * the one before it, for a line above), and a table row from the next row or row group. Hiding
 * that neighbour, as a search does, must take the line away; where it does not, the line is
 * drawn against nothing. A box with a border above and below is a frame, not a rule.
 */
async function orphanedRules(root: Locator): Promise<RuleAudit> {
  return root.locator('*').evaluateAll((elements) => {
    // Through `ownerDocument`, as `collectUndersizedTargets` reaches the page: the tests'
    // TypeScript program has no DOM globals.
    type Drawn = (typeof elements)[number];
    const orphans: string[] = [];
    let examined = 0;
    const draws = (width: string, style: string, colour: string): boolean =>
      Number.parseFloat(width) > 0 &&
      style !== 'none' &&
      style !== 'hidden' &&
      !/^rgba\(.*,\s*0\)$|\/\s*0\)$/.test(colour);
    const shownBeside = (element: Drawn, after: boolean): boolean => {
      const step = (from: Drawn): Drawn =>
        after ? from.nextElementSibling : from.previousElementSibling;
      for (let sibling = step(element); sibling; sibling = step(sibling)) {
        if (sibling.getBoundingClientRect().height > 0) return true;
      }
      return false;
    };
    for (const element of elements) {
      const style = element.ownerDocument.defaultView?.getComputedStyle(element);
      if (!style || element.getClientRects().length === 0) continue;
      const above = draws(style.borderTopWidth, style.borderTopStyle, style.borderTopColor);
      const below = draws(
        style.borderBottomWidth,
        style.borderBottomStyle,
        style.borderBottomColor
      );
      if (above === below) continue;
      examined += 1;
      const cell = element.tagName === 'TD' || element.tagName === 'TH';
      const row = cell ? element.parentElement : null;
      const rowGroup = row ? row.parentElement : null;
      const parted = row
        ? shownBeside(row, below) || (rowGroup ? shownBeside(rowGroup, below) : false)
        : shownBeside(element, below);
      if (!parted) orphans.push(`${below ? 'under' : 'over'} ${element.outerHTML.slice(0, 140)}`);
    }
    return { examined, orphans };
  });
}

/** The name of the queue `publishSnapshotWithSecondQueue` adds. */
const SECOND_QUEUE_NAME = 'Nightly builds';

/**
 * Publishes the fixture with a second, empty queue after its own. The fixture has one queue, so
 * a table of the queues has one row, and a state that needs a row above a hidden one cannot be
 * reached from it.
 */
async function publishSnapshotWithSecondQueue(page: Page): Promise<void> {
  const [queue] = workflowSnapshot.queues;
  const [summary] = workflowSnapshot.queue.queues;
  const second = { name: SECOND_QUEUE_NAME, position: 1 } as const;
  const withSecondQueue: WorkflowSnapshot = {
    ...workflowSnapshot,
    queues: [
      queue,
      {
        ...queue,
        ...second,
        queueId: 'second',
        lifecycle: 'active-empty',
        inFlightRun: null,
        pendingCount: 0,
        tasks: []
      }
    ],
    queue: {
      ...workflowSnapshot.queue,
      queues: [summary, { ...summary, ...second, id: 'second', taskCount: 0 }]
    }
  };
  await page.evaluate(
    "window.dispatchEvent(new MessageEvent('message', { data: " +
      `{ type: 'STATE_SNAPSHOT', payload: ${inlineJson(withSecondQueue)} } }))`
  );
}

/**
 * Queries for the rule check below. Between them they hide the end of a list of rows, every row
 * above a block that opens with a rule of its own, and whole groups between two that stay.
 */
const SETTINGS_RULE_QUERIES = [
  'retry',
  'queue',
  'path',
  'trust',
  'evidence',
  'log',
  'fail'
] as const;

/**
 * A settings row draws a line under it and the last row of a list draws none, a table does the
 * same, and the trust note opens with a line that parts it from the rows above. A search hides
 * rows, so the row left at the end of what is shown is no longer the last of its list, and a
 * block can lose everything above it: each would keep a line with nothing beyond it. The
 * unsearched sections are checked first, which shows the check is quiet on a page that is right.
 */
test('a settings search leaves no rule with nothing beyond it', async ({ page }) => {
  const settings = await openSurface(page, 'settings', 'light');
  const unsearched: string[] = [];
  let examined = 0;
  await eachSettingsSection(page, async (section) => {
    const audit = await orphanedRules(settings);
    examined += audit.examined;
    unsearched.push(...audit.orphans.map((orphan) => `${section}: ${orphan}`));
  });
  // Named, because the empty lists below pass just as well when no rule was looked at.
  expect(examined, 'the page draws rules, and they were looked at').toBeGreaterThan(0);
  expect(unsearched, 'an unsearched section draws a rule with nothing beyond it').toEqual([]);

  for (const query of SETTINGS_RULE_QUERIES) {
    await searchSettings(page, query);
    const shown = await shownSettingsSections(page);
    expect(shown.length, `the search for '${query}' finds settings`).toBeGreaterThan(0);
    const audit = await orphanedRules(settings);
    expect(audit.examined, `rules were looked at under '${query}'`).toBeGreaterThan(0);
    expect(audit.orphans, `the search for '${query}' left a rule with nothing beyond it`).toEqual(
      []
    );
  }

  // The fixture's one queue gives the failure table one row. With a second queue, the name of
  // the first finds the first row alone, which is then the last row shown and not the last row.
  await publishSnapshotWithSecondQueue(page);
  const [fixtureQueue] = workflowSnapshot.queues;
  await searchSettings(page, fixtureQueue.name);
  await expect(page.locator('[data-testid^="queue-failure-policy-row-"]')).toHaveCount(2);
  await expect(page.locator('[data-testid^="queue-failure-policy-row-"]:visible')).toHaveCount(1);
  const audit = await orphanedRules(settings);
  expect(audit.orphans, 'a table row with only hidden rows after it kept its line').toEqual([]);
  assertNoPageErrors(page, 'settings search rules');
});

/**
 * Room a number field keeps for its spin button. Chromium lays the button out on
 * every enabled number field and only fades it in on hover, so the text never
 * gets that width back.
 */
const NUMBER_SPIN_BUTTON_ALLOWANCE_PX = 20;

interface FieldTextFit {
  /** Every field measured, by test id. */
  readonly measured: readonly string[];
  /** Each field whose text is wider than its room, with both widths. */
  readonly cutOff: readonly string[];
}

/**
 * Measures the text a field's `attribute` holds (its placeholder, or the largest
 * value it takes) in the field's own font, against the room the field's box
 * leaves. The text is measured rather than read back from the layout, because
 * nothing a script can reach reports a field's overflow.
 */
async function fieldTextFit(fields: Locator, attribute: 'placeholder' | 'max'): Promise<FieldTextFit> {
  return fields.evaluateAll(
    (nodes, { name, spinButtonAllowance }) => {
      // Through `ownerDocument`, as `collectUndersizedTargets` reaches the page:
      // the tests' TypeScript program has no DOM globals.
      const measured: string[] = [];
      const cutOff: string[] = [];
      for (const field of nodes) {
        const style = field.ownerDocument.defaultView?.getComputedStyle(field);
        const context = field.ownerDocument.createElement('canvas').getContext('2d');
        if (!style || !context || field.getClientRects().length === 0) continue;
        const text = field.getAttribute(name) ?? '';
        context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const needed = context.measureText(text).width;
        const spinButton = field.getAttribute('type') === 'number' ? spinButtonAllowance : 0;
        const room =
          field.clientWidth -
          Number.parseFloat(style.paddingLeft) -
          Number.parseFloat(style.paddingRight) -
          spinButton;
        const fieldName = field.getAttribute('data-testid') ?? field.outerHTML.slice(0, 140);
        measured.push(fieldName);
        if (needed > room) {
          cutOff.push(`${fieldName}: "${text}" needs ${Math.ceil(needed)}px and has ${Math.floor(room)}px`);
        }
      }
      return { measured, cutOff };
    },
    { name: attribute, spinButtonAllowance: NUMBER_SPIN_BUTTON_ALLOWANCE_PX }
  );
}

/**
 * `fieldTextFit` over each Settings section in turn: the page hides the sections it does not
 * show, and `fieldTextFit` skips a field with no box.
 */
async function settingsFieldTextFit(
  page: Page,
  settings: Locator,
  selector: string,
  attribute: 'placeholder' | 'max'
): Promise<FieldTextFit> {
  const measured: string[] = [];
  const cutOff: string[] = [];
  await eachSettingsSection(page, async () => {
    const fit = await fieldTextFit(settings.locator(selector), attribute);
    measured.push(...fit.measured);
    cutOff.push(...fit.cutOff);
  });
  return { measured, cutOff };
}

/**
 * A placeholder that names a field's unset state ("Unset — no limit") is the
 * only place the operator reads that state, and a field too narrow for it says
 * something else ("Unset — no"). The pixel gate cannot hold this: a cut-off
 * placeholder is a stable picture, and the next baseline refresh adopts it.
 */
test('every settings placeholder fits inside its field', async ({ page }) => {
  const settings = await openSurface(page, 'settings', 'light');
  const { measured, cutOff } = await settingsFieldTextFit(
    page,
    settings,
    'input[placeholder]:not([placeholder=""]), textarea[placeholder]:not([placeholder=""])',
    'placeholder'
  );
  // Named, because the empty list below passes just as well when nothing was measured.
  expect(measured, 'the fields this was written for were measured').toEqual(
    expect.arrayContaining([
      'general-settings-input-spendMaxUsdPerRun',
      'general-settings-input-claudeAutoCompactPctOverride'
    ])
  );
  expect(cutOff, 'a settings field cuts off its own placeholder').toEqual([]);
  assertNoPageErrors(page, 'settings placeholders');
});

/**
 * A number field shows the largest value its setting takes. The redesign's
 * 110px field holds every count and duration here, but not a size the host
 * stores in bytes ("10737418240") where the redesign draws MB, and a field too
 * narrow for its value cuts off its last digits. The pixel gate cannot hold
 * this either: it photographs the fixture's values, not the largest.
 */
test('every settings number field shows its largest value', async ({ page }) => {
  const settings = await openSurface(page, 'settings', 'light');
  const { measured, cutOff } = await settingsFieldTextFit(page, settings, 'input[type="number"][max]', 'max');
  // Named, because the empty list below passes just as well when nothing was measured.
  expect(measured, 'the fields this was written for were measured').toEqual(
    expect.arrayContaining([
      'general-settings-input-sessionRetentionMaxBytes',
      'general-settings-input-runtimeLogMaxBytes'
    ])
  );
  expect(cutOff, 'a settings number field cuts off its largest value').toEqual([]);
  assertNoPageErrors(page, 'settings number values');
});

/**
 * T587d — the half of SC-009b the unit suite cannot hold.
 *
 * `App.route-loading.test.ts` covers the *mechanism* of recovery: a mount
 * failure recovers without the loading branch reappearing, a load rejection
 * recovers with it. What it cannot cover is the consequence that distinguishes
 * the two — whether a second chunk request goes out — because in jsdom there is
 * no chunk and no request. Both tests live here, in the runtime where a chunk
 * request is a real event, and count them.
 */
test.describe('route load failure recovery', () => {
  test.use({ viewport: { width: 1440, height: 960 } });

  test('Retry after a mount failure re-mounts from the loaded chunk', async ({ page }) => {
    await installDeterministicHost(page);
    const chunkRequests = countChunkRequests(page);
    const mountDiagnostics: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('route mount failed')) {
        mountDiagnostics.push(message.text());
      }
    });

    await page.goto('/dashboard.html');
    await page.addStyleTag({ content: themeCss('dark') });
    await publishSnapshotMissingHistoryQueueId(page);
    // Stated as a precondition rather than assumed: the omission is documented as
    // crashing the History route alone, and if it ever crashes the landing route
    // too, this is where that says so instead of surfacing as a stray click
    // timeout below.
    await expect(page.getByTestId('queues-tier')).toBeVisible();

    await page.getByTestId('dashboard-route-history').click();
    const errorBranch = page.getByTestId('dashboard-route-error');
    await expect(errorBranch).toBeVisible();
    await expect(errorBranch).toHaveAttribute('role', 'alert');

    const afterFirstFailure = [...chunkRequests()];
    expect(
      afterFirstFailure.filter((path) => path === HISTORY_CHUNK_PATH),
      'the chunk must have loaded — otherwise this is a load rejection, not a mount failure'
    ).toHaveLength(1);
    expect(mountDiagnostics).toHaveLength(1);
    assertNoPageErrors(page, 'history mount failure', {
      reason: 'the boundary reports every caught mount failure by design (FR-004b)',
      match: /route mount failed route=history/
    });

    await errorBranch.getByRole('button', { name: 'Retry' }).click();

    // The same broken snapshot is still published, so the re-mount throws again
    // and lands back on the error branch. That is the point: a second diagnostic
    // proves the retry re-mounted, and the unchanged chunk count proves it did so
    // from the module already in memory.
    await expect.poll(() => mountDiagnostics.length).toBe(2);
    await expect(errorBranch).toBeVisible();
    expect(
      chunkRequests().filter((path) => path === HISTORY_CHUNK_PATH),
      'Retry after a mount failure must not re-request the chunk'
    ).toHaveLength(1);
    assertNoPageErrors(page, 'history mount failure retry', {
      reason: 'the boundary reports every caught mount failure by design (FR-004b)',
      match: /route mount failed route=history/
    });
  });

  /**
   * The finding this test exists to hold: **a chunk whose fetch failed cannot be
   * re-requested by retrying the import.** SC-009b was written expecting Retry to
   * issue a second request on the rejection path; in a real browser it issues
   * none. Two caches sit between `loadRoute` and the network, and application
   * code owns neither — the ES module map records the failed fetch and rejects
   * subsequent `import()` of the same specifier without going out again, and
   * Vite's `__vitePreload` helper keeps its own `seen` set of handled deps. The
   * only escape is a fresh specifier (a cache-busting query), which forfeits the
   * static analysis Vite splits chunks by, and so trades FR-013/SC-012 away for
   * a recovery path that matters least: a chunk served from the extension's own
   * `dist/` fails when it is missing, corrupt, or CSP-blocked, and none of those
   * clear on a retry.
   *
   * So the assertion is the outcome, not the wish. That Retry *runs* is
   * established in `App.route-loading.test.ts`, where the loader is mocked and
   * the loading branch reappears; what this test adds is that the network is not
   * re-hit and the surface does not come back. The control at the end keeps the
   * finding narrow: a different lazy route still loads, so what is poisoned is
   * one module, not the loader.
   */
  test('Retry after a load rejection cannot re-fetch a chunk the browser failed', async ({ page }) => {
    await installDeterministicHost(page);
    // Registered after the deterministic host so it wins: Playwright runs the
    // most recently registered matching handler first.
    let blockChunk = true;
    await page.route(`**${HISTORY_CHUNK_PATH}`, async (route) => {
      if (blockChunk) {
        await route.abort();
        return;
      }
      await route.continue();
    });
    const chunkRequests = countChunkRequests(page);

    await page.goto('/dashboard.html');
    await page.addStyleTag({ content: themeCss('dark') });
    await publishSnapshot(page);
    await expect(page.getByTestId('queues-tier')).toBeVisible();

    await page.getByTestId('dashboard-route-history').click();
    const errorBranch = page.getByTestId('dashboard-route-error');
    await expect(errorBranch).toBeVisible();
    expect(chunkRequests().filter((path) => path === HISTORY_CHUNK_PATH)).toHaveLength(1);
    // The browser's own wording, which names no resource — so the allowance
    // cannot pin which fetch failed. The route handler above does: it aborts one
    // path and nothing else, and the request assertion just above confirms that
    // path was requested exactly once. Identity comes from those, not from this
    // regex, and the checkpoint scope keeps it from excusing a later error.
    assertNoPageErrors(page, 'history load rejection', {
      reason: 'the chunk fetch aborted by this test is the failure under test',
      match: /net::ERR_FAILED/
    });

    // Unblocked, so the network would serve the chunk if it were asked. It is not.
    blockChunk = false;
    await errorBranch.getByRole('button', { name: 'Retry' }).click();
    await page.waitForTimeout(RETRY_SETTLE_MS);

    expect(
      chunkRequests().filter((path) => path === HISTORY_CHUNK_PATH),
      'no second request goes out: the module map already holds the failure'
    ).toHaveLength(1);
    await expect(
      page.getByTestId(ROUTE_MOUNT_TARGETS.history),
      'the surface cannot mount from a module the browser refuses to re-fetch'
    ).toHaveCount(0);
    await expect(errorBranch, 'Retry lands back on the error branch').toBeVisible();
    assertNoPageErrors(page, 'history load rejection retry');

    // The control. Without it this test would pass just as well against a loader
    // that had stopped loading anything at all.
    await page.getByTestId('dashboard-route-metrics').click();
    await assertRouteMounted(page, 'metrics', ROUTE_MOUNT_TARGETS.metrics);
    expect(
      chunkRequests().filter((path) => path === '/chunks/MetricsDashboard.js'),
      'an unpoisoned route still loads, so the loader itself is intact'
    ).toHaveLength(1);
  });
});

/**
 * Every element a coarse pointer can actuate. `summary` is here because the
 * settings groups (FR-R3-143) are `<details>`, and a `<summary>` is a natively
 * interactive control that no `button` selector reaches: it toggles the group,
 * it takes focus, and on a touch screen it is tapped exactly like a button.
 * Nothing measured it until this list did, and the theme's coarse-pointer block
 * did not raise it either — the two omissions covered for each other.
 */
const COARSE_POINTER_TARGETS = 'button, input, select, textarea, summary';

/**
 * Returns one description per control that fails the 44px coarse-pointer floor,
 * empty when they all pass. Extracted so the seven-route walk and the settings
 * deep-walk measure by the identical rule; a second inline copy would drift.
 */
async function collectUndersizedTargets(page: Page): Promise<string[]> {
  return page.locator(COARSE_POINTER_TARGETS).evaluateAll((controls) =>
    controls.flatMap((control) => {
      const element = control;
      const view = element.ownerDocument.defaultView;
      const style = view?.getComputedStyle(element);
      if (!style) return [];
      if (style.display === 'none' || style.visibility === 'hidden') return [];
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return [];
      const inputType = element.getAttribute('type');
      if (inputType === 'checkbox' || inputType === 'radio') {
        const label = element.closest('label');
        const labelRect = label?.getBoundingClientRect();
        return labelRect && labelRect.height >= 44
          ? []
          : [`${element.outerHTML.slice(0, 140)} (label height ${labelRect?.height ?? 0})`];
      }
      const tooShort = rect.height < 44;
      const tooNarrow = element.tagName === 'BUTTON' && rect.width < 44;
      return tooShort || tooNarrow
        ? [`${element.outerHTML.slice(0, 140)} (${rect.width}×${rect.height})`]
        : [];
    })
  );
}

/**
 * How far below its row-name button each span after one starts, in px, named by the button's text.
 * A negative offset means the span shares the button's line.
 */
async function rowNameFollowerOffsets(page: Page): Promise<{ name: string; offset: number }[]> {
  return page.locator('.sg button.rowname + span').evaluateAll((followers) =>
    followers.flatMap((follower) => {
      const rowName = follower.previousElementSibling;
      if (!rowName) return [];
      const nameBox = rowName.getBoundingClientRect();
      if (nameBox.height === 0) return [];
      const offset = follower.getBoundingClientRect().top - nameBox.bottom;
      return [{ name: rowName.textContent.trim(), offset }];
    })
  );
}

/** How far a follower's box may rise above the row name's bottom edge and still count as below it. */
const ROW_NAME_FOLLOWER_TOLERANCE_PX = 2;

/** Where a table's row name sits against the rest of its row, in px. */
interface RowNamePlacement {
  readonly name: string;
  /** How far the name's box sits below the top of its cell's content. */
  readonly drop: number;
  /**
   * For each other cell with text, how far the name's first line sits below that cell's first
   * line, with the text the cell starts with. Negative when the name sits higher.
   */
  readonly cells: readonly { readonly cell: string; readonly offset: number }[];
}

/**
 * Where each row name in `table` sits against the rest of its row. Text that is not drawn, being
 * hidden or clipped to a pixel for a screen reader, is skipped, and so is a cell with none.
 */
async function rowNamePlacements(table: Locator): Promise<RowNamePlacement[]> {
  return table.locator('tr button.rowname').evaluateAll((rowNames) => {
    // Through `ownerDocument`, as `collectUndersizedTargets` reaches the page: the tests'
    // TypeScript program has no DOM globals, `NodeFilter` among them.
    const SHOW_TEXT = 0x4;
    const firstLine = (
      root: (typeof rowNames)[number]
    ): { top: number; text: string } | undefined => {
      const walker = root.ownerDocument.createTreeWalker(root, SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim() ?? '';
        const box = node.parentElement?.getBoundingClientRect();
        if (!text || !box || box.width <= 1 || box.height <= 1) continue;
        const range = root.ownerDocument.createRange();
        range.selectNodeContents(node);
        const line = range.getClientRects().item(0);
        if (line && line.height > 0) return { top: line.top, text };
      }
      return undefined;
    };
    return rowNames.flatMap((rowName) => {
      const nameCell = rowName.closest('td');
      const row = nameCell?.parentElement;
      const name = firstLine(rowName);
      const cellStyle = nameCell?.ownerDocument.defaultView?.getComputedStyle(nameCell);
      if (!nameCell || !row || !name || !cellStyle) return [];
      const contentTop =
        nameCell.getBoundingClientRect().top +
        Number.parseFloat(cellStyle.borderTopWidth) +
        Number.parseFloat(cellStyle.paddingTop);
      const cells = [...row.children].flatMap((cell) => {
        const first = cell === nameCell ? undefined : firstLine(cell);
        return first ? [{ cell: first.text, offset: Math.round(name.top - first.top) }] : [];
      });
      return [{ name: name.text, drop: Math.round(rowName.getBoundingClientRect().top - contentTop), cells }];
    });
  });
}

/**
 * How far a row name's first line may sit from the first line of another cell in its row. Text set
 * smaller, such as a chip's caption, starts a few px lower on the same line.
 */
const ROW_NAME_FIRST_LINE_TOLERANCE_PX = 4;

/** How far a row name's box may sit below the top of its cell, for rounding. */
const ROW_NAME_DROP_TOLERANCE_PX = 1;

/**
 * Asserts that `table` has named rows, each with text beside its name, and that every name starts
 * at the top of its cell, on the first line of its row.
 */
async function expectRowNamesOnFirstLine(table: Locator, what: string): Promise<void> {
  const rows = await rowNamePlacements(table);
  expect(rows.length, `the ${what} table has named rows`).toBeGreaterThan(0);
  expect(
    rows.filter(({ cells }) => cells.length === 0),
    `a ${what} row has text beside its name`
  ).toEqual([]);
  expect(
    rows.filter(
      ({ drop, cells }) =>
        drop > ROW_NAME_DROP_TOLERANCE_PX ||
        cells.some(({ offset }) => Math.abs(offset) > ROW_NAME_FIRST_LINE_TOLERANCE_PX)
    ),
    `a ${what} name starts at the top of its cell, on the first line of its row`
  ).toEqual([]);
}

test.describe('responsive accessibility hardening', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('all dashboard routes keep one main landmark, named forms, and coarse-pointer targets', async ({ page }) => {
    await installDeterministicHost(page);
    await page.goto('/dashboard.html');
    await page.addStyleTag({ content: themeCss('dark') });
    await publishSnapshot(page);
    await expect(page.getByTestId('queues-tier')).toBeVisible();
    await expect.poll(() => page.evaluate("matchMedia('(pointer: coarse)').matches")).toBe(true);

    for (const [route, target] of Object.entries(ROUTE_MOUNT_TARGETS)) {
      await page.getByTestId(`dashboard-route-${route}`).click();
      await assertRouteMounted(page, route, target);
      await expect(
        page.getByTestId('dashboard-route-error'),
        `${route} rendered the route error branch instead of its surface`
      ).toHaveCount(0);
      await expect(page.locator('main')).toHaveCount(1);
      if (route === 'builder') {
        await page.getByRole('tab', { name: 'Models' }).click();
      }

      const measureView = async (view: string): Promise<void> => {
        const overflow = await page.evaluate(
          'Math.max(0, document.documentElement.scrollWidth - window.innerWidth)'
        );
        expect(overflow, `${view} introduced page-level horizontal overflow`).toBeLessThanOrEqual(1);

        const undersized = await collectUndersizedTargets(page);
        expect(undersized, `${view} has undersized coarse-pointer controls`).toEqual([]);

        const unnamedForms = await page.locator('input, select, textarea').evaluateAll((controls) =>
          controls.flatMap((control) => {
            const element = control as typeof control & { labels?: { length: number } };
            const labelledBy = element.getAttribute('aria-labelledby');
            const hasLabelledBy = labelledBy
              ?.split(/\s+/)
              .some((id: string) => element.ownerDocument.getElementById(id)?.textContent?.trim());
            const hasName = Boolean(
              element.getAttribute('aria-label')?.trim() ||
              hasLabelledBy ||
              element.labels?.length
            );
            return hasName ? [] : [element.outerHTML.slice(0, 180)];
          })
        );
        expect(unnamedForms, `${view} has unnamed form controls`).toEqual([]);
      };

      // Settings shows one section at a time and hides the rest, and a hidden control has no
      // box, so the route is measured once per section.
      if (route === 'settings') {
        await eachSettingsSection(page, (section) => measureView(`settings (${section})`));
      } else {
        await measureView(route);
      }

      // Per route, not once at the end: the walk visits seven surfaces, and a
      // single end-of-test drain would let the last route's silence stand in for
      // all seven.
      assertNoPageErrors(page, route);
    }
  });

  /**
   * FR-R3-143 (T052) — the walk above visits the settings route in the state the
   * fixture publishes it, and that state hides two of the surface's new controls
   * from every measurement it makes:
   *
   * - **`StringListField`'s per-entry Remove button.** The fixture's
   *   `cliEnvironmentAllowlist` is `[]`, so the `{#each}` renders nothing and the
   *   only list button the walk sees is Add. A Remove that came out at 20px would
   *   be invisible to the walk forever, because the surface the walk measures
   *   never has one.
   * - **A control that only exists after an interaction.** The entry field's
   *   error line (`role="alert"`) is likewise unreachable from a published
   *   snapshot alone.
   *
   * So this seeds a row through the UI rather than through the fixture: typing
   * and clicking Add is the path an operator takes, it exercises `add()`'s
   * validation against the host's own `itemPattern`, and it leaves the shared
   * snapshot — and therefore the settings baselines — untouched. The allowlist
   * is in the Backends section, the one the page lands on.
   */
  test('the settings surface holds the 44px floor once its list controls exist', async ({ page }) => {
    await installDeterministicHost(page);
    await page.goto('/dashboard.html');
    await page.addStyleTag({ content: themeCss('dark') });
    await publishSnapshot(page);
    await expect(page.getByTestId('queues-tier')).toBeVisible();
    await expect.poll(() => page.evaluate("matchMedia('(pointer: coarse)').matches")).toBe(true);

    await page.getByTestId('dashboard-route-settings').click();
    await assertRouteMounted(page, 'settings', ROUTE_MOUNT_TARGETS.settings);

    // The four group headers are `<summary>`, and each one is a tap target. Three are in
    // sections the page hides on arrival, still mounted, so all four are counted.
    const summaries = page.locator('[data-testid^="settings-group-"] > summary');
    await expect(summaries, 'the page renders its four collapsible groups').toHaveCount(4);

    const allowlist = 'cliEnvironmentAllowlist';
    await expect(
      page.getByTestId(`string-list-empty-${allowlist}`),
      'the fixture starts with an empty allowlist, which is why Remove is unmeasured without this'
    ).toBeVisible();

    await page.getByTestId(`general-settings-input-${allowlist}`).fill('HTTPS_PROXY');
    await page.getByTestId(`general-settings-add-${allowlist}`).click();
    const remove = page.getByTestId(`general-settings-remove-${allowlist}-0`);
    await expect(remove, 'Add appends a row, and the row carries its own Remove').toBeVisible();

    const undersized = await collectUndersizedTargets(page);
    expect(undersized, 'settings has undersized coarse-pointer controls').toEqual([]);

    // Named explicitly, because `toEqual([])` above passes just as well when a
    // control stopped rendering as when it is correctly sized.
    const removeBox = await remove.boundingBox();
    expect(removeBox?.height ?? 0, 'the per-entry Remove is a 44px target').toBeGreaterThanOrEqual(44);
    expect(removeBox?.width ?? 0, 'the per-entry Remove is a 44px target').toBeGreaterThanOrEqual(44);

    const overflow = await page.evaluate(
      'Math.max(0, document.documentElement.scrollWidth - window.innerWidth)'
    );
    expect(overflow, 'the seeded allowlist row must not widen the page').toBeLessThanOrEqual(1);

    assertNoPageErrors(page, 'settings coarse-pointer deep walk');
  });

  /**
   * Finding 31 of the webview port review. The theme's coarse-pointer block makes every button at
   * least 44px wide, so a row name narrower than that left a gap after it, before the tag or the
   * id that follows it on its line. Under a coarse pointer that follower takes the line below the
   * name instead. Both lists that put one there are measured: the Queues table, whose default
   * queue carries a tag, and the Phases list, where every name has its id after it.
   *
   * Measured at a tablet's width, because at the walk's 390px the name cells are too narrow for
   * a name and its follower to share a line, so the gap cannot appear there.
   */
  test.describe('at a tablet width', () => {
    test.use({ viewport: { width: 1024, height: 768 } });

    test('puts the tag or id after a row name on the line below it', async ({ page }) => {
      await installDeterministicHost(page);
      await page.goto('/dashboard.html');
      await page.addStyleTag({ content: themeCss('dark') });
      await publishSnapshot(page);
      await expect(page.getByTestId('queues-tier')).toBeVisible();
      await expect.poll(() => page.evaluate("matchMedia('(pointer: coarse)').matches")).toBe(true);
      await expect(page.getByTestId('queue-default-tag')).toBeVisible();

      const queueRows = await rowNameFollowerOffsets(page);
      expect(queueRows.length, 'the default queue tags its name').toBeGreaterThan(0);
      expect(
        queueRows.filter(({ offset }) => offset < -ROW_NAME_FOLLOWER_TOLERANCE_PX),
        'a queue name keeps its tag on the line below'
      ).toEqual([]);

      await page.getByTestId('dashboard-route-builder').click();
      await assertRouteMounted(page, 'builder', ROUTE_MOUNT_TARGETS.builder);
      await page.getByRole('tab', { name: 'Phases' }).click();
      await expect(page.getByTestId(/^phases-list-item-/).first()).toBeVisible();

      const phaseRows = await rowNameFollowerOffsets(page);
      expect(phaseRows.length, 'every Phase name has its id after it').toBeGreaterThan(0);
      expect(
        phaseRows.filter(({ offset }) => offset < -ROW_NAME_FOLLOWER_TOLERANCE_PX),
        'a Phase name keeps its id on the line below'
      ).toEqual([]);

      assertNoPageErrors(page, 'row-name followers under a coarse pointer');
    });

    /**
     * Raised in the webview port review's hand-over. The coarse-pointer block makes a row name's
     * button at least 44px tall and centres its label in that height, while every cell of a table
     * row starts at its top, so a name on one line sat 9 to 12px below the rest of its row. The
     * name also has to stay at the top of its cell: a cell of icon buttons, such as a run's menu or
     * a Phase's order controls, must not push the row down to line up an icon. The three tables
     * whose rows lead with a name are measured: Queues, the Phases list and History.
     */
    test('starts a row name on the first line of its row', async ({ page }) => {
      await installDeterministicHost(page);
      await page.goto('/dashboard.html');
      await page.addStyleTag({ content: themeCss('dark') });
      await publishSnapshot(page);
      await expect(page.getByTestId('queues-tier')).toBeVisible();
      await expect.poll(() => page.evaluate("matchMedia('(pointer: coarse)').matches")).toBe(true);

      await expectRowNamesOnFirstLine(page.getByRole('table', { name: 'Queues' }), 'queue');

      await page.getByTestId('dashboard-route-builder').click();
      await assertRouteMounted(page, 'builder', ROUTE_MOUNT_TARGETS.builder);
      await page.getByRole('tab', { name: 'Phases' }).click();
      await expect(page.getByTestId(/^phases-list-item-/).first()).toBeVisible();
      await expectRowNamesOnFirstLine(page.getByRole('table', { name: 'Phases' }), 'Phase');

      await page.getByTestId('dashboard-route-history').click();
      await assertRouteMounted(page, 'history', ROUTE_MOUNT_TARGETS.history);
      const runsTable = page.getByRole('table', { name: 'Runs, newest first' });
      await expect(runsTable).toBeVisible();
      await expectRowNamesOnFirstLine(runsTable, 'run');

      assertNoPageErrors(page, 'row-name first lines under a coarse pointer');
    });
  });
});

/**
 * Finding 68 of the webview redesign review. Below 761px the Workflows tab stacks its panes, so the
 * Add steps palette folds up over the canvas instead of in towards it, and its toggle's chevron
 * turns a quarter with it: up to collapse, down to expand. The builder photographs keep the
 * side-by-side width, where it points left and right as the redesign draws it.
 */
test.describe('the stacked Workflows tab', () => {
  test.use({ viewport: { width: 760, height: 900 } });

  test('the Add steps toggle points the way the stacked palette folds', async ({ page }) => {
    await installDeterministicHost(page);
    await page.goto('/dashboard.html');
    await page.addStyleTag({ content: themeCss('dark') });
    await publishSnapshot(page);
    await page.getByTestId('dashboard-route-builder').click();
    await expect(page.getByTestId('pipeline-builder-root')).toBeVisible();
    await page.getByRole('tab', { name: 'Workflows' }).click();
    const picker = page.getByTestId('workflow-picker-toggle');
    if ((await picker.getAttribute('aria-expanded')) !== 'true') await picker.click();
    await page.getByTestId('workflows-list-item-dev-new-feature').click();

    const toggle = page.getByTestId('workflow-palette-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // Degrees the chevron is turned clockwise, read from the computed transform.
    const chevronTurn = (): Promise<unknown> =>
      page.evaluate(`(() => {
        const icon = document.querySelector('[data-testid="workflow-palette-toggle"] svg');
        const matrix = new DOMMatrix(getComputedStyle(icon).transform);
        return Math.round((Math.atan2(matrix.b, matrix.a) * 180) / Math.PI);
      })()`);
    await expect(toggle.locator('use')).toHaveAttribute('href', '#i-collapse');
    await expect.poll(chevronTurn, 'the collapse chevron points up').toBe(90);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle.locator('use')).toHaveAttribute('href', '#i-expand');
    await expect.poll(chevronTurn, 'the expand chevron points down').toBe(90);
    // Collapsed, the stacked palette is a bar across the page rather than a 40px rail.
    await expect(
      page.getByTestId('workflow-action-palette').getByText('Add steps', { exact: true }),
      'the collapsed bar keeps its title'
    ).toBeVisible();

    assertNoPageErrors(page, 'stacked Workflows tab');
  });
});

/** One control of the Workflow editor's head, as the keyboard meets it, and where it is drawn. */
interface HeadStop {
  readonly unit: unknown;
  readonly name: string;
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
}

/**
 * Where the Workflow editor's head breaks reading order, as "from -> to" pairs of the controls
 * the keyboard meets in turn. Read left to right and top to bottom, each control must sit on the
 * same line as the one before it and to its right, or on a later line. The open Workflow list
 * counts as one control, its own box, so rows scrolled out of its height stay out of the measure.
 */
async function editorHeadOrderBreaks(page: Page): Promise<string[]> {
  return page.locator('[data-testid="workflow-catalog-editor"] .ed-head').evaluate((head) => {
    const list = head.querySelector('[data-testid="workflow-picker-list"]');
    const stops: HeadStop[] = [];
    for (const element of head.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')) {
      if (element.tabIndex < 0 || element.matches(':disabled') || !element.checkVisibility()) continue;
      const unit = list?.contains(element) === true ? list : element;
      if (stops.at(-1)?.unit === unit) continue;
      const { top, bottom, left } = unit.getBoundingClientRect();
      const name = unit.getAttribute('data-testid') ?? unit.getAttribute('aria-label') ?? unit.tagName;
      stops.push({ unit, name, top, bottom, left });
    }
    const breaks: string[] = [];
    let before: HeadStop | undefined;
    for (const stop of stops) {
      if (before !== undefined) {
        const laterLine = stop.top >= before.bottom - 1;
        const sameLineAfter = stop.top < before.bottom && stop.bottom > before.top && stop.left >= before.left;
        if (!laterLine && !sameLineAfter) breaks.push(`${before.name} -> ${stop.name}`);
      }
      before = stop;
    }
    return breaks;
  });
}

/**
 * The open Workflow list is the switcher's: it comes straight after the switcher in the DOM and
 * the tab order, so it must come straight after the switcher's line on screen too, with the
 * head's actions after it. Drawn below the actions, a list the keyboard reaches before them sends
 * focus down and then back up the page (WCAG 2.4.3). Finding 54 of the webview port review.
 */
test('the open Workflow list comes after the switcher on screen as in the tab order', async ({
  page
}) => {
  await installDeterministicHost(page);
  await page.goto('/dashboard.html');
  await page.addStyleTag({ content: themeCss('dark') });
  await publishSnapshot(page);
  await page.getByTestId('dashboard-route-builder').click();
  await expect(page.getByTestId('pipeline-builder-root')).toBeVisible();
  await page.getByRole('tab', { name: 'Workflows' }).click();
  const picker = page.getByTestId('workflow-picker-toggle');
  if ((await picker.getAttribute('aria-expanded')) !== 'true') await picker.click();
  await expect(page.getByTestId('workflow-picker-list')).toBeVisible();
  expect(await editorHeadOrderBreaks(page), 'with no Workflow open').toEqual([]);

  await page.getByTestId('workflows-list-item-dev-new-feature').click();
  await expect(page.getByTestId('workflow-field-name')).toBeVisible();
  await picker.click();
  await expect(page.getByTestId('workflow-picker-list')).toBeVisible();
  expect(await editorHeadOrderBreaks(page), 'with a Workflow open').toEqual([]);

  assertNoPageErrors(page, 'Workflow picker order');
});

/**
 * The space under the Builder's tabs. The workflow builder mockup draws its editor 10px under its
 * tabs, and the surfaces mockup, which leaves the Workflows tab to it, spaces its other pages 14px
 * under theirs. Finding 66 of the webview port review.
 */
test('the Workflow editor stands as far under the tabs as the builder mockup draws it', async ({
  page
}) => {
  await installDeterministicHost(page);
  await page.goto('/dashboard.html');
  await page.addStyleTag({ content: themeCss('dark') });
  await publishSnapshot(page);
  await page.getByTestId('dashboard-route-builder').click();
  await expect(page.getByTestId('pipeline-builder-root')).toBeVisible();
  // Pixels from the tabs' bottom edge down to the top of the box the selector names.
  const gapUnderTabs = (selector: string): Promise<unknown> =>
    page.evaluate(`(() => {
      const tabs = document.querySelector('.builder-tabs').getBoundingClientRect();
      const below = document.querySelector('${selector}').getBoundingClientRect();
      return Math.round((below.top - tabs.bottom) * 10) / 10;
    })()`);
  await expect.poll(() => gapUnderTabs('.builder-canvas'), 'under the Phases tab').toBe(14);

  await page.getByRole('tab', { name: 'Workflows' }).click();
  const head = '[data-testid="workflow-catalog-editor"] .ed-head';
  await expect(page.locator(head)).toBeVisible();
  await expect.poll(() => gapUnderTabs(head), 'with no Workflow open').toBe(10);
  const picker = page.getByTestId('workflow-picker-toggle');
  if ((await picker.getAttribute('aria-expanded')) !== 'true') await picker.click();
  await page.getByTestId('workflows-list-item-dev-new-feature').click();
  await expect(page.getByTestId('workflow-field-name')).toBeVisible();
  await expect.poll(() => gapUnderTabs(head), 'with a Workflow open').toBe(10);

  assertNoPageErrors(page, 'Builder tabs spacing');
});
