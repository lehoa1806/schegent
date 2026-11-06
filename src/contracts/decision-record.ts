/**
 * FR-R5-F19 (feature 278, T19.1) — the decision record a blocked row points at.
 *
 * `specs/278-blocked-work-handoff-recovery/contracts/decision-record-open.md`. A decision record is the
 * `decisions.md` a feature keeps beside its spec. The operator reads it to decide; the host never
 * parses it, never writes it and never hands any of its text to a backend prompt (FR-004). The closed
 * outcome set, the file name and the byte bound live here so the handler, the webview and the tests
 * read one definition.
 */

/** The file the command opens, directly under a feature directory. */
export const DECISION_RECORD_FILE = 'decisions.md';

/**
 * Bytes of one decision record the host will read: 256 KiB. A feature's log of decided and open
 * questions runs to a few tens of KiB; the bound keeps one open request from reading an unbounded
 * file into the host. A larger file is refused as `too-large`, never truncated, because half a record
 * can hide the entry the operator came for.
 */
export const DECISION_RECORD_MAX_BYTES = 262_144;

/** The closed answer set. Every one is acknowledged as accepted; only `opened` reads the body. */
export const DECISION_RECORD_OUTCOMES = [
  'opened',
  'row-not-found',
  'no-record',
  'outside-root',
  'symlink-refused',
  'too-large',
  'not-a-file',
  'unreadable',
  'workspace-not-trusted'
] as const;
export type DecisionRecordOutcome = (typeof DECISION_RECORD_OUTCOMES)[number];
