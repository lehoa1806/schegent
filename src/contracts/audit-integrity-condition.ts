/**
 * FR-R4-F03 (FR-020; data-model §2) — the payload of the `audit-integrity-condition` event.
 *
 * The audit writer records two conditions about the history itself, never about a Run:
 *
 *   * `damaged-tail` — the chain's last line was not valid JSON, so the writer kept it untouched,
 *     terminated it, and wrote this row after it, naming the line by file basename, line number,
 *     byte offset, byte length and the SHA-256 of its raw bytes. Verification reads that row as the
 *     diagnosis that excuses the damaged line, and as nothing else.
 *   * `history-reset` — the first row of a history that begins after a deliberate operator reset of
 *     the head checkpoint, so the history itself shows the reset.
 *
 * VERSIONED. Each member carries `conditionVersion`. A reader that meets an unknown `condition` or
 * a higher `conditionVersion` preserves the row (hard rule 5) and never reads it as a diagnosis.
 *
 * NO PATH, NO CONTENT. `file` is a basename, never a path, and nothing here carries a row's bytes
 * (FR-019, hard rule 22). It sits in `contracts/` for the reason `failure-cause.ts` does: no state,
 * no dependency, and one definition the writer, the verifier's restated literals and the payload
 * projection can all be checked against.
 */

/** The event type, written only by the audit writer itself and never by a caller. */
export const AUDIT_INTEGRITY_CONDITION_EVENT = 'audit-integrity-condition';

/**
 * The condition of the first row after a deliberate reset, and the two reason codes of a loss finding.
 * Named here, outside `src/audit/`, so the audit writer carries no bare word of the History surface
 * (`tests/contract/history-does-not-change-run-path.test.ts` holds that boundary by text).
 */
export const HISTORY_RESET_CONDITION = 'history-reset';
export const HISTORY_SHORTER_CAUSE = 'history-shorter';
export const HISTORY_MISSING_CAUSE = 'history-missing';
export type HistoryLossCode = typeof HISTORY_SHORTER_CAUSE | typeof HISTORY_MISSING_CAUSE;

/** The two conditions this release writes. Append only. */
export const INTEGRITY_CONDITIONS = ['damaged-tail', HISTORY_RESET_CONDITION] as const;

export type IntegrityCondition = (typeof INTEGRITY_CONDITIONS)[number];

/** The version every condition payload carries today. */
export const INTEGRITY_CONDITION_VERSION = 1;

/** The digest algorithm of a damaged line, recorded so a future change is readable. */
export const DAMAGE_DIGEST_ALG = 'sha256';

export type AuditIntegrityConditionPayload =
  | {
      readonly condition: 'damaged-tail';
      readonly conditionVersion: 1;
      /** Basename only, never a path. */
      readonly file: string;
      /** 1-based line in `file` at diagnosis. */
      readonly line: number;
      /** Offset of the damaged line's first byte in `file`. */
      readonly byteOffset: number;
      /** Bytes of the damaged line, excluding any terminator. */
      readonly byteLength: number;
      readonly digestAlg: 'sha256';
      /** Hex SHA-256 of exactly those bytes. */
      readonly digest: string;
    }
  | {
      readonly condition: 'history-reset';
      readonly conditionVersion: 1;
      /** The retired checkpoint's position. */
      readonly retiredPosition: number;
      readonly retiredAtMs: number;
    };
