// Feature FR-R3-006 (T351) — reset clears state, not evidence.
//
// The confirmation this feature rewrote now says the audit log, its archives,
// and the per-run session transcripts are preserved. That sentence is a promise
// an operator makes decisions on: reset is what they reach for when a workspace
// is inconsistent, and the reason they can reach for it *while investigating* is
// that it does not destroy what they are investigating with. A reset that took
// the audit log with it would make the recovery command and the diagnosis
// mutually exclusive.
//
// So this asserts the promise on a real filesystem rather than by inspection of
// `RESET_CLEARED_KEYS`. That list is about the `Memento`, and the whole point is
// that these artifacts are not in it — an implementation that started deleting
// files would satisfy every key-level test in this feature and still break this.
// It is also the standing CLAUDE.md rule that task and phase deletion must never
// be implemented by erasing `.schegent/audit.log`; reset is the operation most
// likely to be "simplified" into doing exactly that.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../src/lib/logger';
import { WorkspaceStateStore, KEYS, type Memento } from '../../../src/state/workspace-state';

class MapMemento implements Memento {
  private readonly map = new Map<string, unknown>();
  public get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  public update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

let workspaceRoot: string;
let schegentDir: string;

async function listTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(path.relative(schegentDir, full));
    }
  };
  await walk(dir);
  return out.sort();
}

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-reset-evidence-'));
  schegentDir = path.join(workspaceRoot, '.schegent');
  await fs.mkdir(schegentDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe('FR-R3-006 — reset preserves the audit log and the session trees', () => {
  it('leaves the audit log, its archives, and the session transcripts byte-identical', async () => {
    const logger = new SanitizedLogger();
    const audit = new AuditLogWriter({ workspaceRoot }, logger);
    await audit.append({
      runId: 'run-1',
      phase: 'specify',
      iteration: 0,
      eventType: 'phase-start',
      payload: { pipelineId: 'p', phaseId: 'specify' },
      outcome: 'info'
    });

    // A rotated archive and two per-run session trees, laid out the way the
    // retention service and the transcript writer put them on disk.
    await fs.writeFile(path.join(schegentDir, 'audit.log.1'), 'archived line\n', 'utf8');
    const sessions = path.join(schegentDir, 'sessions');
    for (const runId of ['run-1', 'run-2']) {
      const dir = path.join(sessions, runId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'raw.jsonl'), `{"run":"${runId}"}\n`, 'utf8');
    }

    const before = await listTree(schegentDir);
    const contentsBefore = await Promise.all(
      before.map((rel) => fs.readFile(path.join(schegentDir, rel), 'utf8'))
    );

    const store = new WorkspaceStateStore(new MapMemento());
    await store.setLock({ ownerId: 'w1', acquiredAt: Date.now(), heartbeatAt: Date.now() });
    await store.reset();

    // State is gone.
    expect(store.getLock()).toBeNull();
    // Evidence is not — same files, same bytes.
    expect(await listTree(schegentDir)).toEqual(before);
    const contentsAfter = await Promise.all(
      before.map((rel) => fs.readFile(path.join(schegentDir, rel), 'utf8'))
    );
    expect(contentsAfter).toEqual(contentsBefore);
  });

  it('leaves the audit log appendable, so the reset event lands after the state it cleared', async () => {
    const logger = new SanitizedLogger();
    const audit = new AuditLogWriter({ workspaceRoot }, logger);
    await audit.append({
      runId: '',
      phase: 'queue',
      iteration: 0,
      eventType: 'task-enqueued',
      payload: { queueId: 'default' },
      outcome: 'info'
    });

    const store = new WorkspaceStateStore(new MapMemento());
    const generation = await store.reset();

    // This is the ordering the audit event depends on: the writer that records
    // the reset writes into the same file the reset just declined to touch.
    await audit.append({
      runId: '',
      phase: 'reset',
      iteration: 0,
      eventType: 'workspace-state-reset',
      payload: {
        outcome: 'completed',
        phaseReached: 'reload',
        generation,
        refusalReason: null,
        canceledRunCount: 0
      },
      outcome: 'success'
    });

    const lines = (await fs.readFile(path.join(schegentDir, 'audit.log'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { eventType: string });
    expect(lines.map((entry) => entry.eventType)).toEqual([
      'task-enqueued',
      'workspace-state-reset'
    ]);
  });

  it('does not create, move, or delete anything under .schegent when it clears', async () => {
    // The strongest form of the promise: reset is a memento operation and
    // touches the filesystem not at all. Asserted over an empty tree so a
    // stray write has nowhere to hide among expected files.
    const before = await listTree(schegentDir);
    expect(before).toEqual([]);

    const memento = new MapMemento();
    const store = new WorkspaceStateStore(memento);
    await memento.update(KEYS.watchdog, { pollIntervalMs: 60_000 });
    await store.reset();

    // Asserted against the raw key rather than `getWatchdog()`, which
    // synthesizes a default record for an absent key — a defaulted read cannot
    // tell "cleared" from "never set", and this test is about the clear.
    expect(memento.get(KEYS.watchdog)).toBeUndefined();
    expect(await listTree(schegentDir)).toEqual([]);
  });

  it('preserves the same artifacts when it completes an interrupted reset', async () => {
    // The recovery path runs the clear a second time, on the activation path,
    // with no operator watching. It must be just as file-inert as the first.
    await fs.writeFile(path.join(schegentDir, 'audit.log'), 'pre-existing\n', 'utf8');
    const memento = new MapMemento();
    await memento.update(KEYS.resetMarker, { generation: 4, status: 'in-progress' });
    await memento.update(KEYS.queue, { seeded: true });

    const store = new WorkspaceStateStore(memento);
    expect(await store.completeInterruptedReset()).toBe(4);

    expect(memento.get(KEYS.queue)).toBeUndefined();
    expect(await fs.readFile(path.join(schegentDir, 'audit.log'), 'utf8')).toBe('pre-existing\n');
    expect(await listTree(schegentDir)).toEqual(['audit.log']);
  });
});
