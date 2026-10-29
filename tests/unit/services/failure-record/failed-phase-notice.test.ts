/**
 * FR-R4-F15 (feature 243) — contracts C6.1 and C6.4: the driver's failed-phase effect, the record and
 * then the notice that may point at it.
 *
 * `run-driver-failure-record.test.ts` proves the same behaviour through `RunDriver.drive()`. These
 * cases pin the helper's own rules with a fake recorder, so a change to the order, to what reaches the
 * recorder or to when the notice names it fails here by name. The oracle for every notice is
 * `failureNotice` itself, called with the inputs the helper is supposed to build.
 */
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_QUEUE_ID } from '../../../../src/contracts/queue-identity';
import type { FailureRecordV1 } from '../../../../src/contracts/failure-record';
import { isValidFailureRecord, parseRecordName } from '../../../../src/contracts/validators/failure-record';
import type { SequencerFailureCause } from '../../../../src/controller/fail-decision-cause';
import { SanitizedLogger } from '../../../../src/lib/logger';
import type { InvocationResult } from '../../../../src/parser/stdout-parser';
import { failureNotice, SHOW_LAST_ERROR_SENTENCE } from '../../../../src/services/failure-notice';
import {
  failedPhaseNotice,
  type FailedPhase,
  type FailureRecorder
} from '../../../../src/services/failure-record/failed-phase-notice';
import { createFailureRecorder } from '../../../../src/services/failure-record/failure-record-service';

const RUN = { id: 'run-1', featureId: 'task-1', currentPhase: 'implement' };
const RESULT = { kind: 'remaining_issues', issues: [], auditEntry: null, warnings: [] } as InvocationResult;
const OPTIONS = { iterationCap: 3 };
const TITLE = 'Add the export button';
const ITERATION = 2;

const CAUSES: readonly SequencerFailureCause[] = [
  'cap_exhausted',
  'last_phase_issues_remain',
  'incomplete_turn_unresolved',
  'fatal_signature',
  'phase_failed',
  'phase_timeout'
];
const PLAIN_CAUSES = ['incomplete_turn_unresolved', 'fatal_signature', 'phase_failed', 'phase_timeout'] as const;

function failed(cause: SequencerFailureCause, stalledCount?: number): FailedPhase {
  return {
    run: RUN,
    decision: stalledCount === undefined ? { failureCause: cause } : { failureCause: cause, stalledCount },
    result: RESULT,
    taskTitle: TITLE,
    iteration: ITERATION
  };
}

function recorderAnswering(answer: boolean): { recorder: FailureRecorder; record: ReturnType<typeof vi.fn> } {
  const record = vi.fn<FailureRecorder['record']>(async () => answer);
  return { recorder: { record }, record };
}

describe('failedPhaseNotice', () => {
  it('names the record on a cap notice once the record was written', async () => {
    const { recorder } = recorderAnswering(true);
    const notice = await failedPhaseNotice(recorder, OPTIONS, failed('cap_exhausted', 3));
    expect(notice).toEqual(
      failureNotice({
        cause: 'cap_exhausted',
        phase: 'implement',
        taskTitle: TITLE,
        iteration: ITERATION,
        iterationCap: 3,
        stalledCount: 3,
        recordWritten: true
      })
    );
    expect(notice.message).toContain(SHOW_LAST_ERROR_SENTENCE);
  });

  it('names the record on a last-phase notice once the record was written', async () => {
    const { recorder } = recorderAnswering(true);
    const notice = await failedPhaseNotice(recorder, OPTIONS, failed('last_phase_issues_remain'));
    expect(notice).toEqual(
      failureNotice({ cause: 'last_phase_issues_remain', phase: 'implement', taskTitle: TITLE, recordWritten: true })
    );
    expect(notice.message).toContain(SHOW_LAST_ERROR_SENTENCE);
  });

  it('makes no promise about a record that was not written', async () => {
    const { recorder } = recorderAnswering(false);
    const cap = await failedPhaseNotice(recorder, OPTIONS, failed('cap_exhausted'));
    const last = await failedPhaseNotice(recorder, OPTIONS, failed('last_phase_issues_remain'));
    expect(cap.message).not.toContain(SHOW_LAST_ERROR_SENTENCE);
    expect(last.message).not.toContain(SHOW_LAST_ERROR_SENTENCE);
    expect(cap).toEqual(
      failureNotice({
        cause: 'cap_exhausted',
        phase: 'implement',
        taskTitle: TITLE,
        iteration: ITERATION,
        iterationCap: 3,
        recordWritten: false
      })
    );
  });

  it('builds the notice a driver without a recorder always built, and does not throw', async () => {
    const cap = await failedPhaseNotice(undefined, OPTIONS, failed('cap_exhausted', 3));
    expect(cap).toEqual(
      failureNotice({
        cause: 'cap_exhausted',
        phase: 'implement',
        taskTitle: TITLE,
        iteration: ITERATION,
        iterationCap: 3,
        stalledCount: 3
      })
    );
    expect(cap.message).not.toContain(SHOW_LAST_ERROR_SENTENCE);
  });

  it.each(CAUSES)('hands the recorder what the driver holds for %s', async (cause) => {
    const { recorder, record } = recorderAnswering(true);
    await failedPhaseNotice(recorder, OPTIONS, failed(cause, 4));
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith({
      run: RUN,
      cause,
      result: RESULT,
      iteration: ITERATION,
      iterationCap: 3,
      stalledCount: 4
    });
  });

  it.each(PLAIN_CAUSES)('keeps the record for %s but its notice never mentions one', async (cause) => {
    const { recorder, record } = recorderAnswering(true);
    const notice = await failedPhaseNotice(recorder, OPTIONS, failed(cause));
    expect(record).toHaveBeenCalledOnce();
    expect(notice).toEqual(failureNotice({ cause, phase: 'implement' }));
    expect(notice.message).not.toContain(SHOW_LAST_ERROR_SENTENCE);
  });

  it('waits for the recorder before it builds the notice', async () => {
    let release: (written: boolean) => void = () => undefined;
    const pending = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const recorder: FailureRecorder = { record: () => pending };
    let settled = false;
    const outcome = failedPhaseNotice(recorder, OPTIONS, failed('cap_exhausted')).then((notice) => {
      settled = true;
      return notice;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release(true);
    expect((await outcome).message).toContain(SHOW_LAST_ERROR_SENTENCE);
  });
});

// FR-R4-F17 (feature 245, contracts C5.2 and C5.3; FR-017; SC-007) — the record and the notice for a loop
// stopped on unchanged judged metrics, through F15's REAL recorder over a temporary directory. The
// stop needs no code in `failure-record/`: the cause is a member of the closed vocabulary, so the
// builder and the validator admit it by identity. What these cases pin is the content: the stop's own
// iteration, cap and count in the record, bounded metrics, and nothing from outside the parsed result.
describe('failedPhaseNotice — the unchanged-metrics stop, with the real recorder (FR-R4-F17, C5)', () => {
  const RECORDS_DIR = path.join('.schegent', 'failure-records');
  const FAILED_AT = new Date('2026-10-29T09:15:00.000Z');
  const SECRET = ['sk', 'ant', 'c'.repeat(24)].join('-');
  const ISSUE_TEXT = 'ISSUE-TEXT-FOR-THE-OPERATOR';
  const MODEL_TEXT = 'a warning that must never reach a record';
  const STOP_ITERATION = 3;
  const STOP_CAP = 10;

  let root: string;
  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'failed-phase-notice-stop-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  function realRecorder(): FailureRecorder {
    return createFailureRecorder({
      logger: new SanitizedLogger([]),
      queue: { queueIdForExistingTask: () => DEFAULT_QUEUE_ID },
      workspaceRoot: root,
      platform: 'linux',
      now: () => FAILED_AT
    });
  }

  /** The stub result: open issues, numeric metrics, and text no record may carry. */
  function stopResult(): InvocationResult {
    return {
      kind: 'remaining_issues',
      issues: [
        { tag: 'regression', summary: `${ISSUE_TEXT} one: ${root}/src/export.ts fails` },
        { tag: 'environment', summary: `${ISSUE_TEXT} two: token ${SECRET} was rejected` }
      ],
      auditEntry: { metrics: { spec_gaps: 0, pending_tasks: 3 } },
      warnings: [MODEL_TEXT]
    } as unknown as InvocationResult;
  }

  function stop(cause: SequencerFailureCause, runId = 'run-stop'): FailedPhase {
    return {
      run: { id: runId, featureId: 'task-stop', currentPhase: 'implement' },
      decision: { failureCause: cause, stalledCount: 2 },
      result: stopResult(),
      taskTitle: TITLE,
      iteration: STOP_ITERATION
    };
  }

  async function recordsOnDisk(): Promise<Array<{ name: string; record: FailureRecordV1 }>> {
    const dir = path.join(root, RECORDS_DIR);
    const names = (await fsp.readdir(dir).catch(() => [] as string[])).sort();
    const found: Array<{ name: string; record: FailureRecordV1 }> = [];
    for (const name of names) {
      found.push({ name, record: JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8')) as FailureRecordV1 });
    }
    return found;
  }

  it('writes one valid record carrying the stop\'s cause, iteration, cap and count, and sorted metrics', async () => {
    await failedPhaseNotice(realRecorder(), { iterationCap: STOP_CAP }, stop('judged_metrics_unchanged'));

    const found = await recordsOnDisk();
    expect(found).toHaveLength(1);
    const parsed = parseRecordName(found[0]?.name ?? '');
    expect(isValidFailureRecord(found[0]?.record, parsed ?? undefined)).toBe(true);
    expect(found[0]?.record).toMatchObject({
      cause: 'judged_metrics_unchanged',
      phase: 'implement',
      iteration: STOP_ITERATION,
      iterationCap: STOP_CAP,
      stalledCount: 2,
      issueState: 'listed',
      metrics: [
        { key: 'pending_tasks', value: 3 },
        { key: 'spec_gaps', value: 0 }
      ],
      omittedMetricCount: 0
    });
  });

  it('keeps the agent\'s issue text, and no workspace path, secret or model text (SC-007)', async () => {
    await failedPhaseNotice(realRecorder(), { iterationCap: STOP_CAP }, stop('judged_metrics_unchanged'));

    const onDisk = JSON.stringify(await recordsOnDisk());
    // Control: the issue text and the redaction marker are there, so the absences below are not vacuous.
    expect(onDisk).toContain(ISSUE_TEXT);
    expect(onDisk).toContain('[REDACTED]');
    expect(onDisk).not.toContain(root);
    expect(onDisk).not.toContain(SECRET);
    expect(onDisk).not.toContain(MODEL_TEXT);
  });

  it('ends the notice on the "Show last error" sentence and puts none of the record in it', async () => {
    const notice = await failedPhaseNotice(realRecorder(), { iterationCap: STOP_CAP }, stop('judged_metrics_unchanged'));

    expect(notice).toEqual(
      failureNotice({
        cause: 'judged_metrics_unchanged',
        phase: 'implement',
        taskTitle: TITLE,
        iteration: STOP_ITERATION,
        iterationCap: STOP_CAP,
        stalledCount: 2,
        recordWritten: true
      })
    );
    expect(notice.message.endsWith(SHOW_LAST_ERROR_SENTENCE)).toBe(true);
    for (const text of [ISSUE_TEXT, SECRET, MODEL_TEXT, 'pending_tasks', root]) {
      expect(notice.message.includes(text), text).toBe(false);
    }
  });

  it('keeps the cause and drops the sentence when the recorder could not write (C5.3)', async () => {
    const record = vi.fn<FailureRecorder['record']>(async () => false);
    const notice = await failedPhaseNotice({ record }, { iterationCap: STOP_CAP }, stop('judged_metrics_unchanged'));

    expect(record).toHaveBeenCalledWith(expect.objectContaining({ cause: 'judged_metrics_unchanged' }));
    expect(notice.statusDetail).toBe('Judged metrics unchanged');
    expect(notice.message).toContain('stopped at iteration 3 of 10');
    expect(notice.message).not.toContain(SHOW_LAST_ERROR_SENTENCE);
  });

  it('control: the same fixture failing at the cap writes a record whose cause differs', async () => {
    const recorder = realRecorder();
    await failedPhaseNotice(recorder, { iterationCap: STOP_CAP }, stop('judged_metrics_unchanged', 'run-stop'));
    await failedPhaseNotice(recorder, { iterationCap: STOP_CAP }, stop('cap_exhausted', 'run-cap'));

    const records = (await recordsOnDisk()).map((entry) => entry.record);
    expect(records).toHaveLength(2);
    const causes = records.map((record) => record.cause).sort();
    expect(causes).toEqual(['cap_exhausted', 'judged_metrics_unchanged']);
    // Everything but the cause and the Run is the same, so the case above is about the cause alone.
    const shared = (record: FailureRecordV1 | undefined) => ({
      phase: record?.phase,
      iteration: record?.iteration,
      iterationCap: record?.iterationCap,
      stalledCount: record?.stalledCount,
      metrics: record?.metrics
    });
    expect(shared(records[0])).toEqual(shared(records[1]));
  });
});
