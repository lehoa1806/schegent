// FR-R4-F14 (spec 242, contract M4, M5, D5, D7) — the recorder reads the Run's failure cause.
//
// Each case goes through the real recorder and writer into a temp rollup and back through the real
// reader, so SC-001's "rollup record" half is proven for every member by one round trip, fed by the
// Run alone. The recorder reads only the Run (D5): a crash replay re-drives the journalled Run and
// must record the same code, and the writer's run-id idempotence keeps the first record.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAILURE_CAUSES, type FailureCause } from '../../../src/contracts/failure-cause';
import { SanitizedLogger } from '../../../src/lib/logger';
import { METRICS_ROLLUP_FILENAME } from '../../../src/metrics/metrics-rollup';
import { readMetricsRollup } from '../../../src/metrics/metrics-rollup-reader';
import { MetricsRollupWriter } from '../../../src/metrics/metrics-rollup-writer';
import { TerminalRunRollupRecorder } from '../../../src/metrics/terminal-run-rollup-recorder';
import type { WorkflowRun, WorkflowRunStatus } from '../../../src/state/workflow-run';

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'schegent-rollup-recorder-'));
});
afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function runWith(id: string, status: WorkflowRunStatus, failureCause?: FailureCause): WorkflowRun {
  return {
    id,
    featureId: 'task-1',
    featureDir: '',
    status,
    currentPhase: 'speckit-implement',
    currentIteration: 1,
    startedAt: 1_700_000_000_000,
    lastTransitionAt: 1_700_000_060_000,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    ...(failureCause === undefined ? {} : { failureCause })
  } as unknown as WorkflowRun;
}

function recorderOver(logger = new SanitizedLogger()): TerminalRunRollupRecorder {
  return new TerminalRunRollupRecorder({
    writer: new MetricsRollupWriter({ workspaceRoot, logger }),
    logger,
    workspaceRoot,
    projectRunMetrics: async () => ({ costUsd: 0.5, backendInvocations: 3 })
  });
}

async function recordsOnDisk() {
  return (await readMetricsRollup(workspaceRoot, new SanitizedLogger())).records;
}

async function rawLines(): Promise<Record<string, unknown>[]> {
  const raw = await readFile(join(workspaceRoot, '.schegent', METRICS_ROLLUP_FILENAME), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('TerminalRunRollupRecorder — the failure cause (FR-R4-F14)', () => {
  it.each(FAILURE_CAUSES)('a failed Run with %s keeps its cause through the writer and the reader', async (cause) => {
    await recorderOver().recordTerminalRun(runWith(`run-${cause}`, 'failed', cause));

    const records = await recordsOnDisk();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ runId: `run-${cause}`, terminalStatus: 'failed', v: 2 });
    expect(records[0]?.failureCause).toBe(cause);
  });

  it('records no cause for a completed Run, even a hand-built one that carries a code', async () => {
    await recorderOver().recordTerminalRun(runWith('run-completed', 'completed', 'cap_exhausted'));

    expect((await rawLines())[0]).not.toHaveProperty('failureCause');
    expect((await recordsOnDisk())[0]?.terminalStatus).toBe('completed');
  });

  it('records no cause for a canceled Run', async () => {
    await recorderOver().recordTerminalRun(runWith('run-canceled', 'canceled'));

    expect((await rawLines())[0]).not.toHaveProperty('failureCause');
    expect((await recordsOnDisk())[0]?.terminalStatus).toBe('canceled');
  });

  it('records a failed Run that carries no cause with no key at all (a Run that failed before the feature)', async () => {
    await recorderOver().recordTerminalRun(runWith('run-legacy', 'failed'));

    const [line] = await rawLines();
    expect(line).toMatchObject({ runId: 'run-legacy', terminalStatus: 'failed' });
    expect(line).not.toHaveProperty('failureCause');
  });

  it('records the same code when the journalled Run is replayed by a cold host, and only once (D5, D7)', async () => {
    const failed = runWith('run-replayed', 'failed', 'phase_timeout');
    await recorderOver().recordTerminalRun(failed);

    // A crash between the transition and the append: the intent holds the whole Run as JSON, and the
    // next host re-drives it through a fresh recorder and a writer that has not seen the run id.
    const journalled = JSON.parse(JSON.stringify(failed)) as WorkflowRun;
    await recorderOver().recordTerminalRun(journalled);

    const records = await recordsOnDisk();
    expect(records).toHaveLength(1);
    expect(records[0]?.failureCause).toBe('phase_timeout');
  });

  it('keeps the failed record and its cause when the same Run later completes (spec edge case, D7)', async () => {
    await recorderOver().recordTerminalRun(runWith('run-then-done', 'failed', 'cap_exhausted'));
    await recorderOver().recordTerminalRun(runWith('run-then-done', 'completed'));

    const records = await recordsOnDisk();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ terminalStatus: 'failed', failureCause: 'cap_exhausted' });
  });

  it('records the first failure\'s cause when a resumed Run fails again under the same run id (D7)', async () => {
    const first = runWith('run-twice', 'failed', 'cap_exhausted');
    await recorderOver().recordTerminalRun(first);
    await recorderOver().recordTerminalRun(runWith('run-twice', 'failed', 'phase_failed'));

    const records = await recordsOnDisk();
    expect(records).toHaveLength(1);
    expect(records[0]?.failureCause).toBe('cap_exhausted');
  });
});
