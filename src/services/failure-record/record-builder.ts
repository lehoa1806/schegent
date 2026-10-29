// ---------------------------------------------------------------------------
// FR-R4-F15 (feature 243, contract C2) — the builder that turns a failing phase's result into a
// bounded `FailureRecordV1`.
//
// Pure. It reads the `InvocationResult` the driver already holds, the same object the carry-forward
// read uses, and never reads or assigns any driver state: there is no second parse, and nothing here
// can change what the next iteration is told. Every summary passes `boundSummary`; every tag is
// decided by `normalizeIssueTag`, from which code produced the issue and never from its spelling.
// ---------------------------------------------------------------------------

import type { FailureCause } from '../../contracts/failure-cause';
import {
  FAILURE_RECORD_MAX_BYTES,
  FAILURE_RECORD_MAX_ENTRIES,
  FAILURE_RECORD_MAX_METRICS,
  FAILURE_RECORD_METRIC_KEY_MAX,
  FAILURE_RECORD_VERSION,
  RECORD_METRIC_KEY_PATTERN,
  RECORD_PHASE_PATTERN,
  normalizeIssueTag,
  recordFileName,
  type FailureRecordV1,
  type IssueSource,
  type IssueState,
  type RecordEntry,
  type RecordMetric
} from '../../contracts/failure-record';
import { isRecordIdentifier } from '../../contracts/validators/failure-record';
import type { InvocationResult } from '../../parser/stdout-parser';
import type { WorkflowRun } from '../../state/workflow-run';
import { boundSummary, type SummaryContext } from './record-text';

/** What the driver, or the start-failure handler, knows when it fails a Run. */
export interface FailureRecordInput {
  readonly run: Pick<WorkflowRun, 'id' | 'featureId' | 'currentPhase'>;
  readonly cause: FailureCause;
  /** The failing phase's parsed result; `null` when no phase produced one (probe, audit, start). */
  readonly result: InvocationResult | null;
  readonly iteration?: number | undefined;
  readonly iterationCap?: number | undefined;
  readonly stalledCount?: number | undefined;
}

/** Everything the builder takes from its caller besides the input: identity, time and the pipeline. */
export interface RecordBuildContext extends SummaryContext {
  readonly queueId: string;
  readonly failedAt: string;
  readonly suffix: string;
  /** Defaults to 32,768. Tests lower it to reach the size guard, which the bounded content cannot. */
  readonly maxBytes?: number;
}

interface RawEntry {
  readonly kind: RecordEntry['kind'];
  readonly summary: string;
  readonly tag: string | undefined;
  readonly source: IssueSource;
}

interface RawIssues {
  readonly state: IssueState;
  readonly entries: readonly RawEntry[];
}

/** C2.1 — what the result can honestly say about the open issues. */
function rawIssuesOf(result: InvocationResult | null): RawIssues {
  if (result === null) return { state: 'not-applicable', entries: [] };
  switch (result.kind) {
    case 'remaining_issues':
      return {
        state: 'listed',
        entries: result.issues.map((issue) => ({
          kind: 'issue',
          summary: issue.summary,
          tag: issue.tag,
          // The parser sets `source` on the two issues it substitutes and on no other.
          source: issue.source === 'host' ? 'host' : 'agent'
        }))
      };
    case 'open_questions':
      return {
        state: 'listed',
        entries: result.questions.map((question) => ({
          kind: 'question',
          summary: question,
          tag: undefined,
          source: 'agent'
        }))
      };
    case 'clean':
      return { state: 'none-reported', entries: [] };
    default:
      return { state: 'unparsed', entries: [] };
  }
}

/** C2.2 — the first 20 entries that keep any content, in parser order, and how many were not kept. */
function boundEntries(raw: readonly RawEntry[], context: SummaryContext): {
  readonly entries: readonly RecordEntry[];
  readonly omitted: number;
} {
  const entries: RecordEntry[] = [];
  for (const candidate of raw) {
    if (entries.length >= FAILURE_RECORD_MAX_ENTRIES) break;
    const summary = boundSummary(candidate.summary, context);
    if (summary === null) continue;
    entries.push({
      kind: candidate.kind,
      summary,
      tag: normalizeIssueTag(candidate.tag, candidate.source),
      source: candidate.source
    });
  }
  return { entries, omitted: raw.length - entries.length };
}

function isKeptMetric(key: string, value: unknown): value is number {
  return (
    key.length <= FAILURE_RECORD_METRIC_KEY_MAX &&
    RECORD_METRIC_KEY_PATTERN.test(key) &&
    typeof value === 'number' &&
    Number.isFinite(value)
  );
}

/** C2.3 — well-formed keys with finite values, sorted ascending, at most 16; the rest are counted. */
function boundMetrics(metrics: Readonly<Record<string, number>> | undefined): {
  readonly metrics: readonly RecordMetric[];
  readonly omitted: number;
} {
  if (metrics === undefined) return { metrics: [], omitted: 0 };
  const all = Object.entries(metrics);
  const kept = all
    .filter(([key, value]) => isKeptMetric(key, value))
    .map(([key, value]) => ({ key, value }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .slice(0, FAILURE_RECORD_MAX_METRICS);
  return { metrics: kept, omitted: all.length - kept.length };
}

function knownInteger(value: number | undefined, minimum: number): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= minimum ? value : undefined;
}

/** C2.4 — the phase context a phase result carries, each value only when it is known. Never `0`. */
function phaseContext(
  input: FailureRecordInput
): Partial<Pick<FailureRecordV1, 'phase' | 'iteration' | 'iterationCap' | 'stalledCount'>> {
  if (input.result === null) return {};
  const phase = RECORD_PHASE_PATTERN.test(input.run.currentPhase) ? input.run.currentPhase : undefined;
  const iteration = knownInteger(input.iteration, 1);
  const iterationCap = knownInteger(input.iterationCap, 1);
  const stalledCount = knownInteger(input.stalledCount, 0);
  return {
    ...(phase === undefined ? {} : { phase }),
    ...(iteration === undefined ? {} : { iteration }),
    ...(iterationCap === undefined ? {} : { iterationCap }),
    ...(stalledCount === undefined ? {} : { stalledCount })
  };
}

/** The bytes the writer will put on disk. The bound and the writer both measure exactly this. */
function serializedBytes(record: FailureRecordV1): number {
  return Buffer.byteLength(JSON.stringify(record, null, 2) + '\n');
}

/**
 * C2.5 — while the record is over the bound, drop the last entry and count it; with no entry left,
 * drop every metric and count them. The fixed fields cannot exceed the bound (research R6), and the
 * bounded content reaches about 24,200 bytes of 32,768, so this is a guard the caller's tests reach
 * with a lowered bound. A record whose last entry is dropped no longer claims a list it cannot show.
 */
function fitToBound(record: FailureRecordV1, maxBytes: number): FailureRecordV1 {
  let current = record;
  while (serializedBytes(current) > maxBytes) {
    if (current.entries.length > 0) {
      const entries = current.entries.slice(0, -1);
      current = {
        ...current,
        entries,
        omittedIssueCount: current.omittedIssueCount + 1,
        issueState: entries.length === 0 ? 'unparsed' : current.issueState
      };
    } else if (current.metrics.length > 0) {
      current = {
        ...current,
        metrics: [],
        omittedMetricCount: current.omittedMetricCount + current.metrics.length
      };
    } else {
      break;
    }
  }
  return current;
}

/**
 * Build the record for one failure, or `null` when the identity cannot name a file.
 *
 * `null` means nothing is written: a Run or task id that is not a name segment, a suffix that is not
 * 8 lowercase hex, a `failedAt` that is no instant, or a queue id the record would not validate with.
 * Every non-null output passes `isValidFailureRecord` (C2.6).
 */
export function buildFailureRecord(
  input: FailureRecordInput,
  context: RecordBuildContext
): FailureRecordV1 | null {
  const name = recordFileName({
    failedAt: context.failedAt,
    suffix: context.suffix,
    runId: input.run.id,
    taskId: input.run.featureId
  });
  if (name === null || !isRecordIdentifier(context.queueId)) return null;

  const raw = rawIssuesOf(input.result);
  const bounded = boundEntries(raw.entries, context);
  const metrics = boundMetrics(input.result?.auditEntry?.metrics);
  // A listed result that kept nothing is `unparsed`: a record never claims a list it cannot show.
  const issueState: IssueState =
    raw.state === 'listed' && bounded.entries.length === 0 ? 'unparsed' : raw.state;

  const record: FailureRecordV1 = {
    recordVersion: FAILURE_RECORD_VERSION,
    queueId: context.queueId,
    taskId: input.run.featureId,
    runId: input.run.id,
    failedAt: context.failedAt,
    suffix: context.suffix,
    cause: input.cause,
    ...phaseContext(input),
    issueState,
    entries: bounded.entries,
    omittedIssueCount: bounded.omitted,
    metrics: metrics.metrics,
    omittedMetricCount: metrics.omitted
  };
  return fitToBound(record, context.maxBytes ?? FAILURE_RECORD_MAX_BYTES);
}
