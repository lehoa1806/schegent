import type { BackendRunner, MonitorSidecarHook } from '../contracts/backend-runner';
import { ClaudeCliRunner } from './claude-cli';
import { CodexCliRunner } from './codex-cli';
import { AgyCliRunner } from './agy-cli';
import { SanitizedLogger } from '../lib/logger';
import { judgeBackendContainment } from '../services/backend-containment-policy';

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

export function isBackendRunnerKind(value: unknown): value is BackendRunnerKind {
  return typeof value === 'string' &&
    (SUPPORTED_BACKENDS as ReadonlyArray<string>).includes(value);
}

/**
 * FR-R3-056 — thrown rather than returned, because there is no runner to return.
 * A distinct type so a caller can report the posture refusal as itself instead of
 * as a generic construction failure.
 */
export class UncontainedBackendRefusedError extends Error {
  public constructor(
    public readonly kind: BackendRunnerKind,
    message: string
  ) {
    super(message);
    this.name = 'UncontainedBackendRefusedError';
  }
}

export interface BackendRunnerFactoryOptions {
  /**
   * FR-R3-056 — whether this host accepts a backend that has no OS-enforced
   * bound. Required: see `createBackendRunner`.
   */
  readonly allowUncontained: boolean;
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
/**
 * FR-R3-056 (H-01) — refused here, at the construction point.
 *
 * This is the last place before an uncontained backend exists as an object, and
 * every route reaches it: admission, resume, an auto-drain, a continuation. A
 * check placed at admission alone would be bypassed by every path that does not
 * go through admission, which is most of them.
 *
 * `allowUncontained` is a REQUIRED option, not an optional one defaulting to
 * permissive. An optional gate is a gate omitted at the one call site nobody
 * revisits; making it required means `tsc` enumerates every construction site
 * and no new one can be added without stating its posture. Same reasoning as the
 * required `environmentPolicy` on `WatchdogOptions` (FR-R3-049).
 */
export function createBackendRunner(
  kind: BackendRunnerKind,
  options: BackendRunnerFactoryOptions
): BackendRunner {
  const verdict = judgeBackendContainment(kind, options.allowUncontained);
  if (verdict.outcome === 'refused') {
    throw new UncontainedBackendRefusedError(verdict.kind, verdict.message);
  }
  const monitorHook = options.monitorHook ?? null;
  const logger = options.logger ?? new SanitizedLogger();
  if (verdict.containment === 'none') {
    // FR-R3-056 — say it out loud. The operator accepted this posture in a
    // setting they may have set months ago; the run it applies to is now.
    //
    // Once per constructed runner, not once per run: the registry caches by
    // kind, so this cannot claim to be a per-run record and does not. A genuine
    // per-run entry belongs at admission and needs its own audit event; recorded
    // as outstanding in the decision record rather than implied here.
    logger.warn(
      `backend '${kind}' has no OS-enforced bound; permitted by ` +
        'schegent.backend.allowUncontainedBackends'
    );
  }
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
