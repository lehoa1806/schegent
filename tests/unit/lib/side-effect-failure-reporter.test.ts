import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ProtectedRunIdsUnavailableError,
  querySqliteProtectedRunIds,
  replayTelemetrySpoolAfterSettling,
  sweepWithReadableProtection,
  type SqliteCutoverServices
} from '../../../src/activation/sqlite-cutover-wiring';
import { createSideEffectFailureReporter, type SideEffectOperation } from '../../../src/lib/side-effect-failure-reporter';

// Review gap GC-05 (2026-11-12) — lane settlement, the ACP observation ledger, usage accounting and
// the sweep-protection query each ended in a bare `catch {}`, so a broken side effect left no trace.
// They stay best-effort, and each failure is now reported: once per operation, by error class only,
// because the per-observation paths would otherwise write one line per agent event.
describe('side-effect failure reporter', () => {
  function recordingLogger(): { lines: Array<{ message: string; context: unknown }>; warn: (message: string, context?: unknown) => void } {
    const lines: Array<{ message: string; context: unknown }> = [];
    return { lines, warn: (message, context) => lines.push({ message, context }) };
  }

  it('warns once per operation, with the error class and no message', () => {
    const logger = recordingLogger();
    const report = createSideEffectFailureReporter(logger);

    report('usage-accounting', new TypeError('token sk-secret-value in /home/me'));
    report('usage-accounting', new Error('again'));
    report('lane-settlement', 'thrown string');

    expect(logger.lines).toEqual([
      {
        message: 'best-effort side effect failed; later failures of this operation are not logged',
        context: { operation: 'usage-accounting', error: 'TypeError' }
      },
      {
        message: 'best-effort side effect failed; later failures of this operation are not logged',
        context: { operation: 'lane-settlement', error: 'string' }
      }
    ]);
  });
});

// The sweep-protection query used to report its failure and then return the lane and export pins
// alone, so a retention sweep went on to delete the session groups of runs pinned only in SQLite.
// It now fails closed: the query throws a typed error after reporting, and a sweep that cannot read
// its protected set whole does not run.
describe('sweep protection fails closed (GC-05 follow-up, 2026-11-12)', () => {
  function servicesWhoseQuery(all: () => ReadonlyArray<{ run_id: string }>): SqliteCutoverServices {
    return {
      runLaneCoordinator: { getProtectedRunIds: () => new Set(['lane-pinned']) },
      reportingService: { activeExportRootIds: () => ['export-pinned'] },
      sqliteStore: { writerConnection: { all } }
    } as unknown as SqliteCutoverServices;
  }

  function recordingReport(): { calls: SideEffectOperation[]; report: (operation: SideEffectOperation) => void } {
    const calls: SideEffectOperation[] = [];
    return { calls, report: (operation) => calls.push(operation) };
  }

  it('returns the lane, export and SQLite pins together when the query answers', () => {
    const { calls, report } = recordingReport();
    const ids = querySqliteProtectedRunIds(
      servicesWhoseQuery(() => [{ run_id: 'sqlite-pinned' }]),
      report
    );
    expect([...ids].sort()).toEqual(['export-pinned', 'lane-pinned', 'sqlite-pinned']);
    expect(calls).toHaveLength(0);
  });

  it('reports and throws instead of returning a partial set when the query fails', () => {
    const { calls, report } = recordingReport();
    const services = servicesWhoseQuery(() => {
      throw new Error('SQLITE_MISUSE: database is closed');
    });
    expect(() => querySqliteProtectedRunIds(services, report)).toThrow(ProtectedRunIdsUnavailableError);
    expect(calls).toEqual(['sweep-protection-query']);
  });

  it('protects nothing extra and throws nothing when SQLite is not open', () => {
    const { report } = recordingReport();
    expect(querySqliteProtectedRunIds(null, report).size).toBe(0);
  });

  it('skips the sweep when the protected set cannot be read', async () => {
    const swept: Array<ReadonlySet<string>> = [];
    const outcome = await sweepWithReadableProtection(
      () => {
        throw new ProtectedRunIdsUnavailableError();
      },
      async (ids) => {
        swept.push(ids);
      }
    );
    expect(outcome).toBe('skipped');
    expect(swept).toHaveLength(0);
  });

  it('sweeps with the set it read, and lets any other failure through', async () => {
    const swept: Array<ReadonlySet<string>> = [];
    const outcome = await sweepWithReadableProtection(
      () => new Set(['run-a']),
      async (ids) => {
        swept.push(ids);
      }
    );
    expect(outcome).toBe('swept');
    expect(swept.map((ids) => [...ids])).toEqual([['run-a']]);
    await expect(
      sweepWithReadableProtection(
        () => {
          throw new TypeError('not a protection failure');
        },
        async () => undefined
      )
    ).rejects.toThrow(TypeError);
  });
});

// The telemetry host spools retry-exhausted batches and can replay them, but nothing in the extension
// called the replay, so a spooled batch was never re-sent after a restart. Activation now replays once,
// after the spool work that configuring the destination started has settled, and reports a failure.
describe('telemetry spool replay at activation (review gap closure, 2026-11-12)', () => {
  it('replays only after pending spool work settles', async () => {
    const order: string[] = [];
    const reported: SideEffectOperation[] = [];
    await replayTelemetrySpoolAfterSettling(
      {
        idle: async () => {
          order.push('idle');
        },
        reconcileAndReplaySpool: async () => {
          order.push('replay');
          return { replayed: 0, acknowledged: 0, dropped: 0, expired: 0 };
        }
      },
      (operation) => reported.push(operation)
    );
    expect(order).toEqual(['idle', 'replay']);
    expect(reported).toHaveLength(0);
  });

  it('reports a failed replay as telemetry-spool instead of rejecting', async () => {
    const reported: SideEffectOperation[] = [];
    await expect(
      replayTelemetrySpoolAfterSettling(
        {
          idle: async () => undefined,
          reconcileAndReplaySpool: async () => {
            throw new Error('database is not open');
          }
        },
        (operation) => reported.push(operation)
      )
    ).resolves.toBeUndefined();
    expect(reported).toEqual(['telemetry-spool']);
  });

  it('is called by activation once the destination is configured', () => {
    const source = readFileSync(resolve(__dirname, '../../../src/activation/sqlite-cutover-wiring.ts'), 'utf8');
    const configured = source.indexOf('telemetryHost.configureFromUserSettings(readTelemetryExportUserSettings());');
    const replayed = source.indexOf('void replayTelemetrySpoolAfterSettling(telemetryHost, input.reportSideEffectFailure);');
    expect(configured).toBeGreaterThan(-1);
    expect(replayed).toBeGreaterThan(configured);
  });
});
