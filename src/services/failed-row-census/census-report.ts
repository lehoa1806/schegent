// ---------------------------------------------------------------------------
// FR-R4-F16 (feature 244, contract R; research R11) — the Markdown report of the failed-row census.
//
// Pure: it reads only its two arguments. Every value it writes is one of these: a member of a closed
// set (a cause, a disposition, an unknown reason, a row status, a policy), a number, a time rendered
// from a parsed stamp with `new Date(ms).toISOString()`, the version as the port gave it, or an id that
// passes its pattern (a Run or task id passes `isRunId`, a queue id `isValidQueueId`). Any other
// identifier is written as `NOT_AN_ID` and counted. Every sentence is a constant of this module, none
// built from log or queue text. So nothing written needs escaping, and no title, error summary, actor,
// correlation id or path can reach the report because none is ever read into it.
//
// The six sections of D10 are written in order, with every cell present, zeros included, so two
// reports of the same workspace line up. The reconciliation of data-model §7 is printed whether or not
// it holds: the report does not hide a defect the tests are meant to catch.
// ---------------------------------------------------------------------------

import { FAILURE_CAUSES } from '../../contracts/failure-cause';
import { QUEUE_FAILURE_POLICIES } from '../../contracts/queue-failure-policy';
import { isRunId } from '../../contracts/run-id';
import { isValidQueueId } from '../../queue/queue-registry';
import type { FeatureRequestStatus } from '../../queue/feature-request';
import {
  CENSUS_EPISODE_LIST_MAX,
  DISPOSITIONS,
  UNKNOWN_REASONS,
  type CensusCause,
  type CensusResult,
  type Episode,
  type ReportIdentity
} from './census-model';

/** What an identifier, or any value outside its closed set, is written as. */
export const NOT_AN_ID = '(not an id)';

const NOT_LISTED = '—';
const UNRESOLVED_QUEUE = 'unresolved';
const NO_STORED_POLICY = 'none (uses the default)';
const UNKNOWN_VERSION = 'unknown';
const LARGEST_DATE_MS = 8.64e15;
const VERSION_TEXT = /^[0-9A-Za-z.+-]{1,80}$/;

const CENSUS_CAUSES: readonly CensusCause[] = [...FAILURE_CAUSES, 'not-recorded'];

// Exhaustive over the union at compile time: a status added to `FeatureRequestStatus` fails to compile
// here until it is added, so the report cannot write a status it has not been told is closed.
const STATUS_TOKENS = {
  pending: true,
  'in-flight': true,
  paused: true,
  completed: true,
  canceled: true,
  failed: true
} satisfies Record<FeatureRequestStatus, true>;

// The fixed sentences (R1.2). None is built from log or queue text.
const POLICY_LABEL = 'Policies are the values at the cutoff only; a change before it is not audited.';
const EMPTY_LOG_SENTENCE = 'No audit log was found; there are no episodes.';
const LIMIT_POLICY =
  'A queue can run past a failed row under the continue policy. A change of failure policy is not ' +
  'audited, and the workspace default is a setting, so the census cannot tell why a queue ran on.';
const LIMIT_CLEARS =
  'Clear Failed and Clear Done remove rows without any audit entry, so a row they removed reads ' +
  'row-absent. Clear Queue and Clear All are counted as queue-cleared. Deleting a queue is counted as ' +
  'queue-deleted. Neither of those records provenance.';
const LIMIT_METADATA =
  'The census reads metadata only. It cannot see why an operator chose an exit, and it reads no ' +
  'failure record, transcript or title.';

/** Writes values, counting each one it had to replace with `NOT_AN_ID`. */
class ValueWriter {
  private replaced = 0;

  public get notShown(): number {
    return this.replaced;
  }

  private placeholder(): string {
    this.replaced += 1;
    return NOT_AN_ID;
  }

  public runOrTaskId(value: string): string {
    return isRunId(value) ? value : this.placeholder();
  }

  public queueId(value: string): string {
    return isValidQueueId(value) ? value : this.placeholder();
  }

  public time(ms: number | null): string {
    if (ms === null) return 'none';
    return Number.isFinite(ms) && Math.abs(ms) <= LARGEST_DATE_MS ? new Date(ms).toISOString() : this.placeholder();
  }

  public status(value: string): string {
    return value === 'absent' || Object.prototype.hasOwnProperty.call(STATUS_TOKENS, value)
      ? value
      : this.placeholder();
  }

  public policy(value: string): string {
    return (QUEUE_FAILURE_POLICIES as readonly string[]).includes(value) ? value : this.placeholder();
  }
}

function row(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

function identityLines(identity: ReportIdentity, firstProvenanceMs: number | null, writer: ValueWriter): string[] {
  const version = VERSION_TEXT.test(identity.extensionVersion) ? identity.extensionVersion : UNKNOWN_VERSION;
  const lines = [
    '## Identity',
    '',
    `Cutoff: ${writer.time(identity.cutoffMs)}`,
    `Extension version: ${version}`,
    `First removal recording provenance: ${firstProvenanceMs === null ? 'none seen' : writer.time(firstProvenanceMs)}`,
    '',
    POLICY_LABEL,
    '',
    row(['Queue', 'Stored failure policy', 'Workspace default']),
    row(['---', '---', '---'])
  ];
  for (const queue of identity.snapshot.queues) {
    const stored = queue.storedPolicy === null ? NO_STORED_POLICY : writer.policy(queue.storedPolicy);
    const queueText = writer.queueId(queue.queueId);
    lines.push(row([queueText, stored, writer.policy(identity.snapshot.workspaceDefaultPolicy)]));
  }
  return lines;
}

function coverageLines(result: CensusResult, notShown: number): string[] {
  const log = result.log;
  const noLog =
    log.oldestStampMs === null &&
    log.segmentsRead === 0 &&
    log.unreadableSegments === 0 &&
    log.cutRecords === 0 &&
    log.unparseableLines === 0;
  const lines = [
    '## Coverage',
    '',
    `Oldest entry read: ${log.oldestStampMs === null ? 'none' : isoOf(log.oldestStampMs)}`,
    `Newest entry read: ${log.newestStampMs === null ? 'none' : isoOf(log.newestStampMs)}`,
    '',
    `- Segments read: ${log.segmentsRead}`,
    `- Unreadable segments: ${log.unreadableSegments}`,
    `- Cut records met: ${log.cutRecords}`,
    `- Unparseable lines: ${log.unparseableLines} (malformed census entries among them: ${log.malformedCensusEntries})`,
    `- Backwards timestamps: ${log.backwardsStamps}`,
    `- Collapsed duplicates: ${result.collapsedDuplicates}`,
    `- Records after the cutoff: ${result.entriesAfterCutoff}`,
    `- Identifiers not shown: ${notShown}`,
    `- Unrecognized files beside the log, never read: ${log.unrecognizedNames}`
  ];
  if (noLog) lines.push('', EMPTY_LOG_SENTENCE);
  return lines;
}

/** A stamp the log builder parsed with `Date.parse`, so it is finite and inside the date range. */
function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

function totalsLines(result: CensusResult): string[] {
  const columns = [...DISPOSITIONS, 'unknown'] as const;
  const lines = [
    '## Totals',
    '',
    row(['Cause', ...columns, 'Total']),
    row(['---', ...columns.map(() => '---:'), '---:'])
  ];
  const columnSums = columns.map(() => 0);
  for (const cause of CENSUS_CAUSES) {
    const counts = columns.map((column) => result.totals[cause][column]);
    counts.forEach((count, index) => {
      columnSums[index] = (columnSums[index] as number) + count;
    });
    lines.push(row([cause, ...counts.map(String), String(counts.reduce((sum, count) => sum + count, 0))]));
  }
  const grand = columnSums.reduce((sum, count) => sum + count, 0);
  lines.push(row(['Total', ...columnSums.map(String), String(grand)]));
  lines.push(
    '',
    `Episodes: ${result.episodes.length} = failed terminal records read ${result.failedEndsRead} − ` +
      `collapsed duplicates ${result.collapsedDuplicates} − after the cutoff ${result.failedEndsAfterCutoff}.`,
    `Removals that ended more than one episode: ${result.removalsEndingMoreThanOne}.`
  );
  return lines;
}

function unknownsLines(result: CensusResult): string[] {
  return ['## Unknowns', '', ...UNKNOWN_REASONS.map((reason) => `- ${reason}: ${result.unknownsByReason[reason]}`)];
}

function isStillFailed(episode: Episode): boolean {
  return episode.outcome.kind === 'disposition' && episode.outcome.disposition === 'still-failed';
}

function episodeCells(episode: Episode, writer: ValueWriter): string[] {
  const { outcome } = episode;
  const isGap = outcome.kind === 'unknown' && outcome.reason === 'history-gap';
  return [
    writer.time(episode.failedAtMs),
    writer.runOrTaskId(episode.runId),
    writer.runOrTaskId(episode.taskId),
    episode.queueId === null ? UNRESOLVED_QUEUE : writer.queueId(episode.queueId),
    episode.cause,
    outcome.kind === 'disposition' ? outcome.disposition : NOT_LISTED,
    outcome.kind === 'unknown' ? outcome.reason : NOT_LISTED,
    isStillFailed(episode) ? String(episode.laterStartsInQueue) : NOT_LISTED,
    isGap && episode.snapshotStatus !== null ? writer.status(episode.snapshotStatus) : NOT_LISTED
  ];
}

function episodesLines(result: CensusResult, writer: ValueWriter): string[] {
  const lines = [
    '## Episodes',
    '',
    row([
      'Failed at',
      'Run',
      'Task',
      'Queue',
      'Cause',
      'Disposition',
      'Reason',
      'Later starts in queue',
      'Snapshot'
    ]),
    row(['---', '---', '---', '---', '---', '---', '---', '---:', '---'])
  ];
  const { episodes } = result;
  const listed = Math.min(episodes.length, CENSUS_EPISODE_LIST_MAX);
  for (let offset = 1; offset <= listed; offset += 1) {
    lines.push(row(episodeCells(episodes[episodes.length - offset] as Episode, writer)));
  }
  if (episodes.length > listed) {
    lines.push('', `${episodes.length - listed} more episodes are counted in the totals and not listed.`);
  }
  // D11, FR-016: a queue that started later tasks while a failed row stayed failed. The audit log says
  // that it did, never why. Written for every such episode, not only the listed ones: a still-failed
  // episode is one persisted row, so the count is bounded by the queue state.
  const flags: string[] = [];
  for (let index = episodes.length - 1; index >= 0; index -= 1) {
    const episode = episodes[index] as Episode;
    if (!isStillFailed(episode) || episode.laterStartsInQueue === 0 || episode.queueId === null) continue;
    flags.push(
      `Queue ${writer.queueId(episode.queueId)} started ${episode.laterStartsInQueue} later tasks while ` +
        `task ${writer.runOrTaskId(episode.taskId)} stayed failed; the audit log cannot say why.`
    );
  }
  if (flags.length > 0) lines.push('', ...flags);
  return lines;
}

const LIMITS_LINES = ['## Limits', '', LIMIT_POLICY, '', LIMIT_CLEARS, '', LIMIT_METADATA];

/**
 * The report for `result`, at `identity`'s cutoff and against `identity.snapshot`. Newest episodes
 * first, at most `CENSUS_EPISODE_LIST_MAX` of them; the totals always count every episode.
 */
export function renderCensusReport(result: CensusResult, identity: ReportIdentity): string {
  const writer = new ValueWriter();
  const identitySection = identityLines(identity, result.log.firstProvenanceRemovalMs, writer);
  const episodesSection = episodesLines(result, writer);
  // Written last: the count of what was replaced is known only once everything else has been written.
  const coverageSection = coverageLines(result, writer.notShown);
  const sections = [
    identitySection,
    coverageSection,
    totalsLines(result),
    unknownsLines(result),
    episodesSection,
    LIMITS_LINES
  ];
  return `# Failed-row exits\n\n${sections.map((lines) => lines.join('\n')).join('\n\n')}\n`;
}
