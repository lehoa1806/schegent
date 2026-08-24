import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

// Feature 058 (T023) — multi-root semantics integration test.
//
// This module gets its OWN launch of the host leg, against a real multi-root
// `.code-workspace` materialized from `tests/integration/fixtures/`. See
// `runTest.ts#MULTI_ROOT_MODULE` for why: the test used to synthesize its
// workspace at runtime with `updateWorkspaceFolders`, and on VS Code at the
// declared floor that single-folder-to-multi-root transition RELOADS the window
// — which tore the run down before any assertion could report, and surfaced as
// exit 1 with no output naming this file.
//
// Opening the shape at launch instead of building it needs no transition, so it
// holds on every host. It also means activation happens WITH the multi-root
// workspace, which puts the activation-time surfaces in reach for the first
// time. The three contracts asserted here:
//
//   1. FR-001/FR-002 — `workspaceFolders[0]` is the canonical folder, and the
//      extension's own state lands under it.
//   2. FR-005 — no `.schegent/` directory appears under any non-canonical
//      folder. This is the state-containment rule the picker exists to preserve.
//   3. Feature 058 — the `multi-root.warning-shown` audit event is recorded,
//      names the canonical folder, and carries NO workspace path. The old test
//      could not reach this: activation had already happened against a single
//      folder by the time it ran, so `tests/unit/extension/`
//      `multi-root-activation-warning.test.ts` was the only cover it had.
//
// The toast itself is still unit-covered — `maybeShowMultiRootWarning` routes it
// through `Notifier`, and a live host gives no handle on a shown notification.
// The audit event is the durable half of the same emission and is asserted here.

const EXTENSION_ID = 'schegent.schegent';
const AUDIT_RELATIVE = path.join('.schegent', 'audit.log');
const SCHEGENT_DIR = '.schegent';
const WARNING_EVENT = 'multi-root.warning-shown';
const WARNING_DEADLINE_MS = 5_000;

interface AuditRecord {
  readonly eventType?: string;
  readonly payload?: Record<string, unknown>;
}

function readAuditRecords(auditPath: string): readonly AuditRecord[] {
  return fs
    .readFileSync(auditPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditRecord);
}

/**
 * Wait for the activation-time warning to land.
 *
 * `extension.ts` fires `maybeShowMultiRootWarning` with `void`, so the append
 * is deliberately not awaited by `activate()` — the event can arrive a tick
 * after the extension reports active. Polling is the difference between testing
 * the contract and testing the scheduler.
 */
async function waitForWarningEvent(auditPath: string): Promise<AuditRecord> {
  const startedAt = Date.now();
  let diagnosis = `no audit log at ${auditPath}`;
  for (;;) {
    if (fs.existsSync(auditPath)) {
      const records = readAuditRecords(auditPath);
      const match = records.find((record) => record.eventType === WARNING_EVENT);
      if (match) return match;
      diagnosis =
        `audit log holds ${records.length} record(s), none of type '${WARNING_EVENT}': ` +
        `${records.map((r) => r.eventType ?? '<untyped>').join(', ')}`;
    }
    if (Date.now() - startedAt >= WARNING_DEADLINE_MS) {
      throw new Error(`'${WARNING_EVENT}' not recorded within ${WARNING_DEADLINE_MS}ms — ${diagnosis}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function run(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  assert.ok(
    folders && folders.length >= 2,
    `this module needs a real multi-root workspace but the launch opened ` +
      `${folders?.length ?? 0} folder(s). The multi-root pass in runTest.ts is what supplies it.`
  );
  assert.ok(
    vscode.workspace.workspaceFile,
    'workspace has no .code-workspace file — the folders were synthesized rather than opened, ' +
      'which is the technique this test was moved off of'
  );

  const canonical = folders[0]!;
  const nonCanonical = folders.slice(1);
  assert.ok(nonCanonical.length >= 1, 'multi-root fixture produced no non-canonical folder');

  // Activation should already have happened through `workspaceContains:.specify/`
  // in the canonical folder. `activate()` is the fallback, not the trigger: the
  // warning under test fires at activation, so a test that activates the
  // extension itself is testing a different sequence than an operator gets.
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `extension '${EXTENSION_ID}' not found in test host`);
  if (!ext.isActive) {
    await ext.activate();
  }

  // Contract 3 — the audit event, its payload, and the path-free hard rule.
  const auditPath = path.join(canonical.uri.fsPath, AUDIT_RELATIVE);
  const record = await waitForWarningEvent(auditPath);
  const payload = record.payload;
  assert.ok(payload, `'${WARNING_EVENT}' was recorded with no payload`);
  assert.strictEqual(
    payload.folderCount,
    folders.length,
    `'${WARNING_EVENT}' reported folderCount ${String(payload.folderCount)} for a ` +
      `${folders.length}-folder workspace`
  );
  assert.strictEqual(
    payload.canonicalFolderName,
    canonical.name,
    `'${WARNING_EVENT}' named '${String(payload.canonicalFolderName)}' as canonical, ` +
      `expected '${canonical.name}'`
  );
  // "Never serialize workspace root paths into the structured audit log." The
  // payload carries a display NAME by design; asserting the absence of every
  // open folder's fsPath is what keeps a future field from smuggling one in.
  const serialized = JSON.stringify(record);
  for (const folder of folders) {
    assert.ok(
      !serialized.includes(folder.uri.fsPath),
      `'${WARNING_EVENT}' leaked a workspace root path into the audit log: ${folder.uri.fsPath}`
    );
  }

  // Contract 1 — FR-001/FR-002: state lands under the canonical folder. The
  // audit log this test just read IS that state, so its location is the
  // assertion: it was found under `folders[0]`, not searched for anywhere else.
  assert.ok(
    fs.existsSync(path.join(canonical.uri.fsPath, SCHEGENT_DIR)),
    `no ${SCHEGENT_DIR}/ under the canonical folder ${canonical.uri.fsPath}`
  );

  // Contract 2 — FR-005: nothing under the others.
  for (const folder of nonCanonical) {
    const stray = path.join(folder.uri.fsPath, SCHEGENT_DIR);
    assert.strictEqual(
      fs.existsSync(stray),
      false,
      `unexpected ${SCHEGENT_DIR}/ directory created under non-canonical folder: ${stray}`
    );
  }
}
