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

  it('carries the new pre-spawn refusal cause (feature 212, FR-004)', () => {
    // The `phase-end` arm of the cause guard is an ENUMERATION, so a value added
    // to that event's closed vocabulary and not added here would not merely fail
    // to be recognised: by the rule the test above states, every row carrying it
    // exports as `null` — a tamper signal — rather than as the cause it is.
    const output = createCountsOnlyAuditExport(
      row(3, { outcome: 'failed', terminationReason: 'pre_spawn_refusal', cause: 'pre_spawn_refusal' })
    );

    expect(output).toContain('"cause":"pre_spawn_refusal"');
  });

  it('carries the attempt identifier and refuses a value of another shape (feature 212, FR-002)', () => {
    // Dropped from the allowlist, this export cannot answer WHICH attempt a
    // terminal row closes — the one question FR-002 exists to make answerable —
    // and an auditor handed only the export is back to pairing by order, which
    // FR-003 forbids. The guard is the projection's own shape, shared rather
    // than restated: two copies of a shape are two shapes as soon as one is
    // edited.
    const output = createCountsOnlyAuditExport(
      [
        row(3, { outcome: 'clean', attemptId: '3f2a5c18-9d4e-4b07-8a61-2c5f0e7d1b93' }),
        row(3, { outcome: 'clean', attemptId: '/Users/someone/.schegent/audit.log' }),
        row(3, { outcome: 'clean', attemptId: 42 })
      ].join('\n')
    );

    const ids = output
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { payload: { attemptId?: unknown } }).payload.attemptId);
    expect(ids).toEqual(['3f2a5c18-9d4e-4b07-8a61-2c5f0e7d1b93', null, null]);
    expect(output).not.toContain('.schegent/audit.log');
  });

  it('carries both envelope readings and keeps UNKNOWN absent (feature 212, FR-005, FR-007)', () => {
    // FR-007 requires the ran-without-a-verdict count to be obtainable directly
    // rather than by differencing two event types, and a counts-only export that
    // drops the field cannot supply it at all.
    //
    // The third row is the one that matters most: FR-014 makes an ABSENT
    // `resultEnvelope` mean UNKNOWN permanently, so this export must not invent
    // a key for it. `null` here would read as "on disk and disbelieved" and put
    // pre-spawn refusals into the very population FR-007 counts.
    const output = createCountsOnlyAuditExport(
      [
        row(3, { outcome: 'clean', resultEnvelope: 'received' }),
        row(3, { outcome: 'failed', resultEnvelope: 'absent' }),
        row(3, { outcome: 'failed', terminationReason: 'pre_spawn_refusal' }),
        row(3, { outcome: 'failed', resultEnvelope: 'maybe' })
      ].join('\n')
    );

    const payloads = output
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { payload: Record<string, unknown> }).payload);
    expect(payloads.at(0)?.resultEnvelope).toBe('received');
    expect(payloads.at(1)?.resultEnvelope).toBe('absent');
    expect('resultEnvelope' in (payloads.at(2) ?? {})).toBe(false);
    expect(payloads.at(3)).toHaveProperty('resultEnvelope', null);
    expect(output).not.toContain('maybe');
  });

  it('refuses both pairing fields on an event family that never mints them (feature 212, FR-002, FR-005)', () => {
    // `guardedPayloadValue` promises to scope by `(eventType, key)` and not by
    // key alone. `cause` needs that scoping because it spans five event
    // families; these two need it for the opposite reason. Both are written at
    // exactly two sites, each of which hardcodes `phase-end`, so `phase-end` is
    // not one admitted family among several — it is the only one there is.
    //
    // Which makes a UUID-shaped `attemptId` on some other row an anomaly rather
    // than a field to pass along: nothing in this build could have written it.
    // A by-name guard would admit it on shape and the export would then show it
    // pairing a monitor row to an attempt, a pairing FR-002 never defines. By
    // this file's standing rule the value was on disk and is disbelieved, so it
    // exports as `null` rather than being filtered away.
    const offFamily = JSON.stringify({
      id: 'event-monitor',
      timestamp: '2026-08-02T00:00:00.000Z',
      runId: 'run-private',
      correlationId: 'correlation-private',
      phase: 'speckit-implement',
      iteration: 1,
      eventType: 'monitor-rate-limited',
      outcome: 'success',
      schemaVersion: 3,
      payload: {
        attemptId: '3f2a5c18-9d4e-4b07-8a61-2c5f0e7d1b93',
        resultEnvelope: 'received'
      }
    });

    const payload = (
      JSON.parse(createCountsOnlyAuditExport(offFamily).trim()) as {
        payload: Record<string, unknown>;
      }
    ).payload;

    // Present and null — disbelieved, not silently dropped.
    expect(payload).toHaveProperty('attemptId', null);
    expect(payload).toHaveProperty('resultEnvelope', null);
    // The same two values on the family that does mint them still pass, so the
    // assertion above is about the event type and not about the values.
    const onFamily = (
      JSON.parse(
        createCountsOnlyAuditExport(
          row(3, {
            attemptId: '3f2a5c18-9d4e-4b07-8a61-2c5f0e7d1b93',
            resultEnvelope: 'received'
          })
        ).trim()
      ) as { payload: Record<string, unknown> }
    ).payload;
    expect(onFamily.attemptId).toBe('3f2a5c18-9d4e-4b07-8a61-2c5f0e7d1b93');
    expect(onFamily.resultEnvelope).toBe('received');
  });
});
