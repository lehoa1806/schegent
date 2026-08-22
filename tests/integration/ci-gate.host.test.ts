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
// gate that, by design, MUST stay fast). It also pins `package:smoke` into
// both chains — see the note beside that assertion for why the rule points
// that way.
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
  // This rule used to read the other way: `ci:fast` must NOT invoke
  // `package:smoke`. FR-R3-022 inverted it, and this rail was the copy that
  // did not get updated. Two reasons the new direction is the right one:
  //
  //  1. `package:smoke` was reachable from no local chain at all, so the VSIX
  //     allowlist drifted unnoticed through features 081-095 and surfaced only
  //     in CI. `tests/unit/build/preflight-coverage.test.ts` now *requires*
  //     `npm run build:host && npm run package:smoke` in `ci:fast` for exactly
  //     that reason.
  //  2. "Keep the inner loop fast" is served by the `test:integration`
  //     exclusion above — Electron is the expensive step. Packaging a VSIX is
  //     seconds, and it is the step that catches a shipped-artifact defect.
  //
  // The contradiction was invisible from `ci:fast` because this file only runs
  // under `test:integration`, which `ci:fast` deliberately excludes. That is
  // the drift mechanism round 3 was convened to remove, so the two copies are
  // pinned in the same direction here.
  assert.ok(
    scripts['ci:fast'].includes('package:smoke'),
    'package.json:scripts["ci:fast"] must invoke `package:smoke` so a packaging regression fails the local preflight instead of surfacing only in CI (FR-R3-022)'
  );
}
