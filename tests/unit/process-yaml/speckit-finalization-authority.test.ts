// FR-R4-F19 (feature 247, T010; contracts I, N, C, O and P) — the text of the two finalization
// Phases of `examples/speckit-new-feature.pipeline.yaml`: `finalize`, which verifies, repairs and
// commits only this feature's paths, and `integrate`, which moves each target branch without
// touching a checkout.
//
// Two defects sat in version 4 of `finalize`: it committed everything in the checkout, so another
// feature's half-done work went into this feature's commit, and it merged by switching branches in
// a checkout other sessions share. The Phases are prose, so a quiet edit can bring either back and
// nothing else goes red. This file pins the clauses that carry the fix, each by one phrase, and
// proves the pins live with four mutation controls. The fixtures in
// `tests/integration/process-yaml/finalization-fixtures.test.ts` execute the same commands.
//
// What is pinned is the shape of the rules, not their wording. A pin is declared once as a named
// constant: the real-text test and the mutation control read the same constant, so a control proves
// something about the test that actually runs.

import { describe, expect, it } from 'vitest';

import { PHASE_INSTRUCTION_MAX_LEN } from '../../../src/config/process-definition-validator';
import { extractOpenQuestions, extractRemainingIssues } from '../../../src/parser/stdout-parser';
import { expectMutantKilled, expectPins, type Pin } from '../../fixtures/instruction-pins';
import { instructionOf, loadExample, phaseOf } from '../../fixtures/speckit-new-feature-example';

const example = loadExample();

/** The Phase's instruction, read inside each test so a missing Phase fails that test alone. */
const instructionFor = (phaseId: string): string => instructionOf(phaseOf(example, phaseId));

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A pin on one phrase, taken verbatim from the contract text. */
const has = (label: string, phrase: string): Pin => [label, new RegExp(escapeRegExp(phrase))];

/** A negative pin: it matches the real text only while the phrase is absent, so a control can fail it. */
const lacks = (label: string, phrase: string): Pin => [label, new RegExp(`^(?![\\s\\S]*${escapeRegExp(phrase)})`)];

const FINALIZATION_PHASES = ['finalize', 'integrate'] as const;

// `Repositories:` (contract C2), the same block in both Phases (contract C1).
const REPOSITORIES_PINS: readonly Pin[] = [
  has('resolved before any write, with each command run as written', 'Resolve them before any write, from the workspace root <root>, running each command as written'),
  has('one argument per placeholder', 'each placeholder is one argument, and a <... paths> placeholder one argument per path'),
  has('the heading is exact', 'Under a heading exactly "## Implementation repositories", <root>/AGENTS.md declares one per bullet starting with inline code'),
  has('an entry is a path, then an optional base', 'a path relative to <root> (`.` for <root>), optionally then `(base: <ref>)`, each in inline code, and nothing else'),
  has('a closed character set, and a default base', 'Paths and refs use only letters, digits and . _ / - and never start with -; the base defaults to develop'),
  has('inference without the section', 'Without the section: repo if <root> holds specs/ and repo is a repository top level, else . if <root> is one'),
  has('nothing else picks a repository', 'Nothing else picks a repository.'),
  has('the envelope is added last, on develop', 'Then add the envelope <root>, last, with base develop, when it is a repository top level not already listed.'),
  has('an unresolved scope writes nothing anywhere', 'The scope is unresolved, and nothing is written anywhere, on:'),
  has('no repository, a section with no entry, a broken entry or a twin', 'no repository; a section with no entry, a broken entry or a twin; two entries at one location'),
  has('containment by the physical path', 'absolute, missing or outside <root> by `cd <root>/<path> && pwd -P`'),
  has('a top level by its empty prefix', 'whose `git -C <path> rev-parse --show-prefix` fails or prints anything'),
  has('a merge base is required', 'whose `git -C <path> merge-base HEAD <base>` (its <merge-base>) fails or prints nothing'),
  has('an undeclared gitlink that is no repository', 'a gitlink of <root> (mode 160000 in `git -C <root> ls-files --stage`) in the status below that is no repository'),
  has('each reason is a needs-decision bullet', 'Report each reason under "Remaining issues:" tagged [needs-decision].'),
  has('no substitute, no fetch, no edit of the declaration', 'Never substitute a branch, fetch, or edit the declaration.')
];

// `Ownership:` (contract O1): the status command, the first-match rule, owned and unrelated.
const OWNERSHIP_PINS: readonly Pin[] = [
  has('changes are read by a status that writes no index', '`git --no-optional-locks -C <path> status --porcelain --untracked-files=all --ignore-submodules=none`'),
  has('paths are matched relative to the workspace root', 'matching them to feature paths relative to <root>'),
  has('the working tree is never diffed', 'Never git diff the working tree: it can rewrite the index.'),
  has('the first matching class wins', 'Each path is, first match winning:'),
  has('owned: the feature directory, its named paths, a tied task, a gitlink', '- owned: in <feature_dir>; named by this feature\'s tasks.md or plan.md; tied by you to a named task (say which and why); or the changed gitlink of a repository with feature work.'),
  has('unrelated: another feature\'s claim, or a gitlink of no repository', '- unrelated: claimed by another feature\'s directory, tasks.md or plan.md; or a changed gitlink of no repository.')
];

// US2 (contract O1): the ambiguous class, with its five reasons, and what is never done with such a path.
const AMBIGUOUS_CLAUSES: ReadonlyArray<readonly [label: string, phrase: string]> = [
  ['ambiguous: claimed by this feature and another', '- ambiguous: claimed by this feature and another'],
  ['ambiguous: both status columns letters', 'both status columns letters (partially staged)'],
  ['ambiguous: a change tied to this feature mixed with one that is not', 'mixing a change tied to this feature with one that is not'],
  ['ambiguous: a rename with one side not owned', 'a rename with one side not owned'],
  ['ambiguous: claimed by no feature', 'or claimed by no feature.'],
  ['changing never makes a path owned', 'Changing never makes a path owned'],
  ['a shared pointer is owned only while it names the feature directory', '.specify/feature.json and other shared pointers are owned only while naming <feature_dir>'],
  ['unrelated and ambiguous paths are left exactly as found', 'Leave unrelated and ambiguous paths exactly as found: never stage, format, commit or restore them.'],
  ['each ambiguous path is a needs-decision hand-off', 'Each ambiguous path is a hand-off under "Remaining issues:", tagged [needs-decision], with its reason.']
];
const AMBIGUOUS_PINS: readonly Pin[] = AMBIGUOUS_CLAUSES.map(([label, phrase]) => has(label, phrase));

// US3 (contract N1 steps 1 and 3, P1): integration touches no checkout, and refuses by name.
const INTEGRATE_ISOLATION_PINS: readonly Pin[] = [
  has('never commits, merges, switches, resets, rebases, stashes, fetches, pushes or forces', 'Never run git commit or git merge, switch or check out a branch, reset, rebase, stash, fetch, push, discard, or force a ref; never create, use or remove a worktree; never fix a failing check here.'),
  has('step 1 reads "already integrated" from the full ref', '`git -C <path> merge-base --is-ancestor <source commit> refs/heads/<target>`'),
  has('step 3 finds a missing or checked-out target by for-each-ref', '`git -C <path> for-each-ref \'--format=%(refname) %(objectname) %(worktreepath)\' refs/heads/<target>`'),
  has('step 3 reads only the target\'s own line, not a branch nested under it', 'prints no line for exactly refs/heads/<target> (no such local branch; branches under <target>/ do not count)'),
  has('step 3 computes the merge without a working tree', '`git -C <path> merge-tree --write-tree --name-only --no-messages <target commit> <source commit>`'),
  has('step 3 reads the exit codes', 'exits 1 (a conflict: list its paths and both commits) or neither 0 nor 1 (this Git cannot merge without a working tree)'),
  has('step 3 makes the merge with the old target first and the source second', '`git -C <path> commit-tree <tree> -p <target commit> -p <source commit> -m <message>`')
];

// US4 (contract N1 steps 2 and 5, the record): the record says exactly how far integration got.
const INTEGRATE_RECORD_PINS: readonly Pin[] = [
  has('step 2 reads a gitlink recorded for each implementation', '`git -C <root> ls-tree HEAD -- <path>`'),
  has('step 2 reads a trailer the hooks wrote', '`git -C <root> log -1 --format=%B`'),
  has('step 5 applies by compare-and-swap', '`git -C <path> update-ref refs/heads/<target> <merge> <target commit>`'),
  has('step 5 records the compensating command', '`git -C <path> update-ref refs/heads/<target> <target commit> <merge>`'),
  has('step 5 applies implementation repositories first, the envelope last', 'implementation repositories first, the envelope last'),
  has('step 5 names partial progress', 'the state is partially integrated'),
  has('step 5 never runs the compensating command', 'and never run it'),
  has('the record has its own heading, outside the audit block', 'Report "Finalization record:" on its own line, outside the audit log block.'),
  has('the record\'s state: integrated', 'integrated (every repository integrated or already integrated, nothing handed off or uncommitted)'),
  has('the record\'s state: partially integrated', 'partially integrated'),
  has('the record\'s state: committed, not integrated', 'committed, not integrated (a target still lacks committed feature work)'),
  has('the record\'s state: nothing committed', 'or nothing committed'),
  has('CLEAR only when the state is integrated', 'If the state is integrated → emit [SCHEGENT_STATUS: CLEAR]')
];

// US5 (contract N1 steps 2 and 4): the merge guard holds under isolation. The guard phrase is version 4's.
const GUARD_PIN: Pin = has(
  'integration only if every check is green and no decision waits on a maintainer',
  'only if every check is green and <feature_dir>/decisions.md has no entry with "Status: needs-maintainer"'
);
const INTEGRATE_GUARD_PINS: readonly Pin[] = [
  GUARD_PIN,
  has('step 4: an implementation repository with no check set is unverifiable and withholds', 'unverifiable and withholds'),
  has('step 4: an envelope with no check set does not block', 'does not block')
];

// `finalize` (contract I1, P1).
const FINALIZE_PINS: readonly Pin[] = [
  has('step 1 formats owned paths only', 'Run the project formatter in write mode on owned paths only'),
  has('step 1 falls back to check mode on them', 'one that cannot take paths runs in check mode on them, or is skipped and said under Notes:'),
  has('step 2 runs the check set in each repository', 'Run the full check set in each repository'),
  has('step 2: an implementation repository with no check set is unverifiable', 'an implementation repository is unverifiable'),
  has('step 2: an envelope with no check set has none', 'the envelope has no check set'),
  has('step 3 lists the branch\'s files without writing an index', '`git --no-optional-locks -C <path> diff-index --name-only <merge-base>`'),
  has('step 5 commits only owned paths', 'Commit only owned paths, with conventional commit format: feat(<feature_name>): <summary>'),
  has('step 5 adds the untracked owned paths first', '`git -C <path> add -- <untracked owned paths>`'),
  has('step 5 commits by pathspec', '`git -C <path> commit -m <message> -- <owned paths>`'),
  has('step 5 leaves other staged entries staged', 'which leaves other staged entries staged'),
  has('step 5 commits implementation repositories first, the envelope last', 'Implementation repositories first, the envelope last'),
  has('step 5 stops after a failed commit', 'or after a failed commit'),
  has('step 5 commits nothing on a detached HEAD or the base', 'HEAD is detached or on the base branch'),
  has('step 6 names only the files the fix changed', 'naming only the files it changed'),
  has('step 6 does not apply a fix over a change that is not owned', 'already holds a change that is not owned'),
  has('step 7 never merges, switches or checks out', '7. Never merge, switch or check out a branch, reset, stash or push: integration is the next Phase\'s.'),
  has('CLEAR needs green checks, every owned path committed and no hand-off', 'If all checks are green, every owned path is committed and nothing is handed off → emit [SCHEGENT_STATUS: CLEAR]')
];

/** The git verbs neither Phase may run in a command (research R7; FR-013, FR-017, FR-031). */
const PROHIBITED_SUBCOMMANDS = ['switch', 'checkout', 'merge', 'worktree', 'stash', 'reset', 'push', 'fetch', 'rebase', 'restore', 'clean'];

/** The phrases the shipped text must never contain, as a command or in prose (contract P1). */
const NEGATIVE_PINS: readonly Pin[] = [
  lacks('no commit of everything', 'Commit all changes'),
  lacks('no branch switch', 'git switch'),
  lacks('no checkout', 'git checkout'),
  lacks('no merge with a merge commit made by git', 'git merge --no-ff'),
  lacks('no worktree', 'git worktree'),
  lacks('no stash', 'git stash'),
  lacks('no reset', 'git reset'),
  lacks('no push', 'git push'),
  lacks('no fetch', 'git fetch')
];

/** The tree-to-tree listing `integrate` counts committed paths with; the only `diff` it may run. */
const ALLOWED_DIFF = 'git -C <path> diff --name-only <merge-base> HEAD';

/** The inline-code `git` commands of a text, each reduced to its subcommand and its words. */
function gitCommands(text: string): Array<{ readonly span: string; readonly subcommand: string }> {
  const spans = [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!).filter((span) => span.startsWith('git '));
  return spans.map((span) => {
    const words = span.split(' ').slice(1);
    let index = 0;
    while (words[index] === '--no-optional-locks' || words[index] === '-C') index += words[index] === '-C' ? 2 : 1;
    return { span, subcommand: words[index] ?? '' };
  });
}

/** The text from a line to the line before the next one, as the harness cuts the two blocks (contract C1). */
function section(text: string, from: string, until: (line: string) => boolean): string {
  const lines = text.split('\n');
  const start = lines.indexOf(from);
  const end = lines.findIndex((line, index) => index > start && until(line));
  return lines.slice(start, end).join('\n').trimEnd();
}

/** A replacement control: one clause swapped for another in memory, with the three steps of `expectMutantKilled`. */
function expectReplacementKilled(
  real: string,
  control: { readonly id: string; readonly from: string; readonly to: string; readonly killedBy: readonly Pin[] }
): void {
  expect(real, `${control.id}: the clause occurs in the real text`).toContain(control.from);
  const mutated = real.split(control.from).join(control.to);
  expect(mutated, `${control.id}: the replacement changed the text`).not.toBe(real);
  expectPins(real, control.killedBy);
  const missed = control.killedBy.filter(([, pattern]) => !pattern.test(mutated));
  expect(missed.length, `${control.id}: a pin fails on the mutated text`).toBeGreaterThan(0);
}

describe('the finalization Phases of the new-feature example (FR-R4-F19)', () => {
  describe.each(FINALIZATION_PHASES)('%s: the blocks both Phases carry', (phaseId) => {
    it('resolves the repositories with the review scope\'s rules, plus the envelope (contract C2)', () => {
      expectPins(instructionFor(phaseId), REPOSITORIES_PINS);
    });

    it('classifies each changed path, and owns only what the feature claims (contract O1)', () => {
      expectPins(instructionFor(phaseId), OWNERSHIP_PINS);
    });

    it.each(NEGATIVE_PINS)('%s', (label, pattern) => {
      expect(instructionFor(phaseId), label).toMatch(pattern);
    });

    it('runs no command that switches, merges, stashes, resets, fetches or pushes', () => {
      const prohibited = gitCommands(instructionFor(phaseId)).filter(({ subcommand }) => PROHIBITED_SUBCOMMANDS.includes(subcommand));
      expect(prohibited, `${phaseId}: prohibited commands`).toEqual([]);
    });

    it('control: the command reader sees the commands it must, so an empty list means none', () => {
      const subcommands = gitCommands(instructionFor(phaseId)).map(({ subcommand }) => subcommand);
      expect(subcommands).toContain('status');
      expect(subcommands).toContain('merge-base');
      expect(gitCommands('`git -C a switch develop` and `git --no-optional-locks -C a merge x`').map(({ subcommand }) => subcommand)).toEqual(['switch', 'merge']);
    });
  });

  describe('finalize', () => {
    it('commits only this feature\'s paths, and leaves integration to the next Phase', () => {
      expectPins(instructionFor('finalize'), FINALIZE_PINS);
    });

    it('runs no `git diff` against the working tree, and no `git commit` to merge', () => {
      const diffs = gitCommands(instructionFor('finalize')).filter(({ subcommand }) => subcommand === 'diff');
      expect(diffs.map(({ span }) => span)).toEqual([]);
    });
  });

  describe('integrate', () => {
    it('runs no `git commit`, and the only `git diff` is the tree-to-tree listing', () => {
      const commands = gitCommands(instructionFor('integrate'));
      expect(commands.filter(({ subcommand }) => subcommand === 'commit')).toEqual([]);
      expect(commands.filter(({ subcommand }) => subcommand === 'diff').map(({ span }) => span)).toEqual([ALLOWED_DIFF]);
    });
  });

  describe.each(FINALIZATION_PHASES)('%s: ambiguous paths are hand-offs, never committed (US2)', (phaseId) => {
    it('classifies by first match, and hands off an ambiguous path with its reason', () => {
      expectPins(instructionFor(phaseId), AMBIGUOUS_PINS);
    });

    it.each(AMBIGUOUS_CLAUSES)('control: dropping the clause "%s" fails its pin', (label, phrase) => {
      expectMutantKilled(instructionFor(phaseId), { id: `${phaseId}: ${label}`, removals: [phrase], killedBy: [has(label, phrase)] });
    });
  });

  describe('integrate: no checkout is touched, and each refusal is named (US3)', () => {
    it('forbids every branch change, and moves a ref only by the commands it names', () => {
      expectPins(instructionFor('integrate'), INTEGRATE_ISOLATION_PINS);
    });
  });

  describe('integrate: the record says exactly how far integration got (US4)', () => {
    it('checks the recorded HEADs, applies by compare-and-swap and reports the four states', () => {
      expectPins(instructionFor('integrate'), INTEGRATE_RECORD_PINS);
    });

    // P3 (FR-023): the new heading is read by the real stdout parser as neither of the two it acts on.
    it('P3: the record heading is not read as a list of issues or of questions', () => {
      expect(extractRemainingIssues('Finalization record:\n- b')).toEqual([]);
      expect(extractOpenQuestions('Finalization record:\n- b')).toEqual([]);
    });

    it('P3: the record does not leak its list into the issues above it', () => {
      const report = 'Remaining issues:\n- a\n\nFinalization record:\n- b';
      expect(extractRemainingIssues(report)).toEqual([{ summary: 'a' }]);
      expect(extractRemainingIssues('Remaining issues:\n- a')).toEqual([{ summary: 'a' }]);
    });
  });

  describe('integrate: the merge guard holds under isolation (US5)', () => {
    it('integrates only past green checks and a settled decision, and withholds an unverifiable repository', () => {
      expectPins(instructionFor('integrate'), INTEGRATE_GUARD_PINS);
    });
  });

  describe('mutation controls: a clause put back, or dropped, is caught', () => {
    // M1 (SC-007): the version-4 commit line put back. Only a clause naming owned paths keeps another
    // feature's work out of the commit, so both the positive pin and the negative one must fail.
    it('M1 commit-all restored is caught', () => {
      const finalize = instructionFor('finalize');
      const step5 = finalize.split('\n').find((line) => line.startsWith('5. Commit only owned paths'));
      expect(step5, 'M1: finalize has a step 5 that commits only owned paths').toBeDefined();
      expectReplacementKilled(finalize, {
        id: 'M1',
        from: step5!,
        to: '5. Commit all changes with conventional commit format: feat(<feature_name>): <summary>',
        killedBy: [
          has('step 5 commits only owned paths', 'Commit only owned paths, with conventional commit format: feat(<feature_name>): <summary>'),
          lacks('no commit of everything', 'Commit all changes')
        ]
      });
    });
  });

  describe('mutation controls M2 to M4 (SC-007)', () => {
    // M2: the version-4 merge restored in finalize's step 7. Switching a branch in a shared
    // checkout is the second defect, so the step's prohibition and two negatives must fail.
    it('M2 branch switch restored is caught', () => {
      const finalize = instructionFor('finalize');
      const step7 = finalize.split('\n').find((line) => line.startsWith('7. Never merge, switch or check out a branch'));
      expect(step7, 'M2: finalize has a step 7 that never merges').toBeDefined();
      expectReplacementKilled(finalize, {
        id: 'M2',
        from: step7!,
        to: '7. Merge to local develop branch: git switch develop && git merge --no-ff <feature_branch>, but only if every check is green and <feature_dir>/decisions.md has no entry with "Status: needs-maintainer". Otherwise stop after the commits and say why under "Remaining issues:".',
        killedBy: [
          has('step 7 never merges, switches or checks out', '7. Never merge, switch or check out a branch, reset, stash or push: integration is the next Phase\'s.'),
          lacks('no branch switch', 'git switch'),
          lacks('no merge with a merge commit made by git', 'git merge --no-ff')
        ]
      });
    });

    // M3: the guard removed from integrate's step 2, so integration no longer waits on a green check
    // or a maintainer's decision.
    it('M3 the guard removed is caught', () => {
      expectMutantKilled(instructionFor('integrate'), {
        id: 'M3',
        removals: ['only if every check is green and <feature_dir>/decisions.md has no entry with "Status: needs-maintainer"'],
        killedBy: [GUARD_PIN]
      });
    });

    // M4: the record sentence removed, so a multi-repository run no longer says how far it got.
    it('M4 the record heading removed is caught', () => {
      expectMutantKilled(instructionFor('integrate'), {
        id: 'M4',
        removals: ['Report "Finalization record:" on its own line, outside the audit log block.'],
        killedBy: [has('the record has its own heading, outside the audit block', 'Report "Finalization record:" on its own line, outside the audit log block.')]
      });
    });
  });

  describe('versions, fields, identity and size (P4)', () => {
    const FIELDS = { runner: 'claude', hostVerification: 'exit-code', sideEffects: 'git', model: 'claude-sonnet-5-5', effort: 'medium' };

    it('finalize is at least version 5, integrate at least 1 and the pipeline at least 6', () => {
      expect(phaseOf(example, 'finalize').metadata.version).toBeGreaterThanOrEqual(5);
      expect(phaseOf(example, 'integrate').metadata.version).toBeGreaterThanOrEqual(1);
      expect(example.pipelineVersion).toBeGreaterThanOrEqual(6);
    });

    it('integrate is the last Phase, directly after finalize', () => {
      expect(example.phaseIds.slice(-2)).toEqual(['finalize', 'integrate']);
    });

    it.each(FINALIZATION_PHASES)('%s keeps the version-4 fields and has no retry condition', (phaseId) => {
      const phase = phaseOf(example, phaseId);
      for (const [field, value] of Object.entries(FIELDS)) {
        expect((phase.spec as unknown as Record<string, unknown>)[field], `${phaseId}.${field}`).toBe(value);
      }
      expect(phase.spec.retryCondition, `${phaseId}.retryCondition`).toBeUndefined();
    });

    it('integrate declares no evidence policy and no description (contract N2)', () => {
      const phase = phaseOf(example, 'integrate');
      expect(phase.spec.evidencePolicy).toBeUndefined();
      expect(phase.metadata.description).toBeUndefined(); // 2026-10-29 coincidental: a Phase document's metadata, not the sidebar IPC record the contract governs
    });

    it('finalize still asks for its two metrics, and neither Phase asks for another', () => {
      const metrics = (text: string): string[] => [...text.matchAll(/`([a-z_]+): <N>`/g)].map((match) => match[1]!);
      expect(metrics(instructionFor('finalize'))).toEqual(['checks_passing', 'checks_failing']);
      expect(metrics(instructionFor('integrate'))).toEqual([]);
    });

    it('the Repositories and Ownership blocks are the same string in both Phases (contract C1)', () => {
      const blocks = (phaseId: string): readonly string[] => {
        const text = instructionFor(phaseId);
        return [
          section(text, 'Repositories:', (line) => line === 'Ownership:'),
          section(text, 'Ownership:', (line) => /^1\. /.test(line))
        ];
      };
      const [repositories, ownership] = blocks('finalize');
      expect(repositories, 'a block was found').toContain('Resolve them before any write');
      expect(ownership, 'a block was found').toContain('first match winning');
      expect(blocks('integrate')).toEqual([repositories, ownership]);
    });

    it.each(FINALIZATION_PHASES)('%s fits the instruction cap', (phaseId) => {
      expect(instructionFor(phaseId).length).toBeLessThanOrEqual(PHASE_INSTRUCTION_MAX_LEN);
    });
  });
});
