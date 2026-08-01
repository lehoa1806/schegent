import { expect, test, type Locator, type Page } from '@playwright/test';
import metricsJson from './fixtures/metrics-response.json';
import phaseLogJson from './fixtures/phase-log-response.json';
import snapshotJson from './fixtures/workflow-snapshot.json';

type ThemeName = 'light' | 'dark' | 'high-contrast';
type SurfaceName = 'sidebar' | 'dashboard' | 'pipeline-builder' | 'metrics' | 'activity-feed';

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
    const metrics = page.getByTestId('metrics-section');
    await expect(page.getByTestId('metrics-task-table')).toBeVisible();
    return metrics;
  }

  if (surface === 'pipeline-builder') {
    await page.getByTestId('dashboard-route-pipeline-builder').click();
    const builder = page.getByTestId('pipeline-builder-root');
    await expect(builder).toBeVisible();
    await builder.locator('.phase-list-item').first().click();
    await expect(page.getByTestId('pipelines-name-field-dev-new-feature')).toBeVisible();
    return builder;
  }

  await page.getByTestId('dashboard-route-operations').click();
  if (surface === 'activity-feed') {
    const feed = page.getByTestId('dashboard-activity-audit-feed');
    await expect(page.getByTestId('phase-log-entry').first()).toBeVisible();
    return feed;
  }

  const dashboard = page.getByTestId('dashboard-root');
  await expect(dashboard).toBeVisible();
  return dashboard;
}

const volatileMasks = (page: Page): readonly Locator[] => [
  page.locator('[data-testid^="metrics-task-row-"] > td:nth-child(3)'),
  page.locator('[data-testid^="metrics-task-row-"] > td:nth-child(4)'),
  page.locator('[data-testid="metrics-coverage-window"]'),
  page.locator('time.ts'),
  page.getByTestId('sidebar-telemetry-row')
];

for (const theme of ['light', 'dark', 'high-contrast'] as const) {
  for (const surface of ['sidebar', 'dashboard', 'pipeline-builder', 'metrics', 'activity-feed'] as const) {
    test(`${surface} remains visually stable in ${theme}`, async ({ page }) => {
      const target = await openSurface(page, surface, theme);
      await expect(target).toHaveScreenshot(`${surface}-${theme}.png`, {
        mask: [...volatileMasks(page)],
        maskColor: theme === 'light' ? '#e5e7eb' : '#334155'
      });
    });
  }
}
