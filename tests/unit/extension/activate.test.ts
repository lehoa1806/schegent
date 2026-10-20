import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

const mocks = vi.hoisted(() => {
  /**
   * FR-R3-191 (feature 218) — what the host teardown did, in order
   * (`output:dispose`, `lock:release`, `release:start`, `release:end`), and the
   * runtime log writer each activation built, so a case can read its count.
   */
  const teardown = { events: [] as string[], sinks: [] as RuntimeLogSink[] };
  const state = {
    workspaceFolders: undefined as readonly { uri: { fsPath: string } }[] | undefined,
    listeners: new Set<(event: { added: readonly unknown[]; removed: readonly unknown[] }) => void | Promise<void>>(),
    registerWebviewViewProvider: vi.fn((..._args: unknown[]) => ({ dispose: vi.fn() })),
    registerCommand: vi.fn((..._args: unknown[]) => ({ dispose: vi.fn() })),
    showErrorMessage: vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
    showInformationMessage: vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
    showWarningMessage: vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
    executeCommand: vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
    createOutputChannelDispose: vi.fn(() => {
      teardown.events.push('output:dispose');
    }),
    createStatusBarItemDispose: vi.fn()
  };
  return { state, teardown };
});

vi.mock('vscode', () => {
  const mockOutputChannel = {
    appendLine: vi.fn(),
    append: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: mocks.state.createOutputChannelDispose,
    name: 'Schegent',
    replace: vi.fn()
  };
  const mockStatusBarItem = {
    text: '',
    tooltip: '',
    command: '',
    color: undefined,
    backgroundColor: undefined,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: mocks.state.createStatusBarItemDispose,
    alignment: 1,
    priority: 100
  };
  return {
    window: {
      createOutputChannel: vi.fn(() => mockOutputChannel),
      createStatusBarItem: vi.fn(() => mockStatusBarItem),
      registerWebviewViewProvider: mocks.state.registerWebviewViewProvider,
      showErrorMessage: mocks.state.showErrorMessage,
      showInformationMessage: mocks.state.showInformationMessage,
      showWarningMessage: mocks.state.showWarningMessage
    },
    workspace: {
      get workspaceFolders() {
        return mocks.state.workspaceFolders;
      },
      onDidChangeWorkspaceFolders: (
        listener: (event: { added: readonly unknown[]; removed: readonly unknown[] }) => void | Promise<void>
      ) => {
        mocks.state.listeners.add(listener);
        return {
          dispose: () => {
            mocks.state.listeners.delete(listener);
          }
        };
      },
      // Feature 059 — capability trust resolver subscribes to these
      // two events; the unit-test mock only needs to satisfy the API
      // surface (returning a disposable no-op).
      onDidGrantWorkspaceTrust: (_listener: () => void) => ({
        dispose: () => undefined
      }),
      onDidChangeConfiguration: (
        _listener: (event: { affectsConfiguration: (key: string) => boolean }) => void
      ) => ({
        dispose: () => undefined
      }),
      isTrusted: true,
      getConfiguration: () => ({
        get: <T>(_key: string, def: T) => def,
        inspect: <T>(_key: string) =>
          ({ workspaceValue: undefined, globalValue: undefined } as {
            workspaceValue: T | undefined;
            globalValue: T | undefined;
          })
      })
    },
    commands: {
      executeCommand: mocks.state.executeCommand,
      registerCommand: mocks.state.registerCommand
    },
    Uri: {
      file: (path: string) => ({
        fsPath: path,
        scheme: 'file',
        path,
        toString: () => `file://${path}`,
        with: () => ({ fsPath: path })
      }),
      joinPath: (base: { fsPath: string }, ...segments: string[]) => {
        const joined = [base.fsPath, ...segments].join('/').replace(/\/+/g, '/');
        return {
          fsPath: joined,
          scheme: 'file',
          path: joined,
          toString: () => `file://${joined}`,
          with: () => ({ fsPath: joined })
        };
      }
    },
    StatusBarAlignment: { Left: 1, Right: 2 }
  };
});

/**
 * FR-R3-191 (feature 218) — the runtime log writer each activation builds, with
 * its release wrapped so the teardown's order can be read. The wrapper is a plain
 * function around the real release, so the descriptors close as they do in the
 * host.
 */
vi.mock('../../../src/activation/backend-wiring', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/activation/backend-wiring')>();
  return {
    ...actual,
    createRuntimeEvidenceWiring: (
      ...args: Parameters<typeof actual.createRuntimeEvidenceWiring>
    ): ReturnType<typeof actual.createRuntimeEvidenceWiring> => {
      const wiring = actual.createRuntimeEvidenceWiring(...args);
      const sink = wiring.runtimeLogSink;
      const release = sink.flushAndDispose.bind(sink);
      sink.flushAndDispose = async (): Promise<void> => {
        mocks.teardown.events.push('release:start');
        await release();
        mocks.teardown.events.push('release:end');
      };
      mocks.teardown.sinks.push(sink);
      return wiring;
    }
  };
});

import * as vscode from 'vscode';
import { activate, deactivate } from '../../../src/extension';
import type { RuntimeLogSink } from '../../../src/lib/runtime-log/runtime-log-sink';
// Feature 058 — the canonical-folder picker memoizes its first read for the
// process lifetime, so tests that run `activate(...)` multiple times need to
// flush the cache between cases. The picker's dispose is idempotent.
import { disposeWorkspaceFolderPicker } from '../../../src/state/workspace-folder-picker';
// Feature 058 — the activation guard is one-shot per activation; reset it
// so each test case exercises the predicate independently.
import { resetMultiRootWarningGuardForTest } from '../../../src/state/multi-root-warning';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDiskOwnershipFs } from '../../../src/state/ownership-fs';
import { OwnershipRegistry, PRIMACY_RESOURCE } from '../../../src/state/ownership-registry';
import { STALENESS_THRESHOLD_MS, WorkspaceLockManager } from '../../../src/state/lock';
import { expectNoDescriptorWarnings } from '../../setup/descriptor-warnings';

/**
 * FR-R3-191 — the case's own folder, made by `beforeEach` under the run's temp
 * root, and the workspace inside it that every activation in the case opens.
 */
let caseRoot = '';
let workspaceRoot = '';

interface MockMemento {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Promise<void>;
}

function buildContext(overrides: { mementoStore?: Map<string, unknown> } = {}): {
  context: unknown;
  subscriptions: { dispose: () => unknown }[];
  store: Map<string, unknown>;
} {
  const subscriptions: { dispose: () => unknown }[] = [];
  const store = overrides.mementoStore ?? new Map<string, unknown>();
  const memento: MockMemento = {
    get: <T>(key: string, def?: T): T | undefined => {
      if (store.has(key)) return store.get(key) as T;
      return def;
    },
    update: async (key: string, value: unknown) => {
      if (value === undefined) {
        store.delete(key);
      } else {
        store.set(key, value);
      }
    }
  } as MockMemento;
  // Paths only: nothing here creates either folder.
  const extRoot = path.join(caseRoot, 'ext-root');
  const globalStorage = path.join(caseRoot, 'global-storage');
  const context = {
    subscriptions,
    workspaceState: memento,
    extensionUri: { fsPath: extRoot, scheme: 'file', path: extRoot },
    extensionPath: extRoot,
    asAbsolutePath: (p: string) => path.join(extRoot, p),
    globalState: memento,
    globalStorageUri: { fsPath: globalStorage, scheme: 'file', path: globalStorage },
    secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn(), onDidChange: vi.fn() }
  };
  return { context, subscriptions, store };
}

beforeEach(async () => {
  mocks.state.registerWebviewViewProvider.mockClear();
  mocks.state.registerCommand.mockClear();
  mocks.state.showErrorMessage.mockClear();
  mocks.state.executeCommand.mockClear();
  mocks.state.createOutputChannelDispose.mockClear();
  mocks.state.createStatusBarItemDispose.mockClear();
  mocks.state.listeners.clear();
  mocks.state.workspaceFolders = undefined;
  resetMultiRootWarningGuardForTest();
  // FR-R3-191 — a new folder per case, under the run's temp root, which the
  // global setup points `os.tmpdir()` at and removes at teardown. Ownership
  // records live on disk under the workspace, not in the `Memento`, so they
  // outlive the case that wrote them: a case that opened an earlier case's
  // workspace would find that case's primacy claim still validly held. Each
  // case's workspace is new, so there is no claim in it and nothing to clear.
  caseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-activate-'));
  workspaceRoot = path.join(caseRoot, 'ws');
  // FR-R3-069 — the ownership adapter's judgments anchor at the workspace
  // root, which therefore must EXIST (in production a VS Code workspace folder
  // does by definition). The mocked folder here is only a path, so create it.
  await fs.mkdir(workspaceRoot);
  // Feature 099 (T496f) — flushed last, after the `await`s above. It was put
  // last because the prior case's activation stayed alive, and its in-flight
  // work read the picker: a flush before an `await` let that work refill the
  // cache, and the next case's Stage 2 silently never wired. Since FR-R3-191
  // the `afterEach` deactivates each case's activation, so that premise no
  // longer holds. The flush stays, and stays last, because a `deactivate()`
  // that rejects skips `disposeWorkspaceFolderPicker()`. Nothing about the
  // picker's own contract changes: its cache is invalidated by
  // `onDidChangeWorkspaceFolders` in the product, and this file clears that
  // listener set rather than firing it.
  disposeWorkspaceFolderPicker();
});

/**
 * FR-R3-191 (feature 218) — the host-teardown cases' spy on the lock release,
 * and the error it throws when a case sets one (US2-6).
 */
let lockRelease: { mockRestore(): void } | undefined;
let lockFailure: Error | undefined;

afterEach(async () => {
  // Restored first, so nothing that runs after a case goes through a lock
  // release that throws.
  lockRelease?.mockRestore();
  lockRelease = undefined;
  try {
    // FR-R3-191 (FR-016) — the case's activation goes through the host's
    // deactivation, as a window's does. After a case that already deactivated,
    // there is nothing left to tear down.
    await deactivate();
    // No runtime log writer this case's activations built holds a descriptor
    // once the case is over.
    const open = mocks.teardown.sinks.map((sink) => sink.openDescriptorCount);
    expect(open, 'a writer this case built still holds a descriptor').toEqual(open.map(() => 0));
  } finally {
    // Cleared even when the check fails, so the next case starts empty.
    mocks.teardown.events = [];
    mocks.teardown.sinks = [];
  }
});

// FR-R3-191 (FR-017) — the file disposes what it creates, so it opts in to the
// descriptor detector.
afterAll(() => {
  expectNoDescriptorWarnings();
});

describe('activate() — BUG-001 activation invariant', () => {
  it('(a) registers SidebarViewProvider exactly once when no workspace folder is open', async () => {
    mocks.state.workspaceFolders = undefined;
    const { context } = buildContext();

    await activate(context as Parameters<typeof activate>[0]);

    expect(mocks.state.registerWebviewViewProvider).toHaveBeenCalledTimes(1);
    expect(mocks.state.registerWebviewViewProvider.mock.calls[0][0]).toBe('schegent.sidebar');
    expect(mocks.state.registerCommand).toHaveBeenCalledTimes(1);
    expect(mocks.state.registerCommand.mock.calls[0][0]).toBe('schegent.reset');
  });

  it('(b) registers SidebarViewProvider exactly once when store.initialize() rejects', async () => {
    mocks.state.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
    const incompatibleStore = new Map<string, unknown>([['schegent.schemaVersion', '99.0.0']]);
    const { context } = buildContext({ mementoStore: incompatibleStore });

    await activate(context as Parameters<typeof activate>[0]);

    expect(mocks.state.registerWebviewViewProvider).toHaveBeenCalledTimes(1);
    expect(mocks.state.registerWebviewViewProvider.mock.calls[0][0]).toBe('schegent.sidebar');
    expect(mocks.state.showErrorMessage).toHaveBeenCalledOnce();
    expect(mocks.state.showErrorMessage.mock.calls[0][0]).toMatch(/Schegent/);
    expect(mocks.state.registerCommand).toHaveBeenCalledTimes(1);
    expect(mocks.state.registerCommand.mock.calls[0][0]).toBe('schegent.reset');
  });

  it('(c) running stage-2 wiring after a folder is added registers commands without re-registering the sidebar', async () => {
    mocks.state.workspaceFolders = undefined;
    const { context } = buildContext();

    await activate(context as Parameters<typeof activate>[0]);
    expect(mocks.state.registerWebviewViewProvider).toHaveBeenCalledTimes(1);
    expect(mocks.state.registerCommand).toHaveBeenCalledTimes(1);
    expect(mocks.state.registerCommand.mock.calls[0][0]).toBe('schegent.reset');

    mocks.state.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
    const handlers = Array.from(mocks.state.listeners);
    expect(handlers.length).toBeGreaterThan(0);
    await Promise.all(handlers.map(async (fn) => fn({ added: [], removed: [] })));

    expect(mocks.state.registerWebviewViewProvider).toHaveBeenCalledTimes(1);
    expect(mocks.state.registerCommand.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining([
        'schegent.auto',
        'schegent.schedule',
        'schegent.resume',
        'schegent.cancel',
        'schegent.reset',
        'schegent.showAuditLog'
      ])
    );
  });

  it('(d) tearing down stage-2 when the last folder is removed disposes stage-2 components but keeps the sidebar registered', async () => {
    mocks.state.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
    const { context } = buildContext();

    await activate(context as Parameters<typeof activate>[0]);
    expect(mocks.state.registerWebviewViewProvider).toHaveBeenCalledTimes(1);
    expect(mocks.state.registerCommand).toHaveBeenCalled();

    const statusBarDisposeCallsBefore = mocks.state.createStatusBarItemDispose.mock.calls.length;
    const outputDisposeCallsBefore = mocks.state.createOutputChannelDispose.mock.calls.length;

    mocks.state.workspaceFolders = undefined;
    const handlers = Array.from(mocks.state.listeners);
    expect(handlers.length).toBeGreaterThan(0);
    await Promise.all(handlers.map(async (fn) => fn({ added: [], removed: [] })));

    expect(mocks.state.registerWebviewViewProvider).toHaveBeenCalledTimes(1);
    expect(mocks.state.createStatusBarItemDispose.mock.calls.length).toBeGreaterThan(
      statusBarDisposeCallsBefore
    );
    expect(mocks.state.createOutputChannelDispose.mock.calls.length).toBeGreaterThan(
      outputDisposeCallsBefore
    );
  });
});

describe('activate() — Stage 2 workspace lock reclaim (BUG-005)', () => {
  it('reclaims a stale workspace lock left by a prior process when no run is persisted', async () => {
    mocks.state.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
    const stale = Date.now() - 60_000; // far past the 15s threshold
    const store = new Map<string, unknown>([
      ['schegent.schemaVersion', '1.0.0'],
      [
        'schegent.lock',
        { ownerId: 'schegent-old-pid-deadbeef', acquiredAt: stale, heartbeatAt: stale }
      ]
    ]);
    const { context } = buildContext({ mementoStore: store });

    await activate(context as Parameters<typeof activate>[0]);

    const lock = store.get('schegent.lock') as { ownerId: string } | null;
    expect(lock).not.toBeNull();
    expect(lock!.ownerId).toMatch(/^schegent-/);
    expect(lock!.ownerId).not.toBe('schegent-old-pid-deadbeef');
  });

  it('acquires the workspace lock on Stage 2 even when no lock and no run are persisted', async () => {
    mocks.state.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
    const store = new Map<string, unknown>([['schegent.schemaVersion', '1.0.0']]);
    const { context } = buildContext({ mementoStore: store });

    await activate(context as Parameters<typeof activate>[0]);

    const lock = store.get('schegent.lock') as { ownerId: string } | null;
    expect(lock).not.toBeNull();
    expect(lock!.ownerId).toMatch(/^schegent-/);
  });

  it('does not reclaim when another window holds a fresh workspace lock', async () => {
    // Feature FR-R3-003 — the incumbent is seeded where primacy is now decided:
    // the fenced record under the workspace, not `schegent.lock`. Seeding only
    // the `Memento` no longer expresses "another window holds it", because a
    // `Memento` is a per-extension-host cache — the other window's entry would
    // never appear in this one's, which is the finding this feature closes. The
    // mirror is seeded too, so the assertion can show it was left untouched.
    mocks.state.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
    const fresh = Date.now() - 1_000; // well within the 15s threshold
    const otherOwner = 'schegent-other-pid-cafebabe';
    const ownershipDir = path.join(workspaceRoot, '.schegent', 'ownership');
    const incumbent = new OwnershipRegistry(
      createDiskOwnershipFs({ workspaceRoot, ownershipDir }),
      ownershipDir
    );
    expect(
      (await incumbent.acquire(PRIMACY_RESOURCE, otherOwner, fresh, STALENESS_THRESHOLD_MS))
        .outcome
    ).toBe('acquired');
    const store = new Map<string, unknown>([
      ['schegent.schemaVersion', '1.0.0'],
      ['schegent.lock', { ownerId: otherOwner, acquiredAt: fresh, heartbeatAt: fresh }]
    ]);
    const { context } = buildContext({ mementoStore: store });

    await activate(context as Parameters<typeof activate>[0]);

    const lock = store.get('schegent.lock') as { ownerId: string } | null;
    expect(lock).not.toBeNull();
    expect(lock!.ownerId).toBe(otherOwner);
    // And the incumbent still holds the record it was granted.
    const record = await incumbent.read(PRIMACY_RESOURCE);
    expect(record?.holder?.ownerId).toBe(otherOwner);
  });

  it('FR-R3-070 — a non-primary window installs no recovery and resumes nothing', async () => {
    // Same incumbent seeding as above; what is asserted is the other half of
    // elect-before-recovering: losing the election means every recovery
    // installer declines — no scheduled-start re-arm, no watchdog reattach, no
    // delayed-retry re-arm, no persisted-run resume. The observable is the
    // activation log, which is where each installer records its decline.
    mocks.state.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
    const fresh = Date.now() - 1_000;
    const otherOwner = 'schegent-other-pid-cafebabe';
    const ownershipDir = path.join(workspaceRoot, '.schegent', 'ownership');
    const incumbent = new OwnershipRegistry(
      createDiskOwnershipFs({ workspaceRoot, ownershipDir }),
      ownershipDir
    );
    expect(
      (await incumbent.acquire(PRIMACY_RESOURCE, otherOwner, fresh, STALENESS_THRESHOLD_MS))
        .outcome
    ).toBe('acquired');
    const store = new Map<string, unknown>([
      ['schegent.schemaVersion', '1.0.0'],
      ['schegent.lock', { ownerId: otherOwner, acquiredAt: fresh, heartbeatAt: fresh }]
    ]);
    const { context } = buildContext({ mementoStore: store });
    // The mock returns one shared channel object, so this handle sees every
    // line the activation's logger writes.
    const channel = vscode.window.createOutputChannel('probe') as unknown as {
      appendLine: ReturnType<typeof vi.fn>;
    };
    const before = channel.appendLine.mock.calls.length;

    await activate(context as Parameters<typeof activate>[0]);

    const lines = channel.appendLine.mock.calls
      .slice(before)
      .map((call) => String(call[0]))
      .join('\n');
    for (const declined of [
      'scheduled-start re-arm skipped: window is not primary',
      'watchdog reattach skipped: window is not primary',
      'delayed-retry re-arm skipped: window is not primary'
    ]) {
      expect(lines).toContain(declined);
    }
    expect(lines).not.toContain('activation: resuming run');
  });
});

/**
 * FR-R3-191 (feature 218) — the host teardown releases the runtime log writer.
 *
 * The writer is built in Stage 1 and outlives every folder change, so the host
 * teardown is the one place that can release it. Two paths reach that teardown:
 * `deactivate()`, which awaits it, and the subscription entry, which cannot.
 * Every case reads the writer's own descriptor count.
 */
describe('activate() — the host teardown releases the runtime log writer (FR-R3-191)', () => {
  const PROBE_LINE = 'FR-R3-191 host teardown probe';
  const DEACTIVATED = 'deactivated';
  /** The real release, read before any case replaces it. */
  const releaseLock = WorkspaceLockManager.prototype.release;

  beforeEach(() => {
    lockFailure = undefined;
    lockRelease = vi
      .spyOn(WorkspaceLockManager.prototype, 'release')
      .mockImplementation(async function (this: WorkspaceLockManager): Promise<void> {
        // The real release first, so the heartbeat stops even in a case that throws.
        await releaseLock.call(this);
        mocks.teardown.events.push('lock:release');
        if (lockFailure) throw lockFailure;
      });
  });

  /** The runtime log writer the latest activation built. */
  function latestSink(): RuntimeLogSink {
    const sink = mocks.teardown.sinks.at(-1);
    if (sink === undefined) throw new Error('the activation built no runtime log writer');
    return sink;
  }

  /**
   * Activate with the case's folder open and write one line, so the writer holds
   * a descriptor the teardown has to close.
   */
  async function activateWithLine(): Promise<{
    sink: RuntimeLogSink;
    subscriptions: { dispose: () => unknown }[];
  }> {
    mocks.state.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
    const { context, subscriptions } = buildContext();
    await activate(context as Parameters<typeof activate>[0]);
    const sink = latestSink();
    sink.appendLine(PROBE_LINE);
    await sink.flushPendingWrites();
    expect(sink.openDescriptorCount, 'the writer must hold a descriptor first').toBeGreaterThanOrEqual(1);
    return { sink, subscriptions };
  }

  /** `deactivate()`, recording the moment it resolves among the teardown's events. */
  function deactivateMarked(): Promise<void> {
    return deactivate().then(() => {
      mocks.teardown.events.push(DEACTIVATED);
    });
  }

  /** The writer's release events since `mark`, and the moment `deactivate()` resolved. */
  function releaseOrder(mark: number): string[] {
    return mocks.teardown.events
      .slice(mark)
      .filter((event) => event.startsWith('release:') || event === DEACTIVATED);
  }

  it('US2-1 — `deactivate` releases the writer the activation built', async () => {
    const { sink } = await activateWithLine();

    await deactivate();

    expect({
      open: sink.openDescriptorCount,
      releases: mocks.teardown.events.filter((event) => event === 'release:start').length
    }).toEqual({ open: 0, releases: 1 });
  });

  it('US2-2 — removing the last folder leaves the writer to the host teardown', async () => {
    const { sink } = await activateWithLine();
    const mark = mocks.teardown.events.length;

    mocks.state.workspaceFolders = undefined;
    const handlers = Array.from(mocks.state.listeners);
    await Promise.all(handlers.map(async (fn) => fn({ added: [], removed: [] })));

    // Stage 2 is gone (its lock was released); the writer is Stage 1's and stays.
    expect(mocks.teardown.events.slice(mark)).toContain('lock:release');
    expect(releaseOrder(mark), 'a folder change must not release the writer').toEqual([]);

    const removed = mocks.teardown.events.length;
    await deactivateMarked();
    expect(releaseOrder(removed)).toEqual(['release:start', 'release:end', DEACTIVATED]);
    expect(sink.openDescriptorCount).toBe(0);
  });

  it('US2-3 — whichever path fires first, the writer is released once and `deactivate` waits for it', async () => {
    // The subscription entry first, then `deactivate()`.
    const first = await activateWithLine();
    const firstMark = mocks.teardown.events.length;
    for (const entry of first.subscriptions) entry.dispose();
    await deactivateMarked();
    expect(releaseOrder(firstMark)).toEqual(['release:start', 'release:end', DEACTIVATED]);
    expect(first.sink.openDescriptorCount).toBe(0);

    // `deactivate()` first, then the subscription entry while it is in flight.
    const second = await activateWithLine();
    const secondMark = mocks.teardown.events.length;
    const deactivating = deactivateMarked();
    for (const entry of second.subscriptions) entry.dispose();
    await deactivating;
    expect(releaseOrder(secondMark)).toEqual(['release:start', 'release:end', DEACTIVATED]);
    expect(second.sink.openDescriptorCount).toBe(0);
  });

  it('US2-4 — with no folder open, the host teardown still releases the writer', async () => {
    mocks.state.workspaceFolders = undefined;
    const { context } = buildContext();
    await activate(context as Parameters<typeof activate>[0]);
    const sink = latestSink();
    const mark = mocks.teardown.events.length;

    await deactivateMarked();

    expect(mocks.teardown.events.slice(mark)).toEqual(['release:start', 'release:end', DEACTIVATED]);
    expect(sink.openDescriptorCount).toBe(0);
  });

  it('US2-5 — the writer is released after the Stage 2 teardown and before the host disposes its output', async () => {
    await activateWithLine();
    const mark = mocks.teardown.events.length;

    await deactivateMarked();

    expect(mocks.teardown.events.slice(mark)).toEqual([
      'output:dispose', // Stage 2's own disposables
      'lock:release',
      'release:start',
      'release:end',
      'output:dispose', // the host's, once the release has settled
      DEACTIVATED
    ]);
  });

  it('US2-6 — a Stage 2 teardown that rejects still releases the writer, and `deactivate` rejects with it', async () => {
    const { sink } = await activateWithLine();
    const failure = new Error('the lock release failed');
    lockFailure = failure;
    const mark = mocks.teardown.events.length;

    await expect(deactivate()).rejects.toBe(failure);

    // No host `output:dispose`: the rejection leaves the teardown after the release.
    expect(mocks.teardown.events.slice(mark)).toEqual([
      'output:dispose',
      'lock:release',
      'release:start',
      'release:end'
    ]);
    expect(sink.openDescriptorCount).toBe(0);
  });

  it('US2-7 — each activation tears down only itself, once', async () => {
    const first = await activateWithLine();
    await deactivate();
    const repeated = mocks.teardown.events.length;
    await deactivate();
    expect(mocks.teardown.events.slice(repeated), 'a repeated `deactivate` starts nothing').toEqual([]);

    const second = await activateWithLine();
    const late = mocks.teardown.events.length;
    for (const entry of first.subscriptions) entry.dispose();
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        resolve();
      });
    });
    expect(
      mocks.teardown.events.slice(late),
      "the first activation's entry must not tear down the second"
    ).toEqual([]);

    await deactivateMarked();
    expect(mocks.teardown.events.slice(late)).toEqual([
      'output:dispose',
      'lock:release',
      'release:start',
      'release:end',
      'output:dispose',
      DEACTIVATED
    ]);
    expect(second.sink).not.toBe(first.sink);
    expect(second.sink.openDescriptorCount).toBe(0);
  });

  it("US2-7 — a first teardown that settles after the second activation began leaves the second's in place", async () => {
    const first = await activateWithLine();
    // The first writer's release is held, so the first teardown is still running
    // when the second activation publishes its own. The first clears the published
    // teardown only once that release settles, and must then leave the second's.
    let reachRelease: () => void = () => undefined;
    const releaseReached = new Promise<void>((resolve) => {
      reachRelease = resolve;
    });
    let openRelease: () => void = () => undefined;
    const releaseOpened = new Promise<void>((resolve) => {
      openRelease = resolve;
    });
    const release = first.sink.flushAndDispose.bind(first.sink);
    let firstReleased = Promise.resolve();
    first.sink.flushAndDispose = (): Promise<void> => {
      reachRelease();
      firstReleased = releaseOpened.then(release);
      return firstReleased;
    };
    let second: Awaited<ReturnType<typeof activateWithLine>>;
    try {
      for (const entry of first.subscriptions) entry.dispose();
      await releaseReached;
      second = await activateWithLine();
    } finally {
      // Opened even when a step above fails: the first teardown waits on this
      // gate, and the `afterEach` waits on the first teardown until the second
      // activation publishes its own.
      openRelease();
    }
    await firstReleased;
    // One turn more, for the rest of the first teardown after its release.
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        resolve();
      });
    });
    expect(first.sink.openDescriptorCount).toBe(0);

    const mark = mocks.teardown.events.length;
    await deactivateMarked();
    expect(releaseOrder(mark), "the first teardown must not clear the second's").toEqual([
      'release:start',
      'release:end',
      DEACTIVATED
    ]);
    expect(second.sink.openDescriptorCount).toBe(0);
  });
});
