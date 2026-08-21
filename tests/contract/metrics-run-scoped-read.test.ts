// Feature 103 (T089, T090 — US4, FR-023, FR-025, SC-012) — the run-scoped
// metrics read.
//
// The run detail needs one run's cost and phase counts. Everything already on
// the metrics response is corpus-wide: `tasks` is a fold over
// `.schegent/audit.log` plus whatever archives survive, and that corpus rotates
// on its own schedule. History does not. So the two ranges come apart, and the
// trap T090 pins is the obvious join: a run History still retains, whose audit
// evidence rotated away, has no `TaskRecord` at all. Reading its cost off
// `tasks` would report "not reported" for a run whose cost was recorded
// perfectly well — in the durable rollup, which is written once per terminal run
// while the evidence is still present and never recomputed.
//
// The read is therefore served from the rollup, and the request is additive:
// `runIds` in, `runSummaries` out, with the field omitted entirely when no
// `runIds` was asked for so every existing consumer sees exactly today's shape.
//
// Driven through the REAL `readMetrics()` over a REAL `.schegent/` tree, for the
// same reason T400 is: the property only holds if the corpus scan, the rollup
// read, and the projection line up on disk. The boundary block at the end drives
// the real inbound validator, because `runIds` arrives from the webview and an
// unvalidated list is an unvalidated list whatever it is later compared against.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEntry } from '../../src/audit/audit-entry';
import { readMetrics } from '../../src/metrics/metrics-service';
import { MetricsRollupWriter } from '../../src/metrics/metrics-rollup-writer';
import { validateInboundMessage } from '../../src/contracts/runtime-validators';
import {
  CMD_READ_METRICS,
  isCmdReadMetrics,
  READ_METRICS_RUN_IDS_MAX
} from '../../src/contracts/sidebar-ipc';
import type { SanitizedLogger } from '../../src/lib/logger';

const BASE_MS = Date.parse('2026-02-01T00:00:00.000Z');
const RUN_COUNT = 3;
/** Run 0 lives in the archive; runs 1 and 2 live in the live log. */
const ARCHIVED_RUNS = 1;
const PHASES_PER_RUN = 2;
const COST_PER_RUN = 0.5;

let workspaceRoot: string;
let auditDir: string;

function silentLogger(): SanitizedLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    sanitize: (value: string) => value
  } as unknown as SanitizedLogger;
}

function entry(
  overrides: Partial<AuditEntry> & Pick<AuditEntry, 'id' | 'timestamp' | 'runId' | 'eventType'>
): string {
  return `${JSON.stringify({
    phase: 'speckit-plan',
    iteration: 1,
    payload: {},
    outcome: 'info',
    ...overrides
  })}\n`;
}

interface SeededRun {
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
}

/** One terminal run, shaped like the real log so the fold builds a TaskRecord. */
function runLines(index: number): { lines: string; run: SeededRun } {
  const startMs = BASE_MS + index * 86_400_000;
  const durationMs = 120_000;
  const runId = `run-${String(index).padStart(2, '0')}`;
  const at = (offsetMs: number): string => new Date(startMs + offsetMs).toISOString();

  const lines =
    entry({
      id: `${runId}-start`,
      timestamp: at(0),
      runId,
      phase: 'speckit-specify',
      iteration: 0,
      eventType: 'task-execution-started',
      payload: { taskId: runId, runId, queueId: 'default', pipelineId: 'default', isResume: false }
    }) +
    entry({
      id: `${runId}-end`,
      timestamp: at(durationMs),
      runId,
      phase: 'done',
      iteration: 0,
      eventType: 'task-execution-ended',
      outcome: 'success',
      payload: {
        taskId: runId,
        runId,
        terminalStatus: 'completed',
        durationMs,
        phasesTotal: PHASES_PER_RUN,
        phasesCompleted: PHASES_PER_RUN,
        phasesSkipped: 0
      }
    });

  return { lines, run: { runId, startedAt: at(0), endedAt: at(durationMs), durationMs } };
}

/** Must match the metrics service's ARCHIVE_STAMP_RE or the scan skips it. */
const ARCHIVE_NAME = 'audit.log.20260201-000000';

async function seedCorpus(): Promise<SeededRun[]> {
  const runs: SeededRun[] = [];
  let archived = '';
  let live = '';

  for (let index = 0; index < RUN_COUNT; index += 1) {
    const { lines, run } = runLines(index);
    runs.push(run);
    if (index < ARCHIVED_RUNS) archived += lines;
    else live += lines;
  }

  await writeFile(join(auditDir, ARCHIVE_NAME), archived, 'utf8');
  await writeFile(join(auditDir, 'audit.log'), live, 'utf8');
  return runs;
}

async function recordRollup(runs: readonly SeededRun[]): Promise<void> {
  const writer = new MetricsRollupWriter({ workspaceRoot, logger: silentLogger() });
  for (const run of runs) {
    const outcome = await writer.append({
      runId: run.runId,
      terminalStatus: 'completed',
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      durationMs: run.durationMs,
      phasesTotal: PHASES_PER_RUN,
      phasesCompleted: PHASES_PER_RUN,
      phasesSkipped: 0,
      backendInvocations: PHASES_PER_RUN,
      costUsd: COST_PER_RUN
    });
    expect(outcome).toEqual({ outcome: 'appended' });
  }
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'schegent-run-scoped-metrics-'));
  auditDir = join(workspaceRoot, '.schegent');
  await mkdir(auditDir, { recursive: true });
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('a run-scoped metrics read (T089, FR-023, SC-012)', () => {
  it('returns the rollup record for exactly the runs asked for and no others', async () => {
    const runs = await seedCorpus();
    await recordRollup(runs);

    const response = await readMetrics(
      workspaceRoot,
      { includeArchives: true, runIds: ['run-01'] },
      silentLogger()
    );

    expect(response.runSummaries?.map((summary) => summary.runId)).toEqual(['run-01']);
    expect(response.runSummaries?.[0]).toMatchObject({
      runId: 'run-01',
      terminalStatus: 'completed',
      durationMs: 120_000,
      phasesTotal: PHASES_PER_RUN,
      phasesCompleted: PHASES_PER_RUN,
      phasesSkipped: 0,
      costUsd: COST_PER_RUN
    });
  });

  it('returns an empty list, not the whole rollup, when no asked-for run has a record', async () => {
    const runs = await seedCorpus();
    await recordRollup(runs);

    const response = await readMetrics(
      workspaceRoot,
      { runIds: ['run-that-never-existed'] },
      silentLogger()
    );

    // Present and empty is the honest answer: the field was asked for, and the
    // rollup holds nothing for that run. Falling back to every record would let
    // a detail render another run's cost as its own.
    expect(response.runSummaries).toEqual([]);
  });

  it('leaves a request without runIds shaped exactly as today', async () => {
    const runs = await seedCorpus();
    await recordRollup(runs);

    const scoped = await readMetrics(workspaceRoot, { includeArchives: true, runIds: ['run-01'] }, silentLogger());
    const unscoped = await readMetrics(workspaceRoot, { includeArchives: true }, silentLogger());

    // Omitted entirely, not present-and-undefined: every existing consumer of
    // this response predates the field and none of them may start seeing it.
    expect(Object.hasOwn(unscoped, 'runSummaries')).toBe(false);

    // And the projection is the only difference between the two reads — the
    // corpus-wide half of the response is untouched by scoping.
    const { runSummaries: _scopedOnly, ...rest } = scoped;
    expect(rest).toEqual(unscoped);
  });
});

describe('a retained run whose audit evidence rotated away (T090, FR-025)', () => {
  it('still carries its rollup record when read run-scoped', async () => {
    const runs = await seedCorpus();
    await recordRollup(runs);

    // The prune AuditLogWriter's retention performs: the archive file is gone.
    // Nothing in the product ever rewrites the rollup, so its file is left
    // exactly as the runs left it.
    await rm(join(auditDir, ARCHIVE_NAME), { force: true });

    const response = await readMetrics(
      workspaceRoot,
      { includeArchives: true, runIds: ['run-00'] },
      silentLogger()
    );

    // The evidence really is gone, and the detail must not pretend otherwise.
    expect(response.tasks.some((task) => task.runId === 'run-00')).toBe(false);
    // The cost and phase counts are not, because they never came from there.
    expect(response.runSummaries).toEqual([
      expect.objectContaining({ runId: 'run-00', costUsd: COST_PER_RUN, phasesTotal: PHASES_PER_RUN })
    ]);
  });
});

describe('the run-scoped request at the boundary (T092)', () => {
  function validate(payload: unknown) {
    return validateInboundMessage({ type: CMD_READ_METRICS, correlationId: 'corr-scoped', payload });
  }

  it('threads a runIds list through to the validated command', () => {
    const result = validate({ runIds: ['run-01'] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command).toEqual({
        type: CMD_READ_METRICS,
        correlationId: 'corr-scoped',
        payload: { runIds: ['run-01'] }
      });
    }
  });

  it('keeps an empty payload free of the field rather than defaulting it', () => {
    const result = validate({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command).toEqual({
        type: CMD_READ_METRICS,
        correlationId: 'corr-scoped',
        payload: {}
      });
    }
  });

  it('rejects a runIds that is not a list of non-empty strings', () => {
    expect(validate({ runIds: 'run-01' }).ok).toBe(false);
    expect(validate({ runIds: [42] }).ok).toBe(false);
    expect(validate({ runIds: [''] }).ok).toBe(false);
    expect(validate({ runIds: [null] }).ok).toBe(false);
  });

  it('rejects an unbounded list and an unbounded id', () => {
    expect(validate({ runIds: Array.from({ length: READ_METRICS_RUN_IDS_MAX + 1 }, (_, i) => `run-${i}`) }).ok).toBe(
      false
    );
    expect(validate({ runIds: ['r'.repeat(1024)] }).ok).toBe(false);
  });

  it('holds the discriminator guard to the same gate as the validator', () => {
    const command = (payload: unknown): unknown => ({
      type: CMD_READ_METRICS,
      correlationId: 'corr-guard',
      payload
    });
    expect(isCmdReadMetrics(command({ runIds: ['run-01'] }))).toBe(true);
    expect(isCmdReadMetrics(command({ runIds: 'run-01' }))).toBe(false);
    expect(isCmdReadMetrics(command({ runIds: [42] }))).toBe(false);
  });
});
