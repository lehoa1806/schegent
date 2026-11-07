// The webview under the policy the extension actually ships (FR-R4-F08, contract P).
//
// WHAT THIS PINS. Every other visual spec serves the built pages through
// `serve-built-webviews.mjs`, which strips the `__CSP__` meta from `index.html`
// and never had one in `dashboard.html`, so no browser check in this repository
// has ever run the webview under the policy `buildCspMeta` builds. This spec
// fulfils both pages through the production renderers (`renderWebviewHtml`,
// `renderDashboardHtml`) with a real, fresh nonce per response, a fake webview
// whose `cspSource` is the local test origin, and records every
// `securitypolicyviolation` the pages raise.
//
// WHY. A policy violation is silent to an operator: a blocked inline style just
// does not apply. Thirteen static `style="..."` attributes in the Builder's
// editors are exactly that. The spec lists the violations it sees, fails on any
// that `EXPECTED_VIOLATIONS` does not name (the list starts empty), and asserts
// the computed style of every element whose inline attribute moved to a class.
//
// HERMETIC (contract P4, standing rule 16). It uses no `addStyleTag` and no
// `addScriptTag`, which would be violations of the spec's own making. Every
// request outside `http://127.0.0.1:4173` is aborted and counted, and the count
// must be zero. Snapshots are published with `page.evaluate`.
//
// Contract items: P1 to P8, P10's hardened run; tests P-T1 to P-T5.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { relative, resolve, sep } from 'node:path';
import { buildCspMeta, generateNonce } from '../../src/ui/sidebar/csp';
import { renderDashboardHtml } from '../../src/ui/dashboard/dashboard-html';
import { renderWebviewHtml, type UriLike, type WebviewLike } from '../../src/ui/sidebar/html';
import {
  POLICY_SMOKE_BRANCH_COUNT,
  POLICY_SMOKE_PENDING_TASK_ID,
  POLICY_SMOKE_PHASE_ID,
  POLICY_SMOKE_QUEUE_ID,
  POLICY_SMOKE_ROUTES,
  POLICY_SMOKE_WORKFLOW_ID,
  policySmokeSnapshot,
  type PolicySmokeRoute
} from './fixtures/policy-smoke-snapshot';

/** The one origin the page may touch: the local test asset server. */
const ORIGIN = 'http://127.0.0.1:4173';
const BUNDLE_DIR = resolve(process.cwd(), 'dist/webview');
const CONTROL_PATH = '/__policy-control.html';
const SIDEBAR_PATHS = ['/', '/index.html'] as const;
const DASHBOARD_PATH = '/dashboard.html';
/** Pages this spec serves itself. A violation naming one is the app's own. */
const APP_PAGE_PATHS: readonly string[] = [...SIDEBAR_PATHS, DASHBOARD_PATH, CONTROL_PATH];
/** Appended to the rendered policy for the hardened run (P10); never added in `csp.ts` here. */
const HARDENING_DIRECTIVES = " base-uri 'none'; form-action 'none';";
const SIDEBAR_VIEWPORT = { width: 360, height: 720 } as const;
const DASHBOARD_VIEWPORT = { width: 1440, height: 960 } as const;
/** How close a right-aligned control must sit to its container's content edge. */
const EDGE_TOLERANCE_PX = 1;

/** One `securitypolicyviolation` event, with the fields data model section 5 names. */
interface PolicyViolationRecord {
  readonly page: string;
  readonly effectiveDirective: string;
  readonly blockedURI: string;
  readonly sourceFile: string;
  readonly lineNumber: number;
  readonly sample: string;
}

/** A violation the spec tolerates. Both fields that identify it, and why. */
interface ExpectedViolation {
  readonly effectiveDirective: string;
  readonly blockedURI: string;
  readonly reason: string;
}

/**
 * The tolerated violations. It starts empty (clarification 5) and a reviewer
 * adds to it only for a source the app does not own, with a reason.
 */
const EXPECTED_VIOLATIONS: readonly ExpectedViolation[] = [];

/** True when a blocked source can only be the app's own markup, bundle or pages. */
function isAppOwnedSource(blockedURI: string): boolean {
  return (
    blockedURI.startsWith(ORIGIN) ||
    APP_PAGE_PATHS.includes(blockedURI) ||
    blockedURI.startsWith('/') ||
    blockedURI === 'inline' ||
    blockedURI === 'eval'
  );
}

/**
 * The problems with an expected list; empty when the list is acceptable. An
 * entry with no reason, or one naming a source the app owns (the local origin,
 * a page path, `inline` or `eval`), would hide the findings this spec exists to
 * make (FR-026).
 */
function listProblems(list: readonly ExpectedViolation[]): readonly string[] {
  const problems: string[] = [];
  for (const entry of list) {
    const name = `${entry.effectiveDirective} ${entry.blockedURI}`;
    if (entry.reason.trim() === '') problems.push(`${name}: the reason is empty`);
    if (isAppOwnedSource(entry.blockedURI)) {
      problems.push(`${name}: the blocked source is one the app owns`);
    }
  }
  return problems;
}

/** Every record the list does not match on both directive and blocked source. */
function unexpectedRecords(
  records: readonly PolicyViolationRecord[]
): readonly PolicyViolationRecord[] {
  return records.filter(
    (record) =>
      !EXPECTED_VIOLATIONS.some(
        (entry) =>
          entry.effectiveDirective === record.effectiveDirective &&
          entry.blockedURI === record.blockedURI
      )
  );
}

/** The fake webview: only the local origin, and a path mapping into the bundle. */
const fakeWebview: WebviewLike = {
  cspSource: ORIGIN,
  asWebviewUri: (uri: UriLike) => ({
    toString: () => `${ORIGIN}/${relative(BUNDLE_DIR, uri.fsPath).split(sep).join('/')}`
  })
};

const toLocalUri = (fsPath: string): UriLike => ({ fsPath, scheme: 'file' });

/** A page this spec served, with the nonce it carried. */
interface ServedPage {
  readonly path: string;
  readonly html: string;
  readonly nonce: string;
  readonly hardened: boolean;
}

interface PolicyContext {
  readonly page: Page;
  readonly served: ServedPage[];
  readonly aborted: string[];
  readonly pageErrors: string[];
  readonly hardened: boolean;
}

/** The control page: three things the policy must refuse or allow, under the same policy. */
function controlPageHtml(nonce: string): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${buildCspMeta(ORIGIN, nonce)}">`,
    '<title>Policy control</title></head><body>',
    '<p id="parser-inserted" style="color: red">parser-inserted style attribute</p>',
    '<template id="control-template"><p id="template-cloned" style="color: blue">template-cloned style attribute</p></template>',
    `<script nonce="${nonce}">document.body.appendChild(document.getElementById('control-template').content.cloneNode(true));</script>`,
    '<script>window.__unnoncedInlineRan = true;</script>',
    '</body></html>'
  ].join('\n');
}

/**
 * The policy for the hardened run: what `buildCspMeta` builds plus `base-uri 'none'` and
 * `form-action 'none'`. Once `buildCspMeta` carries them itself nothing is appended, so the
 * hardened run keeps submitting every form under the shipped policy instead of duplicating it.
 */
function hardenedPolicy(policy: string): string {
  const carriesBoth = policy.includes("base-uri 'none'") && policy.includes("form-action 'none'");
  return carriesBoth ? policy : `${policy}${HARDENING_DIRECTIVES}`;
}

function withHardening(html: string, nonce: string): string {
  const policy = buildCspMeta(ORIGIN, nonce);
  return html.replace(policy, hardenedPolicy(policy));
}

async function renderServedPage(pathname: string, hardened: boolean): Promise<ServedPage | null> {
  if (SIDEBAR_PATHS.some((candidate) => candidate === pathname)) {
    const rendered = await renderWebviewHtml({
      webview: fakeWebview,
      extensionRoot: process.cwd(),
      webviewBundleDir: BUNDLE_DIR,
      toLocalUri
    });
    const html = hardened ? withHardening(rendered.html, rendered.nonce) : rendered.html;
    return { path: '/index.html', html, nonce: rendered.nonce, hardened };
  }
  if (pathname === DASHBOARD_PATH) {
    const nonce = generateNonce();
    const rendered = renderDashboardHtml({
      webview: fakeWebview,
      extensionRoot: process.cwd(),
      webviewBundleDir: BUNDLE_DIR,
      nonce,
      toLocalUri
    });
    const html = hardened ? withHardening(rendered, nonce) : rendered;
    return { path: DASHBOARD_PATH, html, nonce, hardened };
  }
  if (pathname === CONTROL_PATH) {
    const nonce = generateNonce();
    return { path: CONTROL_PATH, html: controlPageHtml(nonce), nonce, hardened: false };
  }
  return null;
}

/**
 * The init script: a capturing violation listener and the fake host API. Init
 * scripts are not page script, so neither is subject to the policy under test.
 */
const INIT_SCRIPT = `(() => {
  const records = [];
  Object.defineProperty(window, '__policyViolations', { value: records });
  document.addEventListener('securitypolicyviolation', (event) => {
    records.push({
      page: location.pathname + location.hash,
      effectiveDirective: event.effectiveDirective,
      blockedURI: event.blockedURI,
      sourceFile: event.sourceFile,
      lineNumber: event.lineNumber,
      sample: event.sample
    });
  }, true);
  let persistedState;
  const emit = (data) => window.dispatchEvent(new MessageEvent('message', { data }));
  const api = {
    postMessage(message) {
      if (!message || typeof message !== 'object') return;
      if (typeof message.correlationId !== 'string') return;
      window.setTimeout(() => emit({
        type: 'CMD_ACK', correlationId: message.correlationId, status: 'accepted'
      }), 0);
    },
    setState(state) { persistedState = state; },
    getState() { return persistedState; }
  };
  Object.defineProperty(window, 'acquireVsCodeApi', {
    configurable: false, enumerable: false, value: () => api
  });
})();`;

/** Serve both pages through the production renderers, abort everything else off-origin. */
async function openPolicyContext(page: Page, hardened: boolean): Promise<PolicyContext> {
  // The expected list is checked before any page loads (FR-026).
  expect(listProblems(EXPECTED_VIOLATIONS), 'the expected-violations list itself').toEqual([]);
  const context: PolicyContext = { page, served: [], aborted: [], pageErrors: [], hardened };
  page.on('pageerror', (error) => context.pageErrors.push(`${error.name}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') process.stdout.write(`POLICY_CONSOLE ${message.text()}\n`);
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      context.aborted.push(url.href);
      await route.abort();
      return;
    }
    const served = await renderServedPage(url.pathname, hardened);
    if (served === null) {
      await route.continue();
      return;
    }
    context.served.push(served);
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      headers: { 'Cache-Control': 'no-store' },
      body: served.html
    });
  });
  await page.addInitScript({ content: INIT_SCRIPT });
  return context;
}

/** The policy text a served page carries, read from its meta element. */
function policyOf(html: string): string | null {
  const match = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html);
  return match === null ? null : match.at(1) ?? null;
}

/**
 * Before any verdict: each served page carries exactly the policy `buildCspMeta`
 * builds for its nonce, and a nonced script under the local origin. The
 * renderers fall back silently to a template when the bundle is missing, so a
 * stale `dist/webview` could otherwise mount a stand-in and pass (TA3).
 */
function assertServedPagesAreReal(context: PolicyContext): void {
  expect(context.served.length, 'the spec served no page of its own').toBeGreaterThan(0);
  for (const served of context.served) {
    if (served.path === CONTROL_PATH) continue;
    const expectedPolicy = buildCspMeta(ORIGIN, served.nonce);
    const expected = served.hardened ? hardenedPolicy(expectedPolicy) : expectedPolicy;
    expect(policyOf(served.html), `${served.path}: the policy text`).toBe(expected);
    const scriptTags = served.html.match(/<script\b[^>]*>/gi) ?? [];
    const realScript = scriptTags.some(
      (tag) => tag.includes(`nonce="${served.nonce}"`) && tag.includes(`src="${ORIGIN}/`)
    );
    expect(realScript, `${served.path}: a nonced script under ${ORIGIN}/`).toBe(true);
  }
}

async function publishSnapshot(page: Page, snapshot: unknown = policySmokeSnapshot): Promise<void> {
  await page.evaluate((payload) => {
    // `globalThis` is the page's window; this tsconfig carries no DOM lib.
    const host = globalThis as unknown as { dispatchEvent(event: unknown): boolean };
    host.dispatchEvent(new MessageEvent('message', { data: { type: 'STATE_SNAPSHOT', payload } }));
  }, JSON.parse(JSON.stringify(snapshot)) as unknown);
}

async function collectViolations(page: Page): Promise<readonly PolicyViolationRecord[]> {
  return page.evaluate(() => {
    const store = globalThis as unknown as { __policyViolations: PolicyViolationRecord[] };
    return store.__policyViolations.splice(0, store.__policyViolations.length);
  });
}

function printRecords(label: string, records: readonly PolicyViolationRecord[]): void {
  for (const record of records) {
    const expected = unexpectedRecords([record]).length === 0;
    process.stdout.write(
      `POLICY_VIOLATION ${JSON.stringify({ label, expected, ...record })}\n`
    );
  }
}

async function mountSidebar(context: PolicyContext): Promise<readonly PolicyViolationRecord[]> {
  const { page } = context;
  await page.setViewportSize(SIDEBAR_VIEWPORT);
  await page.goto('/index.html');
  await publishSnapshot(page);
  await expect(page.getByTestId('sidebar-status-row'), 'the sidebar mount target').toBeVisible();
  const records = await collectViolations(page);
  printRecords('sidebar', records);
  return records;
}

async function mountDashboard(context: PolicyContext): Promise<readonly PolicyViolationRecord[]> {
  const { page } = context;
  await page.setViewportSize(DASHBOARD_VIEWPORT);
  await page.goto(DASHBOARD_PATH);
  await publishSnapshot(page);
  await expect(page.getByTestId('queues-tier'), 'the dashboard mount target').toBeVisible();
  const records = await collectViolations(page);
  printRecords('dashboard', records);
  return records;
}

/** One computed-style row of data model section 5, keyed by a selector that survives the move to classes. */
interface StyleRow {
  readonly route: PolicySmokeRoute;
  readonly source: string;
  readonly selector: string;
  readonly equals?: Readonly<Record<string, string>>;
  readonly marginLeftAboveZero?: boolean;
  readonly containerEdge?: boolean;
}

const PHASE_FIELD = (kind: 'model' | 'effort' | 'runner'): string =>
  `label.form-field:has([data-testid="phases-${kind}-${POLICY_SMOKE_PHASE_ID}"])`;

const STYLE_ROWS: readonly StyleRow[] = [
  { route: 'models', source: 'ModelCatalogEditor:94', selector: '.models-container > .toolbar', equals: { 'margin-bottom': '24px' } },
  { route: 'models', source: 'ModelCatalogEditor:95', selector: '.models-container > .toolbar > div', equals: { 'flex-grow': '1' } },
  {
    route: 'models',
    source: 'ModelCatalogEditor:117',
    selector: '.backend-section',
    equals: { 'margin-bottom': '32px', 'padding-top': '16px', 'border-top-width': '1px', 'border-top-style': 'solid' }
  },
  { route: 'models', source: 'ModelCatalogEditor:118', selector: '.backend-section h3', equals: { 'margin-bottom': '16px', 'text-transform': 'capitalize' } },
  { route: 'models', source: 'ModelCatalogEditor:120', selector: '.backend-section > .toolbar', equals: { 'margin-bottom': '16px' } },
  { route: 'models', source: 'ModelCatalogEditor:134', selector: 'button[aria-label^="Detect "]', equals: { 'margin-left': '12px' } },
  { route: 'models', source: 'ModelCatalogEditor:156', selector: 'button[aria-label^="Remove "]', equals: { 'margin-left': '12px' } },
  { route: 'phases', source: 'PhaseCatalogEditor:232', selector: '[data-testid="phases-save-all"]', marginLeftAboveZero: true, containerEdge: true },
  { route: 'phases', source: 'PhaseCatalogEditor:393', selector: PHASE_FIELD('model'), equals: { 'flex-grow': '1' } },
  { route: 'phases', source: 'PhaseCatalogEditor:405', selector: PHASE_FIELD('effort'), equals: { 'flex-grow': '1' } },
  { route: 'phases', source: 'PhaseCatalogEditor:414', selector: PHASE_FIELD('runner'), equals: { 'flex-grow': '1' } },
  { route: 'workflows', source: 'WorkflowToolbar:196', selector: '[data-testid="workflows-save-all"]', marginLeftAboveZero: true, containerEdge: true }
];

interface StyleRowResult {
  readonly route: string;
  readonly source: string;
  readonly present: boolean;
  readonly pass: boolean;
  readonly detail: string;
}

/** Everything one element reports about itself: the properties asked for, margin and edge gap. */
async function measure(
  locator: Locator,
  properties: readonly string[]
): Promise<{ values: Record<string, string>; marginLeft: number; edgeGap: number }> {
  return locator.first().evaluate((element, names) => {
    const view = element.ownerDocument.defaultView;
    if (view === null) throw new Error('the element has no window');
    const style = view.getComputedStyle(element);
    const values: Record<string, string> = {};
    for (const name of names) values[name] = style.getPropertyValue(name);
    // The group pushed right by an auto margin ends at the container's last
    // child: the Pipeline toolbar's Save is followed by Delete, so Save itself
    // is not what reaches the edge.
    const parent = element.parentElement;
    const last = parent === null ? null : parent.lastElementChild;
    let edgeGap = Number.NaN;
    if (parent !== null && last !== null) {
      const parentStyle = view.getComputedStyle(parent);
      const contentRight =
        parent.getBoundingClientRect().right -
        parseFloat(parentStyle.borderRightWidth) -
        parseFloat(parentStyle.paddingRight);
      edgeGap = Math.abs(last.getBoundingClientRect().right - contentRight);
    }
    return { values, marginLeft: parseFloat(style.marginLeft), edgeGap };
  }, properties);
}

async function judgeRow(page: Page, row: StyleRow): Promise<StyleRowResult> {
  const locator = page.locator(row.selector);
  const present = (await locator.count()) > 0;
  const base = { route: row.route, source: row.source, present };
  if (!present) return { ...base, pass: false, detail: `no element matches ${row.selector}` };
  const wanted = Object.keys(row.equals ?? {});
  const measured = await measure(locator, wanted);
  const misses: string[] = [];
  for (const [name, value] of Object.entries(row.equals ?? {})) {
    if (measured.values[name] !== value) misses.push(`${name}: ${measured.values[name]} (wanted ${value})`);
  }
  if (row.marginLeftAboveZero === true && !(measured.marginLeft > 0)) {
    misses.push(`margin-left: ${measured.marginLeft} (wanted above 0)`);
  }
  if (row.containerEdge === true && !(measured.edgeGap <= EDGE_TOLERANCE_PX)) {
    misses.push(`container edge gap: ${measured.edgeGap}px (wanted within ${EDGE_TOLERANCE_PX}px)`);
  }
  return { ...base, pass: misses.length === 0, detail: misses.length === 0 ? 'ok' : misses.join('; ') };
}

/** Open a Builder tab's content and make its affected elements exist. */
async function openBuilderRoute(page: Page, route: PolicySmokeRoute): Promise<void> {
  const builder = page.getByTestId('pipeline-builder-root');
  const tabName = { phases: 'Phases', workflows: 'Workflows', models: 'Models' }[route];
  await page.getByRole('tab', { name: tabName }).click();
  if (route === 'phases') {
    await builder.locator('.phase-list-item').first().click();
    await expect(page.getByTestId(`phases-model-${POLICY_SMOKE_PHASE_ID}`)).toBeVisible();
  }
  if (route === 'workflows') {
    const picker = page.getByTestId('workflow-picker-toggle');
    if ((await picker.getAttribute('aria-expanded')) !== 'true') await picker.click();
    await page.getByTestId(`workflows-list-item-${POLICY_SMOKE_WORKFLOW_ID}`).click();
    await expect(page.locator('.wf-branches')).toHaveCount(1);
  }
  if (route === 'models') {
    await expect(page.locator('.models-container')).toBeVisible();
  }
}

interface BuilderWalk {
  readonly records: readonly PolicyViolationRecord[];
  readonly rows: readonly StyleRowResult[];
  readonly armsProperty: string;
}

/** Open the Builder on the dashboard and visit every route, collecting violations and rows. */
async function walkBuilder(context: PolicyContext): Promise<BuilderWalk> {
  const { page } = context;
  await page.getByTestId('dashboard-route-builder').click();
  await expect(page.getByTestId('pipeline-builder-root')).toBeVisible();
  const rows: StyleRowResult[] = [];
  let armsProperty = '';
  for (const route of POLICY_SMOKE_ROUTES) {
    await openBuilderRoute(page, route);
    for (const row of STYLE_ROWS.filter((candidate) => candidate.route === route)) {
      rows.push(await judgeRow(page, row));
    }
    if (route === 'workflows') {
      armsProperty = await page
        .locator('.wf-branches')
        .first()
        .evaluate((element) => {
          const view = element.ownerDocument.defaultView;
          if (view === null) throw new Error('the element has no window');
          return view.getComputedStyle(element).getPropertyValue('--wf-arms').trim();
        });
    }
  }
  const records = await collectViolations(page);
  printRecords('builder', records);
  for (const row of rows) process.stdout.write(`POLICY_STYLE_ROW ${JSON.stringify(row)}\n`);
  process.stdout.write(`POLICY_STYLE_ARMS ${JSON.stringify({ armsProperty })}\n`);
  return { records, rows, armsProperty };
}

function failedRows(rows: readonly StyleRowResult[]): readonly string[] {
  return rows.filter((row) => !row.pass).map((row) => `${row.route} ${row.source}: ${row.detail}`);
}

test.describe('actual policy smoke', () => {
  test('P-T1 the sidebar and the dashboard mount with zero unexpected violations', async ({ page }) => {
    const context = await openPolicyContext(page, false);
    const sidebar = await mountSidebar(context);
    const dashboard = await mountDashboard(context);
    const walk = await walkBuilder(context);
    assertServedPagesAreReal(context);
    const all = [...sidebar, ...dashboard, ...walk.records];
    expect(
      unexpectedRecords(all).map((record) => `${record.effectiveDirective} ${record.blockedURI} @ ${record.page}`),
      'violations outside EXPECTED_VIOLATIONS'
    ).toEqual([]);
    expect(context.pageErrors, 'page errors').toEqual([]);
    expect(context.aborted, 'requests outside the local server').toEqual([]);
  });

  test('P-T2 every affected element holds its computed style on its route', async ({ page }) => {
    const context = await openPolicyContext(page, false);
    await mountDashboard(context);
    const walk = await walkBuilder(context);
    expect(failedRows(walk.rows), 'computed-style rows that failed').toEqual([]);
    expect(walk.armsProperty, '--wf-arms on the forking node').toBe(String(POLICY_SMOKE_BRANCH_COUNT));
    expect(context.aborted, 'requests outside the local server').toEqual([]);
  });

  test('P-T3 the control page records a parser-inserted attribute and an unnonced script', async ({ page }) => {
    const context = await openPolicyContext(page, false);
    await page.goto(CONTROL_PATH);
    const records = await collectViolations(page);
    printRecords('control', records);
    const styleAttr = records.filter((record) => record.effectiveDirective === 'style-src-attr');
    const scripts = records.filter((record) => record.effectiveDirective.startsWith('script-src'));
    const ran = await page.evaluate(
      () => (globalThis as unknown as { __unnoncedInlineRan?: boolean }).__unnoncedInlineRan === true
    );
    const parserColor = await page.locator('#parser-inserted').evaluate((element) => {
      const view = element.ownerDocument.defaultView;
      return view === null ? '' : view.getComputedStyle(element).color;
    });
    const clonedColor = await page.locator('#template-cloned').evaluate((element) => {
      const view = element.ownerDocument.defaultView;
      return view === null ? '' : view.getComputedStyle(element).color;
    });
    process.stdout.write(
      `POLICY_CONTROL ${JSON.stringify({
        styleAttributeRecords: styleAttr.length,
        templateClonedAttributeRecorded: styleAttr.length > 1,
        scriptRecords: scripts.length,
        unnoncedInlineScriptRan: ran,
        parserInsertedComputedColor: parserColor,
        templateClonedComputedColor: clonedColor
      })}\n`
    );
    expect(styleAttr.length, 'the parser-inserted style attribute must be recorded').toBeGreaterThanOrEqual(1);
    expect(scripts.length, 'the unnonced inline script must be recorded').toBeGreaterThanOrEqual(1);
    expect(ran, 'the unnonced inline script must not run').toBe(false);
    expect(context.aborted, 'requests outside the local server').toEqual([]);
  });

  test('P-T4 the pages hold under base-uri and form-action none, with every form submitted', async ({ page }) => {
    const context = await openPolicyContext(page, true);
    const sidebar = await mountSidebar(context);
    const dashboard = await mountDashboard(context);
    const submitted: string[] = [];
    // Feature 285 (OD-2, FR-002): the Queue input form is retired and the task composer holds no
    // `<form>`, so the first form the webview mounts is a pending Task's inline edit form, behind
    // its Edit control in that Task's Run Detail tier.
    await page.getByTestId(`queue-card-${POLICY_SMOKE_QUEUE_ID}`).click();
    await page.getByTestId(`queue-task-row-${POLICY_SMOKE_PENDING_TASK_ID}`).click();
    await expect(page.getByTestId('run-detail-tier'), 'the Run Detail tier must open').toBeVisible();
    const editToggle = page.locator('button[data-testid^="queue-item-edit-"][aria-label^="Edit "]').first();
    await expect(editToggle, 'a Task\'s Edit control must be present before its form is submitted').toBeVisible();
    await editToggle.click();
    const editForm = page.locator('form[data-testid^="queue-item-edit-form-"]').first();
    await expect(editForm, 'the Task edit form must be present before it is submitted').toBeVisible();
    await editForm.locator('input').fill('policy smoke edit');
    await editForm.locator('button[type="submit"]').click();
    submitted.push('QueueItemActions edit');
    // Saving an edit asks for confirmation. It is not what this step observes, so it is dismissed
    // for the rest of the walk to stay reachable; the next click fails loudly if it is still open.
    const dismiss = page.getByTestId('confirm-dialog-cancel');
    await dismiss
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => dismiss.click())
      .catch(() => undefined);
    await page.getByTestId('dashboard-route-operations').click();
    const walk = await walkBuilder(context);
    await page.getByRole('tab', { name: 'Models' }).click();
    const modelForm = page.locator('form.model-form').first();
    await expect(modelForm, 'the add-model form must be present before it is submitted').toBeVisible();
    await modelForm.locator('input').fill('policy-smoke-model');
    await modelForm.locator('button[type="submit"]').click();
    submitted.push('ModelCatalogEditor add-model');
    const afterSubmit = await collectViolations(page);
    printRecords('hardened-after-submit', afterSubmit);
    const all = [...sidebar, ...dashboard, ...walk.records, ...afterSubmit];
    const formAction = all.filter((record) => record.effectiveDirective === 'form-action');
    const outcome = {
      forms: submitted,
      unexpected: unexpectedRecords(all).length,
      formActionRecords: formAction.length,
      failedRows: failedRows(walk.rows).length,
      records: all.map((record) => `${record.effectiveDirective} ${record.blockedURI}`)
    };
    process.stdout.write(`POLICY_HARDENING ${JSON.stringify(outcome)}\n`);
    assertServedPagesAreReal(context);
    expect(formAction, 'form-action records').toEqual([]);
    expect(unexpectedRecords(all).map((record) => `${record.effectiveDirective} ${record.blockedURI}`), 'violations outside EXPECTED_VIOLATIONS').toEqual([]);
    expect(failedRows(walk.rows), 'computed-style rows that failed').toEqual([]);
    expect(context.aborted, 'requests outside the local server').toEqual([]);
  });

  test('P-T5 the expected list refuses an empty reason and an app-owned source', () => {
    expect(listProblems(EXPECTED_VIOLATIONS), 'the real list').toEqual([]);
    const planted: readonly (readonly ExpectedViolation[])[] = [
      [{ effectiveDirective: 'style-src-elem', blockedURI: 'https://example.invalid/x.css', reason: '' }],
      [{ effectiveDirective: 'script-src-elem', blockedURI: `${ORIGIN}/index.js`, reason: 'planted' }],
      [{ effectiveDirective: 'style-src-attr', blockedURI: 'inline', reason: 'planted' }],
      [{ effectiveDirective: 'script-src-elem', blockedURI: 'eval', reason: 'planted' }]
    ];
    for (const list of planted) {
      expect(listProblems(list).length, JSON.stringify(list)).toBeGreaterThan(0);
    }
    const acceptable: ExpectedViolation = {
      effectiveDirective: 'img-src',
      blockedURI: 'https://example.invalid/pixel.png',
      reason: 'a third-party source the app does not own'
    };
    expect(listProblems([acceptable]), 'a reasoned entry for a source the app does not own').toEqual([]);
  });
});
