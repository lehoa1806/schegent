// Default `vscode` module stub for unit/integration tests that load
// host-side source modules without supplying their own `vi.mock('vscode')`.
//
// The vitest config aliases the `'vscode'` specifier to this file. Tests
// that need richer behavior continue to use `vi.mock('vscode', () => ({…}))`
// at module scope — that takes precedence over the alias.
//
// The stub defaults to `workspace.isTrusted: true` so tests that exercise
// command paths gated by the per-capability trust resolver (Feature 059)
// see the same allow-by-default semantics they had before the resolver
// existed. Tests that exercise the untrusted branch supply their own
// `vi.mock('vscode', …)` override. Configuration `inspect()` returns
// undefined for both scopes, which lets the resolver fall through to
// "trusted by default" (step 4 of the ladder).
//
// Feature 059 — added so the per-capability trust resolver
// (`src/state/capability-trust-resolver.ts`) can be imported transitively
// by unit tests of unrelated modules (queue mutations, message router,
// save-phases command, etc.) without forcing every test file to mock the
// VS Code module surface.

export interface NoopDisposable {
  dispose: () => void;
}

function noopDisposable(): NoopDisposable {
  return { dispose: () => undefined };
}

export const workspace = {
  isTrusted: true as boolean,
  workspaceFolders: undefined as readonly { uri: { fsPath: string; scheme: string } }[] | undefined,
  getConfiguration: (_section?: string, _resource?: unknown) => ({
    get: <T>(_key: string, def: T): T => def,
    inspect: <T>(_key: string): { workspaceValue: T | undefined; globalValue: T | undefined } => ({
      workspaceValue: undefined,
      globalValue: undefined
    }),
    update: async (_key: string, _value: unknown): Promise<void> => undefined
  }),
  onDidGrantWorkspaceTrust: (_listener: () => void): NoopDisposable => noopDisposable(),
  onDidChangeConfiguration: (
    _listener: (event: { affectsConfiguration: (key: string) => boolean }) => void
  ): NoopDisposable => noopDisposable(),
  onDidChangeWorkspaceFolders: (
    _listener: (event: { added: readonly unknown[]; removed: readonly unknown[] }) => void
  ): NoopDisposable => noopDisposable()
};

export const window = {
  createOutputChannel: (_name: string) => ({
    appendLine: () => undefined,
    append: () => undefined,
    clear: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
    replace: () => undefined,
    name: 'stub'
  }),
  createStatusBarItem: (_alignment?: number, _priority?: number) => ({
    text: '',
    tooltip: '',
    command: '',
    color: undefined,
    backgroundColor: undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
    alignment: 1,
    priority: 100
  }),
  registerWebviewViewProvider: (..._args: unknown[]): NoopDisposable => noopDisposable(),
  showErrorMessage: async (..._args: unknown[]): Promise<unknown> => undefined,
  showInformationMessage: async (..._args: unknown[]): Promise<unknown> => undefined,
  showWarningMessage: async (..._args: unknown[]): Promise<unknown> => undefined
};

export const commands = {
  registerCommand: (..._args: unknown[]): NoopDisposable => noopDisposable(),
  executeCommand: async <T>(..._args: unknown[]): Promise<T | undefined> => undefined
};

export const Uri = {
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
};

export const StatusBarAlignment = {
  Left: 1,
  Right: 2
} as const;

export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3
} as const;

export const EventEmitter = class<T> {
  public readonly event = (_listener: (e: T) => void): NoopDisposable => noopDisposable();
  fire(_data: T): void {
    /* noop */
  }
  dispose(): void {
    /* noop */
  }
};

export default {
  workspace,
  window,
  commands,
  Uri,
  StatusBarAlignment,
  ConfigurationTarget,
  EventEmitter
};
