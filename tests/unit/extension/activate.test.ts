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

beforeEach(() => {
  mocks.state.registerWebviewViewProvider.mockClear();
  mocks.state.registerCommand.mockClear();
  mocks.state.showErrorMessage.mockClear();
  mocks.state.executeCommand.mockClear();
  mocks.state.createOutputChannelDispose.mockClear();
  mocks.state.createStatusBarItemDispose.mockClear();
  mocks.state.listeners.clear();
  mocks.state.workspaceFolders = undefined;
});

describe('activate() — BUG-001 activation invariant', () => {
  it('(a) registers SidebarViewProvider exactly once when no workspace folder is open', async () => {
    mocks.state.workspaceFolders = undefined;
    const { context } = buildContext();

    await activate(context as Parameters<typeof activate>[0]);

    expect(mocks.state.registerWebviewViewProvider).toHaveBeenCalledTimes(1);
    expect(mocks.state.registerWebviewViewProvider.mock.calls[0][0]).toBe('schegent.sidebar');
    expect(mocks.state.registerCommand).not.toHaveBeenCalled();
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
    expect(mocks.state.registerCommand).not.toHaveBeenCalled();
  });

  it('(c) running stage-2 wiring after a folder is added registers commands without re-registering the sidebar', async () => {
    mocks.state.workspaceFolders = undefined;
    const { context } = buildContext();

    await activate(context as Parameters<typeof activate>[0]);
    expect(mocks.state.registerWebviewViewProvider).toHaveBeenCalledTimes(1);
    expect(mocks.state.registerCommand).not.toHaveBeenCalled();

    mocks.state.workspaceFolders = [{ uri: { fsPath: '/tmp/ws' } }];
    const handlers = Array.from(mocks.state.listeners);
    expect(handlers.length).toBeGreaterThan(0);
    await Promise.all(handlers.map((fn) => fn({ added: [], removed: [] })));

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
    await Promise.all(handlers.map((fn) => fn({ added: [], removed: [] })));

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
    mocks.state.workspaceFolders = [{ uri: { fsPath: '/tmp/ws' } }];
    const fresh = Date.now() - 1_000; // well within the 15s threshold
    const otherOwner = 'schegent-other-pid-cafebabe';
    const store = new Map<string, unknown>([
      ['schegent.schemaVersion', '1.0.0'],
      ['schegent.lock', { ownerId: otherOwner, acquiredAt: fresh, heartbeatAt: fresh }]
    ]);
    const { context } = buildContext({ mementoStore: store });

    await activate(context as Parameters<typeof activate>[0]);

    const lock = store.get('schegent.lock') as { ownerId: string } | null;
    expect(lock).not.toBeNull();
    expect(lock!.ownerId).toBe(otherOwner);
  });
});
