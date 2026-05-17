// Feature 012 — sanitized reader for `schegent.claude.autoCompactPctOverride`.
//
// Mirrors the pattern of `readFatalSignaturesSetting` (011) and
// `createVerboseDiagnosticsAccessor` (010): the value is re-read at every
// `PhaseRunner.run()` entry via the returned accessor — never cached on
// the runner. Toggling the workspace setting mid-run therefore applies
// only to the **next** subprocess invocation (012 FR-006).
//
// Returns `number | undefined`. `undefined` is the sentinel for "do not
// inject the env var" — callers MUST omit `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`
// from the subprocess env when this returns `undefined` (never inject an
// empty string or `"undefined"` literal).
//
// Malformed inputs (non-integer, out-of-range, wrong type) warn-once via
// the supplied `SanitizedLogger` and fall back to `undefined` so that a
// bad config never blocks extension activation or aborts a phase run.

import type { GeneralSettingsConfig } from '../config/general-settings';
import type { SanitizedLogger } from './logger';

const KEY = 'claude.autoCompactPctOverride';
const MIN = 1;
const MAX = 100;

/** De-dup warn-once across many reads. Keyed by `${cause}:${valueAsString}`. */
const warnedCauses = new Set<string>();

/** Test-only — used by the auto-compact-override.test.ts harness. */
export function __resetAutoCompactOverrideWarnCache(): void {
  warnedCauses.clear();
}

type RejectionCause =
  | 'not-an-integer'
  | 'out-of-range'
  | 'wrong-type';

function warnOnce(logger: SanitizedLogger, cause: RejectionCause, valueStr: string): void {
  const dedupKey = `${cause}:${valueStr}`;
  if (warnedCauses.has(dedupKey)) return;
  warnedCauses.add(dedupKey);
  logger.warn(
    `schegent.claude.autoCompactPctOverride: ignoring value (${cause}); using CLI default.`
  );
}

/**
 * Read and validate `schegent.claude.autoCompactPctOverride` from the
 * supplied workspace config. Returns `undefined` for any unset, null,
 * non-numeric, non-integer, or out-of-range value (warning once per
 * cause+value).
 */
export function readAutoCompactPctOverride(
  config: GeneralSettingsConfig,
  logger: SanitizedLogger
): number | undefined {
  const raw = config.get<unknown>(KEY, undefined);
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    warnOnce(logger, 'wrong-type', safeStringify(raw));
    return undefined;
  }
  if (!Number.isInteger(raw)) {
    warnOnce(logger, 'not-an-integer', String(raw));
    return undefined;
  }
  if (raw < MIN || raw > MAX) {
    warnOnce(logger, 'out-of-range', String(raw));
    return undefined;
  }
  return raw;
}

/**
 * Build an `AutoCompactOverrideAccessor` that re-reads the setting via
 * the supplied `configProvider` thunk on every call. The thunk MUST
 * return a fresh `WorkspaceConfiguration` slice (typically
 * `vscode.workspace.getConfiguration('schegent')`) — caching it would
 * defeat the no-cache invariant.
 */
export function createAutoCompactOverrideAccessor(
  configProvider: () => GeneralSettingsConfig,
  logger: SanitizedLogger
): { readAutoCompactPctOverride(): number | undefined } {
  return {
    readAutoCompactPctOverride(): number | undefined {
      return readAutoCompactPctOverride(configProvider(), logger);
    }
  };
}

function safeStringify(value: unknown): string {
  try {
    if (typeof value === 'string') return JSON.stringify(value);
    return String(value);
  } catch {
    return '<unserialisable>';
  }
}
