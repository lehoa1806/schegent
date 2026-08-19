// Feature 019 T029 — repo-grep regression test.
//
// The runtime-log sink at `src/lib/runtime-log/runtime-log-sink.ts` is
// the ONLY place authorised to append-write to the operator-configured
// runtime-log file (which defaults to `<workspace>/.schegent/syslog`).
//
// To prevent drift — e.g., a future feature introducing a second writer
// that bypasses the redaction-by-reuse, suppression map, and per-emit
// accessor read — this test asserts no other source file under `src/`
// (a) calls `fs.appendFile(...)` against a path containing `syslog`, or
// (b) references the literal substring `syslog` at all outside the
// runtime-log module.
//
// Mirrors the regression-style of:
//   tests/lint/no-inline-save-general-settings.test.ts

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'src');

/**
 * Files under `src/` that are permitted to mention `syslog`. The default
 * path resolver and the doc comments referencing the default belong to
 * the runtime-log module — nothing else should know about the literal.
 */
const ALLOWED_SYSLOG_REFERENCES: ReadonlySet<string> = new Set([
  'src/lib/runtime-log/runtime-log-path.ts'
]);

/**
 * Files under `src/` that are permitted to call `fs.appendFile(...)`.
 * Each of these writes to a distinct, non-syslog sink:
 *
 *   - runtime-log-sink.ts  → the runtime-log file itself (this feature).
 *   - audit-log-writer.ts  → `.schegent/audit.log`.
 *   - raw-transcript-writer.ts → `.schegent/sessions/.../transcript-*.log`.
 *   - verbose-diagnostic-writer.ts → `.schegent/sessions/.../diagnostics/...`.
 *   - cli-transport-sink.ts → `.schegent/cli-transport.log` (FR-R3-007).
 *   - metrics-rollup-writer.ts → `.schegent/metrics-rollup.jsonl` (FR-R3-009).
 *
 * The fifth was added when the per-line `monitor-stdout-line` audit writer was
 * retired: line content needs a home with its own retention budget, and routing
 * it through any writer above would put it back in competition with that
 * writer's budget — the exact coupling the split removed. It reuses the shared
 * sanitizer rather than the shared writer, which is the part that actually
 * matters for redaction-by-reuse.
 *
 * The sixth is the durable metrics rollup, and it is the one entry here that
 * does not need the shared sanitizer at all: a record is a run id, a terminal
 * status, two ISO timestamps, six integers and an optional number, with no
 * operator-authored text in it to redact. Routing it through `audit-log-writer`
 * would have been the obvious reuse and is exactly wrong — the rollup exists
 * *because* the audit log rotates, so sharing that file would give the rollup
 * the retention policy it was built to escape.
 *
 * None of these target a path containing `syslog`. The test below
 * verifies that claim by also scanning for `appendFile.*syslog`.
 */
const ALLOWED_APPENDFILE_FILES: ReadonlySet<string> = new Set([
  'src/lib/runtime-log/runtime-log-sink.ts',
  'src/audit/audit-log-writer.ts',
  'src/audit/raw-transcript-writer.ts',
  'src/audit/verbose-diagnostic-writer.ts',
  'src/monitor/cli-transport-sink.ts',
  'src/metrics/metrics-rollup-writer.ts'
]);

function execGrep(pattern: string, extraFlags: string = ''): readonly string[] {
  let out: string;
  try {
    out = execSync(
      `grep -rln ${extraFlags} -- "${pattern}" "${SCAN_ROOT}"`,
      { encoding: 'utf8' }
    );
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && (!e.stdout || e.stdout.trim() === '')) {
      return [];
    }
    throw err;
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((abs) => (abs.startsWith(REPO_ROOT + '/') ? abs.slice(REPO_ROOT.length + 1) : abs))
    .filter((rel) => rel.endsWith('.ts'));
}

function execGrepLines(pattern: string, extraFlags: string = ''): readonly string[] {
  let out: string;
  try {
    out = execSync(
      `grep -rn ${extraFlags} -- "${pattern}" "${SCAN_ROOT}"`,
      { encoding: 'utf8' }
    );
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && (!e.stdout || e.stdout.trim() === '')) {
      return [];
    }
    throw err;
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe('Feature 019 T029 — no direct syslog fs writes', () => {
  it('only the allowlisted runtime-log module files reference the literal "syslog"', () => {
    const matches = execGrep('syslog');
    const offenders = matches.filter((rel) => !ALLOWED_SYSLOG_REFERENCES.has(rel));
    expect(
      offenders,
      `Files under src/ referencing "syslog" outside the runtime-log module:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('no source file calls fs.appendFile(...) against a path containing "syslog"', () => {
    // A single line containing both `appendFile(` and `syslog` is the
    // smoking gun: it means a caller passed a hardcoded syslog path to
    // appendFile, bypassing the sink. The regex tolerates whitespace
    // between the call and the argument literal.
    const hits = execGrepLines('appendFile.*syslog', '-E');
    expect(
      hits,
      `Direct fs.appendFile(...) calls against a syslog path:\n${hits.join('\n')}`
    ).toEqual([]);
  });

  it('only the allowlisted writer files call fs.appendFile(...)', () => {
    const matches = execGrep('appendFile');
    const offenders = matches.filter((rel) => !ALLOWED_APPENDFILE_FILES.has(rel));
    expect(
      offenders,
      `New fs.appendFile(...) call sites under src/. ` +
        `Either route through an existing writer or add an entry to ` +
        `tests/lint/no-direct-syslog-fs-writes.test.ts after PR review:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('the runtime-log sink remains in the allowlist (sanity check)', () => {
    const matches = execGrep('appendFile');
    expect(matches).toContain('src/lib/runtime-log/runtime-log-sink.ts');
  });
});
