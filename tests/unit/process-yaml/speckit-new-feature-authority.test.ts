// The authority `examples/speckit-new-feature.workflow.yaml` delegates to the
// agent in its implement and finalize Phases.
//
// Two unattended runs stopped on a question nobody could answer. Implement
// reported a task as "needs a maintainer decision", `pending_tasks` stayed above
// zero, and the Phase looped to its cap. Finalize refused to bump a lockfile
// because "a lockfile bump is outside this task and needs your approval", and
// asked for a go-ahead no headless run can give. Both Phases now say what the
// agent may settle alone, what it must set aside, and what it must report; the
// retained incident context is in workspace
// `docs/features/round_5/reconciliation-incidents.md#undecidable-task-recurrence`.
//
// This file pins that text. The Phases are prose, so a quiet edit can widen or
// drop a limit and nothing else goes red: seven other test files load this
// document and none asserts on an instruction. What is pinned is the shape of
// the delegation, not its wording: each limit by a phrase that carries it, the
// loop condition that must NOT absorb the new counts, and the report headings,
// run through the real stdout parser so they cannot be read as issues.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AGENT_ISSUE_TAGS } from '../../../src/contracts/failure-record';
import { extractOpenQuestions, extractRemainingIssues } from '../../../src/parser/stdout-parser';
import { expectMutantKilled, expectPins, type Pin } from '../../fixtures/instruction-pins';
import { instructionOf, loadExample, phaseOf } from '../../fixtures/speckit-new-feature-example';

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
const HANDOFF_NOT_AN_ISSUE: Pin = ['a hand-off is listed separately', /List open hand-offs separately/i];
const CLEAR_RULE: Pin = [
  'CLEAR needs no pending task, spec gap or blocked task',
  /Report completion when 0 tasks are pending, 0 spec gaps remain and 0 tasks are blocked/
];
const CLEAR_DESPITE_HANDOFFS: Pin = ['CLEAR despite hand-offs', /even when hand-off tasks remain/i];
const PENDING_EXCLUDES_HANDOFFS: Pin = [
  'pending excludes the rest',
  /`pending_tasks` excludes blocked and hand-off tasks/i
];
const HANDOFF_COUNT_EQUALS_LIST: Pin = [
  'the hand-off count equals the list',
  /`user_run_tasks` equals the number of listed hand-offs/
];
const LIST_OUTSIDE_AUDIT_BLOCK: Pin = [
  'the list sits outside the audit block',
  /before the audit block/i
];

// The tasks Phase's clauses. It is the only writer of the marker, so these are the
// other half of the protection `HANDOFF_MARKER_PROTECTED` gives on the implement side.
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

describe('the shipped new-feature pipeline: delegated authority', () => {
  const example = loadExample();
  const implement = instructionOf(phaseOf(example, 'claude-speckit-implement'));
  const finalize = instructionOf(phaseOf(example, 'claude-finalize'));
  const tasks = instructionOf(phaseOf(example, 'claude-speckit-tasks'));

  it('ships the three Phase instructions', () => {
    // Without this, every pin below could pass on an empty read.
    expect(implement.length).toBeGreaterThan(0);
    expect(finalize.length).toBeGreaterThan(0);
    expect(tasks.length).toBeGreaterThan(0);
  });

  it('uses version 1 for the Workflow and every bundled Phase', () => {
    expect(example.pipelineVersion).toBe(1);
    for (const [id, phase] of example.phases) {
      expect(phase.metadata.version, id).toBe(1);
    }
  });

  it.each(['specify', 'plan'])('uses only /speckit-%s for the command', (role) => {
    expect(instructionOf(phaseOf(example, `claude-speckit-${role}`))).toBe(`/speckit-${role}`);
  });

  it.each([
    ['claude', ['clarify', 'tasks', 'checklist', 'analyze', 'implement', 'converge']],
    ['codex', ['implement', 'converge']],
    ['agy', ['implement', 'converge']]
  ] as const)('starts each %s command with its literal slash instruction', (backend, roles) => {
    for (const role of roles) {
      const id = `${backend}-speckit-${role}`;
      expect(instructionOf(phaseOf(example, id)).split('\n', 1)[0], id).toBe(`/speckit-${role}`);
    }
  });

  describe('claude-speckit-implement', () => {
    it('still loops on pending tasks alone', () => {
      // A blocked task or a hand-off that fed this condition would loop to the cap,
      // which is the stall the set-aside exists to end.
      expect(phaseOf(example, 'claude-speckit-implement').spec.retryCondition).toBe('pending_tasks > 0');
    });

    it('reports checklist approval blockers and preserves the checklist marks', () => {
      expectPins(implement, [
        ['reports the approval blocker', /If a required checklist still needs approval, report the blocker/],
        ['preserves reviewer marks', /leave its marks unchanged/]
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
        ['difficulty is not a blocker', /Difficulty and fixable failures never make a task a hand-off or a blocker/i]
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

    it('reports all four figures with blocked tasks and hand-offs counted separately', () => {
      expectPins(implement, [
        ['pending', /`pending_tasks: <N>`/],
        ['spec gaps', /`spec_gaps: <N>`/],
        ['blocked', /`blocked_tasks: <N>`/],
        ['hand-offs', /`user_run_tasks: <N>`/],
        PENDING_EXCLUDES_HANDOFFS,
        HANDOFF_COUNT_EQUALS_LIST
      ]);
    });

    it('does not report CLEAR while a task is blocked, and reports it despite hand-offs', () => {
      expectPins(implement, [CLEAR_RULE, CLEAR_DESPITE_HANDOFFS]);
    });

  });

  describe('claude-speckit-tasks', () => {
    // The tasks Phase grants the marker; implement never does. Without a limit on
    // the grant, the phase that writes it could label implementable work and take
    // it out of the loop, so its text is pinned as the implement side is.
    it('does not loop, and stays a workspace Phase', () => {
      const phase = phaseOf(example, 'claude-speckit-tasks');
      expect(phase.spec.retryCondition).toBeUndefined();
      expect(phase.spec.sideEffects).toBeUndefined();
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

  describe('claude-finalize', () => {
    it('does not loop', () => {
      expect(phaseOf(example, 'claude-finalize').spec.retryCondition).toBeUndefined();
    });

    it('reports approvals and decisions without waiting', () => {
      expect(finalize).toContain('Report approval or decision blockers without waiting.');
    });

    it('reports failing checks and holds the commit', () => {
      expectPins(finalize, [
        ['holds commit on a failed check', /Stop before committing if a check fails/],
        ['reports passing checks', /`checks_passing: <N>`/],
        ['reports failing checks', /`checks_failing: <N>`/]
      ]);
    });
  });

  describe('claude-speckit-clarify', () => {
    // Spec 278 (U1): a drained Run is admitted with no feature directory, and the host learns it
    // from this Phase's sidecar. The key and the relative-path rule are what the host reads
    // (`run-phase-facts.ts`).
    const clarify = instructionOf(phaseOf(example, 'claude-speckit-clarify'));

    it('reports the feature directory through the sidecar, under the key the host reads', () => {
      expect(clarify).toMatch(/write the single line `SCHEGENT_FEATURE_DIR=<dir>` to phase-message\.env/);
      expect(clarify).toMatch(/relative to the workspace root/);
      expect(clarify).toMatch(/list that file in the audit log's files_created/);
    });

    it('writes it only when the prompt carries none, and never as an absolute or parent path', () => {
      expect(clarify).toMatch(/if this prompt has no SCHEGENT_FEATURE_DIR line/i);
      expect(clarify).toMatch(/Never write an absolute path or one with a `\.\.` segment/);
    });

    it('keeps its loop condition', () => {
      const phase = phaseOf(example, 'claude-speckit-clarify');
      expect(phase.spec.retryCondition).toBe('open_questions > 0');
    });
  });

  it('ends the workflow at Finalize and omits the old Integrate Phase', () => {
    expect(example.phaseIds.at(-1)).toBe('claude-finalize');
    expect(example.phases.has('claude-speckit-integrate')).toBe(false);
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
          ' A task with any implementation step still undone is pending.'
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
      expect(otherHeadings).toContain('Review scope:');
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

// FR-R4-F15: keep the failure tags the parser recognizes next to the issue report.
describe('the shipped new-feature workflow: issue tags', () => {
  const example = loadExample();
  const taggedPhases = [
    'claude-speckit-analyze',
    'claude-speckit-implement',
    'claude-speckit-converge',
    'claude-code-review',
    'claude-security-review',
    'claude-finalize'
  ];

  it.each(taggedPhases)('%s asks for the accepted issue tags once, when applicable', (phaseId) => {
    const instruction = instructionOf(phaseOf(example, phaseId));
    const lines = instruction.split('\n').filter((line) => line.includes('Prefix each bullet with'));
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toContain('"Remaining issues:"');
    expect(line).toContain('when applicable');
    expect([...line.matchAll(/\[([a-z-]+)\]/g)].map((match) => match[1])).toEqual(AGENT_ISSUE_TAGS);
  });

  it('reads through the real stdout parser: a bullet tagged as the block asks is a tagged issue', () => {
    const report = ['Remaining issues:', '- [needs-decision] pick a retry budget', '- [regression] one case fails', '- no tag fits'].join('\n');
    expect(extractRemainingIssues(report)).toEqual([
      { tag: 'needs-decision', summary: 'pick a retry budget' },
      { tag: 'regression', summary: 'one case fails' },
      { summary: 'no tag fits' }
    ]);
  });

  it('leaves the bugfix example Phase instructions byte for byte as they were at 58e792ae (T4.4, FR-R5-F07)', () => {
    const baseline = '934bf0552a70d19514daace9895334e48ae275f25b07f7d728866ef9ee19cf30';
    const bytes = readFileSync(resolve(__dirname, '..', '..', '..', 'examples', 'speckit-bugfix.workflow.yaml'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(baseline);
    expect(bytes.toString('utf8')).not.toContain('Remaining issues');
  });
});
