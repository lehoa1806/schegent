// GENERATED FILE — do not edit.
//
// Emitted from src/contracts/backend-kinds.ts and src/contracts/backend-descriptors.ts
// by scripts/generate-contract-schemas.mjs (FR-R7-06).
// Edit the host contract source and run: npm run contracts:generate
//
// Self-contained webview projection: carries zero imports from host `src/`.

export type BackendRunnerKind = 'claude' | 'codex' | 'agy';

export const SUPPORTED_BACKENDS: ReadonlyArray<BackendRunnerKind> = Object.freeze(["claude","codex","agy"]);

export const DEFAULT_BACKEND: BackendRunnerKind = "claude";

export function isBackendRunnerKind(value: unknown): value is BackendRunnerKind {
  return typeof value === 'string' &&
    (SUPPORTED_BACKENDS as ReadonlyArray<string>).includes(value);
}

export type SpendDenomination = 'usd' | 'tokens';

export interface WebviewBackendDescriptor {
  readonly kind: BackendRunnerKind;
  readonly displayLabel: string;
  readonly cliPathSettingKey: string;
  readonly cliPathFieldKey: string;
  readonly defaultCliBinary: string;
  readonly spendDenomination: SpendDenomination;
  readonly supportsAutoCompactPctOverride: boolean;
  readonly supportsGitSideEffects: boolean;
  readonly supportsModelDiscovery: boolean;
  readonly unsupportedEffortLevels: readonly string[];
  readonly exampleModelPlaceholder: string;
}

export type BackendMap<T> = { readonly [K in BackendRunnerKind]: T };
export type MutableBackendMap<T> = { [K in BackendRunnerKind]: T };

export const WEBVIEW_BACKEND_DESCRIPTORS: Readonly<Record<BackendRunnerKind, WebviewBackendDescriptor>> =
  Object.freeze({
    claude: Object.freeze({
      kind: "claude",
      displayLabel: "Claude",
      cliPathSettingKey: "cli.path",
      cliPathFieldKey: "cliPath",
      defaultCliBinary: "claude",
      spendDenomination: "usd",
      supportsAutoCompactPctOverride: true,
      supportsGitSideEffects: true,
      supportsModelDiscovery: false,
      unsupportedEffortLevels: Object.freeze([] as const),
      exampleModelPlaceholder: "claude-3-7-sonnet-20250219"
    }),
    codex: Object.freeze({
      kind: "codex",
      displayLabel: "Codex",
      cliPathSettingKey: "codex.path",
      cliPathFieldKey: "codexPath",
      defaultCliBinary: "codex",
      spendDenomination: "tokens",
      supportsAutoCompactPctOverride: false,
      supportsGitSideEffects: false,
      supportsModelDiscovery: false,
      unsupportedEffortLevels: Object.freeze([] as const),
      exampleModelPlaceholder: "model-name"
    }),
    agy: Object.freeze({
      kind: "agy",
      displayLabel: "Agy",
      cliPathSettingKey: "agy.path",
      cliPathFieldKey: "agyPath",
      defaultCliBinary: "agy",
      spendDenomination: "tokens",
      supportsAutoCompactPctOverride: false,
      supportsGitSideEffects: true,
      supportsModelDiscovery: true,
      unsupportedEffortLevels: Object.freeze(["xhigh","max"] as const),
      exampleModelPlaceholder: "model-name"
    })
  });

export const WEBVIEW_BACKEND_LIST: readonly WebviewBackendDescriptor[] = Object.freeze(
  SUPPORTED_BACKENDS.map((kind) => WEBVIEW_BACKEND_DESCRIPTORS[kind])
);

export function findWebviewBackendDescriptor(kind: unknown): WebviewBackendDescriptor | undefined {
  if (typeof kind !== 'string') return undefined;
  if (!Object.prototype.hasOwnProperty.call(WEBVIEW_BACKEND_DESCRIPTORS, kind)) return undefined;
  return WEBVIEW_BACKEND_DESCRIPTORS[kind as BackendRunnerKind];
}

export function getWebviewBackendDescriptor(kind: BackendRunnerKind): WebviewBackendDescriptor {
  const descriptor = findWebviewBackendDescriptor(kind);
  if (descriptor === undefined) {
    throw new TypeError(`unknown backend kind "${String(kind)}"`);
  }
  return descriptor;
}

export function spendDenominationOf(kind: BackendRunnerKind): SpendDenomination {
  return getWebviewBackendDescriptor(kind).spendDenomination;
}

export function isUnsupportedEffortForBackend(kind: unknown, effort: string): boolean {
  const descriptor = findWebviewBackendDescriptor(kind);
  if (descriptor === undefined) return false;
  return descriptor.unsupportedEffortLevels.includes(effort);
}

export function mapMutableBackends<T>(
  fn: (descriptor: WebviewBackendDescriptor) => T
): MutableBackendMap<T> {
  return Object.fromEntries(
    SUPPORTED_BACKENDS.map((kind) => [kind, fn(WEBVIEW_BACKEND_DESCRIPTORS[kind])])
  ) as MutableBackendMap<T>;
}

export function mapBackends<T>(
  fn: (descriptor: WebviewBackendDescriptor) => T
): BackendMap<T> {
  return Object.freeze(mapMutableBackends(fn));
}
