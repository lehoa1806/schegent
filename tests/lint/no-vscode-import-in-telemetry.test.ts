// Feature 033 T003 — repo-grep regression test enforcing the telemetry
// isolation invariant.
//
// `src/telemetry/` hosts the host-side per-process telemetry sampler and
// its platform adapters. The sampler may run on any platform via the
// extension host's Node 18 runtime; the platform adapters shell out to
// `ps` / `powershell.exe` only. No file under this tree has any reason
// to reach for the VS Code extension API — keeping the tree
// `vscode`-free preserves the same posture as `src/headless/` and
// prevents the platform adapters from accidentally pulling in workspace
// state during what should be a process-only probe.
//
// This regression fails the build if any `import … from 'vscode'`,
// `require('vscode')`, or side-effect `import 'vscode'` appears under
// `src/telemetry/`.

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { linesMatching } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'src', 'telemetry');

/**
 * Matching lines under the telemetry tree, as `path:line:text`.
 *
 * This used to shell out to `grep -rnE`, and the patterns below were anchored
 * `^[^:]+:[0-9]+:` because that is the shape of grep's OUTPUT — the `path:line:`
 * prefix it prints — not the shape of the source line it matches against.
 *
 * When the shell-out was replaced with a `node:fs` scan, this file was migrated
 * to whole-file matching, which returns bare paths. The anchor then matched
 * nothing, and two of the three assertions became vacuous: a real
 * `import * as vscode from 'vscode'` in `src/telemetry/` passed all three tests.
 * The suite stayed at 655 passing, which is why counting tests did not catch it.
 *
 * The sibling gate `no-vscode-import-in-headless.test.ts` records this exact
 * defect from feature 089 T015, discovered the same way — "measured by adding a
 * real import and watching all three tests stay green". The lesson was in this
 * directory and was not applied here. It is now: the scan is per-line, and the
 * prefix is reconstructed rather than matched against.
 */
function grepLines(pattern: string): readonly string[] {
  return linesMatching(SCAN_ROOT, pattern).map(
    ({ file, line, text }) => `${file}:${line}:${text}`
  );
}

describe('Feature 033 T003 — no vscode import in src/telemetry/', () => {
  it('no file under src/telemetry/ contains `import … from \'vscode\'`', () => {
    const offenders = grepLines(
      `^[[:space:]]*import[[:space:]].*from[[:space:]]+['\\"]vscode['\\"]`
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
      `^[[:space:]]*import[[:space:]]+['\\"]vscode['\\"]`
    );
    expect(
      offenders,
      `Offending side-effect import 'vscode' in src/telemetry/:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});
