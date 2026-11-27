// GENERATED FILE — do not edit.
//
// Emitted from src/contracts/backend-kinds.ts and backend-descriptors.ts by scripts/generate-contract-schemas.mjs.
// Edit the host contract source and run: npm run contracts:generate
//
// Self-contained leaf webview projection: carries zero imports from host `src/`.

export type BackendRunnerKind = "claude" | "codex" | "agy";

export const SUPPORTED_BACKENDS: ReadonlyArray<BackendRunnerKind> = /*#__PURE__*/ Object.freeze(["claude","codex","agy"]);

export const DEFAULT_BACKEND: BackendRunnerKind = "claude";

export const BACKEND_CLI_DEFAULTS = /*#__PURE__*/ Object.freeze({
  cliPath: "claude",
  codexPath: "codex",
  agyPath: "agy"
});

export function isBackendRunnerKind(value: unknown): value is BackendRunnerKind {
  return typeof value === 'string' &&
    (SUPPORTED_BACKENDS as ReadonlyArray<string>).includes(value);
}
