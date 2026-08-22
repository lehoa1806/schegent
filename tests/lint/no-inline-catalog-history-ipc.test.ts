// Feature 101 (US4, T055) — single-call-site discipline for
// `CMD_READ_DEFINITION_VERSION`.
//
// Every read family in this repo has one of these gates — phase-log, metrics,
// audit-pointer — and a new one without it is precisely the drift the
// convention exists to catch. The shared helper at
// `webview-ui/src/lib/catalog-history-ipc.ts` is the SOLE caller of
// `postCommand(CMD_READ_DEFINITION_VERSION, …)`, because it is also the only
// place `ack.result` is put through `isValidReadDefinitionVersionResponse`. A
// component that posted the command itself would skip that validator and bind
// an unvalidated body straight into the panel.
//
// Mirrors `tests/lint/no-inline-read-metrics-ipc.test.ts`.

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { filesMatching } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  // The webview shim that re-exports the whole IPC contract via a single
  // `export *`. It contains no logic; grep cannot follow re-exports, so the
  // file is allowlisted rather than matched.
  'webview-ui/src/lib/messages.ts',
  // The shared helper — the SINGLE call site of
  // postCommand(CMD_READ_DEFINITION_VERSION, ...).
  'webview-ui/src/lib/catalog-history-ipc.ts'
]);

function listMatchingFiles(pattern: string): readonly string[] {
  let out: string;
  try {
    out = filesMatching(SCAN_ROOT, pattern, { fixed: true }).join('\n');
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && (!e.stdout || e.stdout.trim() === '')) {
      return [];
    }
    if (e.status === 2) {
      return [];
    }
    throw err;
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((abs) => (abs.startsWith(REPO_ROOT + '/') ? abs.slice(REPO_ROOT.length + 1) : abs));
}

describe('Feature 101 T055 — no inline CMD_READ_DEFINITION_VERSION references', () => {
  it('only the allowlisted files reference CMD_READ_DEFINITION_VERSION', () => {
    const matched = listMatchingFiles('CMD_READ_DEFINITION_VERSION');
    const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
    expect(
      offenders,
      'CMD_READ_DEFINITION_VERSION must only be referenced by webview-ui/src/lib/catalog-history-ipc.ts '
        + '(and the messages.ts re-export shim). Route the read through readDefinitionVersion() instead.'
    ).toEqual([]);
  });

  it('the shared helper exists and is the one that validates the response', () => {
    // The allowlist above is only meaningful while the helper it names is the
    // thing doing the validating. A helper that stopped calling the validator
    // would still satisfy the grep and would hand an unvalidated body to the
    // panel — so the gate checks for the validator by name, not just the file.
    const helper = listMatchingFiles('isValidReadDefinitionVersionResponse');
    expect(helper).toContain('webview-ui/src/lib/catalog-history-ipc.ts');
  });
});
