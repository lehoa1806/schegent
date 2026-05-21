import * as path from 'node:path';
import * as vscode from 'vscode';
import { getCanonicalWorkspaceRoot } from '../state/workspace-folder-picker';
import type {
  HostConfigurationService,
  HostDisposable,
  HostLifecycleService,
  HostSchedulerService,
  HostServices
} from './types';

export interface VSCodeHostServicesContext {
  readonly subscriptions: HostDisposable[];
  readonly workspaceState: {
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void> | Promise<void>;
  };
  readonly globalState: {
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void> | Promise<void>;
  };
  readonly globalStorageUri: { readonly fsPath: string };
}

export interface VSCodeHostServicesOptions {
  readonly scheduler?: HostSchedulerService;
}

export function createNoopHostSchedulerService(): HostSchedulerService {
  return {
    async apply(): Promise<void> {},
    async uninstall(): Promise<void> {},
    async inspect(): Promise<unknown> {
      return { registered: false };
    },
    async reconcile(): Promise<unknown> {
      return { action: 'none' };
    }
  };
}

export function createVSCodeHostServices(
  context: VSCodeHostServicesContext,
  options: VSCodeHostServicesOptions = {}
): HostServices {
  const lifecycle = createLifecycleService(context);
  const configuration: HostConfigurationService = {
    getConfiguration(section?: string, resource?: { fsPath: string; scheme: string } | null) {
      return vscode.workspace.getConfiguration(
        section,
        (resource ?? undefined) as vscode.ConfigurationScope | undefined
      );
    }
  };

  return {
    workspace: {
      getCanonicalWorkspaceRoot: () => getCanonicalWorkspaceRoot(),
      isTrusted: () => vscode.workspace.isTrusted,
      onDidGrantTrust: (listener) => lifecycle.register(vscode.workspace.onDidGrantWorkspaceTrust(listener))
    },
    configuration,
    state: {
      workspace: context.workspaceState,
      global: context.globalState
    },
    storage: {
      globalStorageFsPath: context.globalStorageUri.fsPath,
      joinGlobalStoragePath: (...segments) =>
        path.join(context.globalStorageUri.fsPath, ...segments)
    },
    notifications: {
      info: (message) => vscode.window.showInformationMessage(message),
      warn: (message) => vscode.window.showWarningMessage(message),
      error: (message) => vscode.window.showErrorMessage(message)
    },
    commands: {
      execute: (commandId, ...args) => vscode.commands.executeCommand(commandId, ...args)
    },
    files: {
      revealFileInOS: (filePath) =>
        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath))
    },
    scheduler: options.scheduler ?? createNoopHostSchedulerService(),
    lifecycle
  };
}

function createLifecycleService(context: VSCodeHostServicesContext): HostLifecycleService {
  const owned = new Set<HostDisposable>();
  return {
    register(disposable): HostDisposable {
      owned.add(disposable);
      context.subscriptions.push(disposable);
      return disposable;
    },
    disposeAll(): void {
      for (const disposable of [...owned]) {
        owned.delete(disposable);
        try {
          disposable.dispose();
        } catch {
          // Host teardown is best-effort; individual dispose failures must
          // not prevent later disposables from running.
        }
      }
    }
  };
}
