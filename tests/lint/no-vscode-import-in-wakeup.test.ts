// Feature 051 — repo-grep regression test enforcing the wakeup-runner
// isolation invariant for `src/wakeup/`.
//
// `src/wakeup/` hosts the modules reached transitively by
// `src/headless/wakeup-runner.ts` — the standalone CommonJS bundle
// spawned by the OS scheduler (launchd / Task Scheduler / cron /
// systemd-user) outside the VS Code host. The 014 hard rule already
// bans `vscode` imports from `src/headless/`; this test extends the
// same defense to the wakeup tree the runner reaches.
//
// Today's runner-reached modules: `session-log-writer.ts`,
// `session-capture-ring.ts`, `session-log-constants.ts`. The whole
// directory is currently `vscode`-free and we keep it that way so
// that adding a new helper anywhere under `src/wakeup/` does not
// silently re-expose the OS scheduler to extension-host context.
//
// This regression fails the build if any `import … from 'vscode'`,
// `require('vscode')`, or side-effect `import 'vscode'` appears
// under `src/wakeup/`.

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'src', 'wakeup');

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

describe('Feature 051 — no vscode import in src/wakeup/', () => {
  it("no file under src/wakeup/ contains `import … from 'vscode'`", () => {
    const offenders = grepLines(
      `^[^:]+:[0-9]+:[[:space:]]*import[[:space:]].*from[[:space:]]+['\\"]vscode['\\"]`
    );
    expect(
      offenders,
      `Offending import-from-vscode in src/wakeup/:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it("no file under src/wakeup/ contains `require('vscode')`", () => {
    const offenders = grepLines(`require\\([[:space:]]*['\\"]vscode['\\"][[:space:]]*\\)`);
    expect(
      offenders,
      `Offending require('vscode') in src/wakeup/:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it("no file under src/wakeup/ contains a side-effect `import 'vscode'`", () => {
    const offenders = grepLines(
      `^[^:]+:[0-9]+:[[:space:]]*import[[:space:]]+['\\"]vscode['\\"]`
    );
    expect(
      offenders,
      `Offending side-effect import 'vscode' in src/wakeup/:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});
