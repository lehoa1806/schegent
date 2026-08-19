// Feature 084 T034 (FR-058) — the Phase exchange family has one webview call
// site. Mirrors the existing per-family inline-IPC lint tests; the hard rule is
// "never add inline postCommand(...) calls for IPC families that have a shared
// helper", and this is that rule for this family.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');
const HELPER = 'webview-ui/src/lib/process-yaml-ipc.ts';
const ALLOWED = new Set([
  // Declaration site (re-export shim).
  'webview-ui/src/lib/messages.ts',
  HELPER,
  // The helper's own unit test, which names the constant to assert the envelope
  // the helper posts. It mocks `postCommand` rather than calling it, so it adds
  // no call site — the same allowance `no-inline-save-phases.test.ts` and
  // `no-inline-reorder-ipc.test.ts` make for theirs.
  'webview-ui/src/lib/__tests__/process-yaml-ipc.test.ts'
]);
const COMMANDS = ['CMD_EXPORT_PROCESS_YAML', 'CMD_PREFLIGHT_PROCESS_YAML'] as const;

function filesReferencing(literal: string): readonly string[] {
  let output = '';
  try {
    output = execFileSync('rg', ['-l', literal, SCAN_ROOT], { encoding: 'utf8' });
  } catch (error) {
    // rg exits 1 for "no matches", which is not a failure of this scan.
    const status = (error as { status?: number }).status;
    if (status !== 1) throw error;
  }
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((absolute) =>
      absolute.startsWith(`${REPO_ROOT}/`) ? absolute.slice(REPO_ROOT.length + 1) : absolute
    );
}

describe('Phase exchange single webview call site', () => {
  for (const literal of COMMANDS) {
    it(`${literal} is referenced only by the shared helper and contract shim`, () => {
      const files = filesReferencing(literal);
      expect(files.filter((file) => !ALLOWED.has(file))).toEqual([]);
      expect(files).toContain(HELPER);
    });
  }
});

// Feature 086 T072 — the third kind is covered, and covered on purpose.
//
// 086 added `exportWorkflowYaml` beside `exportPhaseYaml` and `exportPipelineYaml`,
// and the scan above already caught anything it could do wrong: all three send
// `CMD_EXPORT_PROCESS_YAML`, and no file outside the helper may name that command.
// So the coverage is real — but it is INCIDENTAL. It holds because 086 reused the
// existing command constant, and a fourth kind that introduced its own would be
// outside `COMMANDS` and therefore outside the lint, silently.
//
// These two checks make the coverage deliberate. The first says the helper is the
// whole webview surface of this family; the second says the family has exactly the
// commands the scan above enumerates.
describe('Feature 086 T072 — the exchange helper is the whole webview surface', () => {
  const HELPER_SOURCE = readFileSync(resolve(REPO_ROOT, HELPER), 'utf8');

  it('declares one sender per kind, and one preflight for all four', () => {
    // Export is per-kind because the operator picks a resource of a known kind;
    // preflight is not, because the DOCUMENT declares its kind (FR-055a/FR-058).
    // A second preflight helper would be a kind on the request in disguise.
    const declared = [...HELPER_SOURCE.matchAll(/^export function (\w+)/gm)].map(
      (match) => match[1]!
    );
    expect(declared.sort()).toEqual([
      'exportModelCatalogYaml',
      'exportPhaseYaml',
      'exportPipelineYaml',
      'exportWorkflowYaml',
      'preflightProcessYaml'
    ]);
  });

  it('enumerates every command the family declares, so a fourth cannot arrive unscanned', () => {
    // Read from the contract rather than restated: `COMMANDS` above is a
    // hand-maintained list, and this is the assertion that it is complete. The
    // constants are declared in the aggregate contract module, not in the
    // family's own `process-yaml.ts`, which only re-exports them.
    const contract = readFileSync(resolve(REPO_ROOT, 'src/contracts/sidebar-ipc.ts'), 'utf8');
    const declared = [...contract.matchAll(/export const (CMD_\w*PROCESS_YAML\w*)/g)].map(
      (match) => match[1]!
    );
    expect(declared.sort()).toEqual([...COMMANDS].sort());
  });
});
