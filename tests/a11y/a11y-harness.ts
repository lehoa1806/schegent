// FR-R3-091 — the accessibility scan's page setup.
//
// WHAT IS REUSED, and it is what the item names. FR-R3-091 §3: "in the same
// harness the visual suite already uses to serve them —
// `serve-built-webviews.mjs` exists and this reuses it rather than standing up a
// second one." The scan runs under a Playwright project whose `webServer` is
// that exact script. There is one server.
//
// The FIXTURES are shared too — `tests/visual/fixtures/` — so the scan looks at
// a populated app rather than an empty shell. An empty-state scan would report a
// clean accessibility tree for surfaces that render almost nothing, which is a
// false assurance of exactly the kind this item exists to prevent.
//
// WHAT IS NOT SHARED, stated rather than left to be discovered: the visual
// suite's `installDeterministicHost` also pins fonts, animation, chunk counting
// and error capture — machinery a screenshot needs and a rule engine does not.
// Rather than extract 800 lines of carefully-reasoned spec mid-change, the boot
// CONTRACT the two must agree on — the theme class names and the message shape
// that publishes a snapshot — is asserted by
// `tests/lint/a11y-policy-parity.test.ts`, so the two cannot drift apart
// silently.
import type { Page } from '@playwright/test';
import { workflowSnapshot } from '../visual/fixtures/workflow-snapshot';

export type ThemeName = 'light' | 'dark' | 'high-contrast';

/** The body class VS Code sets for each theme. Pinned against the visual suite. */
export const THEME_CLASS: Readonly<Record<ThemeName, string>> = {
  light: 'vscode-light',
  dark: 'vscode-dark',
  'high-contrast': 'vscode-high-contrast'
};

export const THEMES: readonly ThemeName[] = ['light', 'dark', 'high-contrast'];

function inlineJson(value: unknown): string {
  // Annotated `string | undefined` because that is what it is: `JSON.stringify`
  // returns `undefined` for `undefined`, a function, or a symbol. The lib type
  // says `string`, which is why the guard below reads as unnecessary to the
  // type-aware rule while being entirely necessary at run time.
  // Cast, not an annotation: an annotation is narrowed away by the initializer's
  // declared type, so the guard still reads as impossible. The cast states the
  // truth the lib type omits — `JSON.stringify` returns `undefined` for
  // `undefined`, a function or a symbol — and keeps the run-time guard real.
  const encoded = JSON.stringify(value) as string | undefined;
  if (encoded === undefined) throw new Error('a11y fixture is not JSON-serializable');
  return encoded.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

/**
 * The two webviews this extension ships. FR-R3-131: the scan covered only the
 * dashboard, and printed `excluded routes: (none)` while an entire webview went
 * unscanned — an undeclared limit read as full coverage, which is the exact
 * failure `EXCLUDED_ROUTES` was created to prevent one level down. The sidebar's
 * `.elapsed-pill` was carrying the same accent-as-small-text pair as the 24
 * baselined dashboard findings, and nothing had ever looked.
 *
 * The viewport widths are the visual suite's, for the same reason the fixtures
 * are shared: the sidebar is a narrow panel in the real product, and a contrast
 * scan at dashboard width would measure a layout nobody sees.
 */
export const WEBVIEWS = {
  dashboard: { path: '/dashboard.html', viewport: { width: 1440, height: 960 } },
  sidebar: { path: '/index.html', viewport: { width: 360, height: 720 } }
} as const;

export type WebviewName = keyof typeof WEBVIEWS;

/**
 * Serve the built dashboard, in one theme, with the shared fixture published.
 *
 * External requests are refused rather than allowed to hang: a scan waiting on a
 * font CDN measures the network, and the CSP the real webview runs under would
 * refuse them anyway.
 */
export async function openDashboard(page: Page, theme: ThemeName): Promise<void> {
  await openWebview(page, theme, 'dashboard');
}

/** The sidebar panel, the extension's other webview. Same fixture, same themes. */
export async function openSidebar(page: Page, theme: ThemeName): Promise<void> {
  await openWebview(page, theme, 'sidebar');
}

async function openWebview(page: Page, theme: ThemeName, webview: WebviewName): Promise<void> {
  await page.setViewportSize(WEBVIEWS[webview].viewport);
  await page.emulateMedia({
    colorScheme: theme === 'light' ? 'light' : 'dark',
    reducedMotion: 'reduce',
    forcedColors: 'none'
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === 'http://127.0.0.1:4173') {
      await route.continue();
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/css', body: '' });
  });
  await page.goto(WEBVIEWS[webview].path);
  await page.evaluate(`
    document.body.classList.remove(
      'vscode-light',
      'vscode-dark',
      'vscode-high-contrast',
      'vscode-high-contrast-light'
    );
    document.body.classList.add(${JSON.stringify(THEME_CLASS[theme])});
  `);
  await page.evaluate(
    `window.dispatchEvent(new MessageEvent('message', { data: { type: 'STATE_SNAPSHOT', payload: ${inlineJson(
      workflowSnapshot
    )} } }))`
  );
}
