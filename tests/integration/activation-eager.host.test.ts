import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

// BUG-002 / FR-031 contract test. Verifies that the Schegent extension
// activates eagerly when VS Code loads a workspace that contains the
// Schegent footprint (`.specify/`), without requiring the operator to
// reveal the sidebar webview or invoke a Schegent command. This guards
// the lifecycle work performed in `wireStage2()` — workspace lock claim
// (`lock.tryAcquire()`), credit watchdog reattachment
// (`watchdog.reattachOnActivation()`), and the persisted-run resumption
// branch — against silent deferral.
//
// This test MUST fail when `package.json` `activationEvents` lacks
// `workspaceContains:.specify/` and pass once the trigger is added.
// See specs/006-sidebar-compact-status-bar/bugs/BUG-002.md.
//
// Feature 111 (T701, FR-024) — this file makes two claims, and only one of them
// can gate.
//
//   The manifest claim — `activationEvents` declares the workspace-content
//   trigger — is now also asserted by
//   `tests/lint/activation-events-declared.test.ts`, which reads `package.json`
//   as data, imports no `vscode`, and therefore runs in the default `npm run
//   test` suite. That file is also where the second trigger,
//   `workspaceContains:.schegent/`, and the reason there is no `onCommand:` or
//   `onView:` entry are recorded.
//
//   The runtime claim — VS Code really did call `activate()` on workspace load,
//   without the sidebar being revealed and without anyone calling
//   `ext.activate()` — cannot move. `vscode.extensions.getExtension` and
//   `ext.isActive` have no meaning under `environment: 'node'`; the stub at
//   `tests/__stubs__/vscode.ts` can return whatever a test wants it to, so an
//   assertion against it would be an assertion about the stub. Only a real
//   extension host can answer "did activation happen on its own", which is why
//   `./vitest.config.ts:40` excludes `*.host.test.ts` and why that exclusion is
//   structural rather than a gap to close.
//
// The manifest assertion below is kept rather than deleted as now-redundant: in
// the host run it reads the *loaded* extension's `packageJSON`, which is the
// manifest VS Code actually resolved, not the file on disk. The two assertions
// agree today and are not the same assertion.
const EXTENSION_ID = 'schegent.schegent';
const REQUIRED_ACTIVATION_EVENT = 'workspaceContains:.specify/';
const ACTIVATION_BUDGET_MS = 5_000;

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `extension '${EXTENSION_ID}' not found in test host`);

  // Manifest contract (FR-031): the activation events must include the
  // workspace-content trigger so that opening any Schegent-shaped workspace
  // is sufficient to fire `activate()`. Without this trigger, the extension
  // only activates on first sidebar reveal, deferring lock claim, watchdog
  // reattach, and persisted-run resumption.
  const pkg = ext.packageJSON as { activationEvents?: readonly string[] } | undefined;
  const declaredEvents = pkg?.activationEvents ?? [];
  assert.ok(
    declaredEvents.includes(REQUIRED_ACTIVATION_EVENT),
    `package.json activationEvents must include "${REQUIRED_ACTIVATION_EVENT}" (FR-031); got ${JSON.stringify(declaredEvents)}`
  );

  // Sanity: confirm the test workspace actually contains the trigger file.
  // Without this guard, an isActive assertion below could pass vacuously
  // for the wrong reason (e.g., some unrelated implicit `onCommand:*` path).
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'test workspace has no folder open');
  const specifyDir = path.join(folder.uri.fsPath, '.specify');
  assert.ok(
    fs.existsSync(specifyDir),
    `test workspace ${folder.uri.fsPath} does not contain .specify/ — workspaceContains trigger cannot fire`
  );

  // Runtime contract (FR-031): wait up to ACTIVATION_BUDGET_MS for the
  // `workspaceContains:.specify/` trigger to fire. We must NOT call
  // `ext.activate()` explicitly — the entire point is to verify that
  // activation happens on workspace load, not on explicit API access.
  const start = Date.now();
  while (!ext.isActive && Date.now() - start < ACTIVATION_BUDGET_MS) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const elapsedMs = Date.now() - start;
  assert.strictEqual(
    ext.isActive,
    true,
    `extension did not activate within ${ACTIVATION_BUDGET_MS}ms despite workspaceContains:.specify/ trigger and the sidebar was never revealed (elapsed=${elapsedMs}ms)`
  );
  assert.ok(
    elapsedMs <= ACTIVATION_BUDGET_MS,
    `extension activation took ${elapsedMs}ms, over budget ${ACTIVATION_BUDGET_MS}ms`
  );
}
