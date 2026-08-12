// Every cap below is asserted against a built artifact under `dist/webview/`,
// which makes this the one unit test with an ordering dependency on a build step.
// `npm run ci` therefore runs `build:webview` before `test`: until feature 089 it
// did not, so these tests measured whatever `dist/webview/` happened to hold —
// a months-old bundle locally, and nothing at all on a clean checkout, where
// `it.runIf(existsSync(...))` skipped them into a silent pass. Keep the build
// ahead of the test in `ci`; the `runIf` guards exist so a bare `vitest run`
// still works, not so the gate can opt itself out.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../..');
const WEBVIEW_DIST = resolve(REPO_ROOT, 'dist/webview');
const JS_BUNDLE = resolve(WEBVIEW_DIST, 'index.js');
const CSS_BUNDLE = resolve(WEBVIEW_DIST, 'index.css');
const DASHBOARD_JS_BUNDLE = resolve(WEBVIEW_DIST, 'dashboard.js');
const DASHBOARD_CSS_BUNDLE = resolve(WEBVIEW_DIST, 'dashboard.css');
const BASELINE_PATH = resolve(__dirname, 'bundle-size-baseline.json');

const MAX_JS_BYTES = 200 * 1024;

// The sidebar entry's own stylesheet. Until feature 089 this shared one constant
// with `dashboard.css`, so every lift the dashboard needed silently widened the
// sidebar's bound too — by 80 KB against an actual 5.3 KB, which is not a bound
// at all. Split so each surface is measured against its own budget; 50 KB is the
// figure both test names have claimed since they were written.
const MAX_CSS_BYTES = 50 * 1024;

// Feature 034 Item 053 (Webview component decomposition) lifted the dashboard
// CSS cap from 56 KB → 60 KB to absorb the new operator-visible queue
// surfaces (`QueueControls.svelte`, `QueueInputForm.svelte`,
// `QueueListView.svelte`) and the settings field-row extractions
// (`settings/general/GeneralSettingFieldRow.svelte`) that emerged from splitting the
// 1047-LOC `Dashboard.svelte` and the 600+-LOC settings tabs into cohesive
// sub-components. Lift again only when a feature intentionally adds
// operator-visible UI.
//
// Feature 065 (T055 / 2026-05-22) lifted 60 KB → 70 KB to absorb the
// operator-visible enqueue/start surfaces: `ScheduledStartIndicator.svelte`,
// `StartModeChooser.svelte`, `SystemTab.svelte`, the migration notice block
// in `QueueListView.svelte`, the idle-pending start button, and the
// status-bar transient indicator styles. The actual post-build size is
// ~66.5 KB; the 70 KB cap leaves headroom for the remaining T059–T066
// polish tasks (label tweaks, dot colors) without re-lifting mid-feature.
//
// Feature 073 (Metrics Dashboard, 2026-08-01) lifted 75 KB → 80 KB to
// absorb the new Metrics tab (`MetricsSection.svelte`): summary cards, the
// sortable/paginated task table with expandable phase detail, phase
// analytics, and the hand-rolled cost-trend SVG chart. The actual
// post-build `dashboard.css` size is ~76.1 KB; the 80 KB cap leaves a small
// forward-growth margin without re-lifting mid-feature.
//
// Feature 089 (T048 / 2026-08-12) lifted 80 KB → 90 KB for the process-platform
// UI merged in features 083-088: the Workflow catalog and graph editors, the
// import/export plan and results tables, the run composer, and the connected-run
// views — 18 new operator-visible components. Actual post-build size is 86,679
// bytes (~84.6 KB).
//
// The Impeccable hardening pass (2026-08-12) route-split the five non-default
// surfaces. The startup stylesheet is now 51,200 bytes; 64 KB leaves deliberate
// headroom while preventing route CSS from drifting back into the initial load.
const MAX_DASHBOARD_CSS_BYTES = 64 * 1024;

// The same route split reduced the dashboard entry from 344,565 bytes to
// 123,563 bytes. Keep both the entry and its synchronously imported runtime
// bounded; lazy History/Metrics/System/Builder/Settings chunks are fetched only
// after navigation intent.
const MAX_DASHBOARD_JS_BYTES = 160 * 1024;
const MAX_DASHBOARD_INITIAL_JS_BYTES = 180 * 1024;
const SIDEBAR_GROWTH_BUDGET_BYTES = 8 * 1024;

/** Keeps every cap's test name reading the number that name is asserted against. */
function kb(bytes: number): string {
  return `${bytes / 1024} KB`;
}

function synchronousBundleBytes(entryPath: string): number {
  const seen = new Set<string>();
  const visit = (filePath: string): number => {
    if (seen.has(filePath) || !existsSync(filePath)) return 0;
    seen.add(filePath);
    const source = readFileSync(filePath, 'utf8');
    const staticImport = /\b(?:from|import)\s*["']([^"']+\.js)["']/g;
    let total = statSync(filePath).size;
    for (const match of source.matchAll(staticImport)) {
      const specifier = match[1];
      if (!specifier?.startsWith('.')) continue;
      const dependency = resolve(dirname(filePath), specifier);
      if (dependency === WEBVIEW_DIST || dependency.startsWith(`${WEBVIEW_DIST}/`)) {
        total += visit(dependency);
      }
    }
    return total;
  };
  return visit(entryPath);
}

interface BundleBaseline {
  readonly indexJsBytes: number;
  readonly capturedAt: string;
  readonly deltaBudgetBytes: number;
  readonly absoluteCapBytes: number;
}

function readBaseline(): BundleBaseline | null {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as BundleBaseline;
}

describe('webview bundle size (SC-010)', () => {
  it.runIf(existsSync(JS_BUNDLE))(
    `index.js stays at or below ${kb(MAX_JS_BYTES)} minified`,
    () => {
      const size = statSync(JS_BUNDLE).size;
      expect(size, `index.js was ${size} bytes (limit ${MAX_JS_BYTES})`).toBeLessThanOrEqual(
        MAX_JS_BYTES
      );
    }
  );

  it.runIf(existsSync(CSS_BUNDLE))(
    `index.css stays at or below ${kb(MAX_CSS_BYTES)}`,
    () => {
      const size = statSync(CSS_BUNDLE).size;
      expect(size, `index.css was ${size} bytes (limit ${MAX_CSS_BYTES})`).toBeLessThanOrEqual(
        MAX_CSS_BYTES
      );
    }
  );

  // T067 (004-operator-ui): the dashboard bundle gets a higher cap because it
  // renders the full extended snapshot (queue + history + monitor) without
  // sub-component lazy loading. Keeping it under 250 KB minified guards
  // against accidental icon-set / charting-library imports.
  it.runIf(existsSync(DASHBOARD_JS_BUNDLE))(
    `dashboard.js stays at or below ${kb(MAX_DASHBOARD_JS_BYTES)} minified`,
    () => {
      const size = statSync(DASHBOARD_JS_BUNDLE).size;
      expect(
        size,
        `dashboard.js was ${size} bytes (limit ${MAX_DASHBOARD_JS_BYTES})`
      ).toBeLessThanOrEqual(MAX_DASHBOARD_JS_BYTES);
    }
  );

  it.runIf(existsSync(DASHBOARD_JS_BUNDLE))(
    `dashboard startup JS stays at or below ${kb(MAX_DASHBOARD_INITIAL_JS_BYTES)} including synchronous chunks`,
    () => {
      const size = synchronousBundleBytes(DASHBOARD_JS_BUNDLE);
      expect(
        size,
        `dashboard synchronous graph was ${size} bytes (limit ${MAX_DASHBOARD_INITIAL_JS_BYTES})`
      ).toBeLessThanOrEqual(MAX_DASHBOARD_INITIAL_JS_BYTES);
    }
  );

  it.runIf(existsSync(DASHBOARD_CSS_BUNDLE))(
    `dashboard.css stays at or below ${kb(MAX_DASHBOARD_CSS_BYTES)}`,
    () => {
      const size = statSync(DASHBOARD_CSS_BUNDLE).size;
      expect(
        size,
        `dashboard.css was ${size} bytes (limit ${MAX_DASHBOARD_CSS_BYTES})`
      ).toBeLessThanOrEqual(MAX_DASHBOARD_CSS_BYTES);
    }
  );

  // T067 (004-operator-ui): post-Vite-split, the sidebar entry can shrink while
  // shared code lives in dist/webview/chunks/. Follow only static imports from
  // the sidebar entry: dashboard route chunks are async-only and must not be
  // charged to sidebar startup merely because both entries share an output dir.
  it.runIf(existsSync(JS_BUNDLE) && existsSync(BASELINE_PATH))(
    'sidebar entry + shared chunks stay within 8 KB delta of the locked baseline',
    () => {
      const baseline = readBaseline();
      expect(baseline, 'bundle-size-baseline.json missing or unreadable').not.toBeNull();
      const total = synchronousBundleBytes(JS_BUNDLE);
      const cap = baseline!.indexJsBytes + SIDEBAR_GROWTH_BUDGET_BYTES;
      expect(
        total,
        `sidebar synchronous graph was ${total} bytes; baseline ${baseline!.indexJsBytes} + growth budget ${SIDEBAR_GROWTH_BUDGET_BYTES} = ${cap} bytes (captured at ${baseline!.capturedAt})`
      ).toBeLessThanOrEqual(cap);
    }
  );

  // T038 (003-progress-monitor): freeze the current bundle size and only allow
  // a small forward growth budget. This catches accidental dependency bloat or
  // failed tree-shaking on subsequent features. Update bundle-size-baseline.json
  // ONLY when a feature intentionally lifts the floor.
  it.runIf(existsSync(JS_BUNDLE) && existsSync(BASELINE_PATH))(
    'index.js stays within delta budget vs the locked baseline',
    () => {
      const baseline = readBaseline();
      expect(baseline, 'bundle-size-baseline.json missing or unreadable').not.toBeNull();
      const currentSize = statSync(JS_BUNDLE).size;
      const cap = baseline!.indexJsBytes + baseline!.deltaBudgetBytes;
      expect(
        currentSize,
        `index.js was ${currentSize} bytes; baseline ${baseline!.indexJsBytes} + delta budget ${baseline!.deltaBudgetBytes} = ${cap} bytes (captured at ${baseline!.capturedAt})`
      ).toBeLessThanOrEqual(cap);
      expect(
        currentSize,
        `index.js exceeded absolute cap of ${baseline!.absoluteCapBytes} bytes`
      ).toBeLessThanOrEqual(baseline!.absoluteCapBytes);
    }
  );

  it('reports a hint when the webview bundle is missing', () => {
    if (!existsSync(JS_BUNDLE)) {
      console.warn(
        `[bundle-size] dist/webview/index.js not found — run \`npm run build:webview\` to populate it before invoking this test.`
      );
    }
    expect(true).toBe(true);
  });
});
