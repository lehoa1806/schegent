/**
 * FR-R7-07 — Pure session-ID shape predicate relocated to `lib/` so both
 * `src/parser/session-id-extractor.ts` and `src/state/workflow-run-migrator.ts`
 * share one authoritative shape check without `state/` importing `parser/`.
 *
 * Pure module. Zero imports. Linear time (no nested quantifiers).
 */

/**
 * Maximum length for a CLI session identifier.
 */
export const MAX_SESSION_ID_LEN = 256;

/**
 * The characters an id may hold: a letter or digit first, then letters,
 * digits, `.`, `_`, `:` and `-`. The id is spawned as the argument of
 * `--resume` or `--conversation`, so one beginning with `-` would reach the CLI
 * as an option (feature-228 security review, I2). Linear: no nested quantifier.
 */
const SESSION_ID_SHAPE = /^[A-Za-z0-9][\w.:-]*$/;

/** The one shape check for a session id, shared by the extractor and the load-time repair. */
export function isSessionIdShape(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SESSION_ID_LEN &&
    SESSION_ID_SHAPE.test(value)
  );
}
