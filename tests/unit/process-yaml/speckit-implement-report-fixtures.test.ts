// Implement's report, through the host's real parser and transition.
//
// A Phase whose condition is `pending_tasks > 0` loops until nothing is pending.
// Implement used to count a task only a person can finish as pending, so a run
// with nothing left but "push the branch" spent its whole retry budget and failed
// at the cap. The instruction now sets those tasks aside and reports them as
// hand-offs; `speckit-new-feature-authority.test.ts` pins that text.
//
// This file pins the other half: what the host does with a report in that shape.
// Each fixture is a report written the way the instruction asks, run through the
// same four steps production runs, in the same order: `parseAuditLogBlock`,
// `parseInvocation`, `mapOutcome`, `transition`. The loop condition is read from
// the shipped example, not typed here, so a fixture cannot pass against a
// condition the example no longer ships.
//
// These are characterization tests: they describe host behavior this feature does
// not change, so they pass on arrival. A red fixture is a finding about the host,
// not a test to edit. What they cannot show is that a model classifies a task the
// way the instruction says; the text pins show it is told to, and only a live run
// shows it does.

import { describe, expect, it } from 'vitest';

import { CAP_EXHAUSTED_CAUSE } from '../../../src/audit/audit-payload';
import { mapOutcome } from '../../../src/controller/phase-outcome-mapper';
import {
  transition,
  type PhaseOutcome,
  type PipelineLike,
  type TransitionResult
} from '../../../src/controller/phase';
import { parseAuditLogBlock } from '../../../src/parser/audit-log-parser';
import {
  extractOpenQuestions,
  extractRemainingIssues,
  parseInvocation,
  type InvocationResult
} from '../../../src/parser/stdout-parser';
import { DEFAULT_ITERATION_CAP } from '../../../src/services/run-planned-total';
import { loadExample, phaseOf } from '../../fixtures/speckit-new-feature-example';

const IMPLEMENT = 'speckit-implement';
const NEXT_PHASE = 'speckit-code-review';
const OPEN_MARKER = '=== SCHEGENT AUDIT LOG ===';
const CLOSE_MARKER = '=== END AUDIT LOG ===';
const CLEAR_TOKEN = '[SCHEGENT_STATUS: CLEAR]';
const FENCE = '```';

type HandoffBasis = 'marker' | 'approval' | 'person-only last step';

interface Handoff {
  readonly id: string;
  readonly basis: HandoffBasis;
  readonly text: string;
}

interface Figures {
  readonly pending_tasks: number;
  readonly spec_gaps: number;
  readonly blocked_tasks: number;
  readonly user_run_tasks: number;
}

type Decision =
  | { readonly kind: 'advance'; readonly nextPhase: string }
  | { readonly kind: 'loop'; readonly nextIteration: number }
  | { readonly kind: 'halt'; readonly status: 'failed'; readonly cause: string };

interface Fixture {
  readonly id: string;
  readonly story: string;
  /** Bullets under `Remaining issues:`, in the order the report lists them. */
  readonly issues: readonly string[];
  readonly handoffs: readonly Handoff[];
  readonly figures: Figures;
  /** Whether the report ends on the completion token. */
  readonly token: boolean;
  readonly kind: InvocationResult['kind'];
  readonly outcome: PhaseOutcome;
  readonly decision: Decision;
  /** The iteration the report is produced at; 1 unless the fixture is at the cap. */
  readonly iteration: number;
}

const example = loadExample();
const retryCondition = phaseOf(example, IMPLEMENT).spec.retryCondition;
if (retryCondition === undefined) throw new Error(`${IMPLEMENT} carries no retryCondition`);

const phaseDef = { id: IMPLEMENT, retryCondition };
const pipeline: PipelineLike = {
  phases: example.phaseIds.map((id) => {
    const condition = phaseOf(example, id).spec.retryCondition;
    return condition === undefined ? { id } : { id, retryCondition: condition };
  })
};

const handoffBullet = ({ id, basis, text }: Handoff): string => `- ${id} (${basis}): ${text}`;

/**
 * One report, in the order the instruction asks for: a prose line, the issues,
 * the hand-off list, the fenced audit block with the four figures as top-level
 * lines, and the token on its own line after the block when the report is clean.
 * `joinIssuesAndHandoffs` is the one knob: the control for the blank line that
 * keeps the two lists apart.
 */
function buildReport(
  fixture: Pick<Fixture, 'issues' | 'handoffs' | 'figures' | 'token'>,
  joinIssuesAndHandoffs: '\n\n' | '\n' = '\n\n'
): string {
  const sections: string[] = ['Implementation pass finished.'];
  const lists: string[] = [];
  if (fixture.issues.length > 0) {
    lists.push(['Remaining issues:', ...fixture.issues.map((issue) => `- ${issue}`)].join('\n'));
  }
  if (fixture.handoffs.length > 0) {
    lists.push(['Hand-off tasks (for the user):', ...fixture.handoffs.map(handoffBullet)].join('\n'));
  }
  if (lists.length > 0) sections.push(lists.join(joinIssuesAndHandoffs));

  const block = [
    FENCE,
    OPEN_MARKER,
    `phase: ${IMPLEMENT}`,
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: []',
    'network_calls: [none]',
    'ruleset_switches: [none]',
    'notes: one implement pass',
    ...Object.entries(fixture.figures).map(([name, value]) => `${name}: ${value}`),
    CLOSE_MARKER,
    FENCE
  ].join('\n');
  sections.push(fixture.token ? `${block}\n${CLEAR_TOKEN}` : block);
  return sections.join('\n\n');
}

interface Run {
  readonly stdout: string;
  readonly metrics: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
  readonly result: InvocationResult;
  readonly outcome: PhaseOutcome;
  readonly decision: TransitionResult;
}

/** The four steps production runs on one invocation's output, in its order. */
function run(stdout: string, iteration: number): Run {
  const audit = parseAuditLogBlock(stdout);
  if (audit.entry === null) throw new Error(`no audit entry: ${audit.warnings.join('; ')}`);
  const result = parseInvocation({
    stdout,
    stderr: '',
    exitCode: 0,
    rateLimit: { matched: false, cause: '' },
    auditEntry: audit.entry,
    auditWarnings: audit.warnings,
    region: audit.region
  });
  const outcome = mapOutcome(result, 0);
  const decision = transition({
    phase: IMPLEMENT,
    outcome,
    iteration,
    iterationCap: DEFAULT_ITERATION_CAP,
    pipeline,
    phaseDef,
    metrics: audit.entry.metrics
  });
  return {
    stdout,
    metrics: audit.entry.metrics,
    warnings: [...audit.warnings, ...audit.entry.warnings],
    result,
    outcome,
    decision
  };
}

function expectDecision(actual: TransitionResult, expected: Decision): void {
  switch (expected.kind) {
    case 'advance':
      expect(actual).toMatchObject({ kind: 'advance', nextPhase: expected.nextPhase });
      return;
    case 'loop':
      expect(actual).toMatchObject({
        kind: 'loop',
        nextPhase: IMPLEMENT,
        nextIteration: expected.nextIteration
      });
      return;
    case 'halt':
      expect(actual).toMatchObject({
        kind: 'halt',
        status: expected.status,
        cause: expected.cause
      });
  }
}

/** F4.1 to F4.5: what one report must come to, through the real chain. */
function expectFixture(fixture: Fixture): void {
  const taken = run(buildReport(fixture), fixture.iteration);

  // The four figures are top-level, zeros included. A zero that went missing
  // would read as "not reported" and fall to the loop condition's missing-metric
  // warning instead of its value.
  expect(taken.metrics).toEqual(fixture.figures);
  expect(
    taken.warnings.filter((warning) => /dropped/i.test(warning)),
    'no metric was dropped'
  ).toEqual([]);

  // A hand-off bullet is never read as an issue, whatever sits above it.
  expect(extractRemainingIssues(taken.stdout).map((issue) => issue.summary)).toEqual(
    fixture.issues
  );
  expect(extractOpenQuestions(taken.stdout)).toEqual([]);

  expect(taken.result.kind).toBe(fixture.kind);
  expect(taken.outcome).toBe(fixture.outcome);
  expectDecision(taken.decision, fixture.decision);
}

const ADVANCE_TO_REVIEW: Decision = { kind: 'advance', nextPhase: NEXT_PHASE };
const NO_OPEN_WORK = {
  pending_tasks: 0,
  spec_gaps: 0,
  blocked_tasks: 0
} as const;

const PUSH_BRANCH: Handoff = { id: 'T150', basis: 'marker', text: 'push the branch' };

/** Reports where a person's step is all that is left: each must advance. */
const ONLY_HANDOFF_FIXTURES: readonly Fixture[] = [
  {
    id: 'F-only',
    story: 'US1-1',
    issues: [],
    handoffs: [
      PUSH_BRANCH,
      {
        id: 'T151',
        basis: 'approval',
        text: 'merge the pull request once the user approves'
      }
    ],
    figures: { ...NO_OPEN_WORK, user_run_tasks: 2 },
    token: true,
    kind: 'clean',
    outcome: 'clean',
    decision: ADVANCE_TO_REVIEW,
    iteration: 1
  },
  {
    id: 'F-last-step',
    story: 'US1-3',
    issues: [],
    handoffs: [
      {
        id: 'T152',
        basis: 'person-only last step',
        text: 'push the branch and open a pull request'
      }
    ],
    figures: { ...NO_OPEN_WORK, user_run_tasks: 1 },
    token: true,
    kind: 'clean',
    outcome: 'clean',
    decision: ADVANCE_TO_REVIEW,
    iteration: 1
  },
  {
    id: 'F-approval',
    story: 'FR-016',
    issues: [],
    handoffs: [
      {
        id: 'T153',
        basis: 'approval',
        text: 'deploy the docs after maintainer approval'
      }
    ],
    figures: { ...NO_OPEN_WORK, user_run_tasks: 1 },
    token: true,
    kind: 'clean',
    outcome: 'clean',
    decision: ADVANCE_TO_REVIEW,
    iteration: 1
  },
  {
    id: 'F-none',
    story: 'D9',
    issues: [],
    handoffs: [],
    figures: { ...NO_OPEN_WORK, user_run_tasks: 0 },
    token: true,
    kind: 'clean',
    outcome: 'clean',
    decision: ADVANCE_TO_REVIEW,
    iteration: 1
  }
];

const WRITE_PARSER_TEST = 'T040 write the parser test';

/**
 * Reports where work is still open: a pending task loops, and the cap still ends
 * the loop. A spec gap or a blocked task is not pending, so the host advances,
 * but neither report is clean, so the result is not a pass.
 */
const OPEN_WORK_FIXTURES: readonly Fixture[] = [
  {
    id: 'F-mixed',
    story: 'US2-1',
    issues: [WRITE_PARSER_TEST],
    handoffs: [PUSH_BRANCH],
    figures: { pending_tasks: 1, spec_gaps: 0, blocked_tasks: 0, user_run_tasks: 1 },
    token: false,
    kind: 'remaining_issues',
    outcome: 'issues_remain',
    decision: { kind: 'loop', nextIteration: 2 },
    iteration: 1
  },
  {
    id: 'F-gap',
    story: 'US2-2',
    issues: ['FR-012: no code implements it'],
    handoffs: [PUSH_BRANCH],
    figures: { pending_tasks: 0, spec_gaps: 1, blocked_tasks: 0, user_run_tasks: 1 },
    token: false,
    kind: 'remaining_issues',
    outcome: 'issues_remain',
    decision: ADVANCE_TO_REVIEW,
    iteration: 1
  },
  {
    id: 'F-blocked',
    story: 'US2-5',
    issues: ['T037 blocked by D-2: which of two equal sources governs?'],
    handoffs: [PUSH_BRANCH],
    figures: { pending_tasks: 0, spec_gaps: 0, blocked_tasks: 1, user_run_tasks: 1 },
    token: false,
    kind: 'remaining_issues',
    outcome: 'issues_remain',
    decision: ADVANCE_TO_REVIEW,
    iteration: 1
  },
  {
    id: 'F-review',
    story: 'FR-016, D1',
    issues: ['T041 merge the change after review'],
    handoffs: [],
    figures: { pending_tasks: 1, spec_gaps: 0, blocked_tasks: 0, user_run_tasks: 0 },
    token: false,
    kind: 'remaining_issues',
    outcome: 'issues_remain',
    decision: { kind: 'loop', nextIteration: 2 },
    iteration: 1
  },
  {
    id: 'F-cap',
    story: 'FR-011',
    issues: [WRITE_PARSER_TEST],
    handoffs: [PUSH_BRANCH],
    figures: { pending_tasks: 1, spec_gaps: 0, blocked_tasks: 0, user_run_tasks: 1 },
    token: false,
    kind: 'remaining_issues',
    outcome: 'issues_remain',
    decision: { kind: 'halt', status: 'failed', cause: CAP_EXHAUSTED_CAUSE },
    iteration: DEFAULT_ITERATION_CAP
  }
];

describe('implement report fixtures: the host, through the real parser and transition', () => {
  it('control: the loop condition and the next Phase come from the shipped example', () => {
    // Without this, every fixture below could pass against a pipeline that no
    // longer loops implement, or no longer runs the code review after it.
    expect(retryCondition).toBe('pending_tasks > 0');
    expect(example.phaseIds).toContain(IMPLEMENT);
    const at = example.phaseIds.indexOf(IMPLEMENT);
    expect(example.phaseIds[at + 1]).toBe(NEXT_PHASE);
  });

  it('control: a report with pending work loops, so the fixtures below can tell the two apart', () => {
    const loop = run(
      buildReport({
        issues: ['T040 write the parser test'],
        handoffs: [],
        figures: { pending_tasks: 1, spec_gaps: 0, blocked_tasks: 0, user_run_tasks: 0 },
        token: false
      }),
      1
    );
    expect(loop.decision).toMatchObject({ kind: 'loop' });
  });

  describe('only a hand-off is left', () => {
    it.each(ONLY_HANDOFF_FIXTURES)('$id ($story) is read as it was written', expectFixture);

    it('F4.7: every report with nothing but hand-offs advances after iteration 1', () => {
      const handoffOnly = ONLY_HANDOFF_FIXTURES.filter(({ id }) => id !== 'F-none');
      expect(handoffOnly.map(({ id }) => id)).toEqual(['F-only', 'F-last-step', 'F-approval']);
      for (const fixture of handoffOnly) {
        const taken = run(buildReport(fixture), 1);
        expect(taken.decision.kind, fixture.id).toBe('advance');
        expect(taken.decision, fixture.id).toMatchObject({ nextPhase: NEXT_PHASE });
      }
    });
  });

  describe('work is still open beside, or instead of, a hand-off', () => {
    it.each(OPEN_WORK_FIXTURES)('$id ($story) is read as it was written', expectFixture);

    it('F4.6: no report with a pending task, a spec gap or a blocked task is clean', () => {
      expect(OPEN_WORK_FIXTURES).toHaveLength(5);
      for (const fixture of OPEN_WORK_FIXTURES) {
        const { pending_tasks, spec_gaps, blocked_tasks } = fixture.figures;
        expect(pending_tasks + spec_gaps + blocked_tasks, `${fixture.id} has open work`).toBeGreaterThan(0);
        const taken = run(buildReport(fixture), fixture.iteration);
        expect(taken.outcome, fixture.id).not.toBe('clean');
      }
    });

    it('F-cap stops where the cap says, as it did before hand-offs were set aside', () => {
      const cap = OPEN_WORK_FIXTURES.find(({ id }) => id === 'F-cap');
      expect(cap?.iteration).toBe(DEFAULT_ITERATION_CAP);
      // One iteration earlier the same report still loops: the cap is the only
      // difference between the two.
      const before = run(buildReport(cap!), DEFAULT_ITERATION_CAP - 1);
      expect(before.decision).toMatchObject({ kind: 'loop', nextIteration: DEFAULT_ITERATION_CAP });
    });

    it('F4.8 control: a hand-off list directly under the issues, with no blank line, gives the same issues', () => {
      const mixed = OPEN_WORK_FIXTURES.find(({ id }) => id === 'F-mixed')!;
      const tight = run(buildReport(mixed, '\n'), 1);
      expect(tight.stdout).toContain(`- ${WRITE_PARSER_TEST}\nHand-off tasks (for the user):`);
      expect(extractRemainingIssues(tight.stdout).map((issue) => issue.summary)).toEqual([
        WRITE_PARSER_TEST
      ]);
    });
  });
});
