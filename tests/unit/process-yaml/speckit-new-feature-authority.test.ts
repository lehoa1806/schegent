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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { extractOpenQuestions, extractRemainingIssues } from '../../../src/parser/stdout-parser';
import { parsePipelinePackage } from '../../../src/services/process-yaml/pipeline-document';
import type { PhaseYamlDocument } from '../../../src/services/process-yaml/types';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';

const EXAMPLE = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'examples',
  'speckit-new-feature.pipeline.yaml'
);

/** The version the text changes shipped at; a later edit may go higher. */
const FIRST_DELEGATING_VERSION = 3;

interface LoadedExample {
  readonly phases: ReadonlyMap<string, PhaseYamlDocument>;
  readonly pipelineVersion: number;
}

function loadExample(): LoadedExample {
  const parsed = parseDocumentText(readFileSync(EXAMPLE, 'utf8'));
  if (!parsed.ok) throw new Error(`${parsed.refusal.code}: ${parsed.refusal.message}`);
  const pkg = parsePipelinePackage(parsed.node);
  if (!pkg.ok) throw new Error(`${pkg.refusal.code}: ${pkg.refusal.message}`);

  const phases = new Map<string, PhaseYamlDocument>();
  let pipelineVersion = Number.NaN;
  for (const resource of pkg.resources) {
    if (!resource.ok) throw new Error(`refused ${resource.resourceKind} ${resource.resourceId}`);
    if (resource.resourceKind === 'phase') {
      phases.set(resource.document.metadata.phaseId, resource.document);
    } else {
      pipelineVersion = resource.definition.version;
    }
  }
  return { phases, pipelineVersion };
}

function phaseOf(example: LoadedExample, phaseId: string): PhaseYamlDocument {
  const phase = example.phases.get(phaseId);
  if (phase === undefined) throw new Error(`the example no longer ships ${phaseId}`);
  return phase;
}

function instructionOf(phase: PhaseYamlDocument): string {
  const text = phase.spec.instruction;
  if (text === undefined) throw new Error(`${phase.metadata.phaseId} carries no instruction`);
  return text;
}

type Pin = readonly [label: string, pattern: RegExp];

function expectPins(text: string, pins: readonly Pin[]): void {
  for (const [label, pattern] of pins) {
    expect(text, label).toMatch(pattern);
  }
}

describe('the shipped new-feature pipeline: delegated authority', () => {
  const example = loadExample();
  const implement = instructionOf(phaseOf(example, 'speckit-implement'));
  const finalize = instructionOf(phaseOf(example, 'finalize'));

  it('control: the example still ships the two Phases and a readable pipeline version', () => {
    // Without this, every pin below could pass on an empty read.
    expect(implement.length).toBeGreaterThan(0);
    expect(finalize.length).toBeGreaterThan(0);
    expect(Number.isFinite(example.pipelineVersion)).toBe(true);
  });

  it('bumps the pipeline and both Phases whose text changed', () => {
    // The version is how an operator who imported the old text learns there is a
    // newer one; a text change without a bump reaches only fresh installs.
    expect(example.pipelineVersion).toBeGreaterThanOrEqual(FIRST_DELEGATING_VERSION);
    for (const phaseId of ['speckit-implement', 'finalize']) {
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
        ['not attempted', /Do not attempt a hand-off task, do not mark it complete/i],
        // A marker takes a task out of the loop, so an agent allowed to write one
        // could label its way past the gate.
        ['agent does not write markers', /do not add, remove or edit any marker/i],
        ['listed for the user', /"Hand-off tasks \(for the user\):"/]
      ]);
    });

    it('counts all four figures and lets only pending_tasks re-loop', () => {
      expectPins(implement, [
        ['pending', /`pending_tasks: <N>`/],
        ['spec gaps', /`spec_gaps: <N>`/],
        ['blocked', /`blocked_tasks: <N>`/],
        ['hand-offs', /`user_run_tasks: <N>`/],
        ['pending excludes the rest', /`pending_tasks` excludes blocked and hand-off tasks/i],
        ['others do not loop', /the other three are recorded and do not re-loop this Phase/i]
      ]);
    });

    it('does not report CLEAR while a task is blocked', () => {
      expect(implement).toMatch(
        /0 tasks are pending, 0 spec gaps remain and 0 tasks are blocked → emit \[SCHEGENT_STATUS: CLEAR\]/
      );
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
