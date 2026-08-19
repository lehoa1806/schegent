// FR-R3-009 T397 — the rollup writer appends at most one record per run id.
//
// Why idempotence is the property under test: a terminal transition is not
// guaranteed to happen exactly once. `TerminalTransitionCoordinator.complete()`
// is reached both by the live terminal path and by the crash-replay loop that
// re-drives a journalled intent, so the same run can arrive at the append site
// twice. Counting it twice would inflate a figure an operator quotes, and the
// inflation is invisible — a rollup with two records for one run looks exactly
// like a rollup with two runs.
//
// Idempotence has to hold across three distinct arrival patterns, and each has
// its own guard: sequential appends inside one host (the in-memory set),
// concurrent appends inside one host (the serialize chain making the
// check-then-append pair atomic), and a second host that starts cold against a
// file already holding the run (the lazy load from disk).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  METRICS_ROLLUP_FILENAME,
  METRICS_ROLLUP_SCHEMA_VERSION,
  parseMetricsRollupLine
} from '../../../src/metrics/metrics-rollup';
import {
  MetricsRollupWriter,
  type MetricsRollupAppend
} from '../../../src/metrics/metrics-rollup-writer';
import type { SanitizedLogger } from '../../../src/lib/logger';
import type { EvidenceHealthReporter } from '../../../src/services/evidence-health/evidence-health-monitor';

let workspaceRoot: string;

function testLogger(): SanitizedLogger & { warnings: { message: string; context?: unknown }[] } {
  const warnings: { message: string; context?: unknown }[] = [];
  const logger = {
    warnings,
    info: vi.fn(),
    warn: (message: string, context?: Record<string, unknown>) => {
      warnings.push({ message, context });
    },
    error: vi.fn(),
    debug: vi.fn(),
    sanitize: (value: string) => value
  };
  return logger as unknown as SanitizedLogger & {
    warnings: { message: string; context?: unknown }[];
  };
}

function reporter(): EvidenceHealthReporter & {
  failures: { sink: string; cause: string }[];
  successes: string[];
} {
  const failures: { sink: string; cause: string }[] = [];
  const successes: string[] = [];
  return {
    failures,
    successes,
    reportFailure: (sink: string, cause: string) => {
      failures.push({ sink, cause });
      return true;
    },
    reportSuccess: (sink: string) => {
      successes.push(sink);
    }
  } as unknown as EvidenceHealthReporter & {
    failures: { sink: string; cause: string }[];
    successes: string[];
  };
}

function append(overrides: Partial<MetricsRollupAppend> = {}): MetricsRollupAppend {
  return {
    runId: 'run-1',
    terminalStatus: 'completed',
    startedAt: '2026-08-01T00:00:00.000Z',
    endedAt: '2026-08-01T00:05:00.000Z',
    durationMs: 300_000,
    phasesTotal: 7,
    phasesCompleted: 7,
    phasesSkipped: 0,
    backendInvocations: 12,
    costUsd: 1.25,
    ...overrides
  };
}

function rollupPath(): string {
  return join(workspaceRoot, '.schegent', METRICS_ROLLUP_FILENAME);
}

async function readRecords(): Promise<ReturnType<typeof parseMetricsRollupLine>['record'][]> {
  const content = await readFile(rollupPath(), 'utf8');
  return content
    .split('\n')
    .map((line) => parseMetricsRollupLine(line).record)
    .filter((record) => record !== null);
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'schegent-rollup-writer-'));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('MetricsRollupWriter — append (FR-R3-009, T387)', () => {
  it('creates the file and stamps the current schema version', async () => {
    const writer = new MetricsRollupWriter({ workspaceRoot, logger: testLogger() });

    const outcome = await writer.append(append());

    expect(outcome).toEqual({ outcome: 'appended' });
    const records = await readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      v: METRICS_ROLLUP_SCHEMA_VERSION,
      runId: 'run-1',
      terminalStatus: 'completed',
      durationMs: 300_000,
      phasesTotal: 7,
      backendInvocations: 12,
      costUsd: 1.25
    });
  });

  it('omits costUsd entirely when no cost was reported', async () => {
    const writer = new MetricsRollupWriter({ workspaceRoot, logger: testLogger() });
    await writer.append(append({ costUsd: undefined }));

    const raw = await readFile(rollupPath(), 'utf8');
    expect(raw).not.toContain('costUsd');
    // "not reported" must stay distinguishable from "reported as zero", because
    // collapsing them understates a total that later gains cost reporting.
    expect(JSON.parse(raw.trim())).not.toHaveProperty('costUsd');
  });

  it('appends rather than rewrites, preserving earlier records verbatim', async () => {
    const writer = new MetricsRollupWriter({ workspaceRoot, logger: testLogger() });
    await writer.append(append({ runId: 'run-1' }));
    const afterFirst = await readFile(rollupPath(), 'utf8');

    await writer.append(append({ runId: 'run-2', terminalStatus: 'failed' }));
    const afterSecond = await readFile(rollupPath(), 'utf8');

    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    const records = await readRecords();
    expect(records.map((record) => record?.runId)).toEqual(['run-1', 'run-2']);
  });

  it('writes with owner-only permissions', async () => {
    const writer = new MetricsRollupWriter({ workspaceRoot, logger: testLogger() });
    await writer.append(append());

    const mode = (await stat(rollupPath())).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('reports success to evidence health once bytes are accepted', async () => {
    const health = reporter();
    const writer = new MetricsRollupWriter({ workspaceRoot, logger: testLogger(), evidenceHealth: health });

    await writer.append(append());

    expect(health.successes).toEqual(['metricsRollup']);
    expect(health.failures).toEqual([]);
  });
});

describe('MetricsRollupWriter — idempotence per run id (FR-R3-009, T388)', () => {
  it('records a repeated terminal transition once', async () => {
    const writer = new MetricsRollupWriter({ workspaceRoot, logger: testLogger() });

    const first = await writer.append(append());
    const second = await writer.append(append());
    const third = await writer.append(append({ durationMs: 999_999, costUsd: 99 }));

    expect(first).toEqual({ outcome: 'appended' });
    expect(second).toEqual({ outcome: 'already-recorded' });
    // A later transition carrying different numbers is still the same run; the
    // first record stands rather than being superseded, because the rollup is
    // append-only and a second record would be a second counted run.
    expect(third).toEqual({ outcome: 'already-recorded' });

    const records = await readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.durationMs).toBe(300_000);
  });

  it('records one line when two terminal transitions for the same run race', async () => {
    const writer = new MetricsRollupWriter({ workspaceRoot, logger: testLogger() });

    const outcomes = await Promise.all([
      writer.append(append()),
      writer.append(append()),
      writer.append(append())
    ]);

    expect(outcomes.filter((o) => o.outcome === 'appended')).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === 'already-recorded')).toHaveLength(2);
    expect(await readRecords()).toHaveLength(1);
  });

  it('sees run ids already on disk from a previous session', async () => {
    const first = new MetricsRollupWriter({ workspaceRoot, logger: testLogger() });
    await first.append(append({ runId: 'run-earlier' }));

    // A fresh writer models the next activation: the in-memory set is empty, so
    // only the lazy load from disk prevents a duplicate.
    const second = new MetricsRollupWriter({ workspaceRoot, logger: testLogger() });
    const outcome = await second.append(append({ runId: 'run-earlier' }));

    expect(outcome).toEqual({ outcome: 'already-recorded' });
    expect(await readRecords()).toHaveLength(1);
  });

  it('does not treat an unreadable line as a recorded run', async () => {
    await mkdir(join(workspaceRoot, '.schegent'), { recursive: true });
    await writeFile(rollupPath(), 'not json at all\n', 'utf8');

    const writer = new MetricsRollupWriter({ workspaceRoot, logger: testLogger() });
    const outcome = await writer.append(append({ runId: 'run-1' }));

    expect(outcome).toEqual({ outcome: 'appended' });
    const records = await readRecords();
    expect(records.map((record) => record?.runId)).toEqual(['run-1']);
  });

  // Real permissions rather than a module spy: the writer's failure path is the
  // one place a run can be dropped from the totals, and the property that
  // matters is that the *next* transition can still record it. Skipped where the
  // mode bits do not bind.
  it('lets a later transition retry a run whose append failed', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const health = reporter();
    const logger = testLogger();
    await mkdir(join(workspaceRoot, '.schegent'), { recursive: true });
    await writeFile(rollupPath(), '', 'utf8');
    await chmod(rollupPath(), 0o444);

    const writer = new MetricsRollupWriter({ workspaceRoot, logger, evidenceHealth: health });
    const failed = await writer.append(append());

    expect(failed).toEqual({ outcome: 'failed', cause: 'permission-denied' });
    expect(health.failures).toEqual([{ sink: 'metricsRollup', cause: 'permission-denied' }]);
    // Counters and codes only: the warning names the run and the cause, never a
    // path or a raw error message.
    const rollupWarnings = logger.warnings.filter((entry) => entry.context !== undefined);
    expect(rollupWarnings).toHaveLength(1);
    expect(rollupWarnings[0]?.context).toEqual({ runId: 'run-1', cause: 'permission-denied' });
    expect(JSON.stringify(rollupWarnings[0])).not.toContain(workspaceRoot);

    await chmod(rollupPath(), 0o600);
    const retried = await writer.append(append());
    expect(retried).toEqual({ outcome: 'appended' });
    expect(await readRecords()).toHaveLength(1);
    expect(health.successes).toEqual(['metricsRollup']);
  });
});
