// Feature 014 T005 — repo-grep regression test enforcing the headless-runner
// isolation invariant.
//
// `src/headless/` hosts the standalone Wake up runner that ships bundled to
// `<globalStorageUri>/wakeup/runner.js`. The bundle is spawned by the OS
// scheduler (launchd / Task Scheduler / cron / systemd-user) as a plain
// `node <runner.js>` subprocess — there is NO VS Code host, no extension
// API, and no `vscode` module to resolve. Any `import … from 'vscode'`
// or `require('vscode')` from this tree would either (a) crash the
// runner at startup with `Cannot find module 'vscode'`, or (b) silently
// pull in unwanted host context via the bundler.
//
// This regression test fails the build if either pattern appears under
// `src/headless/`. The runner MUST be self-contained.
//
// Feature 089 T015 — the scan root already covers every module added to this
// tree, because `grep -r` is recursive and takes the directory rather than a
// file list. What did NOT hold was the thing the scan exists to do: two of the
// three patterns anchored on `^<path>:<lineno>:`, which is the shape of grep's
// OUTPUT, not of the line grep matches against. A pattern anchored that way can
// never match, so both assertions passed vacuously — measured by adding a real
// `import * as vscode from 'vscode';` to this tree and watching all three tests
// stay green. The anchors are dropped below, and `matches an offending line`
// keeps the matcher honest by proving it against known-bad text, so a future
// pattern edit that silently stops matching fails here instead of shipping.

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'src', 'headless');

/** `import … from 'vscode'`, in every spelling including `import type`. */
const IMPORT_FROM =
  `^[[:space:]]*import[[:space:]].*from[[:space:]]+['\\"]vscode['\\"]`;
/** `require('vscode')`, anywhere on the line. */
const REQUIRE_CALL = `require\\([[:space:]]*['\\"]vscode['\\"][[:space:]]*\\)`;
/** A side-effect `import 'vscode'` with no binding. */
const SIDE_EFFECT_IMPORT = `^[[:space:]]*import[[:space:]]+['\\"]vscode['\\"]`;

function grepLines(pattern: string, scanRoot: string = SCAN_ROOT): readonly string[] {
  let out: string;
  try {
    out = execSync(
      `grep -rnE "${pattern}" "${scanRoot}"`,
      { encoding: 'utf8' }
    );
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    // grep exit code 1 = "no matches found", which is the success case here.
    if (e.status === 1 && (!e.stdout || e.stdout.trim() === '')) {
      return [];
    }
    // Exit code 2 = scan-root does not exist; treat as empty (no offenders).
    if (e.status === 2) {
      return [];
    }
    throw err;
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe('Feature 014 T005 — no vscode import in src/headless/', () => {
  it('no file under src/headless/ contains `import … from \'vscode\'`', () => {
    // Matches all of:
    //   import * as vscode from 'vscode';
    //   import { foo } from 'vscode';
    //   import vscode from "vscode";
    //   import type { Uri } from 'vscode';
    const offenders = grepLines(IMPORT_FROM);
    expect(
      offenders,
      `Offending import-from-vscode in src/headless/:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('no file under src/headless/ contains `require(\'vscode\')`', () => {
    const offenders = grepLines(REQUIRE_CALL);
    expect(
      offenders,
      `Offending require('vscode') in src/headless/:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('no file under src/headless/ contains a side-effect `import \'vscode\'`', () => {
    const offenders = grepLines(SIDE_EFFECT_IMPORT);
    expect(
      offenders,
      `Offending side-effect import 'vscode' in src/headless/:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  // The scan's own regression test. Without it, a pattern that matches nothing
  // is indistinguishable from a tree that offends nothing — which is exactly how
  // two of the three above came to pass on a file that imported the host API.
  it('each pattern matches an offending line, and none matches a clean one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'headless-lint-'));
    const cleanDir = mkdtempSync(join(tmpdir(), 'headless-lint-clean-'));
    try {
      writeFileSync(
        join(dir, 'offender.ts'),
        [
          `import * as vscode from 'vscode';`,
          `import { window } from "vscode";`,
          `import type { Uri } from 'vscode';`,
          `import 'vscode';`,
          `const api = require('vscode');`,
          ''
        ].join('\n'),
        'utf8'
      );
      writeFileSync(
        join(dir, 'clean.ts'),
        [
          `// mentions vscode in prose, and imports nothing from it`,
          `import { readFile } from 'node:fs/promises';`,
          `export const note = 'vscode';`,
          ''
        ].join('\n'),
        'utf8'
      );

      expect(grepLines(IMPORT_FROM, dir).length).toBe(3);
      expect(grepLines(SIDE_EFFECT_IMPORT, dir).length).toBe(1);
      expect(grepLines(REQUIRE_CALL, dir).length).toBe(1);

      writeFileSync(join(cleanDir, 'clean.ts'), `export const note = 'vscode';\n`, 'utf8');
      expect(grepLines(IMPORT_FROM, cleanDir)).toEqual([]);
      expect(grepLines(SIDE_EFFECT_IMPORT, cleanDir)).toEqual([]);
      expect(grepLines(REQUIRE_CALL, cleanDir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(cleanDir, { recursive: true, force: true });
    }
  });
});
