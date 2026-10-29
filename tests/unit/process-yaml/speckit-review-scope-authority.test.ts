// The review scope `examples/speckit-new-feature.pipeline.yaml` gives its two review Phases.
//
// The two review Phases found the repository to review by layout: `repo/` when the root holds
// `repo/` and `specs/`, otherwise the root. In a workspace whose code lives in linked
// repositories that picks the planning root, so an envelope diff with no source changes could
// stand in for a review of the code. Both reviews now carry one block, in `Scope:`, that reads
// the workspace owner's declaration, falls back to today's two layouts, and reports an
// unresolved scope as a counted finding instead of reviewing a substitute (FR-R4-F18;
// `specs/246-multi-repo-review-scope/contracts/review-scope-instruction.md`).
//
// This file pins that text. The Phases are prose, so a quiet edit can drop a clause and nothing
// else goes red. What is pinned is the shape of the block, not its wording: each clause by a
// phrase that carries it, the clauses that must NOT come back (the root-only rule), the heading
// run through the real stdout parser so it cannot be read as issues, and the fields of both
// Phases that did not change. `review-scope-fixtures.test.ts` runs the block's commands.

import { describe, expect, it } from 'vitest';

import { PHASE_INSTRUCTION_MAX_LEN } from '../../../src/config/process-definition-validator';
import { extractOpenQuestions, extractRemainingIssues } from '../../../src/parser/stdout-parser';
import { expectMutantKilled, expectPins, type Pin } from '../../fixtures/instruction-pins';
import { instructionOf, loadExample, phaseOf } from '../../fixtures/speckit-new-feature-example';

/** The version the review scope shipped at; a later edit may go higher. */
const FIRST_REVIEW_SCOPE_VERSION = 3;
const REVIEW_SCOPE_PIPELINE_VERSION = 5;
const REVIEW_PHASES = ['speckit-code-review', 'speckit-security-review'] as const;

/** Each review's loop condition, which this feature does not change (FR-023). */
const RETRY_CONDITIONS: Readonly<Record<(typeof REVIEW_PHASES)[number], string>> = {
  'speckit-code-review': 'code_review_findings > 0',
  'speckit-security-review': 'security_review_findings > 0'
};

// The clauses of the block. Each pin is declared once, as a named constant: the real-text test
// and the mutation control read the same constant, so a control proves something about the test
// that actually runs. A pin names a clause by one phrase that carries it, not the whole sentence.
const SCOPE_EVERY_ITERATION: Pin = [
  'resolution runs on every iteration',
  /Resolve the repositories to review before reviewing, on every iteration/
];
const DECL_SECTION: Pin = [
  "the root's AGENTS.md section declares the targets",
  /A section of <root>\/AGENTS\.md headed exactly "## Implementation repositories" declares the targets/
];
const DECL_ENTRY_FORM: Pin = [
  'an entry is an inline-code path, then an optional base, and nothing else',
  /Each bullet starting with inline code is an entry: a path relative to <root> in inline code \(`\.` for <root>\), optionally followed by `\(base: <ref>\)` in inline code, and nothing else/
];
const DECL_CHARSET: Pin = [
  'a path or ref uses a closed character set and never starts with a dash',
  /A path or ref uses only letters, digits and the characters \. _ \/ - and does not start with -/
];
const DECL_DEFAULT_BASE: Pin = ['the base defaults to develop', /The base defaults to develop\./];
const DECL_ONLY_TARGETS: Pin = [
  'with a declaration, its entries are the only targets',
  /With a declaration, its entries are the only targets: add, drop or swap none/
];
const EVIDENCE_NEVER_PICKS: Pin = [
  'evidence never picks a target, and a difference goes under Notes',
  /CLAUDE\.md, a nested AGENTS\.md, plan files and agent memory never pick a target; where one names other repositories, say so under Notes:/
];
const INFER_LAYOUTS: Pin = [
  'without a declaration, repo, then the root, then unresolved',
  /Without one, infer: repo when <root> holds specs\/ and repo is a repository top level, otherwise \. when <root> is one, otherwise the scope is unresolved/
];
const TOP_LEVEL_CHECK: Pin = [
  'a top level is told by git rev-parse --show-prefix',
  /`git -C <path> rev-parse --show-prefix` fails or prints anything/
];
const GIT_FILE_COUNTS: Pin = [
  'a .git file counts like a .git directory',
  /a \.git file counts like a \.git directory/
];
const GITLINK_RULES: Pin = [
  'a gitlink is mode 160000, changed when a listing names it, and the root is checked when it is not a target',
  /A mode 160000 entry in `git -C <path> ls-files --stage` is a repository, not a file, and is changed when either list above names it\. Check those of each target, and of <root> when it is not a target/
];
const WHOLE_SCOPE_UNRESOLVED: Pin = [
  'a declaration with no entry, a broken entry, two sections or two entries at one place leaves the whole scope unresolved',
  /The whole scope is unresolved, and nothing is reviewed, when the section has no entry, an entry breaks the form, there are two such sections, or two entries resolve to the same location/
];
const PER_TARGET_OTHERS_REVIEWED: Pin = [
  'one unresolved target leaves the others reviewed',
  /One target is unresolved, and the others are still reviewed/
];
const OUTSIDE_CHECK: Pin = [
  'a path is outside when absolute or when cd and pwd -P leave the root, and nothing is read there',
  /its path is absolute, or `cd <root>\/<path> && pwd -P` prints neither the root's own `pwd -P` nor a path below it \(read nothing there\)/
];
const BASE_CHECK: Pin = [
  'a base is told by git merge-base, and a failure leaves the target unresolved',
  /`git -C <path> merge-base HEAD <base>` fails or prints nothing/
];
const NO_FALLBACK: Pin = [
  'no other branch, remote-tracking ref or fetch is substituted, and the remedy is named',
  /Never substitute another branch, a remote-tracking ref or a fetch; the remedy is declaring the repository with `\(base: <ref>\)`/
];
const GITLINK_BLOCKS_INFERENCE: Pin = [
  'without a declaration a changed gitlink leaves the scope unresolved and is named',
  /without one, the scope is unresolved and names it/
];
const UNRESOLVED_COUNTED: Pin = [
  'each unresolved condition is a counted finding under Remaining issues, tagged needs-decision',
  /Each unresolved condition is a counted finding: one bullet under "Remaining issues:", tagged \[needs-decision\], naming the path and the reason/
];
const NO_SUBSTITUTE: Pin = [
  'no substitute target is reviewed',
  /Never review a substitute \(the root, a guessed repository or one memory names\)/
];
const DECLARATION_NOT_EDITED: Pin = [
  'the agent never writes or edits the declaration',
  /never write or edit the declaration/
];
const SCOPE_READ_ONLY: Pin = [
  'resolving only reads: it stages, switches, fetches, stashes and writes nothing',
  /Resolving only reads: never stage or unstage a file, switch, create or delete a branch, fetch, stash, update a submodule, write a ref or touch an index/
];
const FILES_LISTING: Pin = [
  'the files are the two listings, less the Spec Kit paths',
  /`git -C <path> diff --name-only --ignore-submodules=none <merge-base> HEAD` or by `git --no-optional-locks -C <path> status --porcelain --untracked-files=all --ignore-submodules=none`, except under specs\/ and \.specify\//
];
const READ_WITHOUT_INDEX_WRITE: Pin = [
  'changes are read with diff-index and never with git diff against the working tree',
  /Read changes with `git --no-optional-locks -C <path> diff-index -p <merge-base>` and untracked files directly\. Never run git diff against the working tree/
];
const GITLINK_UNDECLARED: Pin = [
  'a changed gitlink the declaration omits is listed and uncounted',
  /with a declaration, list it as "changed, not declared, not reviewed" and note it under Notes:, uncounted/
];
const REPORT_HEADING: Pin = [
  'the scope is reported under its own heading, first, outside the audit block',
  /Report "Review scope:" on its own line, first in your report and outside the audit log block/
];
const FIX_INSIDE_TARGETS: Pin = ['a fix stays inside the resolved targets', /inside the resolved targets/];

// What must not come back: the root-only rule the block replaces, and the singular repository.
const ROOT_ONLY_RULE: Pin = ['the root-only rule', /with its own \.git\//];
const CODE_REPOSITORY_SINGULAR: Pin = ['one code repository', /the code repository/];

/**
 * The `Scope:` section both reviews carried at `dbf7f77a` (`examples/speckit-new-feature.pipeline.yaml`
 * `:203`-`:206`, without the instruction's 10-space indent): the root-only rule, M2's replacement.
 */
const BASELINE_SCOPE = [
  'Scope:',
  '- If the workspace root contains both a repo/ subdirectory (with its own .git/) AND a specs/ directory, the code repository is repo/. Otherwise it is the workspace root. Log which.',
  '- In the code repository, review `git diff $(git merge-base HEAD develop)` — every committed and uncommitted change since the branch left develop, the branch finalize merges into — plus each untracked file listed by `git ls-files --others --exclude-standard`. Both commands are read-only: never stage a file to make it visible.',
  '- Spec Kit artifacts (specs/, .specify/) are out of scope.'
].join('\n');

/** The block: from `Scope:` to its last bullet, before the blank line that precedes `Reviewing:`. */
function scopeBlock(instruction: string): string {
  return instruction.slice(instruction.indexOf('Scope:'), instruction.indexOf('\n\nReviewing:'));
}

/** Contract I7's sample: a review with one unresolved target in a declared workspace. */
const SAMPLE_REPORT = [
  'Review scope:',
  '- Source: declaration (AGENTS.md, ## Implementation repositories)',
  '- client-source: base develop, merge base 3f2a91c, 7 changed tracked files, 1 untracked file reviewed',
  '- datahub: base develop, merge base 88d0e4b, no feature changes',
  '- shopify-app: unresolved, no base: develop does not resolve; declare it with `(base: <ref>)`',
  '- klaviyo (gitlink of the root): changed, not declared, not reviewed',
  '',
  'Remaining issues:',
  '- [needs-decision] shopify-app: no base, develop does not resolve here; declare `(base: <ref>)`',
  '- [regression] client-source/src/sync.ts:42 drops the cursor when the page is empty'
].join('\n');

describe('the shipped review scope block (FR-R4-F18)', () => {
  const example = loadExample();
  const instructionFor = (phaseId: (typeof REVIEW_PHASES)[number]): string =>
    instructionOf(phaseOf(example, phaseId));

  it('control: the example ships both reviews and a readable pipeline version', () => {
    // Without this, every pin below could pass on an empty read.
    for (const phaseId of REVIEW_PHASES) {
      expect(instructionFor(phaseId).length, phaseId).toBeGreaterThan(0);
    }
    expect(Number.isFinite(example.pipelineVersion)).toBe(true);
  });

  describe.each(REVIEW_PHASES)('%s', (phaseId) => {
    const instruction = instructionFor(phaseId);

    it('resolves the repositories again on every iteration', () => {
      expectPins(instruction, [SCOPE_EVERY_ITERATION]);
    });

    it('reads the declaration from the root AGENTS.md, in one entry form and a closed character set', () => {
      expectPins(instruction, [DECL_SECTION, DECL_ENTRY_FORM, DECL_CHARSET, DECL_DEFAULT_BASE]);
    });

    it('lets a declaration alone choose the targets, and evidence never', () => {
      expectPins(instruction, [DECL_ONLY_TARGETS, EVIDENCE_NEVER_PICKS]);
    });

    it('lists a changed gitlink the declaration omits, without counting it', () => {
      expectPins(instruction, [GITLINK_UNDECLARED]);
    });

    it('infers repo, then the root, when nothing is declared', () => {
      expectPins(instruction, [INFER_LAYOUTS]);
    });

    it('tells a repository top level by git itself, so a .git file counts', () => {
      expectPins(instruction, [TOP_LEVEL_CHECK, GIT_FILE_COUNTS]);
    });

    it('treats a mode 160000 entry as a repository and checks the root when it is not a target', () => {
      expectPins(instruction, [GITLINK_RULES]);
    });

    it('resolves by reading only', () => {
      expectPins(instruction, [SCOPE_READ_ONLY]);
    });

    it('lists the files with two commands that write no index, and leaves Spec Kit files out', () => {
      expectPins(instruction, [FILES_LISTING]);
    });

    it('reads changes without writing an index, and never runs git diff against the working tree', () => {
      expectPins(instruction, [READ_WITHOUT_INDEX_WRITE]);
    });

    it('leaves the whole scope unresolved when the declaration itself is broken', () => {
      expectPins(instruction, [WHOLE_SCOPE_UNRESOLVED]);
    });

    it('leaves one target unresolved when it is missing, outside, not a top level or without a base', () => {
      expectPins(instruction, [PER_TARGET_OTHERS_REVIEWED, OUTSIDE_CHECK, BASE_CHECK]);
    });

    it('substitutes no branch, remote-tracking ref or fetch for a missing base, and names the remedy', () => {
      expectPins(instruction, [NO_FALLBACK]);
    });

    it('stops without a declaration when a changed gitlink sits in the inferred repository', () => {
      expectPins(instruction, [GITLINK_BLOCKS_INFERENCE]);
    });

    it('counts each unresolved condition, reviews no substitute and never edits the declaration', () => {
      expectPins(instruction, [UNRESOLVED_COUNTED, NO_SUBSTITUTE, DECLARATION_NOT_EDITED]);
    });

    it('reports the scope under its own heading', () => {
      expectPins(instruction, [REPORT_HEADING]);
    });

    it('fixes only inside the resolved targets', () => {
      expectPins(instruction, [FIX_INSIDE_TARGETS]);
    });

    it('no longer states the root-only rule, or names one code repository', () => {
      expect(instruction, ROOT_ONLY_RULE[0]).not.toMatch(ROOT_ONLY_RULE[1]);
      expect(instruction, CODE_REPOSITORY_SINGULAR[0]).not.toMatch(CODE_REPOSITORY_SINGULAR[1]);
    });
  });

  it('control: the read-only pin does not match the text the review carried before', () => {
    // The old text read changes with a working-tree `git diff`, which can rewrite an index.
    expect(BASELINE_SCOPE).not.toMatch(READ_WITHOUT_INDEX_WRITE[1]);
  });

  describe.each(REVIEW_PHASES)('mutation controls on %s: a clause dropped from the shipped text is caught', (phaseId) => {
    const instruction = instructionFor(phaseId);

    // The multi-repository clause: the declaration bullet, and the sentence that makes it the
    // only source of targets. SC-005's first named mutation.
    it('M1 the declaration is caught when removed', () => {
      expectMutantKilled(instruction, {
        id: 'M1',
        removals: [
          '- Declaration. A section of <root>/AGENTS.md headed exactly "## Implementation repositories" declares the targets. Each bullet starting with inline code is an entry: a path relative to <root> in inline code (`.` for <root>), optionally followed by `(base: <ref>)` in inline code, and nothing else. Other lines are prose. A path or ref uses only letters, digits and the characters . _ / - and does not start with -. The base defaults to develop.\n',
          'With a declaration, its entries are the only targets: add, drop or swap none. '
        ],
        killedBy: [DECL_SECTION, DECL_ONLY_TARGETS]
      });
    });

    // Restoring the root-only rule is the regression the filing names: the block replaced by what
    // both reviews said before. It replaces rather than removes, so it asserts the same three
    // steps inline: the block occurs, the text changed, and a live pin fails.
    it('M2 the root-only rule restored is caught', () => {
      const block = scopeBlock(instruction);
      expect(instruction.split(block), 'M2: the block occurs once in the real text').toHaveLength(2);
      const mutated = instruction.split(block).join(BASELINE_SCOPE);
      expect(mutated, 'M2: the replacement changed the text').not.toBe(instruction);

      const killers = [DECL_SECTION, TOP_LEVEL_CHECK];
      expectPins(instruction, killers);
      const missed = killers.filter(([, pattern]) => !pattern.test(mutated));
      expect(missed.length, 'M2: a pin fails on the mutated text').toBeGreaterThan(0);
      expect(mutated, ROOT_ONLY_RULE[0]).toMatch(ROOT_ONLY_RULE[1]);
    });

    it('M3 the .git file clause is caught when removed', () => {
      expectMutantKilled(instruction, {
        id: 'M3',
        removals: [' (a .git file counts like a .git directory)'],
        killedBy: [GIT_FILE_COUNTS]
      });
    });

    it('M4 the counted-finding rule is caught when removed', () => {
      expectMutantKilled(instruction, {
        id: 'M4',
        removals: [
          'Each unresolved condition is a counted finding: one bullet under "Remaining issues:", tagged [needs-decision], naming the path and the reason. '
        ],
        killedBy: [UNRESOLVED_COUNTED]
      });
    });
  });

  describe('the heading, through the real stdout parser (FR-020)', () => {
    it('control: the parser reads the host heading it is meant to', () => {
      expect(extractRemainingIssues('Remaining issues:\n- a')).toEqual([{ summary: 'a' }]);
    });

    it('is not read as issues or as questions', () => {
      expect(extractRemainingIssues('Review scope:\n- x')).toEqual([]);
      expect(extractOpenQuestions('Review scope:\n- x')).toEqual([]);
    });

    it('does not leak its list into the issues above it', () => {
      const report = 'Remaining issues:\n- a\n\nReview scope:\n- b';
      expect(extractRemainingIssues(report)).toEqual([{ summary: 'a' }]);
    });

    it('reads the sample report of contract I7 as exactly its two issues', () => {
      const issues = extractRemainingIssues(SAMPLE_REPORT);
      expect(issues.map((issue) => issue.tag)).toEqual(['needs-decision', 'regression']);
      // Nothing from under `Review scope:` is an issue, and nothing under it is a question.
      expect(issues[0]?.summary).toContain('shopify-app');
      expect(issues[1]?.summary).toContain('client-source/src/sync.ts:42');
      expect(extractOpenQuestions(SAMPLE_REPORT)).toEqual([]);
    });
  });

  describe('versions, unchanged fields and size (FR-023, FR-024)', () => {
    it('moves the pipeline past the text that read one repository', () => {
      expect(example.pipelineVersion).toBeGreaterThanOrEqual(REVIEW_SCOPE_PIPELINE_VERSION);
    });

    it.each(REVIEW_PHASES)('moves %s past the text that read one repository', (phaseId) => {
      expect(phaseOf(example, phaseId).metadata.version).toBeGreaterThanOrEqual(FIRST_REVIEW_SCOPE_VERSION);
    });

    it.each(REVIEW_PHASES)('%s keeps its model, effort, verification and loop condition', (phaseId) => {
      const { spec } = phaseOf(example, phaseId);
      expect(spec.retryCondition).toBe(RETRY_CONDITIONS[phaseId]);
      expect(spec.model).toBe('claude-opus-5-5');
      expect(spec.effort).toBe('high');
      expect(spec.hostVerification).toBe('exit-code');
    });

    it.each(REVIEW_PHASES)('%s still reviews in its own session and delegates to no sub-agent', (phaseId) => {
      const instruction = instructionFor(phaseId);
      expect(instruction).toContain('Do the review yourself, in this session.');
      expect(instruction).toMatch(/do not delegate to a sub-agent/i);
    });

    it('gives both reviews the same Scope section, and no other Phase the declaration', () => {
      expect(scopeBlock(instructionFor('speckit-code-review'))).toBe(
        scopeBlock(instructionFor('speckit-security-review'))
      );
      // `finalize` and `integrate` (FR-R4-F19) resolve their repositories by the same declaration,
      // so they carry its heading too; every other Phase still must not.
      const declaring: readonly string[] = [...REVIEW_PHASES, 'finalize', 'integrate'];
      for (const [phaseId, phase] of example.phases) {
        if (declaring.includes(phaseId)) continue;
        expect(instructionOf(phase), phaseId).not.toContain('## Implementation repositories');
      }
    });

    it.each(REVIEW_PHASES)('%s stays within the instruction length cap', (phaseId) => {
      expect(instructionFor(phaseId).length).toBeLessThanOrEqual(PHASE_INSTRUCTION_MAX_LEN);
    });
  });
});
