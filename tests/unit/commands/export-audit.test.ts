import { describe, expect, it } from 'vitest';
import { createCountsOnlyAuditExport } from '../../../src/commands/export-audit';

function row(schemaVersion: number, payload: Record<string, unknown>): string {
  return JSON.stringify({
    id: `event-${schemaVersion}`,
    timestamp: '2026-08-02T00:00:00.000Z',
    runId: 'run-private',
    correlationId: 'correlation-private',
    phase: 'speckit-implement',
    iteration: 1,
    eventType: 'phase-end',
    outcome: 'success',
    schemaVersion,
    payload
  });
}

describe('createCountsOnlyAuditExport', () => {
  it('exports v3 rows only and strips ids, names, commands, and paths from payloads', () => {
    const output = createCountsOnlyAuditExport([
      row(2, { command: 'legacy command' }),
      row(3, {
        command: 'forbidden command',
        files: ['src/private.ts'],
        metrics: { tests: 12 },
        fileChangeCounts: { created: 1, modified: 2, deleted: 0 },
        omittedFileEvidenceCount: 3,
        outcome: 'clean',
        terminationReason: 'token'
      })
    ].join('\n'));

    expect(output).not.toContain('legacy command');
    expect(output).not.toContain('forbidden command');
    expect(output).not.toContain('private.ts');
    expect(output).not.toContain('run-private');
    expect(output).toContain('"tests":12');
    expect(output.trim().split('\n')).toHaveLength(1);
  });

  it('keeps the literal cap_exhausted cause but strips free-form fatal-signature cause text', () => {
    const output = createCountsOnlyAuditExport([
      row(3, { outcome: 'failure', terminationReason: 'cap-exhausted', cause: 'cap_exhausted' }),
      row(3, {
        outcome: 'failure',
        terminationReason: 'error',
        // Redacted fatal-signature text (or an operator-added FR-033 pattern) — the
        // exact free-form content this counts-only export must not carry.
        cause: 'operator-configured-fatal-signature: leaked secret pattern'
      })
    ].join('\n'));

    expect(output).toContain('"cause":"cap_exhausted"');
    expect(output).not.toContain('leaked secret pattern');
    expect(output).not.toContain('operator-configured-fatal-signature');
  });

  it('carries a stalled count and refuses a value that is not one', () => {
    // `stalled` joined the allowlist with no value check while its sibling
    // `cause` got one, so the allowlist's own defense-in-depth argument — this
    // function parses whatever bytes are ON DISK, not what today's writer
    // produces — was applied to exactly one of the two fields it was written
    // for. An incident review reads this column as a count.
    const retryRow = (payload: Record<string, unknown>): string =>
      JSON.stringify({
        ...(JSON.parse(row(3, payload)) as Record<string, unknown>),
        eventType: 'phase.retry_evaluated'
      });
    const output = createCountsOnlyAuditExport(
      [
        retryRow({ decision: true, stalled: 4 }),
        retryRow({ decision: true, stalled: 'lots' }),
        retryRow({ decision: true, stalled: -2 }),
        retryRow({ decision: true, stalled: 1.5 })
      ].join('\n')
    );

    const rows = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { payload: Record<string, unknown> });
    expect(rows).toHaveLength(4);
    expect(rows.at(0)?.payload.stalled).toBe(4);
    for (const rejected of rows.slice(1)) {
      // `null`, not absent (2026-09-04 review). An absent `stalled` MEANS the
      // stagnation rule did not apply (data-model.md §2 — "absence is not
      // zero"), so filtering a value the guard disbelieves rewrote a tamper
      // signal into a meaningful reading: the reviewer could not tell a healthy
      // record that never had a count from a corrupted one whose count this
      // export refused to carry. `null` says the second thing out loud.
      expect(rejected.payload).toHaveProperty('stalled', null);
    }
    expect(output).not.toContain('lots');
  });

  it('keeps every event family its own cause vocabulary (2026-09-04 review)', () => {
    // The guard was keyed by field NAME, so `cause === 'cap_exhausted'` was
    // applied to every event type that carries a `cause` — and stripped all of
    // them but `phase-end`'s. An operator exporting a log to see why a
    // breakpoint cleared, why a reorder was rejected, or why a retry was
    // scheduled found the field absent, which is indistinguishable from the
    // event never carrying one. It is scoped by `(eventType, field)` now, and
    // the other vocabularies are admitted by shape rather than re-enumerated
    // here — an enumeration in the export is a second copy of five vocabularies
    // that would drift out of step with all of them.
    const eventRow = (eventType: string, payload: Record<string, unknown>): string =>
      JSON.stringify({
        ...(JSON.parse(row(3, payload)) as Record<string, unknown>),
        eventType
      });
    const output = createCountsOnlyAuditExport(
      [
        eventRow('phase-breakpoint-cleared', { cause: 'consumed-by-fire' }),
        eventRow('task-reordered', { cause: 'task-not-pending' }),
        eventRow('phase-end', { cause: 'cap_exhausted' }),
        // A `phase-end` cause outside the closed vocabulary still goes, and the
        // shape guard is not a licence for free-form text on the others.
        eventRow('phase-end', { cause: 'operator-configured-fatal-signature: hunter2' }),
        eventRow('monitor-rate-limited', { cause: '/Users/someone/secret/path.txt' })
      ].join('\n')
    );

    const causes = output
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { payload: { cause?: unknown } }).payload.cause);
    expect(causes).toEqual([
      'consumed-by-fire',
      'task-not-pending',
      'cap_exhausted',
      null,
      null
    ]);
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('secret/path');
  });
});
