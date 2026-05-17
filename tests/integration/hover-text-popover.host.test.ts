import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { renderWebviewHtml, FALLBACK_FAILURE_HTML } from '../../src/ui/sidebar/html';

const EXTENSION_ID = 'schegent.schegent';

// BUG-001 / T050 (2026-05-13): the four contract markers emitted by the
// `hoverTextAnchor` action and the `HoverTextPortal` component. Their
// presence in the built webview bundles is the proof that the redirect's
// wiring contract survived tree-shaking and that the post-T048
// value-equality guard did not accidentally drop them.
//
//   data-hover-text-anchored — set on every popover-mode anchor
//   hover-text-portal-host   — wrapper div created on openPopover()
//   hover-text-popover-body  — class on the rendered popover element
//   hover-text-inline-help   — class on the inline <p> sibling (≤80-char)
//
// Per specs/018-settings-ui-tooltips/contracts/hover-text-component-api.md.
const REQUIRED_HOVER_TEXT_STRINGS: ReadonlyArray<string> = [
  'data-hover-text-anchored',
  'hover-text-popover-body',
  'hover-text-portal-host',
  'hover-text-inline-help'
];

// BUG-001 smoke test. Verifies the post-T048 build ships the hover-text
// wiring contract end-to-end:
//   (a) the extension activates under the real `@vscode/test-electron` host,
//   (b) every contract marker the action and portal emit at runtime is
//       present in at least one built bundle (regression guard against
//       tree-shaking the action / portal component out of the dashboard
//       bundle, which is exactly how the operator would experience BUG-001
//       again if `hoverTextAnchor` callers stopped wiring it),
//   (c) the rendered webview HTML is not the fallback failure template
//       (asset rewrite + CSP wiring did not throw — the post-T048 action
//       still bundles cleanly).
//
// Limitation: this smoke is a static-bundle + render-time check. The
// hover-to-open-popover behavior itself runs in the webview's JS runtime
// and requires a real browser context to drive — verifying that a
// synthetic `mouseenter` → 400ms → `.hover-text-popover-body` round-trip
// happens visibly needs a Playwright / `@vscode/test-cdp` follow-up,
// because the @vscode/test-electron host process has no DOM access to
// the webview's isolated context (only postMessage IPC, which the
// production webview does not currently expose for tests). The unit
// suite at
// webview-ui/src/components/hover-text/__tests__/hover-text-anchor-action.test.ts
// covers the action's behavior under jsdom + fake timers, including
// the BUG-001 value-equality regression added at T049. This host smoke
// is the structural CI gate that catches a tree-shaken / removed
// wiring marker before ship (SC-008).
export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `extension '${EXTENSION_ID}' not found in test host`);
  await ext.activate();

  const extensionRoot = ext.extensionPath;
  const bundleDir = path.join(extensionRoot, 'dist', 'webview');
  assert.ok(
    fs.existsSync(bundleDir),
    `expected webview bundle directory at ${bundleDir} (run \`npm run build:webview\`)`
  );

  const allJsFiles: string[] = [];
  for (const f of fs.readdirSync(bundleDir)) {
    if (f.endsWith('.js')) allJsFiles.push(path.join(bundleDir, f));
  }
  const chunksDir = path.join(bundleDir, 'chunks');
  if (fs.existsSync(chunksDir)) {
    for (const f of fs.readdirSync(chunksDir)) {
      if (f.endsWith('.js')) allJsFiles.push(path.join(chunksDir, f));
    }
  }
  assert.ok(
    allJsFiles.length > 0,
    `no .js bundles found under ${bundleDir} — run \`npm run build:webview\``
  );

  const combinedJs = allJsFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  for (const marker of REQUIRED_HOVER_TEXT_STRINGS) {
    assert.ok(
      combinedJs.includes(marker),
      `built webview bundle does not reference '${marker}' — ` +
        'hoverTextAnchor action or HoverTextPortal component was tree-shaken; ' +
        'FR-002(b) / FR-007 / FR-008 would fail at runtime (BUG-001 recurrence)'
    );
  }

  const panel = vscode.window.createWebviewPanel(
    'schegent.integration.hover-text-popover',
    'Schegent Hover-Text Smoke',
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
      'webview render returned the fallback failure HTML — bundle missing or asset rewrite threw'
    );
    panel.webview.html = html;
  } finally {
    panel.dispose();
  }
}
