import {
  AGENT_ISSUE_TAGS,
  FAILURE_RECORD_MAX_ENTRIES,
  FAILURE_RECORD_MAX_METRICS,
  FAILURE_RECORD_METRIC_KEY_MAX,
  FAILURE_RECORD_NAME,
  FAILURE_RECORD_SUMMARY_MAX,
  FAILURE_RECORD_VERSION,
  HOST_ISSUE_TAGS,
  ISSUE_SOURCES,
  ISSUE_STATES,
  RECORD_ID_PATTERN,
  RECORD_METRIC_KEY_PATTERN,
  RECORD_PHASE_PATTERN,
  RECORD_QUEUE_ID_PATTERN,
  RECORD_SUFFIX_PATTERN,
  UNCLASSIFIED_TAG,
  failedAtStamp,
  stampToFailedAt,
  type FailureRecordV1,
  type ParsedRecordName
} from '../failure-record';
import { isFailureCause } from '../failure-cause';
import {
  CMD_READ_FAILURE_RECORD,
  type ReadFailureRecordResponse,
  type SidebarCommand
} from '../sidebar-ipc';
import { fail, hasUnexpectedKeys, ok, type IpcValidationResult } from './shared';

// FR-R4-F15 (feature 243, contract R2.2, R3) — the one validator for a failure record, and the name
// parser it is checked against. The host reader and the webview both call `isValidFailureRecord`, so
// the file a reader accepts and the record a panel renders cannot be two different questions.

/** The characters no summary may hold: control, format, line and paragraph separators. */
const REJECTED_SUMMARY_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const RECORD_KEYS = [
  'recordVersion',
  'queueId',
  'taskId',
  'runId',
  'failedAt',
  'suffix',
  'cause',
  'phase',
  'iteration',
  'iterationCap',
  'stalledCount',
  'issueState',
  'entries',
  'omittedIssueCount',
  'metrics',
  'omittedMetricCount'
] as const;
const REQUIRED_RECORD_KEYS = RECORD_KEYS.filter(
  (key) => key !== 'phase' && key !== 'iteration' && key !== 'iterationCap' && key !== 'stalledCount'
);
const PHASE_CONTEXT_KEYS = ['phase', 'iteration', 'iterationCap', 'stalledCount'] as const;
const ENTRY_KEYS = ['kind', 'summary', 'tag', 'source'] as const;
const METRIC_KEYS = ['key', 'value'] as const;

/**
 * R2.2 — the identity a record name carries, or `null` when the name is not one this feature wrote.
 * The exact inverse of `recordFileName`: a stamp that names no real instant (month 13) is refused, so
 * every name that parses also names a time.
 */
export function parseRecordName(name: string): ParsedRecordName | null {
  const match = FAILURE_RECORD_NAME.exec(name);
  if (match === null) return null;
  const stamp = match.at(1);
  const suffix = match.at(2);
  const runId = match.at(3);
  const taskId = match.at(4);
  if (stamp === undefined || suffix === undefined || runId === undefined || taskId === undefined) return null;
  const failedAt = stampToFailedAt(stamp);
  if (failedAt === null) return null;
  return { stamp, failedAtMs: Date.parse(failedAt), suffix, runId, taskId };
}

/**
 * An identifier as it may cross the sidebar boundary or become a record's `queueId`: letters, digits,
 * dot, dash and underscore, at most 128, and neither `.` nor `..`. Enumerated, so `../x`, `a/b`,
 * `a\b`, `C:` and `%2e%2e` are refused without this function knowing what any of them is.
 */
export function isRecordIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' && RECORD_QUEUE_ID_PATTERN.test(value) && value !== '.' && value !== '..'
  );
}

type Plain = Readonly<Record<string, unknown>>;

/**
 * A plain object's own data properties, as a prototype-less copy, or `null` for anything else: an
 * array, a class instance, an accessor property, a symbol key, a non-enumerable property. Reading the
 * copy cannot run a getter, because none was allowed to exist. R3.3: a validator that runs the value's
 * code is a validator the value can steer.
 */
function plainData(value: unknown): Plain | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

/** An array's elements, read as data properties only, or `null` past `max` or for an accessor. */
function plainElements(value: unknown, max: number): readonly unknown[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const elements: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) return null;
    elements.push(descriptor.value);
  }
  return elements;
}

function hasOnlyKeys(data: Plain, allowed: readonly string[]): boolean {
  return Object.keys(data).every((key) => allowed.includes(key));
}

function hasAllKeys(data: Plain, required: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(data, key));
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isValidEntry(value: unknown): boolean {
  const entry = plainData(value);
  if (entry === null || !hasOnlyKeys(entry, ENTRY_KEYS) || !hasAllKeys(entry, ENTRY_KEYS)) return false;
  const { kind, summary, tag, source } = entry;
  if (kind !== 'issue' && kind !== 'question') return false;
  if (typeof summary !== 'string' || REJECTED_SUMMARY_CHARACTERS.test(summary)) return false;
  const length = Array.from(summary).length;
  if (length < 1 || length > FAILURE_RECORD_SUMMARY_MAX) return false;
  if (typeof source !== 'string' || !(ISSUE_SOURCES as readonly string[]).includes(source)) return false;
  if (typeof tag !== 'string') return false;
  // A tag belongs to the code that produced the entry: the host's tag only on a host entry, an agent
  // tag only on an agent entry. Anything else is `unclassified` or the file is not ours.
  const tagsOfSource: readonly string[] = source === 'host' ? HOST_ISSUE_TAGS : AGENT_ISSUE_TAGS;
  if (tag !== UNCLASSIFIED_TAG && !tagsOfSource.includes(tag)) return false;
  if (kind === 'question' && (source !== 'agent' || tag !== UNCLASSIFIED_TAG)) return false;
  return true;
}

function isValidMetrics(value: unknown): boolean {
  const metrics = plainElements(value, FAILURE_RECORD_MAX_METRICS);
  if (metrics === null) return false;
  let previous: string | null = null;
  for (const element of metrics) {
    const metric = plainData(element);
    if (metric === null || !hasOnlyKeys(metric, METRIC_KEYS) || !hasAllKeys(metric, METRIC_KEYS)) return false;
    const { key, value: amount } = metric;
    if (typeof key !== 'string' || key.length > FAILURE_RECORD_METRIC_KEY_MAX) return false;
    if (!RECORD_METRIC_KEY_PATTERN.test(key)) return false;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return false;
    // Strictly ascending, which also means unique.
    if (previous !== null && key <= previous) return false;
    previous = key;
  }
  return true;
}

function matchesName(data: Plain, expected: ParsedRecordName): boolean {
  return (
    data['runId'] === expected.runId &&
    data['taskId'] === expected.taskId &&
    data['suffix'] === expected.suffix &&
    typeof data['failedAt'] === 'string' &&
    failedAtStamp(data['failedAt']) === expected.stamp
  );
}

function isValidIdentity(data: Plain): boolean {
  if (!isRecordIdentifier(data['queueId'])) return false;
  const { taskId, runId, suffix, failedAt, cause } = data;
  if (typeof taskId !== 'string' || !RECORD_ID_PATTERN.test(taskId)) return false;
  if (typeof runId !== 'string' || !RECORD_ID_PATTERN.test(runId)) return false;
  if (typeof suffix !== 'string' || !RECORD_SUFFIX_PATTERN.test(suffix)) return false;
  if (typeof failedAt !== 'string' || failedAtStamp(failedAt) === null) return false;
  return isFailureCause(cause);
}

function isValidPhaseContext(data: Plain): boolean {
  const { phase, iteration, iterationCap, stalledCount } = data;
  if (Object.hasOwn(data, 'phase') && (typeof phase !== 'string' || !RECORD_PHASE_PATTERN.test(phase))) return false;
  if (Object.hasOwn(data, 'iteration') && !isPositiveInteger(iteration)) return false;
  if (Object.hasOwn(data, 'iterationCap') && !isPositiveInteger(iterationCap)) return false;
  if (Object.hasOwn(data, 'stalledCount') && !isCount(stalledCount)) return false;
  // `iteration <= iterationCap` is NOT required: a resumed phase re-runs at the iteration it failed on.
  return true;
}

function isValidEntriesFor(data: Plain): boolean {
  const state = data['issueState'];
  if (typeof state !== 'string' || !(ISSUE_STATES as readonly string[]).includes(state)) return false;
  const entries = plainElements(data['entries'], FAILURE_RECORD_MAX_ENTRIES);
  if (entries === null) return false;
  if (state === 'listed' ? entries.length < 1 : entries.length !== 0) return false;
  if (state === 'not-applicable' && PHASE_CONTEXT_KEYS.some((key) => Object.hasOwn(data, key))) return false;
  return entries.every(isValidEntry);
}

/**
 * R3.1 — does `value` satisfy every rule of data-model §4?
 *
 * `expected` is the parsed name when the record was read from disk: the record's Run, task, suffix and
 * time must then equal the name's, so a file renamed or copied under another Run's name is malformed
 * rather than shown as that Run's. Returns `false` for any input and never throws, getters, cycles and
 * hostile proxies included (R3.3).
 */
export function isValidFailureRecord(value: unknown, expected?: ParsedRecordName): value is FailureRecordV1 {
  try {
    const data = plainData(value);
    if (data === null) return false;
    if (!hasOnlyKeys(data, RECORD_KEYS) || !hasAllKeys(data, REQUIRED_RECORD_KEYS)) return false;
    if (data['recordVersion'] !== FAILURE_RECORD_VERSION) return false;
    if (!isValidIdentity(data) || !isValidPhaseContext(data)) return false;
    if (!isCount(data['omittedIssueCount']) || !isCount(data['omittedMetricCount'])) return false;
    if (!isValidEntriesFor(data) || !isValidMetrics(data['metrics'])) return false;
    return expected === undefined || matchesName(data, expected);
  } catch {
    return false;
  }
}

// FR-R4-F15 (contract Q2.1) — two identifiers and nothing else. As with the history description, a
// row that exists is state, not shape: an identifier that is well formed and names no row is the
// handler's `unknown-row`, so a stale queue id is not reported to the operator as a protocol error.
// A value that is not an identifier at all (`../x`, `a/b`, `C:\x`, `%2e%2e`) is refused here and never
// reaches a filesystem call.
export function validateReadFailureRecord(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const context = { type: CMD_READ_FAILURE_RECORD, correlationId };
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('missing-payload', context);
  }
  const value = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(value, ['queueId', 'taskId'])) return fail('unexpected-payload-fields', context);
  const { queueId, taskId } = value;
  if (!isRecordIdentifier(queueId)) return fail('invalid-queueId', context);
  if (!isRecordIdentifier(taskId)) return fail('invalid-taskId', context);
  return ok({ ...context, payload: { queueId, taskId } } as SidebarCommand);
}

const READ_FAILURE_RECORD_FAILURES = ['unknown-row', 'internal-error'] as const;
const ANSWER_ONLY_OUTCOMES = ['none', 'expired', 'unavailable'] as const;

function isRecordCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function addressMatches(data: Plain): boolean {
  return isRecordIdentifier(data['queueId']) && isRecordIdentifier(data['taskId']);
}

/**
 * FR-R4-F15 (contract Q2.2) — the webview's gate before it renders a record.
 *
 * Validated arm by arm, because the arms render differently, and a result that only checked
 * `typeof outcome === 'string'` would let a malformed ack fall through to whichever arm the panel
 * tested last. An `available` arm runs the SAME validator the host's reader runs on the file
 * (`isValidFailureRecord`), and the record must name the very row the arm answers, so a record cannot
 * be shown under another row's name. No arm has a field that could carry a path.
 */
export function isValidReadFailureRecordResponse(value: unknown): value is ReadFailureRecordResponse {
  try {
    const data = plainData(value);
    if (data === null) return false;
    const outcome = data['outcome'];
    if (outcome === 'failure') {
      return (
        hasOnlyKeys(data, ['outcome', 'reason']) &&
        hasAllKeys(data, ['outcome', 'reason']) &&
        (READ_FAILURE_RECORD_FAILURES as readonly unknown[]).includes(data['reason'])
      );
    }
    if (typeof outcome !== 'string') return false;
    if ((ANSWER_ONLY_OUTCOMES as readonly string[]).includes(outcome)) {
      const keys = ['outcome', 'queueId', 'taskId'];
      return hasOnlyKeys(data, keys) && hasAllKeys(data, keys) && addressMatches(data);
    }
    if (outcome === 'malformed') {
      const keys = ['outcome', 'queueId', 'taskId', 'recordCount'];
      return hasOnlyKeys(data, keys) && hasAllKeys(data, keys) && addressMatches(data) && isRecordCount(data['recordCount']);
    }
    if (outcome === 'available') {
      const keys = ['outcome', 'queueId', 'taskId', 'record', 'recordCount'];
      if (!hasOnlyKeys(data, keys) || !hasAllKeys(data, keys) || !addressMatches(data)) return false;
      if (!isRecordCount(data['recordCount']) || !isValidFailureRecord(data['record'])) return false;
      const record = data['record'];
      return record.queueId === data['queueId'] && record.taskId === data['taskId'];
    }
    return false;
  } catch {
    return false;
  }
}
