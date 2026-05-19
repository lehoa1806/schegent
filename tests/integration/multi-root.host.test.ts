import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

// Feature 058 (T023) — multi-root semantics integration test.
//
// The shared integration harness (`runTest.ts`) launches the test host with a
// single `--folder-uri`, so `vscode.workspace.workspaceFolders` contains
// exactly one folder when this test starts. To exercise the multi-root
// invariants without forking the harness, the test programmatically appends a
// second folder via `vscode.workspace.updateWorkspaceFolders(...)` and then
// asserts the two end-to-end contracts:
//
//   1. After appending a second folder, `workspaceFolders[0]` is still the
//      ORIGINAL first folder — the canonical-folder rule (FR-001/FR-002).
//   2. No `.schegent/` directory appears under the appended folder — the
//      state-containment rule (FR-005) that the picker exists to preserve.
//
// What this test does NOT cover:
//   - The activation-time toast and the `multi-root.warning-shown` audit
//     event fire exactly once at `activate()` time. Activation here happens
//     against a single-folder workspace, so those surfaces are exercised by
//     `tests/unit/extension/multi-root-activation-warning.test.ts` instead.
//     A future harness extension may load the .code-workspace fixture under
//     `tests/integration/fixtures/multi-root.code-workspace` to exercise the
//     activation surfaces here too.

const EXTENSION_ID = 'schegent.schegent';

export async function run(): Promise<void> {
  const folders0 = vscode.workspace.workspaceFolders;
  assert.ok(
    folders0 && folders0.length >= 1,
    'integration harness launched without a workspace folder'
  );
  const canonical = folders0[0]!;

  // Ensure the extension is active so that its `onDidChangeWorkspaceFolders`
  // listeners (including the picker's cache-invalidator) are registered
  // before we mutate the workspace.
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `extension '${EXTENSION_ID}' not found in test host`);
  if (!ext.isActive) {
    await ext.activate();
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-multi-root-'));
  let appendedIndex = -1;
  try {
    const appendedUri = vscode.Uri.file(tmpDir);
    appendedIndex = vscode.workspace.workspaceFolders!.length;
    const ok = vscode.workspace.updateWorkspaceFolders(
      appendedIndex,
      0,
      { uri: appendedUri, name: 'appended-secondary' }
    );
    assert.strictEqual(
      ok,
      true,
      'updateWorkspaceFolders returned false — VS Code rejected the append'
    );

    // Wait briefly for the `onDidChangeWorkspaceFolders` event to settle.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const folders1 = vscode.workspace.workspaceFolders;
    assert.ok(
      folders1 && folders1.length >= 2,
      `expected >= 2 folders after append, got ${folders1?.length ?? 0}`
    );

    // Invariant 1 — FR-001/FR-002: the first folder remains the canonical
    // folder. Reordering or appending must NOT shift the canonical pick.
    assert.strictEqual(
      folders1[0]!.uri.fsPath,
      canonical.uri.fsPath,
      `first folder drifted after append: got ${folders1[0]!.uri.fsPath}, expected ${canonical.uri.fsPath}`
    );

    // Invariant 2 — FR-005: no `.schegent/` directory in the appended folder.
    // The extension's audit writer and per-run session tree both root under
    // the canonical folder; an appended folder must remain free of Schegent
    // state.
    const schegentInAppended = path.join(tmpDir, '.schegent');
    assert.strictEqual(
      fs.existsSync(schegentInAppended),
      false,
      `unexpected .schegent/ directory created under non-canonical folder: ${schegentInAppended}`
    );
  } finally {
    // Remove the appended folder so subsequent integration tests start from
    // the single-folder baseline.
    const folders2 = vscode.workspace.workspaceFolders ?? [];
    if (folders2.length > 1 && appendedIndex >= 0) {
      vscode.workspace.updateWorkspaceFolders(appendedIndex, 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
