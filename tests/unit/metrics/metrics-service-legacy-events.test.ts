// Feature FR-R3-007 (T365) — archived logs still parse clean after the writer
// is gone.
//
// This is the half of the change that has no production edit behind it, which is
// exactly why it needs a test. `monitor-stdout-line` and `monitor-stderr-line`
// stay in `ALL_AUDIT_EVENT_TYPES` forever: the writer is removed, but every
// operator with a rotated `.schegent/audit.log.*` still has millions of those
// entries on disk, and the parser's warn-and-preserve rule means a type it does
// not recognise produces `unknown eventType "…" — preserving record`. Take the
// types out of the registry and reading one archive turns into a stream of
// warnings and a `parseWarnings` count that swamps the real ones — a metrics
// dashboard reporting that its own data is suspect, over records it wrote itself.
//
// So the property has two sides, and both are asserted:
//
//   - A retired-but-registered type parses with **no** warning and is inert for
//     grouping. It contributes to `totalScannedEntries` because it was scanned;
//     it contributes to nothing else.
//   - A genuinely unknown type still *does* warn, and is still preserved. If the
//     first assertion were achieved by making the parser lenient about
//     everything, this one would fail — which is the distinction worth pinning.
//
// The mixed-log comparison is the strongest form available here: the same run,
// once with per-line entries interleaved and once without, must produce
// identical metrics. Anything the legacy entries touched would show up as a
// difference rather than as a judgement about which numbers look right.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import { clearMetricsCache, readMetrics } from '../../../src/metrics/metrics-service';
import { parseAuditLogLineDetailed } from '../../../src/parser/audit-log-parser';
import { ALL_AUDIT_EVENT_TYPES, AUDIT_SCHEMA_VERSION } from '../../../src/contracts/audit-events';

const RETIRED_TYPES = ['monitor-stdout-line', 'monitor-stderr-line'] as const;

function line(overrides: Partial<AuditEntry>): string {
  return JSON.stringify({
    id: 'e-default',
    timestamp: '2026-05-23T12:00:00.000Z',
    runId: 'run-legacy',
    phase: 'speckit-implement',
    iteration: 1,
    eventType: 'phase-start',
    payload: {},
    outcome: 'info',
    ...overrides
  });
}

/** One archived per-line entry, in the shape the removed writer produced. */
function legacyLine(o: {
  id: string;
  timestamp: string;
  stream: 'stdout' | 'stderr';
  text: string;
}): string {
  return line({
    id: o.id,
    timestamp: o.timestamp,
    eventType: o.stream === 'stdout' ? 'monitor-stdout-line' : 'monitor-stderr-line',
    outcome: 'info',
    payload: { line: o.text }
  });
}

const RUN_ENTRIES: readonly string[] = [
  line({
    id: 'e-1',
    timestamp: '2026-05-23T12:00:00.000Z',
    phase: 'speckit-specify',
    iteration: 0,
    eventType: 'task-execution-started',
    payload: {
      taskId: 'task-legacy',
      runId: 'run-legacy',
      queueId: 'default',
      pipelineId: 'default',
      isResume: false
    }
  }),
  line({
    id: 'e-2',
    timestamp: '2026-05-23T12:00:01.000Z',
    eventType: 'phase-start',
    payload: { pipelineId: 'default', phaseId: 'speckit-implement' }
  }),
  line({
    id: 'e-3',
    timestamp: '2026-05-23T12:00:02.000Z',
    eventType: 'cli-invocation',
    payload: { pipelineId: 'default', phaseId: 'speckit-implement', command: 'claude --print' }
  }),
  line({
    id: 'e-4',
    timestamp: '2026-05-23T12:05:00.000Z',
    eventType: 'phase-end',
    outcome: 'success',
    payload: {
      pipelineId: 'default',
      phaseId: 'speckit-implement',
      outcome: 'clean',
      totalCostUsd: 0.42
    }
  }),
  line({
    id: 'e-5',
    timestamp: '2026-05-23T12:05:01.000Z',
    phase: 'done',
    iteration: 0,
    eventType: 'task-execution-ended',
    outcome: 'success',
    payload: {
      taskId: 'task-legacy',
      runId: 'run-legacy',
      terminalStatus: 'completed',
      durationMs: 301_000,
      phasesTotal: 1,
      phasesCompleted: 1,
      phasesSkipped: 0
    }
  })
];

/** The same run with 40 archived per-line entries interleaved through it. */
function withLegacyEntries(): readonly string[] {
  const out: string[] = [];
  let sequence = 0;
  for (const entry of RUN_ENTRIES) {
    out.push(entry);
    for (let index = 0; index < 10; index += 1) {
      sequence += 1;
      out.push(
        legacyLine({
          id: `legacy-${sequence}`,
          timestamp: '2026-05-23T12:00:03.000Z',
          stream: sequence % 4 === 0 ? 'stderr' : 'stdout',
          text: `[${sequence}] a line the CLI printed`
        })
      );
    }
  }
  return out;
}

let workspaceRoot: string;

async function writeAuditLog(lines: readonly string[]): Promise<void> {
  const auditDir = join(workspaceRoot, '.schegent');
  await mkdir(auditDir, { recursive: true });
  await writeFile(join(auditDir, 'audit.log'), `${lines.join('\n')}\n`, 'utf8');
  clearMetricsCache(workspaceRoot);
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'schegent-legacy-events-'));
});

afterEach(async () => {
  clearMetricsCache(workspaceRoot);
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('FR-R3-007 — the retired per-line event types stay parseable', () => {
  it('keeps both types in the registry after the writer is gone', () => {
    for (const eventType of RETIRED_TYPES) {
      expect(
        ALL_AUDIT_EVENT_TYPES as readonly string[],
        `${eventType} must stay registered; archived logs are full of it`
      ).toContain(eventType);
    }
    expect(AUDIT_SCHEMA_VERSION, 'removing a writer is not a schema change').toBe(3);
  });

  it('parses an archived per-line entry with no warning', () => {
    for (const eventType of RETIRED_TYPES) {
      const result = parseAuditLogLineDetailed(
        line({ id: 'archived', eventType, payload: { line: 'output' } })
      );
      expect(result.entry, 'the entry is preserved').not.toBeNull();
      expect(result.entry!.eventType).toBe(eventType);
      expect(
        result.warning,
        `${eventType} is retired, not unknown; a warning here would flood an archive read`
      ).toBeUndefined();
    }
  });

  it('still warns — and still preserves — a genuinely unknown type', () => {
    const result = parseAuditLogLineDetailed(
      line({ id: 'future', eventType: 'monitor-quantum-line' as never })
    );
    expect(result.entry, 'warn AND preserve; never drop').not.toBeNull();
    expect(result.warning).toContain('unknown eventType');
    expect(result.warning).toContain('preserving record');
  });
});

describe('FR-R3-007 — archived per-line entries are inert for metrics', () => {
  it('produces metrics identical to the same log without them', async () => {
    await writeAuditLog(RUN_ENTRIES);
    const clean = await readMetrics(workspaceRoot);

    await writeAuditLog(withLegacyEntries());
    const legacy = await readMetrics(workspaceRoot);

    expect(legacy.tasks).toEqual(clean.tasks);
    expect(legacy.phaseTypeAggregates).toEqual(clean.phaseTypeAggregates);
    expect(legacy.costTimeline).toEqual(clean.costTimeline);
  });

  it('reports no parse warnings for a log that is mostly per-line entries', async () => {
    await writeAuditLog(withLegacyEntries());
    const result = await readMetrics(workspaceRoot);

    expect(result.meta.parseWarnings, 'forty archived entries, zero warnings').toBe(0);
    expect(
      result.meta.totalScannedEntries,
      'they were scanned — the count is honest about the work done'
    ).toBe(RUN_ENTRIES.length + 50);
  });

  it('lets an archived per-line entry set the data horizon it really evidences', async () => {
    // The horizon is "how far back does this log reach", and a per-line entry is
    // real evidence of activity at its timestamp. Excluding it would understate
    // the window, which is the opposite of the finding this feature closes.
    await writeAuditLog([
      legacyLine({
        id: 'oldest',
        timestamp: '2026-01-01T00:00:00.000Z',
        stream: 'stdout',
        text: 'earliest thing in the archive'
      }),
      ...RUN_ENTRIES
    ]);
    const result = await readMetrics(workspaceRoot);

    expect(result.oldestIncludedTimestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  it('reads the replacement summary shape without warning', async () => {
    // The counts the per-line events carried now live in one entry per
    // invocation, with two fields that did not exist before. A reader that
    // rejected the new shape would trade one silent loss for another.
    const summary = line({
      id: 'summary',
      timestamp: '2026-05-23T12:05:00.500Z',
      eventType: 'monitor-invocation-summary',
      outcome: 'success',
      payload: {
        status: 'completed',
        durationMs: 300_000,
        exitCode: 0,
        signal: null,
        stdoutLines: 7452,
        stderrLines: 3,
        firstOutputAt: '2026-05-23T12:00:03.000Z',
        lastOutputAt: '2026-05-23T12:04:59.000Z',
        detectedIssues: []
      }
    });
    expect(parseAuditLogLineDetailed(summary).warning).toBeUndefined();

    await writeAuditLog([...RUN_ENTRIES, summary]);
    const result = await readMetrics(workspaceRoot);
    expect(result.meta.parseWarnings).toBe(0);
    expect(result.tasks.map((task) => task.runId)).toEqual(['run-legacy']);
  });
});
