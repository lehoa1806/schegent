import { describe, it, expect, vi, beforeEach } from 'vitest';

const RESOURCE_SCOPED_KEYS = [
  'loop.maxIterations',
  'watchdog.pollIntervalMinutes',
  'invocation.timeoutSeconds',
  'audit.rotation.sizeMB',
  'audit.rotation.maxAgeDays',
  'rules.injectPerPhase'
] as const;

const mocks = vi.hoisted(() => {
  const state = {
    workspaceFolders: undefined as readonly { uri: { fsPath: string; scheme: string } }[] | undefined,
    listeners: new Set<(event: { added: readonly unknown[]; removed: readonly unknown[] }) => void | Promise<void>>(),
    getConfiguration: vi.fn(
      (_section?: string, _resource?: { fsPath: string; scheme: string } | null) => ({
        get: <T>(_key: string, def: T): T => def,
        inspect: <T>(_key: string) =>
          ({ workspaceValue: undefined, globalValue: undefined } as {
            workspaceValue: T | undefined;
            globalValue: T | undefined;
          })
      })
    ),
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
      getConfiguration: mocks.state.getConfiguration
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
        with: () => ({ fsPath: path, scheme: 'file' })
      }),
      joinPath: (base: { fsPath: string }, ...segments: string[]) => {
        const joined = [base.fsPath, ...segments].join('/').replace(/\/+/g, '/');
        return {
          fsPath: joined,
          scheme: 'file',
          path: joined,
          toString: () => `file://${joined}`,
          with: () => ({ fsPath: joined, scheme: 'file' })
        };
      }
    },
    StatusBarAlignment: { Left: 1, Right: 2 }
  };
});

import { activate } from '../../../src/extension';
// Feature 058 — the canonical-folder picker memoizes its first read for the
// process lifetime, so tests that run `activate(...)` multiple times need to
// flush the cache between cases. The picker's dispose is idempotent and
// no-throws.
import { disposeWorkspaceFolderPicker } from '../../../src/state/workspace-folder-picker';
// Feature 058 — the activation guard is one-shot per activation; reset it
// so the second invocation in this test file (different fixture state)
// still exercises the predicate.
import { resetMultiRootWarningGuardForTest } from '../../../src/state/multi-root-warning';

interface MockMemento {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Promise<void>;
}

function buildContext(): {
  context: unknown;
  subscriptions: { dispose: () => unknown }[];
} {
  const subscriptions: { dispose: () => unknown }[] = [];
  const store = new Map<string, unknown>();
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
  return { context, subscriptions };
}

beforeEach(() => {
  mocks.state.getConfiguration.mockClear();
  mocks.state.registerWebviewViewProvider.mockClear();
  mocks.state.registerCommand.mockClear();
  mocks.state.showErrorMessage.mockClear();
  mocks.state.executeCommand.mockClear();
  mocks.state.createOutputChannelDispose.mockClear();
  mocks.state.createStatusBarItemDispose.mockClear();
  mocks.state.listeners.clear();
  mocks.state.workspaceFolders = undefined;
  disposeWorkspaceFolderPicker();
  resetMultiRootWarningGuardForTest();
});

describe('configuration access — BUG-003 FR-039 (resource-scoped reads)', () => {
  it('(a) Stage 2 wiring calls getConfiguration with a resource URI exposing fsPath and scheme', async () => {
    mocks.state.workspaceFolders = [{ uri: { fsPath: '/tmp/ws-a', scheme: 'file' } }];
    const { context } = buildContext();

    await activate(context as Parameters<typeof activate>[0]);

    expect(mocks.state.getConfiguration).toHaveBeenCalled();
    const call = mocks.state.getConfiguration.mock.calls.find((c) => c[0] === 'schegent');
    expect(call, 'expected at least one getConfiguration("schegent", …) call').toBeDefined();
    const resource = call![1] as { fsPath?: unknown; scheme?: unknown } | undefined;
    expect(resource, 'resource argument must be defined').toBeDefined();
    expect(resource).toHaveProperty('fsPath');
    expect(resource).toHaveProperty('scheme');
    expect(typeof resource!.fsPath).toBe('string');
    expect(typeof resource!.scheme).toBe('string');
    expect(resource!.fsPath).toBe('/tmp/ws-a');
  });

  it('(b) Stage 1 (no workspace folder) does not read resource-scoped configuration', async () => {
    mocks.state.workspaceFolders = undefined;
    const { context } = buildContext();

    await activate(context as Parameters<typeof activate>[0]);

    expect(mocks.state.registerWebviewViewProvider).toHaveBeenCalledTimes(1);
    const schegentReads = mocks.state.getConfiguration.mock.calls.filter((c) => c[0] === 'schegent');
    expect(
      schegentReads,
      'Stage 1 placeholder must not read schegent configuration; it has no resource to thread'
    ).toEqual([]);
    for (const _key of RESOURCE_SCOPED_KEYS) {
      // sanity: even via a different config namespace, no resource-scoped property
      // should be fetched without a resource. Stage 1 simply must not call getConfiguration
      // at all for the schegent section.
    }
  });

  it('(c) onDidChangeWorkspaceFolders rewires Stage 2 with the new folder URI (no cached config reuse)', async () => {
    mocks.state.workspaceFolders = [{ uri: { fsPath: '/tmp/ws-first', scheme: 'file' } }];
    const { context } = buildContext();

    await activate(context as Parameters<typeof activate>[0]);
    const firstSchegentCall = mocks.state.getConfiguration.mock.calls.find((c) => c[0] === 'schegent');
    expect(firstSchegentCall).toBeDefined();
    expect((firstSchegentCall![1] as { fsPath: string }).fsPath).toBe('/tmp/ws-first');

    // Tear down: workspace closes, Stage 2 disposes.
    mocks.state.workspaceFolders = undefined;
    let handlers = Array.from(mocks.state.listeners);
    expect(handlers.length).toBeGreaterThan(0);
    await Promise.all(handlers.map((fn) => fn({ added: [], removed: [] })));

    // New workspace opens at a different path — Stage 2 must wire fresh.
    mocks.state.getConfiguration.mockClear();
    mocks.state.workspaceFolders = [{ uri: { fsPath: '/tmp/ws-second', scheme: 'file' } }];
    handlers = Array.from(mocks.state.listeners);
    expect(handlers.length).toBeGreaterThan(0);
    await Promise.all(handlers.map((fn) => fn({ added: [], removed: [] })));

    const secondSchegentCall = mocks.state.getConfiguration.mock.calls.find((c) => c[0] === 'schegent');
    expect(
      secondSchegentCall,
      'rewired Stage 2 must call getConfiguration("schegent", …) again with the new folder URI'
    ).toBeDefined();
    const secondResource = secondSchegentCall![1] as { fsPath: string };
    expect(secondResource.fsPath).toBe('/tmp/ws-second');
    expect(secondResource.fsPath).not.toBe('/tmp/ws-first');
  });
});
