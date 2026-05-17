// Feature 019 — Runtime log level severity helpers.
//
// The runtime-log severity ladder mirrors the existing `SanitizedLogger`
// method set (info/warn/error) plus the new `debug()` level added in
// T010. Ordering: DEBUG < INFO < WARN < ERROR.
//
// `shouldEmit(record, configured)` is the gate used by the sink: it
// allows the record if its severity is ≥ the configured filter, so
// configuring `WARN` admits both WARN and ERROR records and rejects
// DEBUG / INFO.

export type RuntimeLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export const RUNTIME_LOG_LEVELS: ReadonlyArray<RuntimeLogLevel> = Object.freeze([
  'DEBUG',
  'INFO',
  'WARN',
  'ERROR'
]);

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
