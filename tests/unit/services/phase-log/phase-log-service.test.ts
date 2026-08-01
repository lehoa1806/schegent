import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPhaseLogService } from '../../../../src/services/phase-log/phase-log-service';

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
