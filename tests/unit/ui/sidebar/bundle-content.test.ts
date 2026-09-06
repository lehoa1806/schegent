// FR-R3-169 §4 — why this file no longer excuses itself when the bundle is absent.
//
// Both testid audits below were guarded by a conditional-execution helper keyed on
// `existsSync(JS_BUNDLE)`. Measured on 2026-09-06 with `dist/webview` moved aside,
// this file reported:
//
//     ✓ tests/unit/ui/sidebar/bundle-content.test.ts (3 tests | 2 skipped)
//       Tests  1 passed | 2 skipped (3)
//
// Green. The one test that ran was a hint that printed to stderr and asserted
// `expect(true).toBe(true)` — a passing test about nothing, whose warning is
// invisible in any log anyone actually reads. So a build with no webview produced
// the same check mark as a build with a correct one, and the audit that exists to
// catch a missing testid could not distinguish "every testid present" from "no
// bundle to look in".
//
// That is the shape FR-R3-169 was filed about: a gate whose green means nothing.
// The guards are gone and the hint test is retired, replaced by a real presence
// assertion ordered ahead of the audits so the first failure names the true cause
// rather than reporting `missing testids: …` — which would be a true statement
// about a false cause.
//
// THE COST, ACCEPTED DELIBERATELY. A bare `vitest run` on a fresh clone with no
// prior build now fails here. That is intended: `FR-019` makes every npm script
// whose chain reaches the host suite build the webview first, so every supported
// invocation is unaffected, and `tests/lint/webview-build-precedes-host-suite.test.ts`
// keeps it that way. If you are reading this because the file went red on a fresh
// clone, the fix is `npm run build:webview`, not a guard.
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../..');
const WEBVIEW_DIST = resolve(REPO_ROOT, 'dist/webview');
const JS_BUNDLE = resolve(WEBVIEW_DIST, 'index.js');
const DASHBOARD_JS_BUNDLE = resolve(WEBVIEW_DIST, 'dashboard.js');
const CHUNKS_DIR = resolve(WEBVIEW_DIST, 'chunks');

const BUILD_HINT = 'run `npm run build:webview` — this file asserts on built output';

function combinedJs(): string {
  const parts: string[] = [];
  if (existsSync(JS_BUNDLE)) parts.push(readFileSync(JS_BUNDLE, 'utf8'));
  if (existsSync(DASHBOARD_JS_BUNDLE)) parts.push(readFileSync(DASHBOARD_JS_BUNDLE, 'utf8'));
  if (existsSync(CHUNKS_DIR)) {
    for (const f of readdirSync(CHUNKS_DIR).filter((n) => n.endsWith('.js'))) {
      parts.push(readFileSync(join(CHUNKS_DIR, f), 'utf8'));
    }
  }
  return parts.join('\n');
}

const SIDEBAR_REQUIRED_TESTIDS: ReadonlyArray<string> = [
  'sidebar-stats-strip',
  'sidebar-stats-done',
  'sidebar-stats-pending',
  'sidebar-stats-failed',
  'sidebar-active-phase',
  'sidebar-current-task',
  'sidebar-freshness',
  'sidebar-status-row',
  'sidebar-open-dashboard-button'
];

// Feature 097 (T013) deleted Dashboard.svelte and its subtree; these are each
// original FR-033 zone's direct successor testid in the tier components
// (QueueControls.svelte, QueueDetailRows.svelte, PhaseLogFeed.svelte), mirroring
// dashboard-activation.host.test.ts's LAYOUT_ZONE_TESTIDS.
const DASHBOARD_REQUIRED_TESTIDS: ReadonlyArray<string> = [
  'dashboard-queue-input',
  'dashboard-queue-action',
  'queue-detail-rows',
  'dashboard-phase-progression',
  'phase-log-feed'
];

describe('Webview bundle content audit (T072)', () => {
  // Declared first so it reports first: every assertion after this one is about
  // the contents of these two files, and is meaningless if they are not there.
  it('the webview bundle exists to be audited', () => {
    const absent = [JS_BUNDLE, DASHBOARD_JS_BUNDLE].filter((file) => !existsSync(file));
    expect(
      absent.map((file) => file.slice(REPO_ROOT.length + 1)),
      `the webview bundle is absent, so the testid audits below have nothing to read; ${BUILD_HINT}`
    ).toEqual([]);
  });

  it('sidebar entry+chunks reference every required testid', () => {
    const js = combinedJs();
    const missing = SIDEBAR_REQUIRED_TESTIDS.filter((id) => !js.includes(id));
    expect(missing, `missing testids: ${missing.join(', ')}. If all of them are missing, ${BUILD_HINT}`).toEqual([]);
  });

  it('dashboard entry+chunks reference every dashboard pane testid', () => {
    const js = combinedJs();
    const missing = DASHBOARD_REQUIRED_TESTIDS.filter((id) => !js.includes(id));
    expect(missing, `missing testids: ${missing.join(', ')}. If all of them are missing, ${BUILD_HINT}`).toEqual([]);
  });
});
