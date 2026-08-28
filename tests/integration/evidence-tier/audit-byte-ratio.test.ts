// Feature FR-R3-007 (T366) — the byte-ratio acceptance criterion for DATA-01.
//
// The finding this closes is a measurement, so the test is one too. On the log
// that produced it, `monitor-stdout-line` was 1,245,785 of 1,337,386 bytes —
// 93.2% — across 1,839 of 2,029 entries, and nothing in the product read them
// back. At ~1.34 MB per run against a retention budget of 5 MiB x 11
// generations, the metrics horizon was roughly 40 runs, which is what put it in
// conflict with `specs/073-metrics-dashboard/spec.md` SC-001: "the full audit
// retention window (months of activity), not just the most recent 50 tasks".
//
// The criterion has two halves, and only measuring both makes it meaningful:
// total bytes per run must fall by at least 85%, AND metrics-bearing bytes per
// run must stay within 10%. Either alone is trivially satisfiable in the wrong
// direction — a writer that dropped everything would ace the first, and one that
// changed nothing would ace the second.
//
// Both arms drive the REAL `ClaudeCliMonitor` over the REAL `AuditLogWriter`, in
// separate workspace roots, over an identical fixture:
//
//   - `transport-sink` is the shipped wiring: the real `CliTransportSink`
//     receives each line.
//   - `legacy-per-line-writer` reconstructs the removed writer by giving the
//     monitor a recorder that appends `monitor-stdout-line` /
//     `monitor-stderr-line` through the same audit writer. It is the same
//     `appendAudit` call the loops in `src/monitor/claude-cli-monitor.ts` used to
//     make, so the baseline is produced rather than asserted from a constant —
//     a hard-coded "before" number would keep passing after the projection or
//     the envelope changed underneath it.
//
// Two things about the fixture are deliberate and worth stating rather than
// leaving for a reader to infer:
//
//   - It emits 180 lines per run, not the ~1,839 the real log carried. The ratio
//     is scale-invariant once the per-line entries outnumber the ~20 structural
//     entries a run writes, so the reduced volume reproduces the ratio at a
//     fraction of the fs traffic. The assertion is the ratio; the absolute
//     figures are logged for orientation only.
//   - A share of the lines name a file, because real stream-json lines do. That
//     turns out to matter: the removed writer's payload went through
//     `projectAuditPayload`, which REFUSES a path-bearing string, so those
//     entries never reached the log at all. The baseline arm therefore
//     under-counts what the writer was asked to record, and the test pins the
//     refusal explicitly — the audit tier was losing that content, and the
//     transport tier keeps it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../src/lib/logger';
import { ClaudeCliMonitor } from '../../../src/monitor/claude-cli-monitor';
import {
  CLI_TRANSPORT_FILE_NAME,
  CliTransportSink,
  type CliTransportRecord,
  type CliTransportRecorder
} from '../../../src/monitor/cli-transport-sink';
import { expectNoDescriptorWarnings } from '../../setup/descriptor-warnings';
import { clearMetricsCache, readMetrics } from '../../../src/metrics/metrics-service';
import type { TaskRecord } from '../../../src/contracts/sidebar-ipc';

/**
 * FR-R3-137 (T1531c, FR-012) — the sinks this fixture builds, disposed before the
 * `afterAll` below removes the trees they write into. This arm writes with the
 * real `fs`, so it is the one file outside the sink's own suite that genuinely
 * holds an append descriptor; it emitted no warning only because the fixture runs
 * once and the process exits soon after.
 */
const live: CliTransportSink[] = [];
function track<T extends CliTransportSink>(sink: T): T {
  live.push(sink);
  return sink;
}

const RUN_COUNT = 10;
const PHASES = ['speckit-specify', 'speckit-plan', 'speckit-implement'] as const;
const LINES_PER_INVOCATION = 60;
const STDERR_EVERY = 20;
const PATH_BEARING_EVERY = 25;

/**
 * The event types `ingestEntry` in `src/metrics/metrics-service.ts` actually
 * consumes. Anything outside this set contributes nothing to a Task Record, a
 * Phase Record, an aggregate, or the cost timeline, so its bytes are the ones
 * the retention budget spends without buying a dashboard anything.
 */
const METRICS_BEARING: ReadonlySet<string> = new Set([
  'task-execution-started',
  'task-execution-ended',
  'phase-start',
  'phase-end',
  'cli-invocation',
  'phase-jumped',
  'phase-breakpoint-fired'
]);

/** The retention budget the finding is measured against: 5 MiB x 11 generations. */
const RETENTION_BUDGET_BYTES = 5 * 1024 * 1024 * 11;

/** SC-001's floor — a horizon shorter than this is the defect, not the fix. */
const SC_001_TASK_FLOOR = 50;

type Mode = 'transport-sink' | 'legacy-per-line-writer';

/**
 * One invocation's worth of CLI output, in the shape the stream-json format
 * actually produces: a JSON envelope per line, most of them content, some of
 * them naming a file the model touched.
 *
 * The "clean" lines avoid every construct `PATH_OR_ENDPOINT_RE` matches — no
 * leading separator, no drive letter, no `scheme://`, none of the reserved
 * directory names — so their only difference from the path-bearing ones is the
 * property under test.
 */
function cliLines(runIndex: number, phase: string): readonly string[] {
  const lines: string[] = [];
  for (let index = 0; index < LINES_PER_INVOCATION; index += 1) {
    const id = `${runIndex}-${index}`;
    if (index > 0 && index % PATH_BEARING_EVERY === 0) {
      lines.push(
        `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_${id}",` +
          `"content":"edited /Users/dev/app/src/module-${index}.ts (3 hunks applied)"}]}}`
      );
      continue;
    }
    lines.push(
      `{"type":"assistant","message":{"id":"msg_${id}","content":[{"type":"text",` +
        `"text":"${phase} step ${index}: reconciled the task list and re-checked ` +
        `the acceptance criteria; ${index} of ${LINES_PER_INVOCATION} complete."}]}}`
    );
  }
  return lines;
}

interface ArmResult {
  readonly root: string;
  readonly totalBytes: number;
  readonly metricsBearingBytes: number;
  readonly perLineBytes: number;
  readonly perLineEntryCount: number;
  readonly entryCount: number;
  /** Metrics-bearing entries as `eventType` plus their projected payload. */
  readonly metricsBearingRecords: ReadonlyArray<string>;
  readonly linesOffered: number;
  readonly legacyAppendsRefused: number;
  readonly transportLogLines: readonly string[];
}

/**
 * A recorder that puts the line back in the audit log.
 *
 * This is the writer FR-R3-007 removed, reconstructed at the seam the removal
 * created. It appends through the same `AuditLogWriter` the monitor uses, so the
 * baseline log is byte-for-byte what the pre-change host would have written,
 * including the projection refusing a path-bearing line.
 */
class LegacyPerLineAuditWriter implements CliTransportRecorder {
  public refused = 0;
  private readonly pending: Array<Promise<void>> = [];

  constructor(private readonly audit: AuditLogWriter) {}

  public record(entry: CliTransportRecord): void {
    this.pending.push(
      this.audit
        .append({
          runId: entry.runId,
          phase: entry.phase,
          iteration: 0,
          eventType: (entry.stream === 'stdout'
            ? 'monitor-stdout-line'
            : 'monitor-stderr-line') as never,
          outcome: 'info',
          payload: { line: entry.line }
        })
        .then(
          () => undefined,
          () => {
            this.refused += 1;
          }
        )
    );
  }

  public async settle(): Promise<void> {
    await Promise.all(this.pending);
  }
}

async function driveFixture(mode: Mode): Promise<ArmResult> {
  const root = await mkdtemp(join(tmpdir(), `schegent-byte-ratio-${mode}-`));
  const logger = new SanitizedLogger([]);
  const audit = new AuditLogWriter(
    // A rotation size well above the fixture's output: a rotation mid-measurement
    // would move bytes into an archive and understate whichever arm tripped it.
    { workspaceRoot: root, rotationSizeBytes: 512 * 1024 * 1024 },
    logger
  );

  const legacy =
    mode === 'legacy-per-line-writer' ? new LegacyPerLineAuditWriter(audit) : null;
  const sink =
    mode === 'transport-sink'
      ? track(new CliTransportSink({
          settings: {
            read: () => ({
              root,
              path: join(root, '.schegent', CLI_TRANSPORT_FILE_NAME),
              maxBytes: 512 * 1024 * 1024,
              maxGenerations: 3
            })
          },
          sanitize: (line) => logger.sanitize(line),
          logger
        }))
      : null;

  // One clock for both arms. The monitor's payloads carry durations and activity
  // stamps, and a real clock would make the two arms' monitor entries differ in
  // length for a reason that has nothing to do with the property under test.
  let elapsed = 0;
  const wallStart = Date.parse('2026-05-10T09:00:00.000Z');
  const monitor = new ClaudeCliMonitor({
    stallThresholdMs: 90_000,
    rateLimitMatchers: [],
    monotonicNow: () => 1_000 + elapsed,
    now: () => new Date(wallStart + elapsed),
    audit,
    transport: legacy ?? sink!,
    activity: { record: () => {} },
    logger,
    setTimeout: () => 0,
    clearTimeout: () => {}
  });

  let linesOffered = 0;
  for (let runIndex = 0; runIndex < RUN_COUNT; runIndex += 1) {
    const runId = `run-${String(runIndex).padStart(3, '0')}`;
    const taskId = `task-${String(runIndex).padStart(3, '0')}`;
    await audit.append({
      runId,
      phase: PHASES[0],
      iteration: 0,
      eventType: 'task-execution-started',
      outcome: 'info',
      payload: { taskId, runId, queueId: 'default', pipelineId: 'default', isResume: false }
    });

    for (const phase of PHASES) {
      await audit.append({
        runId,
        phase,
        iteration: 0,
        eventType: 'phase-start',
        outcome: 'info',
        payload: { pipelineId: 'default', phaseId: phase }
      });
      await audit.append({
        runId,
        phase,
        iteration: 0,
        eventType: 'cli-invocation',
        outcome: 'info',
        payload: {
          runner: 'claude',
          operation: 'phase',
          permissionMode: 'unrestricted',
          continued: false,
          sessionReused: false,
          diagnosticsEnabled: false
        }
      });

      monitor.onStart(runId, phase, 4_000 + runIndex);
      elapsed += 1_000;
      const lines = cliLines(runIndex, phase);
      linesOffered += lines.length;
      for (let index = 0; index < lines.length; index += 1) {
        const chunk = `${lines[index]}\n`;
        if (index > 0 && index % STDERR_EVERY === 0) monitor.onStderrChunk(runId, chunk);
        else monitor.onStdoutChunk(runId, chunk);
      }
      elapsed += 60_000;
      monitor.onExit(runId, { exitCode: 0, signal: null, killed: false, timedOut: false });

      await audit.append({
        runId,
        phase,
        iteration: 0,
        eventType: 'phase-end',
        outcome: 'success',
        payload: {
          pipelineId: 'default',
          phaseId: phase,
          outcome: 'clean',
          exitCode: 0,
          terminationReason: 'clean',
          durationMs: 61_000,
          totalCostUsd: 0.37,
          numTurns: 12,
          inputTokens: 41_000,
          outputTokens: 6_200
        }
      });
    }

    // Awaited last, and the writer serializes on one chain, so this also flushes
    // every fire-and-forget append the monitor and the legacy recorder queued.
    await audit.append({
      runId,
      phase: 'done',
      iteration: 0,
      eventType: 'task-execution-ended',
      outcome: 'success',
      payload: {
        taskId,
        runId,
        terminalStatus: 'completed',
        durationMs: 183_000,
        phasesTotal: PHASES.length,
        phasesCompleted: PHASES.length,
        phasesSkipped: 0
      }
    });
  }

  await legacy?.settle();
  await sink?.flushPendingWrites();

  const raw = await readFile(join(root, '.schegent', 'audit.log'), 'utf8');
  const logLines = raw.split('\n').filter((line) => line.length > 0);
  let totalBytes = 0;
  let metricsBearingBytes = 0;
  let perLineBytes = 0;
  let perLineEntryCount = 0;
  const metricsBearingRecords: string[] = [];
  for (const line of logLines) {
    const bytes = Buffer.byteLength(line, 'utf8') + 1;
    totalBytes += bytes;
    const entry = JSON.parse(line) as { eventType: string; payload: unknown };
    if (METRICS_BEARING.has(entry.eventType)) {
      metricsBearingBytes += bytes;
      metricsBearingRecords.push(`${entry.eventType} ${JSON.stringify(entry.payload)}`);
    }
    if (/-line$/.test(entry.eventType)) {
      perLineBytes += bytes;
      perLineEntryCount += 1;
    }
  }

  let transportLogLines: readonly string[] = [];
  if (sink) {
    const transport = await readFile(join(root, '.schegent', CLI_TRANSPORT_FILE_NAME), 'utf8');
    transportLogLines = transport.split('\n').filter((line) => line.length > 0);
  }

  return {
    root,
    totalBytes,
    metricsBearingBytes,
    perLineBytes,
    perLineEntryCount,
    entryCount: logLines.length,
    metricsBearingRecords,
    linesOffered,
    legacyAppendsRefused: legacy?.refused ?? 0,
    transportLogLines
  };
}

/**
 * The fields a metrics record derives from the audit entry's own timestamp
 * rather than from a payload. `AuditLogWriter.append` stamps
 * `new Date().toISOString()` and exposes no clock seam, so two arms run seconds
 * apart disagree on every one of them for reasons that have nothing to do with
 * this feature. Everything left is payload-derived, which is what makes the
 * comparison a real one rather than a passable one.
 */
const CLOCK_DERIVED_FIELDS = ['startTime', 'endTime', 'durationMs'] as const;

function withoutClockFields<T extends object>(
  value: T,
  extra: readonly string[] = []
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if ((CLOCK_DERIVED_FIELDS as readonly string[]).includes(key)) continue;
    if (extra.includes(key)) continue;
    out[key] = field;
  }
  return out;
}

/** A Task Record, and each Phase Record inside it, minus the clock fields. */
function clockIndependent(task: TaskRecord): Record<string, unknown> {
  return {
    ...withoutClockFields(task, ['phases']),
    phases: task.phases.map((phase) => withoutClockFields(phase))
  };
}

/**
 * A Phase-type aggregate minus its duration statistics, which are folds over the
 * clock-derived phase durations above.
 */
const AGGREGATE_DURATION_FIELDS = [
  'totalDurationMs',
  'avgDurationMs',
  'p50DurationMs',
  'p90DurationMs',
  'p99DurationMs',
  'longestDurationMs',
  'shortestDurationMs'
] as const;

let after: ArmResult;
let before: ArmResult;

beforeAll(async () => {
  after = await driveFixture('transport-sink');
  before = await driveFixture('legacy-per-line-writer');
}, 120_000);

afterAll(async () => {
  // Descriptors first, then the trees: a handle outliving its file is how a
  // warning gets attributed to whichever suite runs next.
  await Promise.all(live.splice(0).map((sink) => sink.flushAndDispose()));
  for (const arm of [after, before]) {
    if (!arm) continue;
    clearMetricsCache(arm.root);
    await rm(arm.root, { recursive: true, force: true });
  }
  expectNoDescriptorWarnings();
});

describe('FR-R3-007 — audit bytes per run', () => {
  it('reproduces the finding: per-line entries dominate the pre-change log', () => {
    // Grounding for the baseline arm. If this drops off, the "before" side has
    // stopped resembling the log the 93.2% came from, and every ratio below is
    // measuring something else.
    const share = before.perLineBytes / before.totalBytes;
    expect(
      share,
      `per-line share of the baseline log was ${(share * 100).toFixed(1)}% ` +
        `(${before.perLineBytes} of ${before.totalBytes} bytes over ${before.entryCount} entries); ` +
        'the measured log was 93.2%'
    ).toBeGreaterThan(0.85);
    expect(after.perLineBytes, 'the shipped wiring writes none of them').toBe(0);
  });

  it('falls by at least 85% per run', () => {
    const beforePerRun = before.totalBytes / RUN_COUNT;
    const afterPerRun = after.totalBytes / RUN_COUNT;
    const reduction = 1 - afterPerRun / beforePerRun;
    expect(
      reduction,
      `total audit bytes per run: ${Math.round(beforePerRun)} -> ${Math.round(afterPerRun)} ` +
        `(${(reduction * 100).toFixed(1)}% reduction)`
    ).toBeGreaterThanOrEqual(0.85);
  });

  it('leaves metrics-bearing bytes per run within 10% — byte-identical, in fact', () => {
    const beforePerRun = before.metricsBearingBytes / RUN_COUNT;
    const afterPerRun = after.metricsBearingBytes / RUN_COUNT;
    const drift = Math.abs(afterPerRun - beforePerRun) / beforePerRun;
    expect(
      drift,
      `metrics-bearing bytes per run: ${beforePerRun} vs ${afterPerRun}`
    ).toBeLessThanOrEqual(0.1);
    // The stronger statement the criterion's 10% band leaves room for: every
    // varying field in these entries is fixed-width (a v4 UUID id, a 24-char ISO
    // timestamp), so equal content means equal bytes. A drift inside the band
    // would still mean the record set changed, and that is worth failing on.
    expect(afterPerRun, 'the metrics-bearing record set is untouched').toBe(beforePerRun);
    expect(after.metricsBearingBytes).toBeGreaterThan(0);
  });

  it('writes the same metrics-bearing entries, in the same order', () => {
    expect(after.metricsBearingRecords).toEqual(before.metricsBearingRecords);
    expect(
      after.metricsBearingRecords.length,
      'one task pair plus three phase-start/cli-invocation/phase-end triples per run'
    ).toBe(RUN_COUNT * (2 + PHASES.length * 3));
  });
});

describe('FR-R3-007 — what the smaller log still supports', () => {
  it('computes the same dashboard metrics from either log', async () => {
    clearMetricsCache(after.root);
    clearMetricsCache(before.root);
    const afterMetrics = await readMetrics(after.root);
    const beforeMetrics = await readMetrics(before.root);

    expect(afterMetrics.tasks.map(clockIndependent)).toEqual(
      beforeMetrics.tasks.map(clockIndependent)
    );
    expect(afterMetrics.tasks, 'ten runs in, ten Task Records out').toHaveLength(RUN_COUNT);
    expect(
      afterMetrics.phaseTypeAggregates.map((a) => withoutClockFields(a, AGGREGATE_DURATION_FIELDS))
    ).toEqual(
      beforeMetrics.phaseTypeAggregates.map((a) => withoutClockFields(a, AGGREGATE_DURATION_FIELDS))
    );
    expect(afterMetrics.phaseTypeAggregates.map((a) => a.phaseType)).toEqual([...PHASES]);
    expect(afterMetrics.meta.parseWarnings, 'neither log warns').toBe(0);
    expect(beforeMetrics.meta.parseWarnings).toBe(0);
    expect(
      afterMetrics.meta.totalScannedEntries,
      'the reader scans far less to reach the same answer'
    ).toBeLessThan(beforeMetrics.meta.totalScannedEntries / 8);
  });

  it('extends the retention horizon past the 50-task floor SC-001 names', () => {
    const horizon = (bytes: number): number =>
      Math.floor(RETENTION_BUDGET_BYTES / (bytes / RUN_COUNT));
    const beforeHorizon = horizon(before.totalBytes);
    const afterHorizon = horizon(after.totalBytes);

    expect(
      afterHorizon,
      `runs inside the ${RETENTION_BUDGET_BYTES}-byte retention budget: ` +
        `${beforeHorizon} -> ${afterHorizon}`
    ).toBeGreaterThan(SC_001_TASK_FLOOR);
    expect(afterHorizon).toBeGreaterThan(beforeHorizon * 6);
  });
});

describe('FR-R3-007 — the line content moves rather than disappearing', () => {
  it('captures every offered line in the transport tier', () => {
    expect(after.transportLogLines).toHaveLength(after.linesOffered);
    expect(after.linesOffered).toBe(RUN_COUNT * PHASES.length * LINES_PER_INVOCATION);
    const fields = after.transportLogLines[0]!.split('\t');
    expect(fields).toHaveLength(5);
    expect(fields[1], 'attributed to the Run that produced it').toBe('run-000');
    expect(fields[3]).toBe('stdout');
  });

  it('keeps the path-bearing lines the audit tier was refusing outright', () => {
    // The refusal is correct — a workspace path must not enter `audit.log` — but
    // it means the audit tier was never a complete record of CLI output even
    // before this change. The transport tier is where such a line can live.
    expect(
      before.legacyAppendsRefused,
      'the removed writer dropped whole entries on a path-bearing line'
    ).toBeGreaterThan(0);
    expect(
      after.transportLogLines.filter((line) => line.includes('/Users/dev/app/src/module-')),
      'the same lines, in the tier that may hold them'
    ).toHaveLength(before.legacyAppendsRefused);
    // And the loss was silent: the pre-change log holds fewer line entries than
    // the number of lines the writer was handed, with nothing in the log itself
    // to say which ones went missing or why.
    expect(before.perLineEntryCount).toBe(before.linesOffered - before.legacyAppendsRefused);
    expect(before.perLineEntryCount).toBeLessThan(before.linesOffered);
    expect(after.transportLogLines, 'the transport tier drops none of them').toHaveLength(
      before.linesOffered
    );
  });
});
