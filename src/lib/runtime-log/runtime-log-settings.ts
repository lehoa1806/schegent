// Feature 019 — Per-call accessor for runtime debug log settings.
//
// The accessor reads `WorkspaceConfiguration` on every call (never
// caches), mirroring `createAutoCompactOverrideAccessor` (012),
// `createVerboseDiagnosticsAccessor` (010), and the
// `FatalSignaturesAccessor` (011). Toggling
// `schegent.logging.runtimeLogLevel` or `runtimeLogFilePath` in
// `settings.json` therefore applies to the **next emit** without
// requiring extension reload (FR-008, FR-009).
//
// Returns `{ level, path }` or `null` when the path cannot be resolved
// (no workspace + relative input, or operator-supplied malformed path).
// A `null` accessor result short-circuits the sink — no DEBUG/INFO
// records are appended. The hot-path emit cost is one config read +
// two property fetches (≤ 50 µs at the 99th percentile on the dev box).

import type { GeneralSettingsConfig } from '../../config/general-settings';
import type { SanitizedLogger } from '../logger';
import {
  isRuntimeLogLevel,
  type RuntimeLogLevel
} from './runtime-log-level';
import {
  resolveRuntimeLogPath,
  type RuntimeLogPathError
} from './runtime-log-path';

const LEVEL_KEY = 'logging.runtimeLogLevel';
const PATH_KEY = 'logging.runtimeLogFilePath';
const MAX_BYTES_KEY = 'logging.runtimeLogMaxBytes';
const MAX_GENS_KEY = 'logging.runtimeLogMaxGenerations';

// Feature 056 Track 9 — rotation policy bounds (mirror KEY_SPECS).
// Both keys are read on every emit via the accessor; the sink consumes
// them inside the rotation check that runs before each append.
const MAX_BYTES_DEFAULT = 5 * 1024 * 1024;
const MAX_BYTES_MIN = 65_536;
const MAX_BYTES_MAX = 1_073_741_824;
const MAX_GENS_DEFAULT = 3;
const MAX_GENS_MIN = 0;
const MAX_GENS_MAX = 20;

export interface RuntimeLogSettings {
  readonly level: RuntimeLogLevel;
  readonly path: string;
  /** Feature 056 Track 9 — rotation threshold (bytes). */
  readonly maxBytes: number;
  /** Feature 056 Track 9 — rotated-generation cap (0 = truncate in place). */
  readonly maxGenerations: number;
}

export interface RuntimeLogAccessor {
  /** Returns the effective settings or `null` if the path is unresolvable. */
  read(): RuntimeLogSettings | null;
}

function clampInt(
  raw: unknown,
  defaultValue: number,
  min: number,
  max: number
): number {
  if (typeof raw !== 'number') return defaultValue;
  if (!Number.isFinite(raw) || !Number.isInteger(raw)) return defaultValue;
  if (raw < min) return min;
  if (raw > max) return max;
  return raw;
}

/** Per-process de-dup so a misconfiguration warns once per cause. */
const warnedCauses = new Set<string>();

/** Test-only — used by `runtime-log-settings.test.ts`. */
export function __resetRuntimeLogAccessorWarnCache(): void {
  warnedCauses.clear();
}

type LevelWarnCause = 'wrong-type' | 'unrecognized';

function warnLevelOnce(
  logger: SanitizedLogger,
  cause: LevelWarnCause,
  rawStr: string
): void {
  const key = `level:${cause}:${rawStr}`;
  if (warnedCauses.has(key)) return;
  warnedCauses.add(key);
  logger.warn(
    `schegent.logging.runtimeLogLevel: ignoring value (${cause}); using INFO.`
  );
}

function warnPathOnce(
  logger: SanitizedLogger,
  cause: RuntimeLogPathError,
  rawStr: string
): void {
  const key = `path:${cause}:${rawStr}`;
  if (warnedCauses.has(key)) return;
  warnedCauses.add(key);
  // The `absolute-outside-allowed-roots` cause is the security-relevant
  // one (malicious workspace setting targets `/etc/passwd.log` or
  // similar). Phrasing the WARN explicitly so an operator who sees it
  // in the fallback log can match it to the rejected path.
  if (cause === 'absolute-outside-allowed-roots') {
    logger.warn(
      `schegent.logging.runtimeLogFilePath: rejected absolute path outside allowed roots (workspace, globalStorage, tmpdir, home); runtime log disabled until corrected.`
    );
    return;
  }
  logger.warn(
    `schegent.logging.runtimeLogFilePath: cannot resolve (${cause}); runtime log disabled until corrected.`
  );
}

function safeString(value: unknown): string {
  try {
    if (typeof value === 'string') return JSON.stringify(value);
    return String(value);
  } catch {
    return '<unserialisable>';
  }
}

/**
 * Read the level + path from the config and resolve the path against
 * the supplied workspace root. Pure function — no side effects beyond
 * one-shot warnings emitted via the supplied logger.
 *
 * When `allowedAbsoluteRoots` is non-empty, absolute paths are rejected
 * unless they fall under one of those roots (defense-in-depth against a
 * malicious workspace settings file).
 */
export function readRuntimeLogSettings(
  config: GeneralSettingsConfig,
  workspaceRoot: string | null,
  logger: SanitizedLogger,
  allowedAbsoluteRoots?: readonly string[]
): RuntimeLogSettings | null {
  const rawLevel = config.get<unknown>(LEVEL_KEY, 'INFO');
  let level: RuntimeLogLevel;
  if (isRuntimeLogLevel(rawLevel)) {
    level = rawLevel;
  } else if (typeof rawLevel !== 'string') {
    warnLevelOnce(logger, 'wrong-type', safeString(rawLevel));
    level = 'INFO';
  } else {
    warnLevelOnce(logger, 'unrecognized', safeString(rawLevel));
    level = 'INFO';
  }

  const rawPath = config.get<unknown>(PATH_KEY, '');
  const resolved = resolveRuntimeLogPath(rawPath, workspaceRoot, allowedAbsoluteRoots);
  if (!resolved.ok) {
    warnPathOnce(logger, resolved.error, safeString(rawPath));
    return null;
  }
  const maxBytes = clampInt(
    config.get<unknown>(MAX_BYTES_KEY, MAX_BYTES_DEFAULT),
    MAX_BYTES_DEFAULT,
    MAX_BYTES_MIN,
    MAX_BYTES_MAX
  );
  const maxGenerations = clampInt(
    config.get<unknown>(MAX_GENS_KEY, MAX_GENS_DEFAULT),
    MAX_GENS_DEFAULT,
    MAX_GENS_MIN,
    MAX_GENS_MAX
  );
  return { level, path: resolved.path, maxBytes, maxGenerations };
}

/**
 * Build a `RuntimeLogAccessor` that re-reads the config + workspace
 * root on every call. Both providers are thunks so a workspace open /
 * close transition between emits is observed without extension reload.
 *
 * `allowedAbsoluteRootsProvider` (optional) supplies the set of roots
 * an operator-supplied absolute path must descend from. The host wires
 * this with `[workspaceRoot, globalStorage, tmpdir, homedir]`; unit
 * tests can omit it to preserve the historical permissive behavior.
 */
export function createRuntimeLogAccessor(
  configProvider: () => GeneralSettingsConfig,
  workspaceRootProvider: () => string | null,
  logger: SanitizedLogger,
  allowedAbsoluteRootsProvider?: () => readonly string[]
): RuntimeLogAccessor {
  return {
    read(): RuntimeLogSettings | null {
      return readRuntimeLogSettings(
        configProvider(),
        workspaceRootProvider(),
        logger,
        allowedAbsoluteRootsProvider ? allowedAbsoluteRootsProvider() : undefined
      );
    }
  };
}
