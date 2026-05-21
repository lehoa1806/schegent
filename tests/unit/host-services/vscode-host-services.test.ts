import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  type Listener = () => void;
  const config = {
    get: vi.fn(<T>(_key: string, defaultValue: T): T => defaultValue),
    inspect: vi.fn(<T>(_key: string) => ({ workspaceValue: undefined as T | undefined })),
    update: vi.fn(async () => undefined)
  };
  const state = {
    workspaceFolders: undefined as
      | readonly { uri: { fsPath: string; scheme: string }; name: string; index: number }[]
      | undefined,
    folderListeners: new Set<(event: { added: readonly unknown[]; removed: readonly unknown[] }) => void>(),
    trustListeners: new Set<Listener>(),
    getConfiguration: vi.fn(() => config),
    showInformationMessage: vi.fn(async (_message: string) => undefined as string | undefined),
    showWarningMessage: vi.fn(async (_message: string) => undefined as string | undefined),
    showErrorMessage: vi.fn(async (_message: string) => undefined as string | undefined),
    executeCommand: vi.fn(async (..._args: unknown[]) => undefined),
    trusted: true
  };
  return { config, state };
});

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      return mocks.state.workspaceFolders;
    },
    get isTrusted() {
      return mocks.state.trusted;
    },
    getConfiguration: mocks.state.getConfiguration,
    onDidChangeWorkspaceFolders: (
      listener: (event: { added: readonly unknown[]; removed: readonly unknown[] }) => void
    ) => {
      mocks.state.folderListeners.add(listener);
      return {
        dispose: () => {
          mocks.state.folderListeners.delete(listener);
        }
      };
    },
    onDidGrantWorkspaceTrust: (listener: () => void) => {
      mocks.state.trustListeners.add(listener);
      return {
        dispose: () => {
          mocks.state.trustListeners.delete(listener);
        }
      };
    }
  },
  window: {
    showInformationMessage: mocks.state.showInformationMessage,
    showWarningMessage: mocks.state.showWarningMessage,
    showErrorMessage: mocks.state.showErrorMessage
  },
  commands: {
    executeCommand: mocks.state.executeCommand
  },
  Uri: {
    file: (filePath: string) => ({
      fsPath: filePath,
      scheme: 'file',
      path: filePath
    })
  }
}));

import {
  createNoopHostSchedulerService,
  createVSCodeHostServices
} from '../../../src/host-services';
import { disposeWorkspaceFolderPicker } from '../../../src/state/workspace-folder-picker';

function memento() {
  const values = new Map<string, unknown>();
  return {
    get: vi.fn(<T>(key: string, defaultValue?: T): T | undefined => {
      return values.has(key) ? (values.get(key) as T) : defaultValue;
    }),
    update: vi.fn(async (key: string, value: unknown) => {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    })
  };
}

function buildContext() {
  return {
    subscriptions: [] as { dispose(): void }[],
    workspaceState: memento(),
    globalState: memento(),
    globalStorageUri: { fsPath: '/tmp/schegent-global' }
  };
}

beforeEach(() => {
  disposeWorkspaceFolderPicker();
  mocks.config.get.mockClear();
  mocks.config.inspect.mockClear();
  mocks.config.update.mockClear();
  mocks.state.workspaceFolders = undefined;
  mocks.state.folderListeners.clear();
  mocks.state.trustListeners.clear();
  mocks.state.getConfiguration.mockClear();
  mocks.state.showInformationMessage.mockClear();
  mocks.state.showWarningMessage.mockClear();
  mocks.state.showErrorMessage.mockClear();
  mocks.state.executeCommand.mockClear();
  mocks.state.trusted = true;
});

describe('VS Code host services adapter', () => {
  it('keeps host-service type module VS Code-free', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../src/host-services/types.ts'),
      'utf8'
    );

    expect(source).not.toMatch(/from ['"]vscode['"]/);
  });

  it('delegates canonical workspace root reads to the canonical picker', () => {
    const root = {
      uri: { fsPath: '/workspace/primary', scheme: 'file' },
      name: 'primary',
      index: 0
    };
    const secondary = {
      uri: { fsPath: '/workspace/secondary', scheme: 'file' },
      name: 'secondary',
      index: 1
    };
    mocks.state.workspaceFolders = [root, secondary];

    const services = createVSCodeHostServices(buildContext());

    expect(services.workspace.getCanonicalWorkspaceRoot()).toBe(root);
    expect(mocks.state.folderListeners.size).toBe(1);
  });

  it('delegates configuration access to workspace.getConfiguration', async () => {
    const context = buildContext();
    const services = createVSCodeHostServices(context);
    const resource = { fsPath: '/workspace/primary', scheme: 'file' };

    const config = services.configuration.getConfiguration('schegent', resource);
    config.get('cli.path', 'claude');
    await Promise.resolve(config.update('cli.path', 'codex', 2));

    expect(mocks.state.getConfiguration).toHaveBeenCalledWith('schegent', resource);
    expect(mocks.config.get).toHaveBeenCalledWith('cli.path', 'claude');
    expect(mocks.config.update).toHaveBeenCalledWith('cli.path', 'codex', 2);
  });

  it('exposes workspace/global state and global storage path helpers', async () => {
    const context = buildContext();
    const services = createVSCodeHostServices(context);

    await Promise.resolve(services.state.workspace.update('schegent.run', { id: 'run-1' }));
    await Promise.resolve(services.state.global.update('schegent.global', true));

    expect(services.state.workspace.get('schegent.run')).toEqual({ id: 'run-1' });
    expect(services.state.global.get('schegent.global')).toBe(true);
    expect(services.storage.globalStorageFsPath).toBe('/tmp/schegent-global');
    expect(services.storage.joinGlobalStoragePath('wakeup', 'session.log')).toBe(
      '/tmp/schegent-global/wakeup/session.log'
    );
  });

  it('delegates notifications, command execution, and file reveal to VS Code APIs', async () => {
    const services = createVSCodeHostServices(buildContext());

    await Promise.resolve(services.notifications.info('hello'));
    await Promise.resolve(services.notifications.warn('warn'));
    await Promise.resolve(services.notifications.error('error'));
    await Promise.resolve(services.commands.execute('schegent.resume', { taskId: 't1' }));
    await Promise.resolve(services.files.revealFileInOS('/tmp/schegent.log'));

    expect(mocks.state.showInformationMessage).toHaveBeenCalledWith('hello');
    expect(mocks.state.showWarningMessage).toHaveBeenCalledWith('warn');
    expect(mocks.state.showErrorMessage).toHaveBeenCalledWith('error');
    expect(mocks.state.executeCommand).toHaveBeenCalledWith('schegent.resume', { taskId: 't1' });
    expect(mocks.state.executeCommand).toHaveBeenCalledWith(
      'revealFileInOS',
      expect.objectContaining({ fsPath: '/tmp/schegent.log', scheme: 'file' })
    );
  });

  it('registers trust listeners in lifecycle and disposes registered resources', () => {
    const context = buildContext();
    const services = createVSCodeHostServices(context);
    const extra = { dispose: vi.fn() };

    const trustDisposable = services.workspace.onDidGrantTrust(() => undefined);
    services.lifecycle.register(extra);

    expect(context.subscriptions).toContain(trustDisposable);
    expect(context.subscriptions).toContain(extra);
    expect(mocks.state.trustListeners.size).toBe(1);

    services.lifecycle.disposeAll();

    expect(extra.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.state.trustListeners.size).toBe(0);
  });

  it('delegates scheduler calls to the injected scheduler and provides a noop fallback', async () => {
    const scheduler = {
      apply: vi.fn(async (_options: unknown) => undefined),
      uninstall: vi.fn(async () => undefined),
      inspect: vi.fn(async () => ({ registered: true })),
      reconcile: vi.fn(async (_options: unknown) => ({ action: 'updated' }))
    };
    const services = createVSCodeHostServices(buildContext(), { scheduler });

    await services.scheduler.apply({ enabled: true });
    await services.scheduler.uninstall();
    await expect(services.scheduler.inspect()).resolves.toEqual({ registered: true });
    await expect(services.scheduler.reconcile({ enabled: true })).resolves.toEqual({
      action: 'updated'
    });

    expect(scheduler.apply).toHaveBeenCalledWith({ enabled: true });
    expect(scheduler.uninstall).toHaveBeenCalledTimes(1);

    await expect(createNoopHostSchedulerService().inspect()).resolves.toEqual({
      registered: false
    });
  });
});
