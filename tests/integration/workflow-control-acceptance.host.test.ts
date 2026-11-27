import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { renderDashboardHtml } from '../../src/ui/dashboard/dashboard-html';
import {
  ControlLedgerStore,
  lookupRecord
} from '../../src/services/workflow-execution/control-ledger-store';
import { ControlAttemptAdmissionService } from '../../src/services/workflow-execution/control-attempt-admission';
import { CandidateBlockExecutor } from '../../src/services/workflow-execution/candidate-block-executor';
import { ControlCommandService } from '../../src/services/workflow-execution/control-command-service';
import { RepeatExecutor } from '../../src/services/workflow-execution/repeat-executor';
import { ForEachExecutor } from '../../src/services/workflow-execution/foreach-executor';
import {
  createFixtureMemoryMemento,
  createInjectableControlClock,
  makeFixtureFence
} from '../fixtures/workflow-control/workflow-control-fixtures';

const EXTENSION_ID = 'schegent.schegent';
const CSP_META_RE = /<meta\s+http-equiv=["']Content-Security-Policy["']/i;

const WORKFLOW_CONTROL_BUNDLE_MARKERS = [
  'candidate-block-editor',
  'candidate-block-inspector',
  'toggle-repeat-control',
  'repeat-node-projection-',
  'foreach-node-projection-',
  'foreach-error-summary-'
] as const;

function readJavaScriptTree(root: string): string {
  if (!fs.existsSync(root)) return '';
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
 * FR-R5-F35 (F35-T05, SPEC-13) — Real VS Code extension-host qualification for
 * Workflow Control Flow, Repetition, and Backend Recovery (`F23`–`F34`).
 */
export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `extension '${EXTENSION_ID}' not found in test host`);
  await ext.activate();

  const extensionRoot = ext.extensionPath;
  const bundleDir = path.join(extensionRoot, 'dist', 'webview');

  const panel = vscode.window.createWebviewPanel(
    'schegent.workflowControl.integration.test',
    'Schegent Workflow Control Integration Test',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(bundleDir),
        vscode.Uri.file(path.join(extensionRoot, 'resources'))
      ]
    }
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-wf-control-host-'));

  try {
    const html = renderDashboardHtml({
      webview: panel.webview,
      extensionRoot,
      nonce: 'wf-control-nonce-' + Date.now().toString(36),
      toLocalUri: (fsPath) => vscode.Uri.file(fsPath),
      webviewBundleDir: bundleDir
    });

    assert.match(html, CSP_META_RE, 'dashboard HTML must carry a Content-Security-Policy <meta>');
    assert.ok(
      !/<(?:script|link)\b[^>]*\bcrossorigin\b/i.test(html),
      'dashboard HTML must not emit crossorigin attributes'
    );
    panel.webview.html = html;

    const bundleSource = readJavaScriptTree(bundleDir);
    if (bundleSource.length > 0) {
      for (const marker of WORKFLOW_CONTROL_BUNDLE_MARKERS) {
        assert.ok(
          bundleSource.includes(marker),
          `production webview bundle is missing workflow control marker '${marker}'`
        );
      }
    }

    // Host-process control admission, candidate-block command, Repeat & ForEach round-trip
    const clock = createInjectableControlClock();
    const ledgerStore = new ControlLedgerStore(createFixtureMemoryMemento());
    const fence = makeFixtureFence(1, 'host-test');
    const admission = new ControlAttemptAdmissionService({ ledgerStore, clock });
    const candidateExecutor = new CandidateBlockExecutor({
      ledgerStore,
      admissionService: admission,
      clock
    });
    const commandService = new ControlCommandService({ ledgerStore, clock });
    const repeatExecutor = new RepeatExecutor({ ledgerStore, clock });
    const forEachExecutor = new ForEachExecutor({ ledgerStore, clock });

    assert.ok(repeatExecutor);
    assert.ok(forEachExecutor);

    await admission.prepareRootLink({
      ledgerRunId: 'root-host-1',
      connectedRunId: 'root-host-1',
      rootWorkflowId: 'wf-host-acceptance',
      queueId: 'default',
      fence
    });
    await admission.activateRootLink({
      ledgerRunId: 'root-host-1',
      connectedRunId: 'root-host-1',
      fence
    });

    const invocationId = '44444444-4444-4444-8444-444444444444';
    const initBlock = await candidateExecutor.initializeCandidateBlock({
      rootRunId: 'root-host-1',
      workflowId: 'wf-host-acceptance',
      frameKey: 'frame-host-block',
      invocationId,
      nodeId: 'node-host-block',
      selectionPolicy: 'first-ready',
      candidates: [
        {
          candidateId: 'cand-primary',
          nodeId: 'node-cand-1',
          backend: 'claude',
          priority: 1,
          authoredOrder: 0,
          maxAttempts: 2
        },
        {
          candidateId: 'cand-fallback',
          nodeId: 'node-cand-2',
          backend: 'codex',
          priority: 2,
          authoredOrder: 1,
          maxAttempts: 2
        }
      ],
      fence
    });
    assert.equal(initBlock.ok, true);

    const cmdOutcome = await commandService.executeControlCommand({
      version: 1,
      commandId: '55555555-5555-4555-8555-555555555555',
      rootRunId: 'root-host-1',
      queueId: 'default',
      invocationId,
      expectedGeneration: 1,
      action: {
        kind: 'set-policy',
        availabilityPolicy: 'wait-for-selected'
      }
    });
    assert.equal(cmdOutcome.outcome, 'accepted');

    const loaded = ledgerStore.read();
    assert.equal(loaded.ok, true);
    const rootState = lookupRecord(loaded.ledger.roots, 'root-host-1');
    assert.ok(rootState, 'root control state must be persisted in ControlLedgerStore');
  } finally {
    panel.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
