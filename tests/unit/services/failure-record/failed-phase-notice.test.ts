/**
 * FR-R4-F15 (feature 243) — contracts C6.1 and C6.4: the driver's failed-phase effect, the record and
 * then the notice that may point at it.
 *
 * `run-driver-failure-record.test.ts` proves the same behaviour through `RunDriver.drive()`. These
 * cases pin the helper's own rules with a fake recorder, so a change to the order, to what reaches the
 * recorder or to when the notice names it fails here by name. The oracle for every notice is
 * `failureNotice` itself, called with the inputs the helper is supposed to build.
 */
import { describe, expect, it, vi } from 'vitest';

import type { SequencerFailureCause } from '../../../../src/controller/fail-decision-cause';
import type { InvocationResult } from '../../../../src/parser/stdout-parser';
import { failureNotice, SHOW_LAST_ERROR_SENTENCE } from '../../../../src/services/failure-notice';
import {
  failedPhaseNotice,
  type FailedPhase,
  type FailureRecorder
} from '../../../../src/services/failure-record/failed-phase-notice';

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
