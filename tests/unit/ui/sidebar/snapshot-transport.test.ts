import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
  FULL_RESYNC_SNAPSHOT_BYTE_CEILING,
  ROUTINE_SNAPSHOT_BYTE_BUDGET,
  SNAPSHOT_RESYNC_REQUEST,
  SUPPRESSIBLE_SNAPSHOT_SLICES
} from '../../../../src/contracts/snapshot-bounds';
import { DEFAULT_QUEUE_ID } from '../../../../src/contracts/queue-identity';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { HistoryStore } from '../../../../src/state/history-store';
import {
  WorkspaceStateStore,
  type Memento,
  type PersistedHistoryEntry
} from '../../../../src/state/workspace-state';
import { DashboardPanel } from '../../../../src/ui/dashboard/dashboard-panel';
import { projectHistory } from '../../../../src/ui/sidebar/history-projector';
import { STATE_SNAPSHOT } from '../../../../src/ui/sidebar/messages';
import type { ProjectorHandle, ProjectorListener } from '../../../../src/ui/sidebar/projector-handle';
import { SidebarViewProvider } from '../../../../src/ui/sidebar/sidebar-view-provider';
import { buildIdleSnapshot, type WorkflowSnapshot } from '../../../../src/ui/sidebar/snapshot';
import { SnapshotTransport } from '../../../../src/ui/sidebar/snapshot-transport';

const mocks = vi.hoisted(() => ({
  panels: [] as Array<{
    webview: {
      html: string;
      options: Record<string, unknown>;
      cspSource: string;
      postMessage: ReturnType<typeof vi.fn>;
      onDidReceiveMessage: ReturnType<typeof vi.fn>;
      asWebviewUri: ReturnType<typeof vi.fn>;
    };
    visible: boolean;
    active: boolean;
    reveal: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    onDidChangeViewState: ReturnType<typeof vi.fn>;
    onDidDispose: ReturnType<typeof vi.fn>;
    __inbound: ((raw: unknown) => void) | null;
    __viewStateListeners: Array<() => void>;
  }>,
  createWebviewPanel: vi.fn()
}));

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: vi.fn(),
    createWebviewPanel: mocks.createWebviewPanel
  },
  Uri: {
    file: (fsPath: string) => ({
      fsPath,
      scheme: 'file',
      path: fsPath,
      toString: () => `file://${fsPath}`
    })
  },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 }
}));

class LocalMemento implements Memento {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

class FakeProjector implements ProjectorHandle {
  public current: WorkflowSnapshot;
  private readonly listeners = new Set<ProjectorListener>();

  constructor(initial: WorkflowSnapshot) {
    this.current = initial;
  }

  subscribe(listener: ProjectorListener) {
    this.listeners.add(listener);
    listener(this.current);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
  }

  getCurrentSnapshot(): WorkflowSnapshot {
    return this.current;
  }

  emit(next: WorkflowSnapshot): void {
    this.current = next;
    for (const listener of [...this.listeners]) {
      listener(next);
    }
  }
}

function makeSnapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  const base = buildIdleSnapshot({
    isPrimary: true,
    producedAt: '2026-11-06T00:00:00.000Z'
  });
  return Object.freeze({
    ...base,
    ...overrides
  });
}

function makeHistoryEntry(index: number): PersistedHistoryEntry {
  return {
    runId: `run-${index}`,
    featureId: `feat-${index}`,
    descriptionPreview: `preview for run ${index}`,
    terminalStatus: 'completed',
    startedAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
    completedAt: new Date(1_700_000_000_500 + index * 1_000).toISOString(),
    durationMs: 500,
    lastErrorSummary: null,
    auditLogPointer: `runId:run-${index}`
  } as PersistedHistoryEntry;
}

describe('SnapshotTransport & History Memoization (FR-R5-F12)', () => {
  it('defines explicit byte budgets in snapshot-bounds contract', () => {
    expect(ROUTINE_SNAPSHOT_BYTE_BUDGET).toBe(524_288);
    expect(FULL_RESYNC_SNAPSHOT_BYTE_CEILING).toBe(1_048_576);
    expect(SUPPRESSIBLE_SNAPSHOT_SLICES).toContain('history');
    expect(SUPPRESSIBLE_SNAPSHOT_SLICES).toContain('phaseCatalog');
  });

  it('memoizes HistoryStore.list() and projectHistory() across calls until history changes', async () => {
    const store = new WorkspaceStateStore(new LocalMemento());
    await store.initialize();
    const historyStore = new HistoryStore(store);

    await store.appendHistory(DEFAULT_QUEUE_ID, makeHistoryEntry(1));
    await store.appendHistory(DEFAULT_QUEUE_ID, makeHistoryEntry(2));

    const firstList = historyStore.list();
    const secondList = historyStore.list();
    expect(secondList).toBe(firstList);

    const firstProjected = projectHistory(historyStore);
    const secondProjected = projectHistory(historyStore);
    expect(secondProjected).toBe(firstProjected);
    expect(firstProjected).toHaveLength(2);

    // Appending a new history entry invalidates the cache and produces a fresh frozen array
    await store.appendHistory(DEFAULT_QUEUE_ID, makeHistoryEntry(3));
    const thirdProjected = projectHistory(historyStore);
    expect(thirdProjected).not.toBe(firstProjected);
    expect(thirdProjected).toHaveLength(3);
    expect(thirdProjected[0]?.runId).toBe('run-3');
  });

  it('delivers mode="full" on first post and omits unchanged slices on mode="routine"', () => {
    const transport = new SnapshotTransport();
    const history = Object.freeze([
      Object.freeze({
        runId: 'run-1',
        featureId: 'feat-1',
        descriptionPreview: 'done',
        terminalStatus: 'completed' as const,
        startedAt: '2026-11-06T00:00:00.000Z',
        completedAt: '2026-11-06T00:00:01.000Z',
        durationMs: 1000,
        lastErrorSummary: null,
        auditLogPointer: 'runId:run-1',
        queueId: DEFAULT_QUEUE_ID
      })
    ]);

    const snap1 = makeSnapshot({ history, producedAt: '2026-11-06T00:00:01.000Z' });
    const post1 = transport.preparePost(snap1);
    expect(post1.sync).toEqual({ mode: 'full', revision: 1 });
    expect((post1.message.payload as WorkflowSnapshot).history).toBe(history);

    // Tick 2: only producedAt changes; history, catalogs, and tails are unchanged
    const snap2 = makeSnapshot({ history, producedAt: '2026-11-06T00:00:02.000Z' });
    const post2 = transport.preparePost(snap2);
    expect(post2.sync.mode).toBe('routine');
    expect(post2.sync.revision).toBe(2);
    expect(post2.sync.baseRevision).toBe(1);
    expect(post2.sync.omittedSlices).toContain('history');
    expect('history' in (post2.message.payload as Record<string, unknown>)).toBe(false);

    // Tick 3: history changes (restored/appended entry) -> history is included on the wire
    const updatedHistory = Object.freeze([
      ...history,
      Object.freeze({
        ...history[0],
        runId: 'run-2'
      })
    ]);
    const snap3 = makeSnapshot({ history: updatedHistory, producedAt: '2026-11-06T00:00:03.000Z' });
    const post3 = transport.preparePost(snap3);
    expect(post3.sync.mode).toBe('routine');
    expect(post3.sync.revision).toBe(3);
    expect(post3.sync.baseRevision).toBe(2);
    expect(post3.sync.omittedSlices).not.toContain('history');
    expect((post3.message.payload as WorkflowSnapshot).history).toBe(updatedHistory);
  });

  it('includes catalog slice when catalog changes and forces full snapshot after markFailed or forceFullResync', () => {
    const transport = new SnapshotTransport();
    const snap1 = makeSnapshot({
      availablePhases: Object.freeze([{ id: 'p1', name: 'Phase 1', instruction: 'i', loopable: false }])
    });
    const p1 = transport.preparePost(snap1);
    expect(p1.sync.mode).toBe('full');

    // Catalog change: availablePhases updated
    const snap2 = makeSnapshot({
      availablePhases: Object.freeze([
        { id: 'p1', name: 'Phase 1', instruction: 'i', loopable: false },
        { id: 'p2', name: 'Phase 2', instruction: 'i2', loopable: false }
      ])
    });
    const p2 = transport.preparePost(snap2);
    expect(p2.sync.mode).toBe('routine');
    expect(p2.sync.omittedSlices).not.toContain('availablePhases');
    expect((p2.message.payload as WorkflowSnapshot).availablePhases).toHaveLength(2);

    // Simulate post failure -> next post must be mode: 'full'
    p2.markFailed();
    const p3 = transport.preparePost(snap2);
    expect(p3.sync).toEqual({ mode: 'full', revision: 3 });
    expect((p3.message.payload as WorkflowSnapshot).history).toBeDefined();
  });

  it('SidebarViewProvider forces full resync on reveal and responds to SNAPSHOT_RESYNC_REQUEST', async () => {
    const projector = new FakeProjector(makeSnapshot({ producedAt: '2026-11-06T00:00:00.000Z' }));
    const logger = new SanitizedLogger();
    const warnSpy = vi.spyOn(logger, 'warn');
    const provider = new SidebarViewProvider({
      extensionRoot: '/nonexistent',
      projector,
      logger
    });

    const posts: Array<{ type: string; payload: unknown; sync?: { mode: string; revision: number } }> = [];
    let inboundHandler: ((raw: unknown) => void) | null = null;
    const visibilityListeners = new Set<() => void>();
    const fakeView = {
      visible: true,
      webview: {
        cspSource: 'vscode-webview://test',
        html: '',
        options: {},
        asWebviewUri: (u: { fsPath: string }) => ({ toString: () => u.fsPath }),
        postMessage: vi.fn(async (msg: { type: string; payload: unknown; sync?: { mode: string; revision: number } }) => {
          posts.push(msg);
          return true;
        }),
        onDidReceiveMessage: (fn: (raw: unknown) => void) => {
          inboundHandler = fn;
          return { dispose: () => undefined };
        }
      },
      onDidChangeVisibility: (fn: () => void) => {
        visibilityListeners.add(fn);
        return { dispose: () => visibilityListeners.delete(fn) };
      },
      onDidDispose: () => ({ dispose: () => undefined })
    };

    await provider.resolveWebviewView(
      fakeView as unknown as vscode.WebviewView,
      {} as vscode.WebviewViewResolveContext,
      {} as vscode.CancellationToken
    );
    await Promise.resolve();

    expect(posts).toHaveLength(1);
    expect(posts[0]?.sync).toEqual({ mode: 'full', revision: 1 });

    // Second emission while visible -> routine update
    projector.emit(makeSnapshot({ producedAt: '2026-11-06T00:00:01.000Z' }));
    await Promise.resolve();
    expect(posts).toHaveLength(2);
    expect(posts[1]?.sync?.mode).toBe('routine');
    expect(posts[1]?.sync?.revision).toBe(2);

    // Hide -> emit -> reveal -> must post mode: 'full'
    fakeView.visible = false;
    for (const fn of visibilityListeners) fn();
    projector.emit(makeSnapshot({ producedAt: '2026-11-06T00:00:02.000Z' }));
    await Promise.resolve();
    expect(posts).toHaveLength(2);

    fakeView.visible = true;
    for (const fn of visibilityListeners) fn();
    await Promise.resolve();
    expect(posts).toHaveLength(3);
    expect(posts[2]?.sync).toEqual({ mode: 'full', revision: 3 });

    // Routine emission after reveal -> mode: 'routine'
    projector.emit(makeSnapshot({ producedAt: '2026-11-06T00:00:03.000Z' }));
    await Promise.resolve();
    expect(posts).toHaveLength(4);
    expect(posts[3]?.sync?.mode).toBe('routine');

    // Webview sends SNAPSHOT_RESYNC_REQUEST -> host immediately replies with mode: 'full' and logs no warning
    inboundHandler?.({ type: SNAPSHOT_RESYNC_REQUEST, lastRevision: 1 });
    await Promise.resolve();
    expect(posts).toHaveLength(5);
    expect(posts[4]?.sync).toEqual({ mode: 'full', revision: 5 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('DashboardPanel responds to SNAPSHOT_RESYNC_REQUEST and forces full resync on view state reveal', async () => {
    DashboardPanel.__resetForTests();
    mocks.panels.length = 0;
    mocks.createWebviewPanel.mockImplementation(() => {
      const viewStateListeners: Array<() => void> = [];
      const panel = {
        webview: {
          html: '',
          options: {},
          cspSource: 'vscode-resource:',
          postMessage: vi.fn().mockResolvedValue(true),
          onDidReceiveMessage: vi.fn((fn: (raw: unknown) => void) => {
            panel.__inbound = fn;
            return { dispose: vi.fn() };
          }),
          asWebviewUri: vi.fn((u: { fsPath: string }) => ({ toString: () => u.fsPath }))
        },
        visible: true,
        active: true,
        reveal: vi.fn(),
        dispose: vi.fn(),
        onDidChangeViewState: vi.fn((fn: () => void) => {
          viewStateListeners.push(fn);
          return { dispose: vi.fn() };
        }),
        onDidDispose: vi.fn().mockReturnValue({ dispose: vi.fn() }),
        __inbound: null as ((raw: unknown) => void) | null,
        __viewStateListeners: viewStateListeners
      };
      mocks.panels.push(panel);
      return panel;
    });

    const projector = new FakeProjector(makeSnapshot({ producedAt: '2026-11-06T00:00:00.000Z' }));
    const logger = new SanitizedLogger();
    const warnSpy = vi.spyOn(logger, 'warn');
    DashboardPanel.open({
      extensionRoot: '/nonexistent',
      projector,
      dispatch: vi.fn(),
      logger
    });
    const panel = mocks.panels[0];
    if (!panel) throw new Error('expected panel');
    await Promise.resolve();

    const snapshotCalls = () =>
      panel.webview.postMessage.mock.calls
        .map((c) => c[0] as { type: string; sync?: { mode: string; revision: number } })
        .filter((m) => m.type === STATE_SNAPSHOT);

    // Constructor subscribes (post 1: full) and calls postIfVisible (post 2: routine)
    expect(snapshotCalls()[0]?.sync?.mode).toBe('full');

    panel.webview.postMessage.mockClear();
    panel.__inbound?.({ type: SNAPSHOT_RESYNC_REQUEST, lastRevision: null });
    await Promise.resolve();
    expect(snapshotCalls()).toHaveLength(1);
    expect(snapshotCalls()[0]?.sync?.mode).toBe('full');
    expect(warnSpy).not.toHaveBeenCalled();

    DashboardPanel.__resetForTests();
  });
});
