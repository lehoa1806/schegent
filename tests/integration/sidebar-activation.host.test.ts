import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { renderWebviewHtml, FALLBACK_FAILURE_HTML } from '../../src/ui/sidebar/html';

const CSP_META_RE = /<meta\s+http-equiv=["']Content-Security-Policy["']/i;
const EXTENSION_ID = 'schegent.schegent';
const SIDEBAR_VIEW_CONTAINER = 'workbench.view.extension.schegent';

// BUG-004 smoke test. Verifies that the production sidebar activation path
// (a) produces HTML carrying a Content-Security-Policy <meta>, (b) does not
// fall back to the failure HTML, and (c) renders successfully against the
// real `vscode.Webview` API (which rejects duck-typed `{ fsPath }` arguments).
// See plan.md "Webview Sanitization Contract" rules 6-7.
export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `extension '${EXTENSION_ID}' not found in test host`);
  await ext.activate();

  await vscode.commands.executeCommand(`${SIDEBAR_VIEW_CONTAINER}.focus`).then(
    undefined,
    // older VS Code targets accept the bare container id without `.focus`
    () => vscode.commands.executeCommand(SIDEBAR_VIEW_CONTAINER)
  );

  const extensionRoot = ext.extensionPath;
  const bundleDir = path.join(extensionRoot, 'dist', 'webview');

  const panel = vscode.window.createWebviewPanel(
    'schegent.integration.test',
    'Schegent Integration Test',
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
    const { html } = await renderWebviewHtml({
      webview: panel.webview,
      extensionRoot,
      webviewBundleDir: bundleDir,
      toLocalUri: (fsPath) => vscode.Uri.file(fsPath)
    });

    assert.notStrictEqual(
      html,
      FALLBACK_FAILURE_HTML,
      'sidebar render returned the fallback failure HTML — bundle missing or asset rewrite threw'
    );
    assert.match(
      html,
      CSP_META_RE,
      'sidebar render produced HTML without a Content-Security-Policy <meta> — CSP warning would fire'
    );

    // BUG-001: every CSP `script-src`-gated tag class emitted by Vite must
    // carry the nonce, or the browser silently drops it and `mount()` never
    // runs. The real built bundle currently emits at least
    // `<script type="module">` and `<link rel="modulepreload">`; if Vite ever
    // adds `<link rel="preload" as="script">`, this assertion catches it.
    const nonceMatch = html.match(/'nonce-([^']+)'/);
    assert.ok(nonceMatch, 'no nonce found in rendered HTML CSP — cannot verify gated-tag coverage');
    const renderNonce = nonceMatch[1];
    const nonceAttr = `nonce="${renderNonce}"`;
    type GatedClass = { readonly label: string; readonly matcher: RegExp };
    const gatedClasses: ReadonlyArray<GatedClass> = [
      { label: 'script', matcher: /<script\b[^>]*>/gi },
      { label: 'link rel="modulepreload"', matcher: /<link\b[^>]*\brel\s*=\s*["']modulepreload["'][^>]*>/gi },
      {
        label: 'link rel="preload" as="script"',
        matcher: /<link\b[^>]*\brel\s*=\s*["']preload["'][^>]*\bas\s*=\s*["']script["'][^>]*>/gi
      }
    ];
    for (const cls of gatedClasses) {
      const opens = html.match(cls.matcher) ?? [];
      // Skip classes the bundle does not currently emit — but still validate
      // the script class because every webview must have at least one.
      if (opens.length === 0 && cls.label !== 'script') continue;
      assert.ok(opens.length > 0, `expected at least one <${cls.label}> in rendered HTML`);
      for (const tag of opens) {
        assert.ok(
          tag.includes(nonceAttr),
          `<${cls.label}> tag missing nonce — CSP would block it: ${tag}`
        );
      }
    }

    // 006-sidebar-compact-status-bar: the rendered sidebar must mount the
    // four compact-zone containers — Status Row, Stats Strip, Current Task,
    // and the Open Dashboard button. The previous live-activity-header,
    // monitor-pill, queue, and history testids no longer belong to the
    // sidebar bundle (they live in dist/webview/dashboard.js). Post-Vite-split,
    // the new testids may land in either dist/webview/index.js or
    // dist/webview/chunks/*; we concatenate all built sidebar JS so we catch
    // tree-shaken regressions wherever they land.
    const bundlePath = path.join(bundleDir, 'index.js');
    assert.ok(
      fs.existsSync(bundlePath),
      `expected webview bundle at ${bundlePath} (run \`npm run build:webview\`)`
    );
    const allJsFiles = [bundlePath];
    const chunksDir = path.join(bundleDir, 'chunks');
    if (fs.existsSync(chunksDir)) {
      for (const f of fs.readdirSync(chunksDir)) {
        if (f.endsWith('.js')) allJsFiles.push(path.join(chunksDir, f));
      }
    }
    const combinedJs = allJsFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const REQUIRED_TESTIDS: ReadonlyArray<string> = [
      'app-root',
      'sidebar-status-row',
      'sidebar-stats-strip',
      'sidebar-current-task',
      'sidebar-open-dashboard-button'
    ];
    for (const id of REQUIRED_TESTIDS) {
      assert.ok(
        combinedJs.includes(id),
        `webview bundle does not reference data-testid="${id}" — component missing or tree-shaken`
      );
    }

    panel.webview.html = html;

    // Positive runtime signal (BUG-001): the gated-tag-coverage assertions
    // above run against the *real* built bundle, not a fixture. The
    // production `dist/webview/index.html` emits a `<link rel="modulepreload"
    // href="/chunks/theme.js">` — if T054 (`injectNonceIntoTags` widening) is
    // reverted, the rendered HTML's modulepreload tag will lack the nonce,
    // CSP would block it at runtime, and the assertion above will fail before
    // reaching here. We do not wait for a webview→host message because the
    // production webview does not auto-post on mount; introducing such a
    // heartbeat would expand BUG-001 scope (new IPC message type plus
    // router/validator changes).
  } finally {
    panel.dispose();
  }
}
