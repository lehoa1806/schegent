import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    workspaceFolders: undefined as readonly { uri: { fsPath: string } }[] | undefined,
    listeners: new Set<(event: { added: readonly unknown[]; removed: readonly unknown[] }) => void | Promise<void>>(),
    registerWebviewViewProvider: vi.fn((..._args: unknown[]) => ({ dispose: vi.fn() })),
    registerCommand: vi.fn((..._args: unknown[]) => ({ dispose: vi.fn() })),
    showErrorMessage: vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
    showInformationMessage: vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
    showWarningMessage: vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
    executeCommand: vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
    createOutputChannelDispose: vi.fn(),
    createStatusBarItemDispose: vi.fn()
  };
  return { state };
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

import { activate } from '../../../src/extension';
// Feature 058 — the canonical-folder picker memoizes its first read for the
// process lifetime, so tests that run `activate(...)` multiple times need to
// flush the cache between cases. The picker's dispose is idempotent.
import { disposeWorkspaceFolderPicker } from '../../../src/state/workspace-folder-picker';
// Feature 058 — the activation guard is one-shot per activation; reset it
// so each test case exercises the predicate independently.
import { resetMultiRootWarningGuardForTest } from '../../../src/state/multi-root-warning';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createDiskOwnershipFs } from '../../../src/state/ownership-fs';
import { OwnershipRegistry, PRIMACY_RESOURCE } from '../../../src/state/ownership-registry';
import { STALENESS_THRESHOLD_MS } from '../../../src/state/lock';

/** The workspace every activation in this file opens. */
const WORKSPACE_ROOT = '/tmp/ws';

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
  const context = {
    subscriptions,
    workspaceState: memento,
    extensionUri: { fsPath: '/tmp/ext-root', scheme: 'file', path: '/tmp/ext-root' },
    extensionPath: '/tmp/ext-root',
    asAbsolutePath: (p: string) => `/tmp/ext-root/${p}`,
    globalState: memento,
    globalStorageUri: { fsPath: '/tmp/global-storage', scheme: 'file', path: '/tmp/global-storage' },
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
  // Feature FR-R3-003 — ownership records live on disk under the workspace, not
  // in the `Memento`, so unlike every other line above they outlive the process.
  // Each `activate()` below is a separate simulated window that never reaches
  // `dispose()`, so its primacy claim stays validly held: without this, the
  // second activation in the file is correctly refused, and the file's outcome
  // would depend on its own history and on whether 15 s of staleness had elapsed.
  await fs.rm(path.join(WORKSPACE_ROOT, '.schegent', 'ownership'), {
    recursive: true,
    force: true
  });
  // Feature 099 (T496f) — flushed AFTER the await, not before it. The prior
  // case's activation is still alive by design (see the note above), and its
  // in-flight async work reads the picker; a flush that happens before an
  // `await` leaves a window in which one of those reads re-populates the cache
  // with the `undefined` this line just set two statements above. The next case
  // then sets its folder, calls `activate`, and reads a cache that was already
  // populated — so stage 2 silently never wires. Flushing last leaves no such
  // window. Nothing about the picker's own contract changes: its cache is
  // invalidated by `onDidChangeWorkspaceFolders` in the product, and this file
  // clears that listener set rather than firing it.
  disposeWorkspaceFolderPicker();
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
    mocks.state.workspaceFolders = [{ uri: { fsPath: '/tmp/ws' } }];
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

    mocks.state.workspaceFolders = [{ uri: { fsPath: '/tmp/ws' } }];
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
    mocks.state.workspaceFolders = [{ uri: { fsPath: '/tmp/ws' } }];
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
    mocks.state.workspaceFolders = [{ uri: { fsPath: '/tmp/ws' } }];
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
    mocks.state.workspaceFolders = [{ uri: { fsPath: '/tmp/ws' } }];
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
    mocks.state.workspaceFolders = [{ uri: { fsPath: WORKSPACE_ROOT } }];
    const fresh = Date.now() - 1_000; // well within the 15s threshold
    const otherOwner = 'schegent-other-pid-cafebabe';
    const ownershipDir = path.join(WORKSPACE_ROOT, '.schegent', 'ownership');
    const incumbent = new OwnershipRegistry(createDiskOwnershipFs(ownershipDir), ownershipDir);
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
});
