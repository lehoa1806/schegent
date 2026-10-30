import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCountsOnlyAuditExport, runExportAuditLog } from '../../../src/commands/export-audit';
import { EXPORT_TEXT } from '../../../src/commands/evidence-commands';
import { FAILURE_CAUSES } from '../../../src/contracts/failure-cause';
import type { Notifier } from '../../../src/ui/notifications';
import { removeTempRoot } from '../../temp-root-cleanup';

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

// FR-R4-F14 (spec 242, contract E4.1) — the metadata-only export carries `failureCause`, with the module's
// own rule for a value it does not believe: scoped by event type, a member exports as itself, and
// anything else exports as `null` ("on disk and disbelieved"), never filtered and never rewritten.
describe('createCountsOnlyAuditExport — failureCause (FR-R4-F14)', () => {
  function eventRow(eventType: string, payload: Record<string, unknown>): string {
    return JSON.stringify({
      id: 'event-3',
      timestamp: '2026-08-02T00:00:00.000Z',
      runId: 'run-private',
      correlationId: 'correlation-private',
      phase: 'speckit-implement',
      iteration: 1,
      eventType,
      outcome: 'failure',
      schemaVersion: 3,
      payload
    });
  }

  const payloadsOf = (output: string): Array<Record<string, unknown>> =>
    output
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { payload: Record<string, unknown> }).payload);

  const ended = { terminalStatus: 'failed', durationMs: 5, phasesTotal: 3, phasesCompleted: 1, phasesSkipped: 0 };

  it.each(FAILURE_CAUSES)('keeps the member %s on task-execution-ended as itself', (cause) => {
    const [payload] = payloadsOf(
      createCountsOnlyAuditExport(eventRow('task-execution-ended', { ...ended, failureCause: cause }))
    );
    expect(payload.failureCause).toBe(cause);
  });

  it('exports a value that is not a member as null, and never carries a secret-bearing signature', () => {
    const output = createCountsOnlyAuditExport(
      [
        eventRow('task-execution-ended', { ...ended, failureCause: 'cap_exhausted ' }),
        eventRow('task-execution-ended', { ...ended, failureCause: 'CAP_EXHAUSTED' }),
        eventRow('task-execution-ended', { ...ended, failureCause: 'pre_spawn_refusal' }),
        eventRow('task-execution-ended', { ...ended, failureCause: 42 }),
        eventRow('task-execution-ended', { ...ended, failureCause: 'fatal: token=sk-ant-SENTINEL' })
      ].join('\n')
    );

    expect(payloadsOf(output).map((payload) => payload.failureCause)).toEqual([null, null, null, null, null]);
    expect(output).not.toContain('SENTINEL');
    expect(output).not.toContain('sk-ant');
  });

  it('exports a failureCause on phase-end, or on any other event type, as null', () => {
    const output = createCountsOnlyAuditExport(
      [
        eventRow('phase-end', { outcome: 'failed', failureCause: 'cap_exhausted' }),
        eventRow('monitor-rate-limited', { failureCause: 'phase_failed' })
      ].join('\n')
    );

    const payloads = payloadsOf(output);
    expect(payloads).toHaveLength(2);
    for (const payload of payloads) expect(payload).toHaveProperty('failureCause', null);
  });

  it('exports a line written before the feature, with no key, without one', () => {
    const [payload] = payloadsOf(createCountsOnlyAuditExport(eventRow('task-execution-ended', ended)));
    expect('failureCause' in payload).toBe(false);
  });
});


// Feature 251 (FR-R4-F04, contract T15; FR-020 to FR-025; E1 to E9) — what `runExportAuditLog` writes, where
// it asks to write it, and what it records.
//
// What it pins: the save dialog starts in the home directory with `schegent-audit-v3.jsonl`; a destination
// that is not a local file (a `vscode-remote:` URI) is refused with one row; a new target and an existing
// `0644` one both end `0600`; the allowlisted output is byte-for-byte what `createCountsOnlyAuditExport`
// makes; one `exported` row carries the counts of rows written and skipped; one `refused` row is written for
// a target inside `.schegent`; nothing is written when the dialog is dismissed; and an append that throws
// leaves the file where it is and says so (O5).
describe('runExportAuditLog (FR-R4-F04, T15)', () => {
  const FIXTURE = [
    row(3, { outcome: 'clean', metrics: { tests: 12 } }),
    row(2, { command: 'legacy command' }),
    'not json at all',
    row(3, { outcome: 'failure', cause: 'cap_exhausted' })
  ].join('\n');

  let workspace: string;
  let home: string;
  let outside: string;
  let notices: string[];
  let appended: Array<Record<string, unknown>>;
  let suggested: string[];

  beforeEach(async () => {
    workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-export-audit-ws-')));
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-export-audit-home-')));
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-export-audit-out-')));
    await fs.mkdir(path.join(workspace, '.schegent'), { recursive: true });
    await fs.writeFile(path.join(workspace, '.schegent', 'audit.log'), `${FIXTURE}\n`, 'utf8');
    notices = [];
    appended = [];
    suggested = [];
  });

  afterEach(async () => {
    await Promise.all([workspace, home, outside].map((dir) => removeTempRoot(dir)));
  });

  const notifier = (): Notifier =>
    ({
      info: (message: string) => notices.push(message),
      warn: (message: string) => {
        notices.push(message);
        return Promise.resolve(undefined);
      },
      error: (message: string) => notices.push(message)
    }) as unknown as Notifier;

  const run = (
    target: { scheme: string; fsPath: string } | undefined,
    options: { appendFails?: boolean } = {}
  ): Promise<void> =>
    runExportAuditLog({
      workspaceRoot: workspace,
      notifier: notifier(),
      auditWriter: {
        append: async (entry: Record<string, unknown>) => {
          if (options.appendFails === true) throw new Error('disk full');
          appended.push(entry);
          return entry as never;
        }
      } as never,
      promptForTarget: async (suggestedPath: string) => {
        suggested.push(suggestedPath);
        return target;
      },
      homeDirectory: () => home
    });

  it('suggests the home directory with the audit file name, and writes where the operator chose', async () => {
    const target = path.join(outside, 'audit.jsonl');
    await run({ scheme: 'file', fsPath: target });

    expect(suggested).toEqual([path.join(home, 'schegent-audit-v3.jsonl')]);
    expect(await fs.readFile(target, 'utf8')).toBe(createCountsOnlyAuditExport(`${FIXTURE}\n`));
  });

  it('writes a new target 0600, and narrows an existing 0644 one to 0600', async () => {
    if (process.platform === 'win32') return;
    const fresh = path.join(outside, 'fresh.jsonl');
    await run({ scheme: 'file', fsPath: fresh });
    expect((await fs.stat(fresh)).mode & 0o777).toBe(0o600);

    const existing = path.join(outside, 'existing.jsonl');
    await fs.writeFile(existing, 'old content that is longer than the export\n'.repeat(50), 'utf8');
    await fs.chmod(existing, 0o644);
    await run({ scheme: 'file', fsPath: existing });
    expect((await fs.stat(existing)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(existing, 'utf8'), 'the old bytes are replaced, not appended to').toBe(
      createCountsOnlyAuditExport(`${FIXTURE}\n`)
    );
  });

  it('records one exported row with the rows it wrote and the rows it skipped', async () => {
    await run({ scheme: 'file', fsPath: path.join(outside, 'audit.jsonl') });

    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      runId: '',
      phase: 'operator',
      iteration: 0,
      eventType: 'evidence-exported',
      outcome: 'info',
      payload: { kind: 'audit-metadata', outcome: 'exported', included: 2, omitted: 2 }
    });
    expect(Object.keys(appended[0]!.payload as object).sort()).toEqual(['included', 'kind', 'omitted', 'outcome']);
  });

  it('refuses a vscode-remote destination with one refused row, and writes nothing', async () => {
    const target = path.join(outside, 'remote.jsonl');
    await run({ scheme: 'vscode-remote', fsPath: target });

    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      payload: { kind: 'audit-metadata', outcome: 'refused', included: 0, refusal: 'destination-not-local-file' }
    });
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(notices.join(' ')).toContain(EXPORT_TEXT.refusal['destination-not-local-file']);
  });

  it('refuses a target inside .schegent with one refused row', async () => {
    const inside = path.join(workspace, '.schegent', 'copy.jsonl');
    await run({ scheme: 'file', fsPath: inside });

    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ payload: { outcome: 'refused', refusal: 'destination-in-evidence-store' } });
    await expect(fs.stat(inside)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an alias that resolves into .schegent, which the text of the path does not name', async () => {
    if (process.platform === 'win32') return;
    const link = path.join(outside, 'alias');
    await fs.symlink(path.join(workspace, '.schegent'), link);
    await run({ scheme: 'file', fsPath: path.join(link, 'copy.jsonl') });

    expect(appended[0]).toMatchObject({ payload: { outcome: 'refused', refusal: 'destination-in-evidence-store' } });
    expect(await fs.readdir(path.join(workspace, '.schegent')), 'nothing was written into the store').toEqual(['audit.log']);
  });

  it('records nothing and writes nothing when the dialog is dismissed', async () => {
    await run(undefined);
    expect(appended).toEqual([]);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('keeps the file and says so when the append throws (O5)', async () => {
    const target = path.join(outside, 'audit.jsonl');
    await run({ scheme: 'file', fsPath: target }, { appendFails: true });

    expect(await fs.readFile(target, 'utf8')).toBe(createCountsOnlyAuditExport(`${FIXTURE}\n`));
    expect(notices.join(' ')).toContain(EXPORT_TEXT.notRecorded);
    expect(notices.join(' '), 'the error message does not reach the operator').not.toContain('disk full');
  });
});
