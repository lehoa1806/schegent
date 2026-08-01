import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

// US6 / T049 / FR-033 — release-gate smoke (host-side).
//
// This integration test is the "if you regress release gate, Electron will
// fail" rail. Its job is to fail the Electron host suite if a future PR
// strips `test:integration` out of `npm run ci` (the documented full
// pre-merge gate) or sneaks it into `npm run ci:fast` (the inner-loop
// gate that, by design, MUST stay fast).
//
// We do this from inside the Electron host so that the `npm run
// test:integration` runner itself fails when the canonical chain is
// broken — that way the regression cannot be papered over by skipping a
// unit test.
export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'test workspace has no folder open');

  // Walk up from the workspace root until we find package.json. The
  // integration suite runs against the project's own checkout, so the
  // package.json should be at workspaceRoot or a parent.
  const workspaceRoot = folder.uri.fsPath;
  let cursor = workspaceRoot;
  let pkgPath: string | null = null;
  for (let i = 0; i < 6 && cursor; i += 1) {
    const candidate = path.join(cursor, 'package.json');
    if (fs.existsSync(candidate)) {
      pkgPath = candidate;
      break;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  assert.ok(pkgPath, 'could not locate package.json from the workspace root');

  const raw = fs.readFileSync(pkgPath, 'utf8');
  const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
  const scripts = parsed.scripts ?? {};

  assert.ok(typeof scripts.ci === 'string', 'package.json:scripts.ci is missing');
  assert.ok(
    typeof scripts['ci:fast'] === 'string',
    'package.json:scripts["ci:fast"] is missing'
  );
  assert.ok(
    scripts.ci.includes('test:integration'),
    'package.json:scripts.ci must invoke `npm run test:integration` so Electron is part of the documented release gate'
  );
  assert.ok(
    scripts.ci.includes('package:smoke'),
    'package.json:scripts.ci must invoke `npm run package:smoke` so packaged VSIX creation is part of the documented release gate'
  );
  assert.ok(
    scripts['package:smoke']?.includes('scripts/package-vsix-smoke.mjs'),
    'package.json:scripts["package:smoke"] must inspect the produced VSIX contents, not only create the archive'
  );
  assert.ok(
    scripts.ci.includes('typecheck:tests'),
    'package.json:scripts.ci must statically typecheck every test source'
  );
  assert.ok(
    scripts['ci:fast'].includes('typecheck:tests'),
    'package.json:scripts["ci:fast"] must statically typecheck every test source'
  );
  assert.ok(
    !scripts['ci:fast'].includes('test:integration'),
    'package.json:scripts["ci:fast"] must NOT invoke `test:integration` — that script is the inner-loop iteration gate'
  );
  assert.ok(
    !scripts['ci:fast'].includes('package:smoke'),
    'package.json:scripts["ci:fast"] must NOT invoke `package:smoke` — that script is the inner-loop iteration gate'
  );
}
