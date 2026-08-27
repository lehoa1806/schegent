import type { BackendRunner, MonitorSidecarHook } from '../contracts/backend-runner';
import { ClaudeCliRunner } from './claude-cli';
import { CodexCliRunner } from './codex-cli';
import { AgyCliRunner } from './agy-cli';
import { SanitizedLogger } from '../lib/logger';
import {
  ALLOW_UNCONTAINED_SETTING,
  judgeBackendContainment
} from '../services/backend-containment-policy';
import type { ProcessEnvironmentMode } from './spawn-env';
import {
  DEFAULT_BACKEND,
  SUPPORTED_BACKENDS,
  type BackendRunnerKind
} from '../contracts/backend-kinds';

// Feature 034 Item 050 — backend selection.
//
// The `schegent.backend.runner` workspace setting picks the concrete
// `BackendRunner` implementation at activation time. The default is
// `'claude'`; existing workspaces see no behavior change. Adding a new
// backend means:
//   1. Implement `BackendRunner` in `src/runner/<your>-cli.ts` (no
//      `shell:true`, monitor sidecar events, cancellation/timeout
//      discipline — see `docs/operations/backends.md`).
//   2. Extend the union in `src/contracts/backend-kinds.ts` and the
//      `package.json` enum.
//   3. Add a `case` here that constructs the new runner.
//
// FR-R3-089 — the backend *identity* surface (`BackendRunnerKind`,
// `SUPPORTED_BACKENDS`, `DEFAULT_BACKEND`, `isBackendRunnerKind`) moved to
// `src/contracts/backend-kinds.ts`. This module keeps construction. Do not
// re-export identity from here: `tests/lint/backend-kind-placement.test.ts`
// forbids both a value import of this module from outside `src/runner/` and a
// re-export hub anywhere.
//
// All runners receive the same monitor hook so the controller's audit
// pipeline, telemetry sampler, and live-activity projector remain
// backend-agnostic.


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
   * FR-R3-056, reshaped by FR-R3-125 — the backends this host accepts WITHOUT an
   * OS-enforced bound. Required: see `createBackendRunner`.
   *
   * A set, not a boolean: allowing `agy` must not allow `claude`. Resolved from
   * `schegent.backend.uncontainedBackends` by `resolveUncontainedGrant`, which
   * also reports the entries that grant nothing.
   */
  readonly uncontainedGranted: ReadonlySet<BackendRunnerKind>;
  /**
   * FR-R3-125 (FR-007) — the environment policy mode, so the compounding case can
   * be stated where both facts are known. Optional and defaulting to `undefined`
   * ONLY because a caller that cannot know it must not be forced to guess; a
   * missing mode suppresses the compound warning rather than fabricating one.
   */
  readonly environmentMode?: ProcessEnvironmentMode;
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
 * `uncontainedGranted` is a REQUIRED option, not an optional one defaulting to
 * permissive. An optional gate is a gate omitted at the one call site nobody
 * revisits; making it required means `tsc` enumerates every construction site
 * and no new one can be added without stating its posture. Same reasoning as the
 * required `environmentPolicy` on `WatchdogOptions` (FR-R3-049).
 *
 * FR-R3-125 (FR-008) — the enforcement point does NOT move. This is still the
 * last place before an uncontained backend exists as an object, and the change is
 * to the shape of what is granted, not to where the grant is checked.
 */
export function createBackendRunner(
  kind: BackendRunnerKind,
  options: BackendRunnerFactoryOptions
): BackendRunner {
  const verdict = judgeBackendContainment(kind, options.uncontainedGranted);
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
    // kind, so this cannot claim to be a per-run record and does not. The
    // per-run record is `backend-posture-admitted` (FR-R3-064), which also
    // carries the mechanism as of FR-R3-125.
    logger.warn(
      `backend '${kind}' has no OS-enforced bound; permitted by ` +
        `${ALLOW_UNCONTAINED_SETTING} naming '${kind}'`
    );
    // FR-R3-125 (FR-007) — the COMPOUNDING case, said once, as one fact.
    //
    // `warnIfEnvironmentIsUnrestricted` in `activation/backend-wiring.ts` already
    // warns about `inherit`, once per workspace at activation. It is correct and
    // is deliberately left alone: it is about the environment policy ON ITS OWN,
    // and it does not know which backend is spawning. This warning is about the
    // conjunction, and this is the only place both facts are in hand.
    //
    // It fires on ONE of four combinations. The other three are silent by
    // construction and asserted so — a warning that fires on three of four is
    // noise, and noise gets filtered, which is how the one that mattered is lost.
    //
    // Once per CONSTRUCTED RUNNER, like the warning above it: the registry caches
    // by kind, so this is not a per-run record and does not claim to be. The
    // per-run record is `backend-posture-admitted`, which carries the containment
    // and the mechanism; the environment mode is deliberately NOT in that payload,
    // which is closed to three bounded primitives plus the mechanism (FR-R3-064).
    if (options.environmentMode === 'inherit') {
      logger.warn(
        `backend '${kind}' has no OS-enforced bound AND schegent.cli.environmentMode is ` +
          "'inherit', so it receives the full ambient environment: credentials in the shell " +
          'that launched this window are reachable by model-generated actions. Set ' +
          'schegent.cli.environmentMode to allowlist or minimal, or use a contained backend. ' +
          'See docs/operations/untrusted-repositories.md.'
      );
    }
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
