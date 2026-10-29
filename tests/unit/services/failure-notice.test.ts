// FR-R4-F14 (spec 242, contract N6, FR-011 to FR-017, FR-025) — the failure notices.
//
// One row per cause except `start_failed`, whose notice is the classification's own announcement
// (research R10). Each row pins the exact text of contract N3 as a literal, so a reworded sentence
// fails here and not in front of an operator, and the rules every text shares: the full Resume title
// wherever a Resume is advised, never a bare "Schegent: Resume", never a promise of a "Retry feature"
// button or a "Show last error" action that does not exist (N3.1), and the outcome before the action.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FAILURE_CAUSE_LABELS,
  type FailureCause
} from '../../../src/contracts/failure-cause';
import { SanitizedLogger } from '../../../src/lib/logger';
import {
  failureNotice,
  markCompletedTitle,
  ROW_TITLE_HINT_LENGTH,
  RESUME_FAILED_WORKFLOW_TITLE,
  type FailureNoticeInput
} from '../../../src/services/failure-notice';

const sanitizer = new SanitizedLogger();
const sanitize = (value: string): string => sanitizer.sanitize(value);

const PHASE = 'speckit-implement';
const TITLE = 'Add the export button';
const RESUME = '"Schegent: Resume Paused or Failed Workflow"';
const MARK_COMPLETED = `"Mark '${TITLE}' as completed"`;

interface Row {
  readonly input: FailureNoticeInput;
  readonly expected: string;
  /** The clause that states the outcome. It must come before the first action title. */
  readonly outcome: string;
  readonly advisesResume: boolean;
}

const ROWS: Record<Exclude<FailureCause, 'start_failed'>, Row> = {
  cap_exhausted: {
    input: { cause: 'cap_exhausted', phase: PHASE, taskTitle: TITLE, iteration: 5, iterationCap: 5, sanitize },
    expected:
      `Schegent: ${PHASE} reached its iteration cap (iteration 5 of 5) with its retry condition still ` +
      `unmet, so the run failed. ${RESUME} gives ${PHASE} one more attempt, and it fails the same way ` +
      `unless the blocker is resolved first. If you finished the work by hand, record it with ` +
      `${MARK_COMPLETED}.`,
    outcome: 'so the run failed.',
    advisesResume: true
  },
  last_phase_issues_remain: {
    input: { cause: 'last_phase_issues_remain', phase: PHASE, taskTitle: TITLE, sanitize },
    expected:
      `Schegent: ${PHASE} failed — the last phase reported remaining issues, so the run did not ` +
      `complete. Fix the issues first, then use ${RESUME} to run ${PHASE} again. If you finished the ` +
      `work by hand, record it with ${MARK_COMPLETED}.`,
    outcome: 'the last phase reported remaining issues, so the run did not complete.',
    advisesResume: true
  },
  incomplete_turn_unresolved: {
    input: { cause: 'incomplete_turn_unresolved', phase: PHASE, sanitize },
    expected:
      `Schegent: ${PHASE} did not finish its turn, even after the automatic resumes, so the run ` +
      `failed. ${RESUME} runs ${PHASE} again.`,
    outcome: 'so the run failed.',
    advisesResume: true
  },
  fatal_signature: {
    input: { cause: 'fatal_signature', phase: PHASE, sanitize },
    expected:
      `Schegent: ${PHASE} stopped because the backend's output matched a fatal error pattern, so the ` +
      `run failed. Find the error in the run's transcript or the runtime log and fix its cause before ` +
      `using ${RESUME}.`,
    outcome: 'so the run failed.',
    advisesResume: true
  },
  phase_failed: {
    input: { cause: 'phase_failed', phase: PHASE, sanitize },
    expected:
      `Schegent: ${PHASE} failed, so the run failed. Check the run's transcript for what went wrong ` +
      `before using ${RESUME} to run ${PHASE} again.`,
    outcome: 'so the run failed.',
    advisesResume: true
  },
  phase_timeout: {
    input: { cause: 'phase_timeout', phase: PHASE, sanitize },
    expected:
      `Schegent: ${PHASE} ran out of time, so the run failed. ${RESUME} runs ${PHASE} again; if it ` +
      `keeps running out of time, check what it was waiting on before resuming.`,
    outcome: 'so the run failed.',
    advisesResume: true
  },
  runner_probe_failed: {
    input: { cause: 'runner_probe_failed', runnerKind: 'claude', sanitize },
    expected:
      `Schegent: the run failed before its first phase because the claude CLI is missing or does not ` +
      `start. Install or repair it, then use ${RESUME}; the resume checks the CLI again.`,
    outcome: 'the run failed before its first phase',
    advisesResume: true
  },
  audit_evidence_unavailable: {
    input: { cause: 'audit_evidence_unavailable' },
    expected:
      'Schegent: execution stopped because required structured audit evidence is unavailable. ' +
      'Resolve the evidence sink and reload the workspace before resuming.',
    outcome: 'execution stopped',
    advisesResume: false
  }
};

const FORBIDDEN_FRAGMENTS = ['"Schegent: Resume"', 'Retry feature', 'Schegent: Resume Queue', 'Show last error'];

describe('failureNotice — one text per cause (FR-011 to FR-017)', () => {
  for (const [cause, row] of Object.entries(ROWS)) {
    describe(cause, () => {
      const notice = failureNotice(row.input);

      it('is the exact text of contract N3, on one line', () => {
        expect(notice.message).toBe(row.expected);
        expect(notice.message).not.toMatch(/[\n\r]| {2}/);
      });

      it('names no action that does not exist (N3.1)', () => {
        for (const fragment of FORBIDDEN_FRAGMENTS) {
          expect(notice.message.includes(fragment), fragment).toBe(false);
        }
      });

      it('carries the full Resume title wherever it advises a Resume', () => {
        expect(notice.message.includes(RESUME_FAILED_WORKFLOW_TITLE)).toBe(row.advisesResume);
      });

      it('states the outcome before the first action title', () => {
        const outcomeAt = notice.message.indexOf(row.outcome);
        expect(outcomeAt).toBeGreaterThanOrEqual(0);
        const actionAts = [RESUME_FAILED_WORKFLOW_TITLE, 'Mark \''].map((title) => notice.message.indexOf(title)).filter((at) => at >= 0);
        for (const actionAt of actionAts) expect(outcomeAt).toBeLessThan(actionAt);
      });

      it("sets the status bar's detail to the cause's fixed label (N4)", () => {
        expect(notice.statusDetail).toBe(FAILURE_CAUSE_LABELS[cause as keyof typeof ROWS]);
      });
    });
  }

  it('covers every cause except start_failed, which keeps the classification announcement', () => {
    expect(Object.keys(ROWS).sort()).toEqual(
      Object.keys(FAILURE_CAUSE_LABELS).filter((cause) => cause !== 'start_failed').sort()
    );
  });
});

describe('failureNotice — the cap notice (FR-014, D10)', () => {
  const cap = (stalledCount?: number) =>
    failureNotice({
      cause: 'cap_exhausted',
      phase: PHASE,
      taskTitle: TITLE,
      iteration: 10,
      iterationCap: 10,
      ...(stalledCount === undefined ? {} : { stalledCount }),
      sanitize
    }).message;

  it('states the unchanged-metrics count when it is greater than one', () => {
    expect(cap(9)).toContain(
      'with its retry condition still unmet, so the run failed. Its metrics were unchanged across the last 9 comparisons. '
    );
  });

  it('states no count for 1, for 0 or when absent', () => {
    for (const message of [cap(1), cap(0), cap()]) {
      expect(message).not.toContain('unchanged');
      expect(message).not.toContain('comparisons');
    }
  });

  it('reports the iteration as "iteration N of CAP", not "after N iterations"', () => {
    expect(cap()).toContain('(iteration 10 of 10)');
    expect(cap()).not.toMatch(/after \d+ iterations/);
  });

  it('says a Resume fails the same way only unless the blocker is resolved first', () => {
    expect(cap()).toContain('unless the blocker is resolved first');
    expect(cap()).not.toMatch(/\b(never|cannot|will not work)\b/i);
  });

  it('offers the hand-finished route by the exact title of the row button', () => {
    expect(cap()).toContain(markCompletedTitle(TITLE, sanitize));
    expect(markCompletedTitle(TITLE, sanitize)).toBe(`Mark '${TITLE}' as completed`);
  });
});

describe('failureNotice — interpolated strings are stripped, redacted and cut (FR-013, hard rules 1 and 2)', () => {
  const SECRET = 'sk-ant-' + 'A'.repeat(30);
  const hostile = `\u0007bell ${SECRET} ` + 'x'.repeat(300);

  it('renders a title stripped of control characters, redacted, and cut to 24 code points plus "..."', () => {
    const title = markCompletedTitle(hostile, sanitize);
    expect(title).not.toContain('\u0007');
    expect(title).not.toContain(SECRET);
    expect(title).not.toContain('AAAA');
    expect(title).toBe(`Mark '${Array.from(`bell [REDACTED] ${'x'.repeat(300)}`).slice(0, 24).join('')}...' as completed`);
  });

  it('leaves a title of 24 code points or fewer whole, with no suffix', () => {
    expect(markCompletedTitle('a'.repeat(24), sanitize)).toBe(`Mark '${'a'.repeat(24)}' as completed`);
    expect(markCompletedTitle('a'.repeat(25), sanitize)).toBe(`Mark '${'a'.repeat(24)}...' as completed`);
  });

  it('never splits a surrogate pair when it cuts', () => {
    const astral = '\u{1F600}'.repeat(30);
    const title = markCompletedTitle(astral, sanitize);
    expect(title).toBe(`Mark '${'\u{1F600}'.repeat(24)}...' as completed`);
  });

  it('redacts a secret that straddles the cut before cutting it', () => {
    const straddling = `${'y'.repeat(20)}${SECRET}`;
    const title = markCompletedTitle(straddling, sanitize);
    expect(title).not.toContain('sk-ant');
    expect(title).not.toContain('AAAA');
  });

  it('applies the same cleaning to the phase and the runner kind', () => {
    const phase = failureNotice({ cause: 'phase_failed', phase: `\u0007${SECRET}`, sanitize }).message;
    expect(phase).not.toContain('\u0007');
    expect(phase).not.toContain(SECRET);
    const kind = failureNotice({ cause: 'runner_probe_failed', runnerKind: `\u0007${SECRET}`, sanitize }).message;
    expect(kind).not.toContain('\u0007');
    expect(kind).not.toContain(SECRET);
  });

  it('redacts with the host\'s own redaction set when no sanitizer is passed', () => {
    const planted = failureNotice({ cause: 'phase_failed', phase: `x ${SECRET}` }).message;
    expect(planted).not.toContain(SECRET);
    expect(planted).toContain('[REDACTED]');
    expect(markCompletedTitle(SECRET)).not.toContain('AAAA');
  });

  it('takes no field that could carry agent output, a warning, an audit block or a signature (FR-025)', () => {
    const withWarnings = failureNotice({
      cause: 'phase_failed',
      phase: PHASE,
      sanitize,
      // @ts-expect-error the input type has no field for the parser's warnings
      warnings: ['planted-warning-sentinel']
    });
    expect(withWarnings.message).not.toContain('planted-warning-sentinel');

    const withSignature = failureNotice({
      cause: 'fatal_signature',
      phase: PHASE,
      sanitize,
      // @ts-expect-error nor for the fatal signature's text
      fatalCause: 'fatal-signature:planted-signature-sentinel'
    });
    expect(withSignature.message).not.toContain('planted-signature-sentinel');
  });
});

describe('the titles the notices name are pinned to their sources (FR-013)', () => {
  const repoRoot = resolve(__dirname, '../../..');

  it('RESUME_FAILED_WORKFLOW_TITLE equals the manifest title of schegent.resume', () => {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      contributes: { commands: Array<{ command: string; title: string }> };
    };
    const title = manifest.contributes.commands.find((entry) => entry.command === 'schegent.resume')?.title;
    expect(RESUME_FAILED_WORKFLOW_TITLE).toBe(title);
  });

  it("ROW_TITLE_HINT_LENGTH and the '...' suffix match QueueItemActions.svelte's labelHint", () => {
    const source = readFileSync(
      resolve(repoRoot, 'webview-ui/src/components/QueueItemActions.svelte'),
      'utf8'
    );
    const expression = /const labelHint = \$derived\(\s*item\.label\.length > (\d+) \? `\$\{item\.label\.slice\(0, (\d+)\)\}(\.\.\.)` : item\.label\s*\);/.exec(
      source
    );
    expect(expression, 'the labelHint expression changed; update failure-notice.ts and this pin').not.toBeNull();
    const [, comparedAt, slicedAt, suffix] = expression ?? [];
    expect(Number(comparedAt)).toBe(ROW_TITLE_HINT_LENGTH);
    expect(Number(slicedAt)).toBe(ROW_TITLE_HINT_LENGTH);
    expect(suffix).toBe('...');
    expect(markCompletedTitle('z'.repeat(ROW_TITLE_HINT_LENGTH + 1), sanitize)).toContain(
      `${'z'.repeat(ROW_TITLE_HINT_LENGTH)}${suffix}`
    );
  });
});

// FR-R4-F15 (feature 243, contract C6.5, C7.12, D13) — the two notices that used to say nothing about
// what was open now point at "Show last error", but only when a failure record was actually written.
describe('failureNotice — the retained-diagnostics sentence (FR-022, D13)', () => {
  const SHOW_LAST_ERROR = '"Show last error" lists what was open.';
  const POINTED = ['cap_exhausted', 'last_phase_issues_remain'] as const;
  const inputFor = (cause: (typeof POINTED)[number], recordWritten?: boolean): FailureNoticeInput =>
    ({ ...ROWS[cause].input, ...(recordWritten === undefined ? {} : { recordWritten }) }) as FailureNoticeInput;

  for (const cause of POINTED) {
    describe(cause, () => {
      const base = ROWS[cause].expected;

      it('appends the sentence once, after a single space, when the record was written', () => {
        const message = failureNotice(inputFor(cause, true)).message;
        expect(message).toBe(`${base} ${SHOW_LAST_ERROR}`);
        expect(message.split(SHOW_LAST_ERROR)).toHaveLength(2);
        expect(message).not.toMatch(/[\n\r]| {2}/);
      });

      it('is byte-identical to the feature 242 text when no record was written', () => {
        expect(failureNotice(inputFor(cause, false)).message).toBe(base);
      });

      it('is byte-identical to the feature 242 text when the input says nothing about a record', () => {
        expect(failureNotice(inputFor(cause)).message).toBe(base);
      });

      it('keeps the status bar detail as the cause label, whatever the record', () => {
        for (const recordWritten of [true, false, undefined]) {
          expect(failureNotice(inputFor(cause, recordWritten)).statusDetail).toBe(FAILURE_CAUSE_LABELS[cause]);
        }
      });

      it('still states the outcome before the first action title, and ends on the new sentence', () => {
        const message = failureNotice(inputFor(cause, true)).message;
        expect(message.indexOf(ROWS[cause].outcome)).toBeLessThan(message.indexOf(RESUME_FAILED_WORKFLOW_TITLE));
        expect(message.endsWith(SHOW_LAST_ERROR)).toBe(true);
      });
    });
  }

  it('gives no other cause the sentence, even if a caller passes the field anyway', () => {
    for (const [cause, row] of Object.entries(ROWS)) {
      if (cause === 'cap_exhausted' || cause === 'last_phase_issues_remain') continue;
      const message = failureNotice({ ...row.input, recordWritten: true } as unknown as FailureNoticeInput).message;
      expect(message, cause).toBe(row.expected);
    }
  });
});
