// Feature 084 T034 (FR-058) — the Phase exchange family has one webview call
// site. Mirrors the existing per-family inline-IPC lint tests; the hard rule is
// "never add inline postCommand(...) calls for IPC families that have a shared
// helper", and this is that rule for this family.

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');
const HELPER = 'webview-ui/src/lib/process-yaml-ipc.ts';
const ALLOWED = new Set(['webview-ui/src/lib/messages.ts', HELPER]);
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
