// Feature 091 (T007, US1) — the reader `extension.ts` supplies as
// `readPriorRunOutputs`, and the two refusals FR-011 requires it to keep apart.
//
// The distinction is the whole point of the slice's read half, and it lives in
// one shape: `null` means "no such Run", `[]` means "that Run is known and
// recorded nothing". Collapsing them — returning `[]` for an absent entry, or
// `null` for a known Run with no outputs — turns a wrong reference into a
// misleading refusal, and both mistakes are one character away in the source.
//
// Composed against the real resolver rather than asserted on the reader alone.
// What matters is the refusal an operator sees, and that is a property of the
// pair; a reader tested in isolation could keep the distinction while the
// resolver quietly discarded it.

import { describe, it, expect, beforeEach } from 'vitest';
import { HistoryStore } from '../../../../src/state/history-store';
import type { HistoryEntry } from '../../../../src/state/history-entry';
import { WorkspaceStateStore, type Memento } from '../../../../src/state/workspace-state';
import { resolvePriorOutput } from '../../../../src/services/run-request/output-reference-resolver';
import type { RunOutputRecord } from '../../../../src/contracts/run-results';

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

function entryFor(runId: string, runOutputs?: readonly RunOutputRecord[]): HistoryEntry {
  return {
    runId,
    featureId: `feat-${runId}`,
    descriptionPreview: runId,
    terminalStatus: 'completed',
    startedAt: '2026-08-01T00:00:00.000Z',
    completedAt: '2026-08-01T00:00:01.000Z',
    durationMs: 1_000,
    lastErrorSummary: null,
    auditLogPointer: `runId:${runId}`,
    ...(runOutputs !== undefined ? { runOutputs } : {})
  };
}

let history: HistoryStore;

/** Exactly the expression `extension.ts` supplies to the command router. */
function readPriorRunOutputs(runId: string): readonly RunOutputRecord[] | null {
  return history.outputsFor(runId);
}

function refusalFor(sourceRunId: string, outputName: string) {
  return resolvePriorOutput(
    { outputsFor: (runId) => readPriorRunOutputs(runId) },
    { sourceRunId, outputName }
  );
}

beforeEach(async () => {
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  history = new HistoryStore(store);
});

describe('a Run the reader cannot find (FR-011)', () => {
  it('answers null rather than an empty list', async () => {
    await history.append(entryFor('run-known'));
    expect(readPriorRunOutputs('run-never-existed')).toBeNull();
  });

  it('refuses as prior-run-not-found', async () => {
    await history.append(entryFor('run-known', [{ name: 'report', status: 'unresolved' }]));
    expect(refusalFor('run-never-existed', 'report')).toEqual({
      ok: false,
      code: 'prior-run-not-found'
    });
  });

  it('reports a Run aged past the history cap as not found, not as recording nothing', async () => {
    // Retention is finite, and from the composing operator's position "this host
    // can no longer tell you about that Run" and "no such Run" are the same
    // answer. Claiming it was found and recorded nothing would assert something
    // about a record the host does not have.
    await history.append(entryFor('run-oldest', [{ name: 'report', status: 'resolved', reference: 'out/report.md' }]));
    for (let i = 0; i < 50; i++) {
      await history.append(entryFor(`run-filler-${i}`));
    }
    expect(readPriorRunOutputs('run-oldest')).toBeNull();
    expect(refusalFor('run-oldest', 'report')).toEqual({
      ok: false,
      code: 'prior-run-not-found'
    });
  });
});

describe('a Run the reader finds (FR-011, FR-012)', () => {
  it('answers an empty list — not null — for a Run that recorded nothing', async () => {
    await history.append(entryFor('run-silent'));
    expect(readPriorRunOutputs('run-silent')).toEqual([]);
  });

  it('refuses an output of a Run that recorded nothing as prior-output-not-found', async () => {
    await history.append(entryFor('run-silent'));
    expect(refusalFor('run-silent', 'report')).toEqual({
      ok: false,
      code: 'prior-output-not-found'
    });
  });

  it('refuses an output name the Run never recorded as prior-output-not-found', async () => {
    await history.append(
      entryFor('run-recorded', [{ name: 'report', status: 'resolved', reference: 'out/report.md' }])
    );
    expect(refusalFor('run-recorded', 'summary')).toEqual({
      ok: false,
      code: 'prior-output-not-found'
    });
  });

  it('refuses an output recorded unresolved as prior-output-not-found (FR-012)', async () => {
    await history.append(
      entryFor('run-recorded', [
        { name: 'report', status: 'resolved', reference: 'out/report.md' },
        { name: 'summary', status: 'unresolved' }
      ])
    );
    expect(refusalFor('run-recorded', 'summary')).toEqual({
      ok: false,
      code: 'prior-output-not-found'
    });
  });

  it('resolves an output recorded with a location', async () => {
    await history.append(
      entryFor('run-recorded', [{ name: 'report', status: 'resolved', reference: 'out/report.md' }])
    );
    expect(refusalFor('run-recorded', 'report')).toEqual({
      ok: true,
      reference: 'out/report.md'
    });
  });

  it('matches the output name exactly, without trimming or case folding', async () => {
    await history.append(
      entryFor('run-recorded', [{ name: 'report', status: 'resolved', reference: 'out/report.md' }])
    );
    expect(refusalFor('run-recorded', ' report').ok).toBe(false);
    expect(refusalFor('run-recorded', 'Report').ok).toBe(false);
  });
});
