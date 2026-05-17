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

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'src', 'headless');

function grepLines(pattern: string): readonly string[] {
  let out: string;
  try {
    out = execSync(
      `grep -rnE "${pattern}" "${SCAN_ROOT}"`,
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
    // Matches both:
    //   import * as vscode from 'vscode';
    //   import { foo } from 'vscode';
    //   import vscode from "vscode";
    const offenders = grepLines(`^[^:]+:[0-9]+:[[:space:]]*import[[:space:]].*from[[:space:]]+['\\"]vscode['\\"]`);
    expect(
      offenders,
      `Offending import-from-vscode in src/headless/:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('no file under src/headless/ contains `require(\'vscode\')`', () => {
    const offenders = grepLines(`require\\([[:space:]]*['\\"]vscode['\\"][[:space:]]*\\)`);
    expect(
      offenders,
      `Offending require('vscode') in src/headless/:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('no file under src/headless/ contains a side-effect `import \'vscode\'`', () => {
    const offenders = grepLines(`^[^:]+:[0-9]+:[[:space:]]*import[[:space:]]+['\\"]vscode['\\"]`);
    expect(
      offenders,
      `Offending side-effect import 'vscode' in src/headless/:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});
