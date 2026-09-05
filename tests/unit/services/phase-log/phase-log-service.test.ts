import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPhaseLogService,
  type PhaseLogSnapshotView
} from '../../../../src/services/phase-log/phase-log-service';

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'phase-log-service-history-'));
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

const HISTORY_SELECTION = Object.freeze({
  queueId: 'default',
  taskId: 'run-history-only',
  pipelineId: 'standard',
  phaseId: 'speckit-plan',
  iterationN: null
});

async function writeHistoryStream(): Promise<void> {
  const streamPath = path.join(
    workspaceRoot,
    '.schegent',
    'sessions',
    HISTORY_SELECTION.taskId,
    'diagnostics',
    HISTORY_SELECTION.pipelineId,
    HISTORY_SELECTION.phaseId,
    'iter-1',
    'stream.jsonl'
  );
  await fs.mkdir(path.dirname(streamPath), { recursive: true });
  await fs.writeFile(
    streamPath,
    `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'historical evidence' }] } })}\n`,
    'utf8'
  );
}

function historyOnlySnapshot() {
  return {
    queue: {
      inFlight: null,
      pending: [],
      recent: [],
      queues: [{ id: 'default' }]
    },
    history: [{ runId: HISTORY_SELECTION.taskId }],
    availablePipelines: [{ id: HISTORY_SELECTION.pipelineId }],
    availablePhases: [{ id: HISTORY_SELECTION.phaseId }]
  } as const;
}

describe('PhaseLogService history fallback (069)', () => {
  it('reads a history-only run by its on-disk run id', async () => {
    await writeHistoryStream();
    const resolveRunId = vi.fn(() => null);
    const service = createPhaseLogService({
      workspaceRoot,
      sanitize: (value) => value,
      readVerboseSetting: () => true,
      getSnapshot: historyOnlySnapshot,
      resolveRunId
    });

    const result = await service.read({ selection: HISTORY_SELECTION });

    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    expect(result.manifest.isInFlight).toBe(false);
    expect(result.manifest.iterations).toEqual([1]);
    expect(result.manifest.selectedIteration).toBe(1);
    expect(result.manifest.entries).toEqual([
      expect.objectContaining({
        kind: 'assistant-text',
        body: expect.objectContaining({ text: 'historical evidence' })
      })
    ]);
    expect(resolveRunId).toHaveBeenCalledWith(HISTORY_SELECTION.taskId);
  });

  it('rejects an unknown historical task before resolving a session path', async () => {
    const resolveRunId = vi.fn(() => null);
    const service = createPhaseLogService({
      workspaceRoot,
      sanitize: (value) => value,
      readVerboseSetting: () => true,
      getSnapshot: historyOnlySnapshot,
      resolveRunId
    });

    const result = await service.read({
      selection: { ...HISTORY_SELECTION, taskId: 'run-not-in-history' }
    });

    expect(result).toEqual({ outcome: 'failure', reason: 'unknown-tuple' });
    expect(resolveRunId).not.toHaveBeenCalled();
  });
});

// Feature 203 Phase 6 (US3) — "wait or intervene" is answered honestly.
//
// `F12`: `isInFlight` answers "is the selected TASK the running one" and was the
// only progress evidence a card had. An operator reading phase 3 of a task whose
// runtime has moved to phase 7 was told to wait for output that no longer had a
// writer. `FR-016` requires a claim about the selected phase to rest on evidence
// about that phase, so `derivePhaseProgress` compares the run's own phase against
// the selected one, and `isInFlight` keeps its task-level meaning untouched (`X4`).
//
// Every case below asserts BOTH: the member the classifier reached, and that
// `isInFlight` is still `true` in the same manifest. The second half is what makes
// the first half mean something — under `isInFlight` alone these three situations
// are one situation, and it is the wrong one twice.

const IN_FLIGHT_SELECTION = Object.freeze({
  queueId: 'default',
  taskId: 'run-in-flight',
  pipelineId: 'standard',
  phaseId: 'speckit-plan',
  iterationN: null
});

/**
 * The phase the run has moved on to. A real, distinct identifier rather than
 * `null` or an omission: `F21` records that `currentPhase` and `selection.phaseId`
 * are the same identifier space, and a comparison against a missing value would
 * pass whether or not that were true.
 */
const EXECUTING_PHASE = 'speckit-implement';

function inFlightSnapshot(currentPhase: string | null): PhaseLogSnapshotView {
  return {
    queue: {
      inFlight: { id: IN_FLIGHT_SELECTION.taskId, currentPhase },
      pending: [],
      recent: [],
      queues: [{ id: IN_FLIGHT_SELECTION.queueId }]
    },
    history: [],
    availablePipelines: [{ id: IN_FLIGHT_SELECTION.pipelineId }],
    availablePhases: [{ id: IN_FLIGHT_SELECTION.phaseId }, { id: EXECUTING_PHASE }]
  };
}

function serviceReadingPhaseOf(currentPhase: string | null) {
  return createPhaseLogService({
    workspaceRoot,
    sanitize: (value) => value,
    readVerboseSetting: () => true,
    getSnapshot: () => inFlightSnapshot(currentPhase),
    resolveRunId: () => null
  });
}

/**
 * The selected phase has a log directory holding one iteration whose stream is
 * empty — the phase was reached and produced nothing displayable. Without it the
 * only reachable member would be `phase-not-recorded`, and the classifier's other
 * progress fork (record present: running vs. not) would go unexercised.
 */
async function writeEmptyIteration(): Promise<void> {
  const iterationDir = path.join(
    workspaceRoot,
    '.schegent',
    'sessions',
    IN_FLIGHT_SELECTION.taskId,
    'diagnostics',
    IN_FLIGHT_SELECTION.pipelineId,
    IN_FLIGHT_SELECTION.phaseId,
    'iter-1'
  );
  await fs.mkdir(iterationDir, { recursive: true });
  await fs.writeFile(path.join(iterationDir, 'stream.jsonl'), '', 'utf8');
}

async function readSelectedPhase(currentPhase: string | null) {
  const result = await serviceReadingPhaseOf(currentPhase).read({
    selection: IN_FLIGHT_SELECTION
  });
  expect(result.outcome).toBe('success');
  if (result.outcome !== 'success') throw new Error('unreachable: asserted above');
  // `X4` — the task-level flag is unchanged by this feature and is still true in
  // every case here. It is the evidence a card is no longer allowed to quote.
  expect(result.manifest.isInFlight).toBe(true);
  return result.manifest;
}

describe('Feature 203 T058 — a running task does not make its other phases running', () => {
  it('SC-014: nothing recorded for a phase the run has moved past is phase-not-recorded', async () => {
    const manifest = await readSelectedPhase(EXECUTING_PHASE);

    expect(manifest.verboseDiagnosticsState).toEqual({ kind: 'phase-not-recorded' });
    expect(
      manifest.verboseDiagnosticsState.kind,
      'the containing task being in flight is not evidence about this phase'
    ).not.toBe('phase-running-no-output');
  });

  it('SC-014: a record with nothing displayable is not a promise of more to come', async () => {
    await writeEmptyIteration();

    const manifest = await readSelectedPhase(EXECUTING_PHASE);

    expect(manifest.iterations).toEqual([1]);
    expect(manifest.entries).toEqual([]);
    expect(manifest.verboseDiagnosticsState).toEqual({ kind: 'nothing-displayable' });
  });
});

describe('Feature 203 T059 — the executing phase is reported as running', () => {
  it('US3 scenario 2: the selected phase IS the executing one and has written nothing', async () => {
    // Identical to the first T058 case in every respect except which phase the
    // run names. That is the whole point: the disk, the setting and the task's
    // in-flight state are held constant, and the member still changes.
    const manifest = await readSelectedPhase(IN_FLIGHT_SELECTION.phaseId);

    expect(manifest.verboseDiagnosticsState).toEqual({ kind: 'phase-running-no-output' });
  });

  it('US3 scenario 2: a record open and still empty is the running case, not the displayable one', async () => {
    await writeEmptyIteration();

    const manifest = await readSelectedPhase(IN_FLIGHT_SELECTION.phaseId);

    expect(manifest.verboseDiagnosticsState).toEqual({ kind: 'phase-running-no-output' });
  });
});

describe('Feature 203 T060 — an unestablished progress makes no progress claim', () => {
  it('FR-017: in flight with no named phase reports what the disk says, not a guess', async () => {
    const manifest = await readSelectedPhase(null);

    // `unknown` is not `running`, and it is not `not-running` either. Here the
    // absent directory answers the question the snapshot could not, and the
    // member says exactly that much.
    expect(manifest.verboseDiagnosticsState).toEqual({ kind: 'phase-not-recorded' });
    expect(manifest.verboseDiagnosticsState.kind).not.toBe('phase-running-no-output');
  });

  it('FR-017: a record present under an unknown progress claims nothing about it', async () => {
    await writeEmptyIteration();

    // The case where the disk cannot answer either: the phase was reached and
    // recorded nothing displayable, and whether it is still going is genuinely
    // not known. `nothing-displayable` states the read and stops there.
    const manifest = await readSelectedPhase(null);

    expect(manifest.verboseDiagnosticsState).toEqual({ kind: 'nothing-displayable' });
  });
});
