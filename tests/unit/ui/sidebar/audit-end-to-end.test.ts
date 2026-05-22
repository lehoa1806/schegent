import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogWriter } from '../../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { WorkspaceStateStore, type Memento } from '../../../../src/state/workspace-state';
import { StateProjector } from '../../../../src/ui/sidebar/state-projector';
import type { WorkflowSnapshot } from '../../../../src/ui/sidebar/snapshot';

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

const FLUSH_PAD_MS = 50;

async function waitMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('audit -> projector end-to-end (T060)', () => {
  let workspaceRoot: string;
  let memento: FakeMemento;
  let store: WorkspaceStateStore;
  let writer: AuditLogWriter;
  let projector: StateProjector;
  let snapshots: WorkflowSnapshot[];

  beforeEach(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'schegent-e2e-'));
    memento = new FakeMemento();
    store = new WorkspaceStateStore(memento);
    await store.initialize();
    writer = new AuditLogWriter({ workspaceRoot }, new SanitizedLogger());
    projector = new StateProjector({
      store,
      audit: writer,
      ownerId: 'owner-e2e',
      debounceMs: 150
    });
    projector.start();
    snapshots = [];
    projector.subscribe((snap) => snapshots.push(snap));
  });

  afterEach(() => {
    projector.dispose();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('surfaces an appended audit entry on the next projector snapshot', async () => {
    snapshots = [];

    const entry = await writer.append({
      runId: 'run-e2e',
      phase: 'speckit-specify',
      iteration: 1,
      eventType: 'phase-start',
      outcome: 'info',
      payload: { summary: 'beginning specify' }
    });

    await waitMs(150 + FLUSH_PAD_MS);

    expect(snapshots.length).toBeGreaterThan(0);
    const last = snapshots[snapshots.length - 1];
    expect(last.auditTail.length).toBeGreaterThan(0);
    const head = last.auditTail[last.auditTail.length - 1];
    expect(head.id).toBe(entry.id);
    expect(head.category).toBe('phase-transition');
    expect(head.summary).toContain('beginning specify');
  });

  it('coalesces audit + store changes into a single debounced snapshot', async () => {
    snapshots = [];

    await Promise.all([
      writer.append({
        runId: 'run-e2e',
        phase: 'speckit-plan',
        iteration: 1,
        eventType: 'cli-invocation',
        outcome: 'success',
        payload: { summary: 'invoked claude' }
      }),
      store.setQueue({ requests: [], inFlightId: null, paused: false, pausedReason: null, updatedAt: Date.now(), queueLifecycle: 'active-empty', scheduledStartAt: null, scheduledStartSource: null })
    ]);

    await waitMs(150 + FLUSH_PAD_MS);

    expect(snapshots.length).toBe(1);
    const only = snapshots[0];
    expect(only.auditTail.length).toBeGreaterThan(0);
    expect(only.auditTail[only.auditTail.length - 1].category).toBe('cli-invocation');
  });
});
