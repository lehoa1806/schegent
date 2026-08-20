import { expect, test, type Locator, type Page } from '@playwright/test';
import metricsJson from './fixtures/metrics-response.json';
import phaseLogJson from './fixtures/phase-log-response.json';
import snapshotJson from './fixtures/workflow-snapshot.json';

type ThemeName = 'light' | 'dark' | 'high-contrast';
type SurfaceName =
  | 'sidebar'
  | 'queues'
  | 'builder'
  | 'metrics'
  | 'activity-feed';

/** The one queue `fixtures/workflow-snapshot.json` registers. */
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

const workflowSnapshot: unknown = snapshotJson;
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
      await expect(target).toHaveScreenshot(`${surface}-${theme}.png`, {
        mask: [...volatileMasks(page)],
        maskColor: theme === 'light' ? '#e5e7eb' : '#334155'
      });
    });
  }
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

    const routeTargets = {
      // The operations route lands on the Queues tier since feature 092; the
      // pane that used to be here is a click deeper and is covered by the
      // `dashboard` surface above.
      operations: 'queues-tier',
      history: 'history-dashboard',
      metrics: 'metrics-section',
      system: 'system-tab',
      builder: 'pipeline-builder-root',
      settings: 'settings-surface-root'
    } as const;

    for (const [route, target] of Object.entries(routeTargets)) {
      await page.getByTestId(`dashboard-route-${route}`).click();
      await expect(page.getByTestId(target)).toBeVisible();
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
    }
  });
});
