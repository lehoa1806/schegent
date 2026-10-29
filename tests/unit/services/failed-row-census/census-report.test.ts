/**
 * FR-R4-F16 (feature 244) — contract R3.1 to R3.6: the report the census command opens.
 *
 * `specs/244-failed-row-exit-evidence/contracts/census-report.md`. Every case renders a result from
 * contract E's fixture, or from a synthetic log built the same way. The report writes only closed-set
 * tokens, numbers, times and ids that pass their patterns, so nothing in it needs escaping: R3.5 and
 * R3.6 search the text for what must never appear, and a control in each shows the search can hit.
 */
import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { FAILURE_CAUSES } from '../../../../src/contracts/failure-cause';
import {
  CENSUS_EPISODE_LIST_MAX,
  DISPOSITIONS,
  UNKNOWN_REASONS,
  type CensusResult
} from '../../../../src/services/failed-row-census/census-model';
import { NOT_AN_ID, renderCensusReport } from '../../../../src/services/failed-row-census/census-report';
import { runFailedRowCensus } from '../../../../src/services/failed-row-census/failed-row-census';
import {
  HISTORIES,
  HistoryBuilder,
  QUEUE_DEFAULT,
  SENTINELS,
  history,
  runId,
  taskId,
  type BuiltHistory
} from '../../../fixtures/failed-row-census/histories';

const VERSION = '0.2.0';
const HEADINGS = ['Identity', 'Coverage', 'Totals', 'Unknowns', 'Episodes', 'Limits'] as const;

function render(built: BuiltHistory): { result: CensusResult; text: string } {
  const result = runFailedRowCensus(built.log, built.snapshot);
  const text = renderCensusReport(result, {
    cutoffMs: built.cutoffMs,
    extensionVersion: VERSION,
    snapshot: built.snapshot
  });
  return { result, text };
}

/** The lines of one `##` section, without its heading. */
function section(text: string, heading: string): string[] {
  const lines = text.split('\n');
  const start = lines.indexOf(`## ${heading}`);
  expect(start, `heading ${heading}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => line.startsWith('## '));
  return next === -1 ? rest : rest.slice(0, next);
}

function tableRows(lines: readonly string[]): string[][] {
  return lines
    .filter((line) => line.startsWith('|'))
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()));
}

/** A history with several outcomes, so the report is not trivially short. */
function fullHistory(): BuiltHistory {
  const builder = new HistoryBuilder()
    .policy(QUEUE_DEFAULT, 'continue')
    .start(runId(1), taskId(1), QUEUE_DEFAULT)
    .fail(runId(1), taskId(1), 'phase_failed')
    .remove(taskId(1), QUEUE_DEFAULT, 'completed', { run: runId(1), provenance: 'attested' })
    .start(runId(2), taskId(2), QUEUE_DEFAULT)
    .fail(runId(2), taskId(2), 'cap_exhausted')
    .start(runId(3), taskId(3), QUEUE_DEFAULT)
    .start(runId(4), taskId(4), QUEUE_DEFAULT)
    .fail(runId(5), taskId(5), 'omit')
    .row({ queue: QUEUE_DEFAULT, taskId: taskId(2), status: 'failed', runId: runId(2) });
  return builder.build();
}

describe('the report: its six sections (contract R3.1)', () => {
  it.each([
    ['an empty log', () => history('E6.29')],
    ['a full one', fullHistory]
  ])('writes the title and the six headings once each, in order, for %s', (_name, build) => {
    const { text } = render(build());
    const lines = text.split('\n');
    expect(lines[0]).toBe('# Failed-row exits');
    expect(lines.filter((line) => line.startsWith('# '))).toHaveLength(1);
    const headings = lines.filter((line) => line.startsWith('## '));
    expect(headings).toEqual(HEADINGS.map((heading) => `## ${heading}`));
  });
});

describe('the report: identity and coverage (contract R2 items 1 and 2)', () => {
  it('names the cutoff, the version and the first removal that recorded provenance', () => {
    const { text } = render(history('E6.3'));
    const identity = section(text, 'Identity').join('\n');
    expect(identity).toContain(`Cutoff: ${new Date(history('E6.3').cutoffMs).toISOString()}`);
    expect(identity).toContain(`Extension version: ${VERSION}`);
    expect(identity).toMatch(/First removal recording provenance: \d{4}-\d{2}-\d{2}T[\d:.]+Z/);
  });

  it('says none seen when no removal carried the key', () => {
    const identity = section(render(history('E6.1')).text, 'Identity').join('\n');
    expect(identity).toContain('First removal recording provenance: none seen');
  });

  it('lists one policy row per snapshot queue, with none (uses the default) for a queue with no override', () => {
    const built = new HistoryBuilder()
      .policy(QUEUE_DEFAULT, 'continue')
      .row({ queue: QUEUE_DEFAULT, taskId: taskId(1), status: 'pending', runId: null })
      .defaultIs('halt-on-failure')
      .build();
    const rows = tableRows(section(render(built).text, 'Identity'));
    expect(rows[0]).toEqual(['Queue', 'Stored failure policy', 'Workspace default']);
    expect(rows[2]).toEqual([QUEUE_DEFAULT, 'continue', 'halt-on-failure']);

    const none = tableRows(section(render(history('E6.12')).text, 'Identity'));
    expect(none[2]).toEqual([QUEUE_DEFAULT, 'none (uses the default)', 'halt-on-failure']);
  });

  it('counts every coverage figure the log and the result hold', () => {
    const built = new HistoryBuilder()
      .start(runId(1), taskId(1), QUEUE_DEFAULT)
      .fail(runId(1), taskId(1))
      .fail(runId(1), taskId(1))
      .cut()
      .unreadable()
      .unparseable()
      .malformedStart()
      .build();
    const { text } = render(built);
    const coverage = section(text, 'Coverage').join('\n');
    expect(coverage).toContain('Segments read: 0');
    expect(coverage).toContain('Unreadable segments: 1');
    expect(coverage).toContain('Cut records met: 1');
    expect(coverage).toContain('Unparseable lines: 2 (malformed census entries among them: 1)');
    expect(coverage).toContain('Backwards timestamps: 0');
    expect(coverage).toContain('Collapsed duplicates: 1');
    expect(coverage).toContain('Records after the cutoff: 0');
    expect(coverage).toContain('Identifiers not shown: 0');
    expect(coverage).toContain('Unrecognized files beside the log, never read: 0');
    expect(coverage).toMatch(/Oldest entry read: \d{4}-/);
    expect(coverage).toMatch(/Newest entry read: \d{4}-/);
  });

  it('says there is no audit log, as a sentence and not an error, for an empty log only', () => {
    const empty = section(render(history('E6.29')).text, 'Coverage').join('\n');
    expect(empty).toContain('No audit log was found; there are no episodes.');
    expect(empty).toContain('Oldest entry read: none');
    expect(section(render(history('E6.1')).text, 'Coverage').join('\n')).not.toContain('No audit log was found');
  });
});

describe('the report: the totals table (contract R3.2)', () => {
  it('sums every row and every column to its Total, and the grand total to the episode count', () => {
    const { result, text } = render(fullHistory());
    const rows = tableRows(section(text, 'Totals'));
    const header = rows[0] as string[];
    expect(header).toEqual(['Cause', ...DISPOSITIONS, 'unknown', 'Total']);
    const body = rows.slice(2);
    const causes = [...FAILURE_CAUSES, 'not-recorded'];
    expect(body.map((row) => row[0])).toEqual([...causes, 'Total']);

    const numeric = body.map((row) => row.slice(1).map(Number));
    for (const row of numeric) {
      expect(row.slice(0, -1).reduce((sum, value) => sum + value, 0)).toBe(row[row.length - 1]);
    }
    const columnCount = header.length - 1;
    for (let column = 0; column < columnCount; column += 1) {
      const above = numeric.slice(0, -1).reduce((sum, row) => sum + (row[column] as number), 0);
      expect((numeric[numeric.length - 1] as number[])[column]).toBe(above);
    }
    const grand = (numeric[numeric.length - 1] as number[])[columnCount - 1];
    expect(grand).toBe(result.episodes.length);
    expect(result.episodes.length).toBeGreaterThan(2);
  });

  it('writes every cell, zeros included, so two reports line up', () => {
    const rows = tableRows(section(render(history('E6.29')).text, 'Totals')).slice(2);
    for (const row of rows) for (const cell of row.slice(1)) expect(cell).toBe('0');
    expect(rows).toHaveLength(FAILURE_CAUSES.length + 2);
  });

  it('lists every unknown reason in order, beside the totals and not folded into them', () => {
    const lines = section(render(fullHistory()).text, 'Unknowns').filter((line) => line.startsWith('- '));
    expect(lines.map((line) => line.slice(2).split(':')[0])).toEqual([...UNKNOWN_REASONS]);
    for (const line of lines) expect(line).toMatch(/: \d+$/);
  });
});

describe('the report: the reconciliation line (contract R3.3)', () => {
  const RECONCILIATION =
    /^Episodes: (\d+) = failed terminal records read (\d+) − collapsed duplicates (\d+) − after the cutoff (\d+)\.$/;

  it('writes the result\'s own numbers, which satisfy n = a - b - c, for every history in the table', () => {
    for (const id of Object.keys(HISTORIES)) {
      const { result, text } = render(history(id));
      const totals = section(text, 'Totals');
      const line = totals.find((candidate) => RECONCILIATION.test(candidate));
      expect(line, id).toBeDefined();
      const [, episodes, read, duplicates, after] = RECONCILIATION.exec(line as string) as RegExpExecArray;
      expect(Number(episodes), id).toBe(result.episodes.length);
      expect(Number(read), id).toBe(result.failedEndsRead);
      expect(Number(duplicates), id).toBe(result.collapsedDuplicates);
      expect(Number(after), id).toBe(result.failedEndsAfterCutoff);
      expect(Number(episodes), id).toBe(Number(read) - Number(duplicates) - Number(after));
      expect(totals, id).toContain('Removals that ended more than one episode: 0.');
    }
  });

  it('writes both lines whether or not they hold', () => {
    const { result } = render(history('E6.1'));
    const broken: CensusResult = { ...result, removalsEndingMoreThanOne: 2, failedEndsRead: 7 };
    const text = renderCensusReport(broken, {
      cutoffMs: history('E6.1').cutoffMs,
      extensionVersion: VERSION,
      snapshot: history('E6.1').snapshot
    });
    const totals = section(text, 'Totals');
    expect(totals).toContain('Removals that ended more than one episode: 2.');
    expect(totals).toContain('Episodes: 1 = failed terminal records read 7 − collapsed duplicates 0 − after the cutoff 0.');
  });
});

describe('the report: the episode list (contract R3.4)', () => {
  function manyEpisodes(count: number): BuiltHistory {
    const builder = new HistoryBuilder();
    for (let index = 1; index <= count; index += 1) {
      builder.start(runId(index), taskId(index), QUEUE_DEFAULT).fail(runId(index), taskId(index));
    }
    return builder.build();
  }

  it('lists 200 of 205 episodes, newest first, and says the other 5 are counted and not listed', () => {
    const { result, text } = render(manyEpisodes(205));
    expect(result.episodes).toHaveLength(205);
    const rows = tableRows(section(text, 'Episodes')).slice(2);
    expect(rows).toHaveLength(CENSUS_EPISODE_LIST_MAX);
    expect(rows[0]?.[1]).toBe(runId(205));
    expect(rows[CENSUS_EPISODE_LIST_MAX - 1]?.[1]).toBe(runId(6));
    expect(section(text, 'Episodes')).toContain('5 more episodes are counted in the totals and not listed.');
  });

  it('writes no more-episodes line when everything is listed', () => {
    const { text } = render(manyEpisodes(3));
    expect(text).not.toContain('more episodes are counted');
    expect(tableRows(section(text, 'Episodes')).slice(2)).toHaveLength(3);
  });

  it('fills later starts for still-failed rows only, and the snapshot status for history-gap only', () => {
    const header = tableRows(section(render(history('E6.12')).text, 'Episodes'))[0] as string[];
    expect(header).toEqual([
      'Failed at',
      'Run',
      'Task',
      'Queue',
      'Cause',
      'Disposition',
      'Reason',
      'Later starts in queue',
      'Snapshot'
    ]);
    const stillFailed = tableRows(section(render(history('E6.12')).text, 'Episodes'))[2] as string[];
    expect(stillFailed[5]).toBe('still-failed');
    expect(stillFailed[7]).toBe('2');
    expect(stillFailed[8]).toBe('—');
    const gap = tableRows(section(render(history('E6.10')).text, 'Episodes'))[2] as string[];
    expect(gap[5]).toBe('—');
    expect(gap[6]).toBe('history-gap');
    expect(gap[7]).toBe('—');
    expect(gap[8]).toBe('failed');
  });

  it('writes the cause of a Run that failed before causes were recorded as not-recorded', () => {
    const row = tableRows(section(render(fullHistory()).text, 'Episodes')).slice(2).find((cells) => cells[1] === runId(5));
    expect(row?.[4]).toBe('not-recorded');
  });
});

describe('the report: nothing from the log or the queue reaches it (contract R3.5)', () => {
  it('writes no planted sentinel, no temporary root and no path for any history in the table', () => {
    for (const id of Object.keys(HISTORIES)) {
      const { text } = render(history(id));
      for (const sentinel of SENTINELS) expect(text, `${id} ${sentinel}`).not.toContain(sentinel);
      expect(text, id).not.toContain(os.tmpdir());
      expect(text, id).not.toContain('/');
      expect(text, id).not.toContain('\\');
    }
  });

  it('control: the same search finds a sentinel put into the text', () => {
    const { text } = render(history('E6.1'));
    const planted = `${text}\n${SENTINELS[0]}`;
    expect(SENTINELS.some((sentinel) => planted.includes(sentinel))).toBe(true);
    expect(`${text}${os.tmpdir()}`.includes(os.tmpdir())).toBe(true);
  });
});

describe('the report: identifiers that fail their pattern are not shown (contract R3.6)', () => {
  const HOSTILE = {
    run: 'HOSTILE-RUN|cell',
    task: '`HOSTILE-TASK`',
    queue: '<script>HOSTILE-QUEUE</script>',
    snapshotQueue: 'HOSTILE-SNAPSHOT\nNEWLINE'
  } as const;

  function hostileHistory(): BuiltHistory {
    return new HistoryBuilder()
      .start(HOSTILE.run, HOSTILE.task, HOSTILE.queue)
      .fail(HOSTILE.run, HOSTILE.task)
      .row({ queue: HOSTILE.queue, taskId: HOSTILE.task, status: 'failed', runId: HOSTILE.run })
      .row({ queue: HOSTILE.snapshotQueue, taskId: taskId(7), status: 'pending', runId: null })
      .build();
  }

  it('renders each as (not an id), writes none of it, and counts each', () => {
    const { result, text } = render(hostileHistory());
    expect(result.episodes).toHaveLength(1);
    expect(NOT_AN_ID).toBe('(not an id)');
    for (const fragment of ['HOSTILE', '<script>', '</script>', '`', 'NEWLINE']) {
      expect(text, fragment).not.toContain(fragment);
    }
    // The episode's run, task and queue, and the two snapshot queues in the identity table.
    const shown = text.split(NOT_AN_ID).length - 1;
    expect(shown).toBe(5);
    expect(section(text, 'Coverage').join('\n')).toContain(`Identifiers not shown: ${shown}`);
  });

  it('keeps every table row on one line, so a planted newline cannot start a heading or a row', () => {
    const { text } = render(hostileHistory());
    const headings = text.split('\n').filter((line) => line.startsWith('#'));
    expect(headings).toEqual(['# Failed-row exits', ...HEADINGS.map((heading) => `## ${heading}`)]);
    for (const row of tableRows(section(text, 'Episodes'))) expect(row).toHaveLength(9);
  });

  it('shows ids that pass their patterns, so the placeholder is not simply everywhere', () => {
    const { text } = render(history('E6.1'));
    expect(text).not.toContain(NOT_AN_ID);
    expect(text).toContain(runId(1));
    expect(text).toContain(taskId(1));
    expect(text).toContain(QUEUE_DEFAULT);
  });
});

describe('the report: its fixed limits (contract R2 item 6)', () => {
  it('ends with three paragraphs of fixed text', () => {
    const limits = section(render(history('E6.1')).text, 'Limits').filter((line) => line.trim().length > 0);
    expect(limits).toHaveLength(3);
    expect(limits[0]).toContain('continue');
    expect(limits[0]).toContain('not audited');
    expect(limits[1]).toContain('Clear Failed and Clear Done');
    expect(limits[1]).toContain('row-absent');
    expect(limits[2]).toContain('metadata only');
  });
});

// Contract R3.7 and User Story 4: a queue that ran past a failed row is flagged with its count and its
// stated limit, and the policies are labelled as the cutoff's.
describe('the report: a queue that ran past a failed row (contract R3.7, FR-016)', () => {
  const POLICY_LABEL = 'Policies are the values at the cutoff only; a change before it is not audited.';
  const FLAG_LINE = /^Queue .+ started \d+ later tasks while task .+ stayed failed; the audit log cannot say why\.$/;

  it('writes exactly one flag line for E6.12, with its queue, its count of 2 and its task', () => {
    const { text } = render(history('E6.12'));
    const flags = text.split('\n').filter((line) => FLAG_LINE.test(line));
    expect(flags).toEqual([
      `Queue ${QUEUE_DEFAULT} started 2 later tasks while task ${taskId(1)} stayed failed; the audit log cannot say why.`
    ]);
    expect(section(text, 'Episodes')).toContain(flags[0]);
  });

  it('places the flag line after the episode table', () => {
    const lines = section(render(history('E6.12')).text, 'Episodes');
    const lastRow = lines.map((line) => line.startsWith('|')).lastIndexOf(true);
    expect(lines.findIndex((line) => FLAG_LINE.test(line))).toBeGreaterThan(lastRow);
  });

  it('labels the policies as the values at the cutoff, immediately above the identity table', () => {
    const lines = section(render(history('E6.12')).text, 'Identity');
    const header = lines.findIndex((line) => line === '| Queue | Stored failure policy | Workspace default |');
    expect(header).toBeGreaterThan(0);
    const before = lines.slice(0, header).filter((line) => line.trim().length > 0);
    expect(before[before.length - 1]).toBe(POLICY_LABEL);
  });

  it('writes the label whether or not a queue ran on, and once', () => {
    const { text } = render(history('E6.1'));
    expect(text.split('\n').filter((line) => line === POLICY_LABEL)).toHaveLength(1);
  });

  it('control: a history with no later starts yields neither the flag line nor any "started ... later tasks" text', () => {
    const { text } = render(history('E6.1'));
    expect(text.split('\n').filter((line) => FLAG_LINE.test(line))).toEqual([]);
    expect(text).not.toMatch(/started \d+ later tasks/);
  });

  it('flags only still-failed rows: a failure that was resumed is not flagged though other tasks started', () => {
    const built = new HistoryBuilder()
      .start(runId(1), taskId(1), QUEUE_DEFAULT)
      .fail(runId(1), taskId(1))
      .start(runId(2), taskId(2), QUEUE_DEFAULT)
      .start(runId(1), taskId(1), QUEUE_DEFAULT, true)
      .build();
    expect(render(built).text).not.toMatch(/started \d+ later tasks/);
  });

  it('writes one line for each still-failed row of each queue, and shows ids that fail their pattern as (not an id)', () => {
    const built = new HistoryBuilder()
      .start(runId(1), taskId(1), QUEUE_DEFAULT)
      .fail(runId(1), taskId(1))
      .start(runId(2), taskId(2), QUEUE_DEFAULT)
      .start('HOSTILE-RUN', 'HOSTILE-TASK', 'HOSTILE-QUEUE')
      .fail('HOSTILE-RUN', 'HOSTILE-TASK')
      .start(runId(3), taskId(3), 'HOSTILE-QUEUE')
      .row({ queue: QUEUE_DEFAULT, taskId: taskId(1), status: 'failed', runId: runId(1) })
      .row({ queue: 'HOSTILE-QUEUE', taskId: 'HOSTILE-TASK', status: 'failed', runId: 'HOSTILE-RUN' })
      .build();
    const { text } = render(built);
    const flags = text.split('\n').filter((line) => FLAG_LINE.test(line));
    expect(flags).toHaveLength(2);
    expect(text).not.toContain('HOSTILE');
    expect(flags).toContain(`Queue ${NOT_AN_ID} started 1 later tasks while task ${NOT_AN_ID} stayed failed; the audit log cannot say why.`);
  });
});
