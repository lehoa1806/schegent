export interface HostDisposable {
  dispose(): void;
}

export interface HostUri {
  readonly fsPath: string;
  readonly scheme: string;
}

export interface HostWorkspaceFolder {
  readonly uri: HostUri;
  readonly name: string;
  readonly index: number;
}

export interface HostWorkspaceService {
  getCanonicalWorkspaceRoot(): HostWorkspaceFolder | undefined;
  isTrusted(): boolean;
  onDidGrantTrust(listener: () => void): HostDisposable;
}

export interface HostConfigurationInspection<T> {
  readonly defaultValue?: T;
  readonly globalValue?: T;
  readonly workspaceValue?: T;
  readonly workspaceFolderValue?: T;
}

export interface HostConfiguration {
  get<T>(key: string, defaultValue: T): T;
  inspect<T>(key: string): HostConfigurationInspection<T> | undefined;
  update(key: string, value: unknown, target: number): Promise<void> | Thenable<void>;
}

export interface HostConfigurationService {
  getConfiguration(section?: string, resource?: HostUri | null): HostConfiguration;
}

export interface HostMemento {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Promise<void> | Thenable<void>;
}

export interface HostStateService {
  readonly workspace: HostMemento;
  readonly global: HostMemento;
}

export interface HostStorageService {
  readonly globalStorageFsPath: string;
  joinGlobalStoragePath(...segments: readonly string[]): string;
}

export interface HostNotificationService {
  info(message: string): Promise<string | undefined> | Thenable<string | undefined>;
  warn(message: string): Promise<string | undefined> | Thenable<string | undefined>;
  error(message: string): Promise<string | undefined> | Thenable<string | undefined>;
}

export interface HostCommandService {
  execute<T = unknown>(commandId: string, ...args: readonly unknown[]): Promise<T> | Thenable<T>;
}

export interface HostFileService {
  revealFileInOS(filePath: string): Promise<void> | Thenable<void>;
}

export interface HostSchedulerService {
  apply(options: unknown): Promise<void>;
  uninstall(): Promise<void>;
  inspect(): Promise<unknown>;
  reconcile(options: unknown): Promise<unknown>;
}

export interface HostLifecycleService {
  register(disposable: HostDisposable): HostDisposable;
  disposeAll(): void;
}

export interface HostServices {
  readonly workspace: HostWorkspaceService;
  readonly configuration: HostConfigurationService;
  readonly state: HostStateService;
  readonly storage: HostStorageService;
  readonly notifications: HostNotificationService;
  readonly commands: HostCommandService;
  readonly files: HostFileService;
  readonly scheduler: HostSchedulerService;
  readonly lifecycle: HostLifecycleService;
}
