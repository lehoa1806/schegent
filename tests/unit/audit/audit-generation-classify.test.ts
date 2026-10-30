// Feature 251 (FR-R4-F04, contract T12, FR-018; data-model §7) — which audit generations carry legacy
// content-bearing rows.
//
// What it pins: `classifyAuditGeneration(bytes)` returns `legacy-content` when any row is a retired
// `monitor-stdout-line` or `monitor-stderr-line` (CLI output the audit log carried before transport moved
// out of it), or a `cli-invocation` with `schemaVersion < 3` and a `payload.command` (a pre-v3 command
// line), and `metadata-only` otherwise, ignoring lines that do not parse. It never changes a byte.
//
// Why: the Run export names which of its audit files hold such rows, because a reader of an old history
// would otherwise assume every file is metadata only. The classifier is pure; the export and the bundle
// call it.

import { describe, expect, it } from 'vitest';

import { classifyAuditGeneration } from '../../../src/audit/audit-generation-classify';

const row = (fields: Record<string, unknown>): string =>
  JSON.stringify({ id: 'r', timestamp: '2026-03-10T00:00:00.000Z', phase: 'p', iteration: 0, outcome: 'info', ...fields });
const bytes = (...lines: string[]): Buffer => Buffer.from(`${lines.join('\n')}\n`, 'utf8');

describe('classifyAuditGeneration (T12)', () => {
  it.each(['monitor-stdout-line', 'monitor-stderr-line'])('labels a %s row legacy-content', (eventType) => {
    expect(classifyAuditGeneration(bytes(row({ eventType: 'phase-start', schemaVersion: 3, payload: {} }), row({ eventType, schemaVersion: 2, payload: { line: 'x' } })))).toBe(
      'legacy-content'
    );
  });

  it('labels a pre-v3 cli-invocation with a command legacy-content', () => {
    expect(classifyAuditGeneration(bytes(row({ eventType: 'cli-invocation', schemaVersion: 2, payload: { command: 'claude -p ...' } })))).toBe('legacy-content');
  });

  it('does not label a v3 cli-invocation, or a pre-v3 one without a command', () => {
    expect(classifyAuditGeneration(bytes(row({ eventType: 'cli-invocation', schemaVersion: 3, payload: { command: 'x' } })))).toBe('metadata-only');
    expect(classifyAuditGeneration(bytes(row({ eventType: 'cli-invocation', schemaVersion: 2, payload: {} })))).toBe('metadata-only');
  });

  it('labels a v3 history metadata-only', () => {
    expect(
      classifyAuditGeneration(
        bytes(
          row({ eventType: 'phase-start', schemaVersion: 3, payload: { taskId: 't' } }),
          row({ eventType: 'phase-end', schemaVersion: 3, payload: { exitCode: 0 } })
        )
      )
    ).toBe('metadata-only');
  });

  it('ignores lines that do not parse, in either direction', () => {
    expect(classifyAuditGeneration(Buffer.from('not json\n{broken\n', 'utf8'))).toBe('metadata-only');
    expect(
      classifyAuditGeneration(bytes('garbage', row({ eventType: 'monitor-stdout-line', schemaVersion: 2, payload: {} }), '{"half"'))
    ).toBe('legacy-content');
  });

  it('labels an empty file metadata-only, and never throws', () => {
    expect(classifyAuditGeneration(Buffer.alloc(0))).toBe('metadata-only');
  });
});
