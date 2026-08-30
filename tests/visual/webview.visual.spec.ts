import { expect, test, type Locator, type Page } from '@playwright/test';
import metricsJson from './fixtures/metrics-response.json';
import phaseLogJson from './fixtures/phase-log-response.json';
import { workflowSnapshot } from './fixtures/workflow-snapshot';
// The webview's route union, imported across the CJS/ESM line that was thought
// to block it. `tests/` is type-checked as Node16/CJS and `webview-ui` is
// `"type": "module"`, which raises TS1541 for a bare type-only import — but
// `resolution-mode` resolves it, and the `.js` extension is not optional (drop
// it and the diagnostic is TS2835, which is what made this look unreachable).
// Type-only, so nothing survives to runtime and Playwright's transform erases it.
import type { DashboardRoute } from '../../webview-ui/src/dashboard/routes.js' with { 'resolution-mode': 'import' };

type ThemeName = 'light' | 'dark' | 'high-contrast';
type SurfaceName =
  | 'sidebar'
  | 'queues'
  | 'builder'
  | 'metrics'
  | 'activity-feed';

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
  // Feature 098 (T067, FR-043) — `pipelines-discard` is here because the
  // fixture's two Pipelines used to claim `scope: 'built-in'`, a state no
  // installation can now reach: the built-in layer holds no rows, so every
  // Pipeline an operator has is one they imported into `user` or `workspace`.
  // The fixture now says `workspace`, and this landmark is what holds it there
  // — the control renders only for a scope that is not `built-in`. The scope
  // also appears twice in the photograph itself (a badge in the list, and the
  // testid of each list row), so a regression would show up as a pixel diff;
  // this fails with the landmark's name instead.
  builder: {
    present: [
      'pipeline-builder-root',
      'pipelines-save-all',
      'pipelines-sequence-status',
      'pipelines-discard'
    ],
    absent: [
      'pipeline-catalog-error',
      'pipeline-catalog-loading',
      'pipelines-no-phases',
      'save-error-banner'
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
  runs: 'runs-surface',
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

interface ThemePalette {
  readonly foreground: string;
  readonly background: string;
  readonly muted: string;
  readonly border: string;
  readonly input: string;
  readonly hover: string;
  readonly active: string;
  readonly focus: string;
  readonly blue: string;
  readonly green: string;
  readonly yellow: string;
  readonly red: string;
  readonly purple: string;
}

const metricsResponse: unknown = metricsJson;
const phaseLogResponse: unknown = phaseLogJson;

const THEMES: Readonly<Record<ThemeName, ThemePalette>> = {
  light: {
    foreground: '#1f2328',
    background: '#ffffff',
    muted: '#59636e',
    border: '#d0d7de',
    input: '#f6f8fa',
    hover: '#eaeef2',
    active: '#dbeafe',
    focus: '#0969da',
    blue: '#0969da',
    green: '#1a7f37',
    yellow: '#9a6700',
    red: '#cf222e',
    purple: '#8250df'
  },
  dark: {
    foreground: '#e6edf3',
    background: '#0d1117',
    muted: '#8b949e',
    border: '#30363d',
    input: '#161b22',
    hover: '#21262d',
    active: '#1f3a5f',
    focus: '#58a6ff',
    blue: '#58a6ff',
    green: '#3fb950',
    yellow: '#d29922',
    red: '#f85149',
    purple: '#bc8cff'
  },
  'high-contrast': {
    foreground: '#ffffff',
    background: '#000000',
    muted: '#ffffff',
    border: '#ffffff',
    input: '#000000',
    hover: '#1a1a1a',
    active: '#000000',
    focus: '#ffff00',
    blue: '#00ffff',
    green: '#00ff00',
    yellow: '#ffff00',
    red: '#ff5555',
    purple: '#ff7fff'
  }
};

function themeCss(theme: ThemeName): string {
  const palette = THEMES[theme];
  return `
    :root {
      color-scheme: ${theme === 'light' ? 'light' : 'dark'};
      --vscode-font-family: Arial, sans-serif;
      --vscode-editor-font-family: monospace;
      --vscode-font-size: 14px;
      --vscode-foreground: ${palette.foreground};
      --vscode-descriptionForeground: ${palette.muted};
      --vscode-disabledForeground: ${palette.muted};
      --vscode-editor-background: ${palette.background};
      --vscode-sideBar-background: ${palette.background};
      --vscode-editorWidget-background: ${palette.input};
      --vscode-editorWidget-border: ${palette.border};
      --vscode-panel-border: ${palette.border};
      --vscode-sideBarSectionHeader-border: ${palette.border};
      --vscode-widget-border: ${palette.border};
      --vscode-widget-shadow: rgba(0, 0, 0, 0.35);
      --vscode-input-background: ${palette.input};
      --vscode-input-foreground: ${palette.foreground};
      --vscode-input-border: ${palette.border};
      --vscode-button-background: ${palette.blue};
      --vscode-button-foreground: ${theme === 'light' ? '#ffffff' : '#000000'};
      --vscode-button-hoverBackground: ${palette.focus};
      --vscode-button-secondaryBackground: ${palette.input};
      --vscode-button-secondaryForeground: ${palette.foreground};
      --vscode-button-secondaryHoverBackground: ${palette.hover};
      --vscode-button-border: ${palette.border};
      --vscode-list-hoverBackground: ${palette.hover};
      --vscode-list-activeSelectionBackground: ${palette.active};
      --vscode-list-activeSelectionForeground: ${palette.foreground};
      --vscode-toolbar-hoverBackground: ${palette.hover};
      --vscode-focusBorder: ${palette.focus};
      --vscode-badge-background: ${palette.blue};
      --vscode-badge-foreground: ${theme === 'light' ? '#ffffff' : '#000000'};
      --vscode-charts-blue: ${palette.blue};
      --vscode-charts-green: ${palette.green};
      --vscode-charts-yellow: ${palette.yellow};
      --vscode-charts-orange: ${palette.yellow};
      --vscode-charts-red: ${palette.red};
      --vscode-charts-purple: ${palette.purple};
      --vscode-errorForeground: ${palette.red};
      --vscode-editorWarning-foreground: ${palette.yellow};
      --vscode-notificationsInfoIcon-foreground: ${palette.blue};
      --vscode-notificationsWarningIcon-foreground: ${palette.yellow};
      --vscode-testing-iconPassed: ${palette.green};
      --vscode-testing-iconFailed: ${palette.red};
      --vscode-testing-iconQueued: ${palette.yellow};
      --vscode-textBlockQuote-background: ${palette.input};
      --vscode-textCodeBlock-background: ${palette.input};
      --vscode-textLink-foreground: ${palette.blue};
      --vscode-editorHoverWidget-background: ${palette.input};
      --vscode-editorHoverWidget-foreground: ${palette.foreground};
      --vscode-editorHoverWidget-border: ${palette.border};
      --vscode-inputValidation-errorBackground: ${palette.input};
      --vscode-inputValidation-errorBorder: ${palette.red};
      --vscode-inputValidation-infoBackground: ${palette.input};
      --vscode-inputValidation-warningBackground: ${palette.input};
      --vscode-inputValidation-warningBorder: ${palette.yellow};
      --vscode-inputValidation-warningForeground: ${palette.yellow};
    }
    html, body { background: ${palette.background} !important; }
    *, *::before, *::after { animation: none !important; transition: none !important; }
  `;
}

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
    // Feature 180 (T1556, FR-005) — the Builder opens on Phases now, so the tab
    // this baseline frames has to be asked for. Role and name rather than a test
    // id: the tab buttons carry `id="builder-tab-{id}"` and no `data-testid`
    // (`BuilderTabs.svelte`), and this is the handle a screen-reader user has.
    // Capturing Pipelines rather than the new landing tab is deliberate — it
    // keeps the strip the only difference between these baselines and their
    // predecessors, which is what makes the comparison evidence.
    await page.getByRole('tab', { name: 'Pipelines' }).click();
    await builder.locator('.phase-list-item').first().click();
    await expect(page.getByTestId('pipelines-name-field-dev-new-feature')).toBeVisible();
    return builder;
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

for (const theme of ['light', 'dark', 'high-contrast'] as const) {
  for (const surface of [
    'sidebar',
    'queues',
    'builder',
    'metrics',
    'activity-feed'
  ] as const) {
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

      const overflow = await page.evaluate(
        'Math.max(0, document.documentElement.scrollWidth - window.innerWidth)'
      );
      expect(overflow, `${route} introduced page-level horizontal overflow`).toBeLessThanOrEqual(1);

      const undersized = await page.locator('button, input, select, textarea').evaluateAll((controls) =>
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
      expect(undersized, `${route} has undersized coarse-pointer controls`).toEqual([]);

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
      expect(unnamedForms, `${route} has unnamed form controls`).toEqual([]);

      // Per route, not once at the end: the walk visits seven surfaces, and a
      // single end-of-test drain would let the last route's silence stand in for
      // all seven.
      assertNoPageErrors(page, route);
    }
  });
});
