// The authority `examples/speckit-new-feature.pipeline.yaml` delegates to the
// agent in its implement and finalize Phases.
//
// Two unattended runs stopped on a question nobody could answer. Implement
// reported a task as "needs a maintainer decision", `pending_tasks` stayed above
// zero, and the Phase looped to its cap. Finalize refused to bump a lockfile
// because "a lockfile bump is outside this task and needs your approval", and
// asked for a go-ahead no headless run can give. Both Phases now say what the
// agent may settle alone, what it must set aside, and what it must report; the
// write-up is `docs/audits/implement-stall-on-undecidable-task-2026-10-28.md`
// in the workspace.
//
// This file pins that text. The Phases are prose, so a quiet edit can widen or
// drop a limit and nothing else goes red: seven other test files load this
// document and none asserts on an instruction. What is pinned is the shape of
// the delegation, not its wording: each limit by a phrase that carries it, the
// loop condition that must NOT absorb the new counts, and the report headings,
// run through the real stdout parser so they cannot be read as issues.

import { describe, expect, it } from 'vitest';

import { extractOpenQuestions, extractRemainingIssues } from '../../../src/parser/stdout-parser';
import { instructionOf, loadExample, phaseOf } from '../../fixtures/speckit-new-feature-example';

/** The version the text changes shipped at; a later edit may go higher. */
const FIRST_DELEGATING_VERSION = 3;

type Pin = readonly [label: string, pattern: RegExp];

function expectPins(text: string, pins: readonly Pin[]): void {
  for (const [label, pattern] of pins) {
    expect(text, label).toMatch(pattern);
  }
}

// The hand-off clauses of implement's instruction. Each pin is declared once, as
// a named constant: the real-text test and the mutation control below read the
// same constant, so a control proves something about the test that actually runs.
// A pin names a clause by one phrase that carries it, not the whole sentence.
const HANDOFF_ONLY_THREE: Pin = ['a hand-off is one of three cases', /only in these three cases/i];
const HANDOFF_APPROVAL_NAMED: Pin = [
  'approval case names a person',
  /names a person's approval as the condition/i
];
const HANDOFF_PERSON_ONLY_STEP: Pin = [
  'person-only last step case',
  /only remaining step is pushing, opening or merging a pull request, watching CI, or deploying/i
];
const HANDOFF_APPROVAL_NOT_REVIEW: Pin = [
  'review and test wording is not approval',
  /Review, test results and other conditions do not count/i
];
const HANDOFF_BOUND: Pin = [
  'an undone implementation step keeps a task pending',
  /any implementation step still undone is pending/i
];
const HANDOFF_NOT_DIFFICULTY: Pin = [
  'difficulty never makes a hand-off',
  /never make a task a hand-off/i
];
const HANDOFF_MARKER_OUTSIDE_CODE: Pin = [
  'a marker counts outside inline code',
  /carries the token USER-RUN outside inline code/
];
const HANDOFF_QUOTED_NOT_MARKED: Pin = [
  'a quoted mention is not a mark',
  /only quotes the token in inline code is not marked/i
];
// Takes over the label `not attempted`.
const HANDOFF_NO_TICK: Pin = [
  'not attempted',
  /Do not attempt a hand-off task, do not mark it complete/i
];
// A marker takes a task out of the loop, so an agent allowed to write one could
// label its way past the gate. Widens the label `agent does not write markers`.
const HANDOFF_MARKER_PROTECTED: Pin = [
  'agent does not write markers',
  /do not add, remove or edit any marker or approval wording/i
];
const HANDOFF_HEADING: Pin = ['listed for the user', /"Hand-off tasks \(for the user\):"/];
const HANDOFF_BASIS_FORMAT: Pin = [
  'each hand-off is listed with its basis',
  /`- <task id> \(<basis>\): <task text>`/
];
const HANDOFF_HEADING_OMITTED: Pin = [
  'no heading with no hand-off',
  /With none open, omit that heading/i
];
const HANDOFF_NOT_AN_ISSUE: Pin = ['a hand-off is never an issue', /Never list a hand-off task there/i];
const CLEAR_RULE: Pin = [
  'CLEAR needs no pending task, spec gap or blocked task',
  /0 tasks are pending, 0 spec gaps remain and 0 tasks are blocked → emit \[SCHEGENT_STATUS: CLEAR\]/
];
const CLEAR_DESPITE_HANDOFFS: Pin = ['CLEAR despite hand-offs', /even when hand-off tasks remain/i];
const PENDING_EXCLUDES_HANDOFFS: Pin = [
  'pending excludes the rest',
  /`pending_tasks` excludes blocked and hand-off tasks/i
];
const HANDOFF_COUNT_EQUALS_LIST: Pin = [
  'the hand-off count equals the list',
  /`user_run_tasks` equals the number of tasks listed under "Hand-off tasks \(for the user\):"/
];
const LIST_OUTSIDE_AUDIT_BLOCK: Pin = [
  'the list sits outside the audit block',
  /before the SCHEGENT AUDIT LOG block and outside it/i
];
const TOKEN_WHERE_CONTRACT_SAYS: Pin = [
  'the token only where the contract reads it',
  /only where the output contract says, on its own line after the audit log block/i
];
const TOKEN_NEVER_ECHOED: Pin = [
  'the token is never echoed',
  /Never echo it in prose, in a list or in a quote/i
];

// The tasks Phase's clauses. It is the only writer of the marker, so these are the
// other half of the protection `HANDOFF_MARKER_PROTECTED` gives on the implement side.
const TASKS_RUNS_SKILL: Pin = [
  'runs the skill first',
  /Run \/speckit-tasks on the active feature/
];
const TASKS_MARK_ONLY_FOR_PERSON: Pin = [
  'a mark only when a person is needed',
  /\[USER-RUN\][^\n]*only when it needs a person/i
];
const TASKS_PERSON_STEPS: Pin = [
  'the person-only steps',
  /pushing, opening or merging a pull request, watching CI, deploying to a system outside this repository, an explicit approval/i
];
const TASKS_WAITING_WORK: Pin = [
  'work waiting on one of them',
  /work that cannot start until one of those has happened/i
];
const TASKS_NEVER_MARK_HEADLESS: Pin = [
  'headless work is never marked',
  /Never mark work the authorized headless run can complete/i
];
const TASKS_SPLIT: Pin = ['a mixed line is split', /split it in two/i];
const TASKS_NO_ADDED_TASK: Pin = ['no person-only task is added', /Never add a person-only task/i];
const TASKS_QUOTED_MENTION: Pin = [
  'a mention of the label is written in inline code',
  /inline code, as `USER-RUN`/
];

/**
 * A mutation control: one clause removed from the real text, in memory only
 * (nothing is written to disk). A control that proves nothing must fail here,
 * never pass as a false kill, so it asserts three things in order:
 *
 * 1. applied: every removal occurs in the real text, and the mutated text differs;
 * 2. live: every pin that should catch it matches the real text;
 * 3. killed: at least one of those pins does not match the mutated text.
 */
interface Mutant {
  readonly id: string;
  readonly removals: readonly string[];
  readonly killedBy: readonly Pin[];
}

function mutate(text: string, removals: readonly string[]): string {
  return removals.reduce((mutated, removal) => mutated.split(removal).join(''), text);
}

function expectMutantKilled(real: string, mutant: Mutant): void {
  const mutated = mutate(real, mutant.removals);
  for (const removal of mutant.removals) {
    expect(real, `${mutant.id}: the removal occurs in the real text`).toContain(removal);
  }
  expect(mutated, `${mutant.id}: the removal changed the text`).not.toBe(real);

  expectPins(real, mutant.killedBy);

  const missed = mutant.killedBy.filter(([, pattern]) => !pattern.test(mutated));
  expect(missed.length, `${mutant.id}: a pin fails on the mutated text`).toBeGreaterThan(0);
}

describe('the shipped new-feature pipeline: delegated authority', () => {
  const example = loadExample();
  const implement = instructionOf(phaseOf(example, 'speckit-implement'));
  const finalize = instructionOf(phaseOf(example, 'finalize'));
  const tasks = instructionOf(phaseOf(example, 'speckit-tasks'));

  it('control: the example still ships the three Phases and a readable pipeline version', () => {
    // Without this, every pin below could pass on an empty read.
    expect(implement.length).toBeGreaterThan(0);
    expect(finalize.length).toBeGreaterThan(0);
    expect(tasks.length).toBeGreaterThan(0);
    expect(Number.isFinite(example.pipelineVersion)).toBe(true);
  });

  it('bumps the pipeline and the three Phases whose text changed', () => {
    // The version is how an operator who imported the old text learns there is a
    // newer one; a text change without a bump reaches only fresh installs.
    expect(example.pipelineVersion).toBeGreaterThanOrEqual(FIRST_DELEGATING_VERSION);
    for (const phaseId of ['speckit-tasks', 'speckit-implement', 'finalize']) {
      expect(
        phaseOf(example, phaseId).metadata.version,
        `${phaseId} version`
      ).toBeGreaterThanOrEqual(FIRST_DELEGATING_VERSION);
    }
  });

  describe('speckit-implement', () => {
    it('still loops on pending tasks alone', () => {
      // A blocked task or a hand-off that fed this condition would loop to the cap,
      // which is the stall the set-aside exists to end.
      expect(phaseOf(example, 'speckit-implement').spec.retryCondition).toBe('pending_tasks > 0');
    });

    it('tells the agent nobody can answer, so it decides or sets aside', () => {
      expectPins(implement, [
        ['no questions', /nobody can answer a question/i],
        ['never asks', /never ask the user anything/i],
        ['never waits', /never stop to wait/i]
      ]);
    });

    it('ranks the sources the agent settles a conflict by', () => {
      expect(implement).toMatch(
        /constitution[^\n]*spec\.md[^\n]*plan\.md[^\n]*research\.md[^\n]*tasks\.md/i
      );
    });

    it('bounds what the agent may decide alone', () => {
      expectPins(implement, [
        ['project rules win', /project rules outrank this authority/i],
        ['reversible and local', /reversible inside this repository/i],
        ['no security or privacy weakening', /never weaken a security or privacy property/i],
        ['constitution is not editable', /edit the constitution/i],
        ['requirements are not rewritten', /delete or reinterpret a requirement in spec\.md/i],
        [
          'existing tests keep their outcome',
          /expected outcome of a test that already exists on develop/i
        ]
      ]);
    });

    it('records decisions where a maintainer can find them, with a status', () => {
      expectPins(implement, [
        ['decision record', /<feature_dir>\/decisions\.md/],
        ['decided entries', /Status: decided/],
        ['open entries', /Status: needs-maintainer/],
        ['how to undo', /"Reversal:"/]
      ]);
    });

    it('sets aside what needs a maintainer, without ticking it or retrying it', () => {
      expectPins(implement, [
        ['blocked tasks', /Blocked tasks\./],
        ['unchecked', /Leave the task unchecked in tasks\.md/i],
        ['dependants are blocked', /depends on a blocked task is blocked too/i],
        ['no retry', /Do not attempt it again in a later iteration/i],
        ['difficulty is not a blocker', /Difficulty, size and a failing test you can fix are not blockers/i]
      ]);
    });

    it('does not let a person-only step stall the loop or pass for done', () => {
      expectPins(implement, [
        ['hand-off marker', /USER-RUN/],
        HANDOFF_MARKER_OUTSIDE_CODE,
        HANDOFF_QUOTED_NOT_MARKED,
        HANDOFF_NO_TICK,
        HANDOFF_MARKER_PROTECTED,
        HANDOFF_HEADING
      ]);
    });

    it('names the three cases that make a task a hand-off, and no other', () => {
      expectPins(implement, [
        HANDOFF_ONLY_THREE,
        HANDOFF_APPROVAL_NAMED,
        HANDOFF_PERSON_ONLY_STEP
      ]);
    });

    it('keeps unfinished work pending: review wording, an undone step and difficulty are no hand-off', () => {
      expectPins(implement, [
        HANDOFF_APPROVAL_NOT_REVIEW,
        HANDOFF_BOUND,
        HANDOFF_NOT_DIFFICULTY
      ]);
    });

    it('lists each open hand-off with its basis, outside the issues and the audit block', () => {
      expectPins(implement, [
        HANDOFF_BASIS_FORMAT,
        HANDOFF_HEADING_OMITTED,
        HANDOFF_NOT_AN_ISSUE,
        LIST_OUTSIDE_AUDIT_BLOCK
      ]);
    });

    it('counts all four figures and lets only pending_tasks re-loop', () => {
      expectPins(implement, [
        ['pending', /`pending_tasks: <N>`/],
        ['spec gaps', /`spec_gaps: <N>`/],
        ['blocked', /`blocked_tasks: <N>`/],
        ['hand-offs', /`user_run_tasks: <N>`/],
        PENDING_EXCLUDES_HANDOFFS,
        HANDOFF_COUNT_EQUALS_LIST,
        ['others do not loop', /the other three are recorded and do not re-loop this Phase/i]
      ]);
    });

    it('does not report CLEAR while a task is blocked, and reports it despite hand-offs', () => {
      expectPins(implement, [CLEAR_RULE, CLEAR_DESPITE_HANDOFFS]);
    });

    it('emits the completion token only where the output contract reads it', () => {
      expectPins(implement, [TOKEN_WHERE_CONTRACT_SAYS, TOKEN_NEVER_ECHOED]);
    });
  });

  describe('speckit-tasks', () => {
    // The tasks Phase grants the marker; implement never does. Without a limit on
    // the grant, the phase that writes it could label implementable work and take
    // it out of the loop, so its text is pinned as the implement side is.
    it('does not loop, and stays a workspace Phase', () => {
      const phase = phaseOf(example, 'speckit-tasks');
      expect(phase.spec.retryCondition).toBeUndefined();
      expect(phase.spec.sideEffects).toBeUndefined();
    });

    it('runs the skill first, on the active feature', () => {
      expectPins(tasks, [TASKS_RUNS_SKILL]);
    });

    it('marks a task only when it needs a person', () => {
      expectPins(tasks, [TASKS_MARK_ONLY_FOR_PERSON, TASKS_PERSON_STEPS, TASKS_WAITING_WORK]);
    });

    it('never marks work the headless run can complete, and splits a mixed line', () => {
      expectPins(tasks, [TASKS_NEVER_MARK_HEADLESS, TASKS_SPLIT]);
    });

    it('adds no task of its own, and writes a mention of the label in inline code', () => {
      expectPins(tasks, [TASKS_NO_ADDED_TASK, TASKS_QUOTED_MENTION]);
    });
  });

  describe('finalize', () => {
    it('is still the last Phase: it does not loop', () => {
      expect(phaseOf(example, 'finalize').spec.retryCondition).toBeUndefined();
    });

    it('tells the agent nobody can answer, so it acts inside its authority', () => {
      expectPins(finalize, [
        ['no questions', /nobody can answer a question/i],
        ['no approval requests', /never ask for approval/i]
      ]);
    });

    it('presumes the feature caused a failure unless shown otherwise', () => {
      // The delegation applies only to failures the feature did not cause; the
      // default has to point the other way or a feature bug can be filed as noise.
      expect(finalize).toMatch(/caused by the feature unless you can show/i);
    });

    it('keeps the ban on masking a failure', () => {
      expectPins(finalize, [
        ['still no masking', /Do NOT mask failures/],
        ['audit thresholds count as masking', /weaker audit threshold or ignore list/i]
      ]);
    });

    it('authorizes a bounded dependency fix', () => {
      expectPins(finalize, [
        ['explicit authority', /authorized to fix/i],
        ['no approval needed', /without asking for approval/i],
        ['smallest step', /lowest version the advisory names as fixed/i],
        ['patch or minor only', /patch or minor versions only/i],
        ['non-forcing', /does not force/i],
        ['bounded count', /at most three/i]
      ]);
    });

    it('answers the scope rule that stopped the run, and still yields to an outright ban', () => {
      // The refusal was "a lockfile bump is outside this task". Without a sentence
      // that puts the fix inside the task, the delegation does not move that agent;
      // without the second half, it overrides a project that forbids the change.
      expectPins(finalize, [
        ['inside the task', /part of this Phase's task/i],
        ['an outright ban still wins', /forbids dependency changes outright/i]
      ]);
    });

    it('withholds the authority for anything larger, and for any way of silencing a check', () => {
      expectPins(finalize, [
        ['no major bump', /a major version bump/i],
        ['no new, removed or replaced dependency', /adding, removing or replacing a dependency/i],
        ['no overrides', /overrides, resolutions or constraints entry/i],
        ['no blanket update', /forced or blanket update/i],
        [
          'no check weakening',
          /audit command, its threshold, its ignore list or a waiver, or to CI configuration/i
        ],
        ['no unfixable advisory', /advisory with no fixed version/i]
      ]);
    });

    it('names a per-package command for npm, never the tree-wide audit fix', () => {
      // `npm audit fix` applies every fixable remediation in the tree in one install,
      // so offered as the "targeted" example it walks past the three-package bound.
      expect(finalize).toMatch(/`npm update <package>`/);
      expect(finalize).toMatch(/blanket update, such as `npm audit fix`/i);
      expect(finalize).not.toMatch(/for example `npm audit fix`/i);
    });

    it('re-runs everything after a bump and undoes a bump that breaks a green check', () => {
      expectPins(finalize, [
        ['full re-run', /[Rr]e-run the FULL check set/],
        ['revertible', /git revert/]
      ]);
    });

    it('commits the feature before the dependency fix, and merges only after both', () => {
      // The order is what makes `git revert` of the fix clean: the fix is its own
      // commit on top of the feature's, never mixed into it.
      const feature = finalize.indexOf('feat(<feature_name>)');
      const fix = finalize.indexOf('fix(deps)');
      const merge = finalize.indexOf('git merge --no-ff');
      expect(feature, 'feature commit step').toBeGreaterThanOrEqual(0);
      expect(fix, 'dependency fix commit').toBeGreaterThan(feature);
      expect(merge, 'merge step').toBeGreaterThan(fix);
    });

    it('does not merge while a check fails or a decision waits on a maintainer', () => {
      expect(finalize).toMatch(
        /only if every check is green and <feature_dir>\/decisions\.md has no entry with "Status: needs-maintainer"/
      );
    });

    it('reports CLEAR only once the merge is done', () => {
      // Finalize is the last Phase, so what it reports is the run's outcome. A
      // withheld merge reported as CLEAR would close the run with a decision open.
      expect(finalize).toMatch(
        /all checks are green and the merge is done → emit \[SCHEGENT_STATUS: CLEAR\]/
      );
    });

    it('reports each dependency it changed, and keeps its metrics', () => {
      expectPins(finalize, [
        ['change list', /"Dependency fixes applied:"/],
        ['passing', /`checks_passing: <N>`/],
        ['failing', /`checks_failing: <N>`/]
      ]);
    });
  });

  describe('mutation controls: a clause dropped from the shipped text is caught', () => {
    // Feature 241 FR-017: each clause that keeps a hand-off from being retried, or
    // an unfinished task from passing as one, has a control that removes it and
    // expects a named pin to fail. The pins are the constants declared above.
    it('M1 hand-off exclusion is caught when removed', () => {
      expectMutantKilled(implement, {
        id: 'M1',
        removals: [' and hand-off'],
        killedBy: [PENDING_EXCLUDES_HANDOFFS]
      });
    });

    it('M2 no-tick clause is caught when removed', () => {
      expectMutantKilled(implement, {
        id: 'M2',
        removals: [', do not mark it complete'],
        killedBy: [HANDOFF_NO_TICK]
      });
    });

    it('M3 marker protection is caught when removed', () => {
      expectMutantKilled(implement, {
        id: 'M3',
        removals: [', and do not add, remove or edit any marker or approval wording on any task line'],
        killedBy: [HANDOFF_MARKER_PROTECTED]
      });
    });

    it("M4 B2's never-mark sentence is caught when removed", () => {
      expectMutantKilled(tasks, {
        id: 'M4',
        removals: ['Never mark work the authorized headless run can complete.'],
        killedBy: [TASKS_NEVER_MARK_HEADLESS]
      });
    });

    it('M5 CLEAR rule is caught when removed', () => {
      expectMutantKilled(implement, {
        id: 'M5',
        removals: [', 0 spec gaps remain and 0 tasks are blocked'],
        killedBy: [CLEAR_RULE]
      });
    });

    it('M6 hand-off heading is caught when removed', () => {
      expectMutantKilled(implement, {
        id: 'M6',
        removals: ['"Hand-off tasks (for the user):"'],
        killedBy: [HANDOFF_HEADING]
      });
    });

    it("M7 D2's bound is caught when removed", () => {
      expectMutantKilled(implement, {
        id: 'M7',
        removals: [
          ' A task with any implementation step still undone is pending, even when its line also names such a step.'
        ],
        killedBy: [HANDOFF_BOUND]
      });
    });

    it("M8 D6's quoted-mention rule is caught when removed", () => {
      expectMutantKilled(implement, {
        id: 'M8',
        removals: [
          ' outside inline code',
          ' A line that only quotes the token in inline code is not marked.'
        ],
        killedBy: [HANDOFF_MARKER_OUTSIDE_CODE, HANDOFF_QUOTED_NOT_MARKED]
      });
    });
  });

  describe('the report headings the Phases ask for, through the real stdout parser', () => {
    // Any `"...:"` the instructions quote. The two headings the host reads are
    // left out of the loop; the rest are human-readable only and must stay that way.
    const HOST_HEADINGS = new Set(['Remaining issues:', 'Open questions:']);
    const quoted = (text: string): string[] =>
      [...text.matchAll(/"([^"\n]+:)"/g)].map((match) => match[1]!);
    const otherHeadings = [
      ...new Set(
        [...example.phases.values()].flatMap((phase) => quoted(instructionOf(phase)))
      )
    ].filter((heading) => !HOST_HEADINGS.has(heading));

    it('control: the parser reads the host heading it is meant to', () => {
      expect(extractRemainingIssues('Remaining issues:\n- a\n- b')).toEqual([
        { summary: 'a' },
        { summary: 'b' }
      ]);
    });

    it('control: the new headings are among the ones checked', () => {
      expect(otherHeadings).toContain('Hand-off tasks (for the user):');
      expect(otherHeadings).toContain('Dependency fixes applied:');
    });

    it.each(otherHeadings)('%s is not read as a heading the host acts on', (heading) => {
      expect(extractRemainingIssues(`${heading}\n- x`)).toEqual([]);
      expect(extractOpenQuestions(`${heading}\n- x`)).toEqual([]);
    });

    it.each(otherHeadings)('%s does not leak its list into the issues above it', (heading) => {
      const report = `Remaining issues:\n- a\n\n${heading}\n- b`;
      expect(extractRemainingIssues(report)).toEqual([{ summary: 'a' }]);
    });

    it('a blocked-task report keeps its issues and drops the hand-offs', () => {
      const report = [
        'Remaining issues:',
        '- T037 blocked by D-2: which of two equal sources governs?',
        '- FR-012: no code implements it',
        '',
        'Hand-off tasks (for the user):',
        '- T150 push the branch'
      ].join('\n');
      expect(extractRemainingIssues(report).map((issue) => issue.summary)).toEqual([
        'T037 blocked by D-2: which of two equal sources governs?',
        'FR-012: no code implements it'
      ]);
    });
  });
});
