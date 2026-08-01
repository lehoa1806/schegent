import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'schegent.schegent';

function readJavaScriptTree(root: string): string {
  const sources: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        sources.push(fs.readFileSync(fullPath, 'utf8'));
      }
    }
  };
  visit(root);
  return sources.join('\n');
}

/**
 * Release qualification automation for the production artifact portions of
 * features 067 and 068. Behavioral transitions and reload reconstruction are
 * covered by webview/host tests; this real VS Code host module proves that the
 * built extension shipped those paths instead of tree-shaking them away.
 */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `extension '${EXTENSION_ID}' not found in test host`);
  await extension.activate();

  const bundleDirectory = path.join(extension.extensionPath, 'dist', 'webview');
  const productionJavaScript = readJavaScriptTree(bundleDirectory);

  for (const marker of [
    'acquireVsCodeApi',
    'getState',
    'setState',
    'isLiveMode',
    'jump-current',
    'phase-log-live-indicator'
  ]) {
    assert.ok(
      productionJavaScript.includes(marker),
      `production webview bundle is missing Live Mode/reload marker '${marker}'`
    );
  }

  for (const marker of [
    'system-view-debug',
    'system-view-audit',
    'system-panel-debug',
    'system-panel-audit',
    'system-debug-log',
    'system-audit-log'
  ]) {
    assert.ok(
      productionJavaScript.includes(marker),
      `production dashboard bundle is missing System subtab marker '${marker}'`
    );
  }
}
