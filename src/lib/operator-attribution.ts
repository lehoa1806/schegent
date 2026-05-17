/**
 * Feature 017 — Operator attribution helper.
 *
 * Returns the OS user name (via `os.userInfo().username`) for stamping the
 * `actor` field on `PhaseOverride` entries and on every audit event whose
 * cause is operator-initiated. If the lookup throws (no homedir, missing
 * passwd entry on minimal containers, etc.), returns the literal
 * `'unknown-operator'` — the same default that the v2 → v3 migrator uses
 * when reviving legacy `PhaseOverride` records that pre-date this field.
 *
 * The constant is exported so tests and migrators can pin the same literal
 * without duplicating it.
 */

import * as os from 'node:os';

export const UNKNOWN_OPERATOR = 'unknown-operator';

export function getOperatorActor(): string {
  try {
    const info = os.userInfo();
    const name = info?.username;
    if (typeof name === 'string' && name.length > 0) {
      return name;
    }
    return UNKNOWN_OPERATOR;
  } catch {
    return UNKNOWN_OPERATOR;
  }
}
