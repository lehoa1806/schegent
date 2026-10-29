/**
 * FR-R4-F15 (feature 243, contract R) — the bounded record a failed Run leaves behind.
 *
 * WHAT IT IS. One immutable, redacted, path-free file per failure, written beside the session tree
 * and not inside it, so Remove (which deletes the session tree) does not take it. It holds what the
 * agent said was still open when the Run failed, in at most 20 entries of 240 characters, plus the
 * phase context and the audit block's metrics. It is diagnostic content for an operator to read. It
 * is not audit evidence, and no queue decision reads it (hard rule 66; `failure-record-isolation`).
 *
 * WHY THIS SITS IN `contracts/`. The webview imports values only from here
 * (`webview-host-import-direction.test.ts`), and it validates and renders the record, so the shape,
 * the closed sets and the file name live where both sides can read them and cannot disagree. This
 * module has no state and imports nothing from outside this directory. The validator is the sibling
 * `validators/failure-record.ts`; the I/O is `services/failure-record/`.
 *
 * GROWTH RULE. A record names its version, and a reader that meets another version treats the file as
 * malformed rather than guessing. The closed tag sets are appended to, never renamed.
 */
import type { FailureCause } from './failure-cause';

/** The only record version. Any other value, a future one included, reads as malformed. */
export const FAILURE_RECORD_VERSION = 1;
/** D3 — entries kept per record; the rest are counted, not kept. */
export const FAILURE_RECORD_MAX_ENTRIES = 20;
/** D3 — characters per summary, counted as Unicode code points so a cut never splits one. */
export const FAILURE_RECORD_SUMMARY_MAX = 240;
/** D3 — metrics kept per record. */
export const FAILURE_RECORD_MAX_METRICS = 16;
/** D3 — characters in a metric key. */
export const FAILURE_RECORD_METRIC_KEY_MAX = 64;
/** D3 — bytes of one serialized record, `JSON.stringify(record, null, 2)` plus a newline. */
export const FAILURE_RECORD_MAX_BYTES = 32_768;
/** D5 — records kept per workspace; the sweep removes the oldest beyond it. */
export const FAILURE_RECORD_RETAINED_MAX = 200;
/** D1 — where the records live, as the segments `openWithinRoot` walks under the workspace root. */
export const FAILURE_RECORD_DIR = ['.schegent', 'failure-records'] as const;

/**
 * D2 — `<stamp>_<suffix>_<runId>_<taskId>.json`. The `_` cannot occur in either id, so the parse is
 * exact. A name that does not match is not a record, and nothing that reads or sweeps the directory
 * ever touches it.
 */
export const FAILURE_RECORD_NAME =
  /^(\d{8}T\d{9}Z)_([0-9a-f]{8})_([A-Za-z0-9-]{1,64})_([A-Za-z0-9-]{1,64})\.json$/;
/** The Run and task ids a name is built from. Both are `randomUUID()` in practice. */
export const RECORD_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
/** The queue id the body carries. Wider than a name segment because the queue id is not in the name. */
export const RECORD_QUEUE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
/** The phase id the body carries. */
export const RECORD_PHASE_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
/** A metric key: an identifier, so it can never read as markup or a path. */
export const RECORD_METRIC_KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** The suffix of a name and of a record: 8 lowercase hex characters. */
export const RECORD_SUFFIX_PATTERN = /^[0-9a-f]{8}$/;

/** D6 — the five labels the example phases ask the agent for. A claim, never a decision input. */
export const AGENT_ISSUE_TAGS = [
  'regression',
  'pre-existing',
  'environment',
  'needs-approval',
  'needs-decision'
] as const;
/** D6 — the one label only the host's own substituted issues carry. */
export const HOST_ISSUE_TAGS = ['constitution'] as const;
export type RecordTag =
  | (typeof AGENT_ISSUE_TAGS)[number]
  | (typeof HOST_ISSUE_TAGS)[number]
  | 'unclassified';
/** The tag of an entry no closed tag fits: untagged, unknown, forged or an open question. */
export const UNCLASSIFIED_TAG = 'unclassified';

/** Who wrote an entry. `host` is set by the parser at its two substitution sites and nowhere else. */
export const ISSUE_SOURCES = ['agent', 'host'] as const;
export type IssueSource = (typeof ISSUE_SOURCES)[number];

/** D4 — what the record can honestly say about the open issues. */
export const ISSUE_STATES = ['listed', 'none-reported', 'unparsed', 'not-applicable'] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

export interface RecordEntry {
  readonly kind: 'issue' | 'question';
  /** Stripped, redacted, path-free, at most 240 code points. */
  readonly summary: string;
  readonly tag: RecordTag;
  readonly source: IssueSource;
}

export interface RecordMetric {
  readonly key: string;
  readonly value: number;
}

export interface FailureRecordV1 {
  readonly recordVersion: 1;
  readonly queueId: string;
  readonly taskId: string;
  readonly runId: string;
  /** ISO 8601 UTC with milliseconds; equals the name's stamp. */
  readonly failedAt: string;
  /** 8 lowercase hex; equals the name's suffix. */
  readonly suffix: string;
  readonly cause: FailureCause;
  readonly phase?: string;
  readonly iteration?: number;
  readonly iterationCap?: number;
  readonly stalledCount?: number;
  readonly issueState: IssueState;
  readonly entries: readonly RecordEntry[];
  readonly omittedIssueCount: number;
  readonly metrics: readonly RecordMetric[];
  readonly omittedMetricCount: number;
}

/** What a record name says, parsed by `parseRecordName`. */
export interface ParsedRecordName {
  readonly stamp: string;
  readonly failedAtMs: number;
  readonly suffix: string;
  readonly runId: string;
  readonly taskId: string;
}

/**
 * R1.3 — the one place a tag is decided.
 *
 * By the code that produced the issue, never by how it is spelled: a host issue keeps only a host
 * tag, an agent issue keeps only an agent tag, and anything else is `unclassified`. An agent's own
 * `[constitution]` bullet therefore reads as the agent's claim, not as the host's substitute. Matching
 * is exact and case-sensitive because the parser reads lowercase tags only.
 */
export function normalizeIssueTag(tag: string | undefined, source: IssueSource): RecordTag {
  if (tag === undefined) return UNCLASSIFIED_TAG;
  const allowed: readonly string[] = source === 'host' ? HOST_ISSUE_TAGS : AGENT_ISSUE_TAGS;
  return allowed.includes(tag) ? (tag as RecordTag) : UNCLASSIFIED_TAG;
}

/**
 * `YYYYMMDDTHHmmssSSSZ` in UTC for a `failedAt` that is an ISO 8601 string with milliseconds, or
 * `null` for any other string. The round trip through `Date` is what refuses `2026-10-28T14:30:05Z`
 * (no milliseconds) and `2026-13-01T00:00:00.000Z` (no such month).
 */
export function failedAtStamp(failedAt: string): string | null {
  const ms = Date.parse(failedAt);
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  if (iso !== failedAt) return null;
  const stamp = iso.replace(/[-:.]/g, '');
  return /^\d{8}T\d{9}Z$/.test(stamp) ? stamp : null;
}

/** The inverse of {@link failedAtStamp}: the ISO string a stamp names, or `null` for a stamp that is no real instant. */
export function stampToFailedAt(stamp: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(stamp);
  if (match === null) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`;
  return failedAtStamp(iso) === stamp ? iso : null;
}

/**
 * R2.1 — the file name for a record's identity, or `null` when any part cannot be a name segment.
 * A `null` means nothing is written: the caller never composes a path from an id it has not checked.
 */
export function recordFileName(identity: {
  readonly failedAt: string;
  readonly suffix: string;
  readonly runId: string;
  readonly taskId: string;
}): string | null {
  const { failedAt, suffix, runId, taskId } = identity;
  if (!RECORD_SUFFIX_PATTERN.test(suffix)) return null;
  if (!RECORD_ID_PATTERN.test(runId) || !RECORD_ID_PATTERN.test(taskId)) return null;
  const stamp = failedAtStamp(failedAt);
  if (stamp === null) return null;
  return `${stamp}_${suffix}_${runId}_${taskId}.json`;
}
