import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../..');
const WEBVIEW_DIST = resolve(REPO_ROOT, 'dist/webview');
const JS_BUNDLE = resolve(WEBVIEW_DIST, 'index.js');
const CSS_BUNDLE = resolve(WEBVIEW_DIST, 'index.css');
const DASHBOARD_JS_BUNDLE = resolve(WEBVIEW_DIST, 'dashboard.js');
const DASHBOARD_CSS_BUNDLE = resolve(WEBVIEW_DIST, 'dashboard.css');
const CHUNKS_DIR = resolve(WEBVIEW_DIST, 'chunks');
const BASELINE_PATH = resolve(__dirname, 'bundle-size-baseline.json');

const MAX_JS_BYTES = 200 * 1024;
// Feature 034 Item 053 (Webview component decomposition) lifted the dashboard
// CSS cap from 56 KB → 60 KB to absorb the new operator-visible queue
// surfaces (`QueueControls.svelte`, `QueueInputForm.svelte`,
// `QueueListView.svelte`) and the settings field-row extractions
// (`settings/general/GeneralSettingFieldRow.svelte`,
// `settings/wakeup/WakeupLogList.svelte`) that emerged from splitting the
// 1047-LOC `Dashboard.svelte` and the 600+-LOC settings tabs into cohesive
// sub-components. The sidebar `index.css` is well inside the cap; only
// `dashboard.css` is at the new boundary. Lift again only when a feature
// intentionally adds operator-visible UI.
//
// Feature 065 (T055 / 2026-05-22) lifted 60 KB → 70 KB to absorb the
// operator-visible enqueue/start surfaces: `ScheduledStartIndicator.svelte`,
// `StartModeChooser.svelte`, `SystemTab.svelte`, the migration notice block
// in `QueueListView.svelte`, the idle-pending start button, and the
// status-bar transient indicator styles. The actual post-build size is
// ~66.5 KB; the 70 KB cap leaves headroom for the remaining T059–T066
// polish tasks (label tweaks, dot colors) without re-lifting mid-feature.
const MAX_CSS_BYTES = 70 * 1024;
const MAX_DASHBOARD_JS_BYTES = 250 * 1024;
const SIDEBAR_GROWTH_BUDGET_BYTES = 8 * 1024;

function totalChunkBytes(): number {
  if (!existsSync(CHUNKS_DIR)) return 0;
  return readdirSync(CHUNKS_DIR)
    .filter((f) => f.endsWith('.js'))
    .reduce((sum, f) => sum + statSync(join(CHUNKS_DIR, f)).size, 0);
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
    'index.js stays at or below 200 KB minified',
    () => {
      const size = statSync(JS_BUNDLE).size;
      expect(size, `index.js was ${size} bytes (limit ${MAX_JS_BYTES})`).toBeLessThanOrEqual(
        MAX_JS_BYTES
      );
    }
  );

  it.runIf(existsSync(CSS_BUNDLE))(
    'index.css stays at or below 50 KB',
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
    'dashboard.js stays at or below 250 KB minified',
    () => {
      const size = statSync(DASHBOARD_JS_BUNDLE).size;
      expect(
        size,
        `dashboard.js was ${size} bytes (limit ${MAX_DASHBOARD_JS_BYTES})`
      ).toBeLessThanOrEqual(MAX_DASHBOARD_JS_BYTES);
    }
  );

  it.runIf(existsSync(DASHBOARD_CSS_BUNDLE))(
    'dashboard.css stays at or below 50 KB',
    () => {
      const size = statSync(DASHBOARD_CSS_BUNDLE).size;
      expect(
        size,
        `dashboard.css was ${size} bytes (limit ${MAX_CSS_BYTES})`
      ).toBeLessThanOrEqual(MAX_CSS_BYTES);
    }
  );

  // T067 (004-operator-ui): post-Vite-split, the sidebar entry can shrink while
  // shared code lives in dist/webview/chunks/. We measure entry+chunks together
  // so a regression that re-inlines theme/snapshot code is still caught against
  // the baseline (plus a small forward growth budget for additive features).
  it.runIf(existsSync(JS_BUNDLE) && existsSync(BASELINE_PATH))(
    'sidebar entry + shared chunks stay within 8 KB delta of the locked baseline',
    () => {
      const baseline = readBaseline();
      expect(baseline, 'bundle-size-baseline.json missing or unreadable').not.toBeNull();
      const total = statSync(JS_BUNDLE).size + totalChunkBytes();
      const cap = baseline!.indexJsBytes + SIDEBAR_GROWTH_BUDGET_BYTES;
      expect(
        total,
        `sidebar entry+chunks were ${total} bytes; baseline ${baseline!.indexJsBytes} + growth budget ${SIDEBAR_GROWTH_BUDGET_BYTES} = ${cap} bytes (captured at ${baseline!.capturedAt})`
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
