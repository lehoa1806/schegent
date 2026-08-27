

export const RUNTIME_LOG_LEVELS: ReadonlyArray<RuntimeLogLevel> = Object.freeze([
  'DEBUG',
  'INFO',
  'WARN',
  'ERROR'
]);

// FR-R3-132 (T1502) — moved to `src/contracts/snapshot-vocabulary.ts` so the webview
// imports it instead of restating it. Re-exported unchanged.
import type { RuntimeLogLevel } from '../../contracts/snapshot-vocabulary';

export type { RuntimeLogLevel };


const SEVERITY: Readonly<Record<RuntimeLogLevel, number>> = Object.freeze({
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40
});

export function isRuntimeLogLevel(value: unknown): value is RuntimeLogLevel {
  return (
    typeof value === 'string' &&
    (RUNTIME_LOG_LEVELS as ReadonlyArray<string>).includes(value)
  );
}

export function levelSeverity(level: RuntimeLogLevel): number {
  return SEVERITY[level];
}

/**
 * True when a record at `record` should be admitted under the
 * `configured` filter. Severity-≥ semantics: DEBUG admits all, ERROR
 * admits only ERROR.
 */
export function shouldEmit(
  record: RuntimeLogLevel,
  configured: RuntimeLogLevel
): boolean {
  return SEVERITY[record] >= SEVERITY[configured];
}
