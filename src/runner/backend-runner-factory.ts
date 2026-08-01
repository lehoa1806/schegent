import type { BackendRunner, MonitorSidecarHook } from '../contracts/backend-runner';
import { ClaudeCliRunner } from './claude-cli';
import { CodexCliRunner } from './codex-cli';
import { AgyCliRunner } from './agy-cli';
import { SanitizedLogger } from '../lib/logger';

// Feature 034 Item 050 — backend selection.
//
// The `schegent.backend.runner` workspace setting picks the concrete
// `BackendRunner` implementation at activation time. The default is
// `'claude'`; existing workspaces see no behavior change. Adding a new
// backend means:
//   1. Implement `BackendRunner` in `src/runner/<your>-cli.ts` (no
//      `shell:true`, monitor sidecar events, cancellation/timeout
//      discipline — see `docs/operations/backends.md`).
//   2. Extend the union literal below and the `package.json` enum.
//   3. Add a `case` here that constructs the new runner.
//
// All runners receive the same monitor hook so the controller's audit
// pipeline, telemetry sampler, and live-activity projector remain
// backend-agnostic.

export type BackendRunnerKind = 'claude' | 'codex' | 'agy';

export const SUPPORTED_BACKENDS: ReadonlyArray<BackendRunnerKind> = Object.freeze([
  'claude',
  'codex',
  'agy'
]);

export const DEFAULT_BACKEND: BackendRunnerKind = 'claude';

export interface BackendRunnerFactoryOptions {
  readonly monitorHook?: MonitorSidecarHook | null;
  /**
   * Probe `<cli> --help` once per activation to pick the safest available
   * prompt transport. Only relevant for Claude today; Codex uses stdin
   * universally and ignores this flag.
   */
  readonly probeTransport?: boolean;
  readonly logger?: SanitizedLogger;
}

/**
 * Resolve the operator-selected backend kind.
 *
 * Unknown / empty / non-string values collapse to `DEFAULT_BACKEND` so a
 * malformed `package.json` override never breaks activation. The host
 * MUST log the coercion at WARN so the operator notices.
 */
export function resolveBackendKind(
  raw: string | undefined | null,
  logger?: Pick<SanitizedLogger, 'warn'>
): BackendRunnerKind {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return DEFAULT_BACKEND;
  }
  const trimmed = raw.trim().toLowerCase();
  if ((SUPPORTED_BACKENDS as ReadonlyArray<string>).includes(trimmed)) {
    return trimmed as BackendRunnerKind;
  }
  logger?.warn(
    `backend-runner-factory: unknown schegent.backend.runner '${trimmed}', falling back to '${DEFAULT_BACKEND}'`
  );
  return DEFAULT_BACKEND;
}

/**
 * Construct the concrete `BackendRunner` for the requested kind.
 *
 * The function is the SINGLE construction site for runner instances so
 * `extension.ts` doesn't grow a switch over backend identity; everything
 * downstream (controller, monitor, sampler, audit) consumes the
 * `BackendRunner` interface only.
 */
export function createBackendRunner(
  kind: BackendRunnerKind,
  options: BackendRunnerFactoryOptions = {}
): BackendRunner {
  const monitorHook = options.monitorHook ?? null;
  const logger = options.logger ?? new SanitizedLogger();
  switch (kind) {
    case 'codex':
      return new CodexCliRunner(undefined, monitorHook, logger);
    case 'agy':
      return new AgyCliRunner(undefined, monitorHook, logger);
    case 'claude':
    default:
      return new ClaudeCliRunner(
        undefined,
        monitorHook,
        { probeTransport: options.probeTransport ?? false },
        logger
      );
  }
}
