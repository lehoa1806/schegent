import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../..');
const WEBVIEW_DIST = resolve(REPO_ROOT, 'dist/webview');
const JS_BUNDLE = resolve(WEBVIEW_DIST, 'index.js');
const DASHBOARD_JS_BUNDLE = resolve(WEBVIEW_DIST, 'dashboard.js');
const CHUNKS_DIR = resolve(WEBVIEW_DIST, 'chunks');

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

const DASHBOARD_REQUIRED_TESTIDS: ReadonlyArray<string> = [
  'dashboard-queue-input',
  'dashboard-queue-management',
  'dashboard-queue-list',
  'dashboard-phase-progression',
  'dashboard-activity-audit-feed'
];

describe('Webview bundle content audit (T072)', () => {
  it.runIf(existsSync(JS_BUNDLE))(
    'sidebar entry+chunks reference every required testid',
    () => {
      const js = combinedJs();
      const missing = SIDEBAR_REQUIRED_TESTIDS.filter((id) => !js.includes(id));
      expect(missing, `missing testids: ${missing.join(', ')}`).toEqual([]);
    }
  );

  it.runIf(existsSync(DASHBOARD_JS_BUNDLE))(
    'dashboard entry+chunks reference every dashboard pane testid',
    () => {
      const js = combinedJs();
      const missing = DASHBOARD_REQUIRED_TESTIDS.filter((id) => !js.includes(id));
      expect(missing, `missing testids: ${missing.join(', ')}`).toEqual([]);
    }
  );

  it('reports a hint when the webview bundle is missing', () => {
    if (!existsSync(JS_BUNDLE)) {
      console.warn(
        `[bundle-content] dist/webview/index.js not found — run \`npm run build:webview\` to populate it before invoking this test.`
      );
    }
    expect(true).toBe(true);
  });
});
