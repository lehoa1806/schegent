// FR-R3-071 (feature 152) — the composition check the source plan demanded
// instead of another unit test: two tests passed on either side of this seam
// because each assumed a different generation of the contract, so the property
// is asserted END TO END — record through the REAL recorder onto a real tmp
// workspace, construct a FRESH store instance (the restart), resolve through
// the resolver the replay commands use, and compare BYTES with the sanitized
// original. That byte-identity is the property FR-R3-010 was built to provide
// and the current build silently lost.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { HistoryRecorder } from '../../src/services/history-recorder';
import {
  HistoryDescriptionStore,
  historyDescriptionRef
} from '../../src/services/history/history-description-store';
import { resolveHistoryDescription } from '../../src/services/history/history-description-resolver';
import { TerminalTransitionCoordinator } from '../../src/services/terminal-transition-coordinator';
import { HistoryStore } from '../../src/state/history-store';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { SanitizedLogger } from '../../src/lib/logger';
import type { WorkflowRun } from '../../src/state/workflow-run';

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

function terminalRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-rt-1', featureId: 'task-rt-1', featureDir: '', status: 'completed',
    currentPhase: 'done', currentIteration: 1, startedAt: 1, lastTransitionAt: 2,
    phasesCompleted: [], lastError: null, delayedRetryCount: 0,
    pendingRetryAt: null, pendingRetryCause: null, phaseOverrides: [],
    manualPauseAt: null, manualPauseCause: null, phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    ...overrides
  } as WorkflowRun;
}

let workspaceRoot: string;
let logger: SanitizedLogger;

function makeRecorder(historyStore: HistoryStore): HistoryRecorder {
  return new HistoryRecorder({
    historyStore,
    logger,
    queueIdForTask: () => 'default',
    originForTask: () => null,
    descriptions: new HistoryDescriptionStore({ workspaceRoot, logger })
  });
}

beforeEach(async () => {
  workspaceRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-152-replay-'))
  );
  logger = new SanitizedLogger();
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe('FR-R3-071 — a recorded description replays byte-identical', () => {
  // Long enough that the 80-char preview cannot masquerade as the original,
  // and carrying whitespace shapes the preview's collapse would destroy.
  const original =
    'Implement the retry coordinator:\n  - preserve  double  spaces\n  - and this second line, ' +
    'which pushes the text well past the eighty character preview cap so a truncation is loud.';

  it('records through the real recorder, restarts the store, resolves byte-identical', async () => {
    const state = new WorkspaceStateStore(new FakeMemento());
    await state.initialize();
    const historyStore = new HistoryStore(state);
    await makeRecorder(historyStore).record(terminalRun(), original, 'completed');

    const entry = historyStore.list().find((h) => h.runId === 'run-rt-1');
    expect(entry).toBeDefined();
    expect(entry!.descriptionRef).toBe(historyDescriptionRef('run-rt-1'));
    expect(entry!.originalDescription).toBeUndefined();

    // The restart: a FRESH store instance over the same workspace.
    const resolution = await resolveHistoryDescription(entry!, {
      descriptions: new HistoryDescriptionStore({ workspaceRoot, logger }),
      logger
    });
    expect(resolution.outcome).toBe('resolved');
    const expected = logger.sanitize(original);
    expect((resolution as { description: string }).description).toBe(expected);
    // Byte-identity, stated as bytes: no collapse, no cap, no re-sanitize.
    expect(Buffer.from((resolution as { description: string }).description, 'utf8')).toEqual(
      Buffer.from(expected, 'utf8')
    );
  });

  it('corrupt ref, absent file, and legacy entry each produce their named outcome', async () => {
    const state = new WorkspaceStateStore(new FakeMemento());
    await state.initialize();
    const historyStore = new HistoryStore(state);
    await makeRecorder(historyStore).record(terminalRun(), original, 'completed');
    const entry = historyStore.list().find((h) => h.runId === 'run-rt-1')!;
    const descriptions = new HistoryDescriptionStore({ workspaceRoot, logger });

    // Corrupt ref: points outside the history store — unreadable, not preview.
    expect(
      (
        await resolveHistoryDescription(
          { ...entry, originalDescription: undefined, descriptionRef: '../outside.txt' },
          { descriptions, logger }
        )
      ).outcome
    ).toBe('unreadable');

    // Absent file: the retention sweep's shape — missing, not preview.
    await fs.rm(path.join(workspaceRoot, '.schegent', 'history', 'run-rt-1.txt'));
    expect(
      (await resolveHistoryDescription(entry, { descriptions, logger })).outcome
    ).toBe('missing');

    // Legacy entry: inline text answers.
    expect(
      await resolveHistoryDescription(
        { runId: 'run-legacy', descriptionRef: undefined, originalDescription: 'old text' },
        { descriptions, logger }
      )
    ).toEqual({ outcome: 'legacy', description: 'old text' });
  });
});

describe('FR-R3-071 — the repair intent survives a failing recorder', () => {
  it('a failing recorder retains the intent; a succeeding one clears it, and replay uses the journalled description', async () => {
    const state = new WorkspaceStateStore(new FakeMemento());
    await state.initialize();
    const queue = { finish: vi.fn(async () => undefined) };
    const run = terminalRun({ id: 'run-crash', featureId: 'task-crash' });

    const failing = new TerminalTransitionCoordinator(
      state,
      queue as never,
      { record: vi.fn(async () => ({ outcome: 'failed' as const, code: 'EIO' })) },
      logger
    );
    await failing.complete(run, 'the operator text');
    const journalled = state.getTerminalTransitionIntents()['run-crash'];
    expect(journalled).toBeDefined();
    expect(journalled.description).toBe('the operator text');

    // The recovery: a succeeding recorder replays with the JOURNALLED text —
    // not the featureId — and the durable outcome clears the intent.
    const recorded: string[] = [];
    const succeeding = new TerminalTransitionCoordinator(
      state,
      queue as never,
      {
        record: vi.fn(async (_run: WorkflowRun, description: string) => {
          recorded.push(description);
          return { outcome: 'recorded' as const };
        })
      },
      logger
    );
    await succeeding.replay();
    expect(recorded).toEqual(['the operator text']);
    expect(state.getTerminalTransitionIntents()['run-crash']).toBeUndefined();
  });
});
