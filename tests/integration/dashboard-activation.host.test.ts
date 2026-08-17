import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { renderDashboardHtml } from '../../src/ui/dashboard/dashboard-html';

const CSP_META_RE = /<meta\s+http-equiv=["']Content-Security-Policy["']/i;
const EXTENSION_ID = 'schegent.schegent';

// BUG-001 / SC-014 smoke test. Verifies that the production dashboard render
// path (a) succeeds against the real `vscode.Webview` API — which rejects
// duck-typed `{ fsPath }` arguments — (b) carries a Content-Security-Policy
// <meta>, and (c) rebases the Vite-emitted asset graph (dashboard.js,
// chunks/theme.js, index2.css, dashboard.css). See plan.md "Webview
// Sanitization Contract" rules 6-7 and the dashboard's BUG-001 patch.
//
// BUG-003 (T060) extension: also asserts the operations-surface layout-zone
// testids are baked into the dashboard JS bundle output, proving the tier
// components ship the zones expected at runtime. String-presence in the
// bundle is a precondition for runtime DOM mount. Feature 097 (T013) deleted
// `Dashboard.svelte` and its subtree; this list now names each original
// FR-033 zone's direct successor in the tier components (`QueueControls.svelte`,
// `QueueDetailRows.svelte`, `PhaseLogFeed.svelte`) rather than the deleted
// file's own testids.
const LAYOUT_ZONE_TESTIDS = [
  'dashboard-queue-input',
  'dashboard-queue-action',
  'queue-detail-rows',
  'dashboard-phase-progression',
  'phase-log-feed'
] as const;
export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `extension '${EXTENSION_ID}' not found in test host`);
  await ext.activate();

  const extensionRoot = ext.extensionPath;
  const bundleDir = path.join(extensionRoot, 'dist', 'webview');

  const panel = vscode.window.createWebviewPanel(
    'schegent.dashboard.integration.test',
    'Schegent Dashboard Integration Test',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(bundleDir),
        vscode.Uri.file(path.join(extensionRoot, 'resources'))
      ]
    }
  );

  try {
    const html = renderDashboardHtml({
      webview: panel.webview,
      extensionRoot,
      nonce: 'test-nonce-' + Date.now().toString(36),
      toLocalUri: (fsPath) => vscode.Uri.file(fsPath),
      webviewBundleDir: bundleDir
    });

    assert.match(
      html,
      CSP_META_RE,
      'dashboard render produced HTML without a Content-Security-Policy <meta> — CSP warning would fire'
    );

    const dashboardHtmlPath = path.join(bundleDir, 'dashboard.html');
    if (fs.existsSync(dashboardHtmlPath)) {
      // When the Vite-built dashboard.html exists we expect every emitted
      // asset to be rewritten through asWebviewUri. Missing any of these
      // means the asset sweep regressed (BUG-001).
      assert.match(
        html,
        /asWebviewUri|vscode-webview|https?:\/\/[^"]*\.(?:vscode-webview\.net|vscode-cdn\.net)/,
        'dashboard render did not produce vscode-webview URIs — asset sweep failed'
      );
      assert.ok(
        /dashboard\.js/.test(html),
        'dashboard render did not reference dashboard.js'
      );
      assert.ok(
        /chunks\/theme\.js/.test(html),
        'dashboard render did not reference chunks/theme.js — Vite shared chunk not rebased (BUG-001)'
      );
      assert.ok(
        /index2\.css/.test(html),
        'dashboard render did not reference index2.css — shared theme stylesheet not rebased (BUG-001)'
      );
      assert.ok(
        /dashboard\.css/.test(html),
        'dashboard render did not reference dashboard.css'
      );
    }

    // crossorigin must be stripped (incompatible with the VS Code webview iframe).
    assert.ok(
      !/<(?:script|link)\b[^>]*\bcrossorigin\b/i.test(html),
      'dashboard render left a `crossorigin` attribute — VS Code webview iframe rejects this'
    );

    // Assignment to `panel.webview.html` is the real-API contract gate.
    // BUG-001's failure mode is that this throws synchronously when asWebviewUri
    // was passed a duck-typed `{ fsPath }` literal during rewrite.
    panel.webview.html = html;

    // BUG-003 (T060) — assert the operations-surface layout-zone testids are
    // present in the built dashboard JS bundle. The Svelte compiler bakes
    // `data-testid="…"` literals into the emitted module, so a bundle-string
    // scan reliably proves the tier components shipped the five expected
    // zones (feature 097 / T013 relocated them out of `Dashboard.svelte`).
    const dashboardJsCandidates: string[] = [
      path.join(bundleDir, 'dashboard.js'),
      path.join(bundleDir, 'chunks', 'dashboard.js')
    ];
    let bundleSource = '';
    for (const candidate of dashboardJsCandidates) {
      if (fs.existsSync(candidate)) {
        bundleSource += fs.readFileSync(candidate, 'utf8');
      }
    }
    if (fs.existsSync(path.join(bundleDir, 'chunks'))) {
      for (const file of fs.readdirSync(path.join(bundleDir, 'chunks'))) {
        const full = path.join(bundleDir, 'chunks', file);
        if (file.endsWith('.js') && fs.statSync(full).isFile()) {
          bundleSource += fs.readFileSync(full, 'utf8');
        }
      }
    }
    if (bundleSource.length > 0) {
      for (const testid of LAYOUT_ZONE_TESTIDS) {
        assert.ok(
          bundleSource.includes(testid),
          `dashboard JS bundle is missing layout-zone testid '${testid}' — ` +
            'the operations surface (BUG-003 / T059, relocated by feature 097) did not ship it'
        );
      }
    }
  } finally {
    panel.dispose();
  }
}
