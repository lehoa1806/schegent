/**
 * FR-R4-F14 (feature 242, contract N, D8 to D11) — the warning an operator reads when a run fails.
 *
 * Nine fixed host templates, one per failure cause except `start_failed`, whose notice is the
 * start-failure classification's own announcement (research R10). Each text starts with the outcome
 * and then gives the advice (FR-011): the named action, if any, is worth taking, and the one that
 * would not help is not offered. Every action is named by the exact title an operator sees:
 *
 *   - "Schegent: Resume Paused or Failed Workflow" resumes the failed Run at the iteration it failed
 *     on, so a phase that failed at its cap gets ONE more attempt, not a fresh set (D10);
 *   - "Mark '<title>' as completed" is the queue row's button, for work finished by hand.
 *
 * No text names the "Retry feature" button, the queue-level resume or the short resume title that is
 * not the command's full title: none is the right action for a failed Run (D9, D11, N3.1). Three texts
 * name "Show last error", and only when a failure record was written (FR-R4-F15 D13; see
 * {@link SHOW_LAST_ERROR_SENTENCE}): the button shows the record, so the sentence is true only then.
 *
 * WHAT GOES IN, AND WHAT NEVER DOES. The inputs are the cause, the phase id, the runner kind, the
 * task's description, two integers and a count, and nothing else. No agent output, parser warning,
 * audit block or fatal-signature text is an input, so none can reach a notice (FR-025, SC-002); the
 * type has no field for one. The three interpolated strings go through `cleanAnnouncementValue`
 * (strip, redact, cap), the same cleaning a resume announcement gets, so a control character or a
 * secret an operator typed into a task description is neither shown nor made a link by accident
 * (hard rules 1, 2 and 23). The title is then cut the way the row button cuts its own label, so the
 * notice and the button read alike.
 *
 * `sanitize` is optional. `SanitizedLogger.sanitize` reads no instance state, so the default (a
 * sink-less instance) redacts with exactly the host logger's set (hard rule 23), and a caller that
 * holds no logger, or a test double that has none, still builds a safe notice.
 */
import {
  FAILURE_CAUSE_LABELS,
  type FailureCause
} from '../contracts/failure-cause';
import { SanitizedLogger } from '../lib/logger';
import { cleanAnnouncementValue } from './resume-decision';

/** The title `package.json` gives `schegent.resume`; a unit test pins the two together. */
export const RESUME_FAILED_WORKFLOW_TITLE = 'Schegent: Resume Paused or Failed Workflow';

/**
 * How many characters of a task's description the queue row's button shows: the cut in
 * `webview-ui/src/components/QueueItemActions.svelte`'s `labelHint`. A unit test reads that
 * expression and pins this number and the suffix to it.
 */
export const ROW_TITLE_HINT_LENGTH = 24;

const ROW_TITLE_ELLIPSIS = '...';

/** Strips, redacts and caps one operator-authored string. */
type Sanitize = (value: string) => string;

const defaultRedactor = new SanitizedLogger();
const defaultSanitize: Sanitize = (value) => defaultRedactor.sanitize(value);

interface PhaseNotice {
  readonly phase: string;
  readonly sanitize?: Sanitize;
}

/**
 * What a notice may be built from. One arm per shape of the text; a field an arm does not name cannot
 * be passed, so the type is the proof that nothing else reaches the message.
 */
export type FailureNoticeInput =
  | (PhaseNotice & {
      readonly cause: 'cap_exhausted';
      /** The Task's description: the row button's own label is cut from it. */
      readonly taskTitle: string;
      readonly iteration: number;
      readonly iterationCap: number;
      /** Consecutive unchanged comparisons. Stated only when greater than 1 (FR-014). */
      readonly stalledCount?: number | undefined;
      /** FR-R4-F15 (D13) — a failure record was written, so "Show last error" has something to show. */
      readonly recordWritten?: boolean | undefined;
    })
  | (PhaseNotice & {
      readonly cause: 'last_phase_issues_remain';
      readonly taskTitle: string;
      /** FR-R4-F15 (D13) — as on the cap notice. */
      readonly recordWritten?: boolean | undefined;
    })
  | (PhaseNotice & {
      readonly cause: 'judged_metrics_unchanged';
      readonly taskTitle: string;
      readonly iteration: number;
      readonly iterationCap: number;
      /** Consecutive unchanged comparisons; at least 1 whenever the stop applied (FR-R4-F17). */
      readonly stalledCount?: number | undefined;
      /** FR-R4-F15 (D13) — as on the cap notice. */
      readonly recordWritten?: boolean | undefined;
    })
  | (PhaseNotice & {
      readonly cause:
        | 'incomplete_turn_unresolved'
        | 'fatal_signature'
        | 'phase_failed'
        | 'phase_timeout';
    })
  | { readonly cause: 'runner_probe_failed'; readonly runnerKind: string; readonly sanitize?: Sanitize }
  | { readonly cause: 'audit_evidence_unavailable' };

export interface FailureNotice {
  /** The warning text: one line, single spaces. */
  readonly message: string;
  /** The status bar's detail: the cause's fixed label. */
  readonly statusDetail: string;
}

/**
 * The text of the row button that records a Task as finished by hand: `Mark '<title>' as completed`,
 * with the title built as the button builds its label (sanitized, then cut at
 * {@link ROW_TITLE_HINT_LENGTH} code points plus an ellipsis). Strip and redact happen BEFORE the
 * cut, so a secret that straddles the cut is redacted whole first, and the cut counts code points so
 * it never splits a surrogate pair.
 */
export function markCompletedTitle(description: string, sanitize: Sanitize = defaultSanitize): string {
  const clean = Array.from(cleanAnnouncementValue(description, sanitize));
  const title =
    clean.length > ROW_TITLE_HINT_LENGTH
      ? `${clean.slice(0, ROW_TITLE_HINT_LENGTH).join('')}${ROW_TITLE_ELLIPSIS}`
      : clean.join('');
  return `Mark '${title}' as completed`;
}

const RESUME = `"${RESUME_FAILED_WORKFLOW_TITLE}"`;

/**
 * FR-R4-F15 (D13, contract C6.5) — the one sentence the cap and last-phase notices gain when a failure
 * record was written. It names the button by the exact label the queue row shows, and it is appended
 * after a single space, so the message without it is byte-identical to feature 242's.
 */
export const SHOW_LAST_ERROR_SENTENCE = '"Show last error" lists what was open.';

function withRecordPointer(message: string, recordWritten: boolean | undefined): string {
  return recordWritten === true ? `${message} ${SHOW_LAST_ERROR_SENTENCE}` : message;
}

/** ` Its metrics were unchanged across the last {n} comparisons.`, only for a count above one. */
function stalledClause(stalledCount: number | undefined): string {
  if (stalledCount === undefined || !Number.isFinite(stalledCount) || stalledCount <= 1) return '';
  return ` Its metrics were unchanged across the last ${Math.trunc(stalledCount)} comparisons.`;
}

/**
 * FR-R4-F17 (contract C4.1) — `the last {n} comparison(s)`, or `its recent comparisons` when the count
 * is absent or is not a positive integer once truncated.
 */
function unchangedComparisonsPhrase(stalledCount: number | undefined): string {
  if (stalledCount === undefined || !Number.isFinite(stalledCount) || Math.trunc(stalledCount) < 1) {
    return 'its recent comparisons';
  }
  const count = Math.trunc(stalledCount);
  return `the last ${count} comparison${count === 1 ? '' : 's'}`;
}

function messageFor(input: FailureNoticeInput): string {
  if (input.cause === 'audit_evidence_unavailable') {
    return (
      'Schegent: execution stopped because required structured audit evidence is unavailable. ' +
      'Resolve the evidence sink and reload the workspace before resuming.'
    );
  }
  const sanitize = input.sanitize ?? defaultSanitize;
  if (input.cause === 'runner_probe_failed') {
    const runnerKind = cleanAnnouncementValue(input.runnerKind, sanitize);
    return (
      `Schegent: the run failed before its first phase because the ${runnerKind} CLI is missing or ` +
      `does not start. Install or repair it, then use ${RESUME}; the resume checks the CLI again.`
    );
  }

  const phase = cleanAnnouncementValue(input.phase, sanitize);
  switch (input.cause) {
    case 'cap_exhausted':
      // "iteration N of CAP", not "after N iterations": a resumed phase runs again at the iteration it
      // failed on, so a second cap failure reports the same number after one more invocation.
      return withRecordPointer(
        `Schegent: ${phase} reached its iteration cap (iteration ${input.iteration} of ` +
          `${input.iterationCap}) with its retry condition still unmet, so the run failed.` +
          `${stalledClause(input.stalledCount)} ${RESUME} gives ${phase} one more attempt, and it ` +
          `fails the same way unless the blocker is resolved first. If you finished the work by hand, ` +
          `record it with "${markCompletedTitle(input.taskTitle, sanitize)}".`,
        input.recordWritten
      );
    case 'last_phase_issues_remain':
      // The first clause is the sentence FR-R3-199's pinned driver test asserts (FR-026); it states the
      // outcome, and the advice that FR-015 requires follows it.
      return withRecordPointer(
        `Schegent: ${phase} failed — the last phase reported remaining issues, so the run did not ` +
          `complete. Fix the issues first, then use ${RESUME} to run ${phase} again. If you ` +
          `finished the work by hand, record it with "${markCompletedTitle(input.taskTitle, sanitize)}".`,
        input.recordWritten
      );
    case 'judged_metrics_unchanged': {
      // The stop is stated as a measurement, never as "no progress": unchanged figures do not prove that
      // no work happened (FR-016). The resolve sentence comes before the Resume it advises, and the
      // resume runs the phase again at the iteration it stopped on (FR-R4-F17 D9, D10).
      const iteration = Math.trunc(input.iteration);
      return withRecordPointer(
        `Schegent: ${phase} stopped at iteration ${iteration} of ${Math.trunc(input.iterationCap)} ` +
          `because the figures its retry condition reads were unchanged across ` +
          `${unchangedComparisonsPhrase(input.stalledCount)}, so the run failed before reaching its ` +
          `iteration cap. Work the condition does not measure may still have happened. Resolve what ` +
          `blocks the condition first; then ${RESUME} runs ${phase} again at iteration ${iteration}, ` +
          `with the iterations left up to the cap. If you finished the work by hand, record it with ` +
          `"${markCompletedTitle(input.taskTitle, sanitize)}".`,
        input.recordWritten
      );
    }
    case 'incomplete_turn_unresolved':
      return (
        `Schegent: ${phase} did not finish its turn, even after the automatic resumes, so the run ` +
        `failed. ${RESUME} runs ${phase} again.`
      );
    case 'fatal_signature':
      return (
        `Schegent: ${phase} stopped because the backend's output matched a fatal error pattern, so ` +
        `the run failed. Find the error in the run's transcript or the runtime log and fix its ` +
        `cause before using ${RESUME}.`
      );
    case 'phase_failed':
      return (
        `Schegent: ${phase} failed, so the run failed. Check the run's transcript for what went ` +
        `wrong before using ${RESUME} to run ${phase} again.`
      );
    case 'phase_timeout':
      return (
        `Schegent: ${phase} ran out of time, so the run failed. ${RESUME} runs ${phase} again; if ` +
        `it keeps running out of time, check what it was waiting on before resuming.`
      );
  }
}

/**
 * The notice and the status bar's detail for one failure. The detail is the cause's fixed label
 * (contract N4), never the message.
 */
export function failureNotice(input: FailureNoticeInput): FailureNotice {
  const cause: FailureCause = input.cause;
  return { message: messageFor(input), statusDetail: FAILURE_CAUSE_LABELS[cause] };
}
