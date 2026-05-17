// Feature 033 T003 — repo-grep regression test enforcing the telemetry
// isolation invariant.
//
// `src/telemetry/` hosts the host-side per-process telemetry sampler and
// its platform adapters. The sampler may run on any platform via the
// extension host's Node 18 runtime; the platform adapters shell out to
// `ps` / `powershell.exe` only. No file under this tree has any reason
// to reach for the VS Code extension API — keeping the tree
// `vscode`-free preserves the same posture as `src/headless/` and
// `src/wakeup/` and prevents the platform adapters from accidentally
// pulling in workspace state during what should be a process-only
// probe.
//
// This regression fails the build if any `import … from 'vscode'`,
// `require('vscode')`, or side-effect `import 'vscode'` appears under
// `src/telemetry/`.

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'src', 'telemetry');

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

describe('Feature 033 T003 — no vscode import in src/telemetry/', () => {
  it('no file under src/telemetry/ contains `import … from \'vscode\'`', () => {
    const offenders = grepLines(
      `^[^:]+:[0-9]+:[[:space:]]*import[[:space:]].*from[[:space:]]+['\\"]vscode['\\"]`
    );
    expect(
      offenders,
      `Offending import-from-vscode in src/telemetry/:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('no file under src/telemetry/ contains `require(\'vscode\')`', () => {
    const offenders = grepLines(`require\\([[:space:]]*['\\"]vscode['\\"][[:space:]]*\\)`);
    expect(
      offenders,
      `Offending require('vscode') in src/telemetry/:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('no file under src/telemetry/ contains a side-effect `import \'vscode\'`', () => {
    const offenders = grepLines(
      `^[^:]+:[0-9]+:[[:space:]]*import[[:space:]]+['\\"]vscode['\\"]`
    );
    expect(
      offenders,
      `Offending side-effect import 'vscode' in src/telemetry/:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});
