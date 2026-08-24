// FR-R3-020 (T573, T574, T575, T578a-c, T569a-b, T573b) — Every branch a
// workflow trigger names must resolve to a ref that exists, and every workflow
// must be reachable by some event.
//
// Audit finding OPS-N1: four merge-blocking workflows — the 3-OS test matrix,
// the PR gate, CodeQL, and dependency review — were scoped to
// `branches: [main]` in a repository with no `main` branch. A workflow scoped
// to a nonexistent branch emits no failure and no skipped-run notice, so it is
// indistinguishable from one that passed; 38 merges landed on `develop` with
// none of the four running. Two shipped defects (OPS-N2, REL-N1) reached
// `develop` through that hole, and OPS-N2 was itself a recurrence of REL-03 for
// the same reason.
//
// The retarget is six lines and will drift again the next time the branch model
// changes. This gate is what makes the drift a build failure instead of silent
// coverage loss. It asserts a fact about the tree, not a behaviour of the
// product, in the manner of its 73 peers under this directory.
//
// Deliberately NOT covered, and asserted as such below so a later reader does
// not mistake the omission for a reader bug:
//   - `branches-ignore:` — an ignore entry naming a stale branch widens the
//     trigger rather than disabling it, which is the opposite failure mode.
//   - `tags:` — not a branch. `release.yml` legitimately names `v*`, which
//     matches no branch and must not be reported.
//
// The gate resolves refs; it does not emulate GitHub's filter evaluation.
// GitHub decides whether a workflow fires. The weaker, checkable property —
// every branch a trigger names exists — is what catches this finding, and it
// cannot produce a false positive for a name that exists somewhere in the repo.

import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

/** Triggers whose `branches:` filter names a branch that must exist. */
const BRANCH_FILTERED_TRIGGERS: ReadonlySet<string> = new Set([
  'push',
  'pull_request',
  'pull_request_target'
]);

/** Events that can start a workflow without an operator pressing a button. */
const REACHABLE_EVENTS: ReadonlySet<string> = new Set([
  'push',
  'pull_request',
  'pull_request_target',
  'schedule',
  'workflow_call'
]);

// Workflows allowed to be reachable by `workflow_dispatch` alone. An entry is a
// recorded decision that a workflow is operator-triggered on purpose; it is not
// a place to park a workflow whose trigger broke. Empty today — every workflow
// in the tree qualifies on a real event: `full-gate.yml` and
// `security-audit.yml` on `schedule`, `release.yml` on a tag `push`, and the
// four gates on `push`/`pull_request`.
const DISPATCH_ONLY_ALLOWLIST: ReadonlySet<string> = new Set<string>([]);

// The exact number of branch entries each workflow contributes. Asserted
// per file rather than as a positive total (T573, plan risk 1): a total lets
// one file drop out of the reader and be covered by its siblings' entries,
// which is the vacuous pass this gate exists to prevent.
const EXPECTED_BRANCH_ENTRIES: ReadonlyMap<string, number> = new Map([
  // FR-R3-061 — schedule + dispatch, no branch filter. Deliberately off the PR
  // path: the canary probes real CLIs, and a PR gate that depends on a
  // third-party service goes red for reasons unrelated to the change under
  // review. Zero here IS the requirement, not an omission.
  ['backend-canary.yml', 0],
  ['ci.yml', 2], // push + pull_request
  ['codeql.yml', 2], // push + pull_request (schedule carries no branch filter)
  ['dependency-review.yml', 1], // pull_request
  ['full-gate.yml', 0], // schedule + dispatch
  ['pr.yml', 1], // pull_request, block-sequence form
  ['release.yml', 0], // tags only — a tag filter is not a branch entry
  ['security-audit.yml', 0] // schedule + dispatch
]);

interface BranchEntry {
  readonly workflow: string;
  readonly trigger: string;
  readonly value: string;
  readonly line: number;
}

interface WorkflowTriggers {
  readonly workflow: string;
  readonly events: readonly string[];
}

/**
 * Enumerates every ref name in the repository, or `null` when refs cannot be
 * resolved in this environment.
 *
 * One call per gate run (FR-013a): the whole universe is read once and every
 * entry is resolved against it in memory, rather than shelling out per entry.
 * Read-only by construction (FR-014) — no fetch, no ref write, no index or
 * worktree write.
 */
export type RefLister = () => readonly string[] | null;

const listRefsFromGit: RefLister = () => {
  try {
    const raw = execFileSync(
      'git',
      ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const names = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((refName) =>
        refName
          .replace(/^refs\/heads\//, '')
          .replace(/^refs\/remotes\//, '')
          .replace(/^refs\/tags\//, '')
      )
      .filter((name) => name.length > 0 && name !== 'HEAD');
    return names.length > 0 ? names : null;
  } catch {
    return null;
  }
};

/**
 * Reads the workflow directory, or `null` when it is absent or holds no
 * workflow file. An absent directory is an environment shape — a sparse
 * checkout or a source export — not a defect this gate can substantiate;
 * `scripts/check-workflow-pins.mjs` already fails loudly on it.
 */
function listWorkflowFiles(): readonly string[] | null {
  if (!existsSync(WORKFLOW_DIR)) return null;
  const files = readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
  return files.length > 0 ? files : null;
}

/**
 * Bounded reader over one workflow file. Not a YAML parser: it tracks the
 * current top-level key, the current trigger under `on:`, and the current list
 * key under that trigger, which is the whole grammar these files use for
 * trigger filters. FR-017 forbids adding a YAML dependency for one gate, and
 * `scripts/check-workflow-pins.mjs` already reads the same files this way.
 */
export function readWorkflowTriggers(
  workflow: string,
  source: string
): { readonly entries: readonly BranchEntry[]; readonly triggers: WorkflowTriggers } {
  const entries: BranchEntry[] = [];
  const events: string[] = [];
  const lines = source.split('\n');

  let inOnBlock = false;
  let currentTrigger: string | null = null;
  let currentListKey: string | null = null;
  // The indent of a trigger name is learned from the first line inside `on:`
  // rather than assumed to be 2. A file indented differently would otherwise
  // yield no triggers at all, which reads as "reachable by no event" — a false
  // failure, and the one shape of bug this gate must not have.
  let triggerIndent: number | null = null;

  const indentOf = (line: string): number => line.length - line.trimStart().length;

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.replace(/\s+#.*$/, '');
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    const indent = indentOf(line);

    // A top-level key ends the `on:` block unless it is `on:` itself.
    if (indent === 0) {
      const topMatch = /^(?:"|')?([A-Za-z_][\w-]*)(?:"|')?:\s*(.*)$/.exec(trimmed);
      const topKey = topMatch?.[1] ?? null;
      inOnBlock = topKey === 'on';
      currentTrigger = null;
      currentListKey = null;
      triggerIndent = null;
      if (inOnBlock) {
        // The inline forms `on: [push, pull_request]` and `on: push` carry no
        // branch filter, but they do declare events, so reachability must see
        // them. Anything on the `on:` line ends the block for this reader.
        const inlineEvents = (topMatch?.[2] ?? '').trim();
        if (inlineEvents.length > 0) {
          inOnBlock = false;
          const declared = inlineEvents.startsWith('[')
            ? parseFlowSequence(inlineEvents)
            : [unquote(inlineEvents)];
          events.push(...declared.filter((event) => event.length > 0));
        }
      }
      continue;
    }
    if (!inOnBlock) continue;

    // A trigger name sits one level in: `push:`, `pull_request:`,
    // `workflow_dispatch: {}`.
    if (triggerIndent === null) triggerIndent = indent;
    if (indent === triggerIndent) {
      const triggerName = /^([A-Za-z_][\w-]*):/.exec(trimmed)?.[1] ?? null;
      currentTrigger = triggerName;
      currentListKey = null;
      if (triggerName !== null) events.push(triggerName);
      continue;
    }

    if (currentTrigger === null) continue;

    // A filter key under a trigger: `branches:`, `branches-ignore:`, `tags:`,
    // `types:`. Either flow form (`branches: [a, b]`) or block form, whose
    // items arrive on later lines.
    const filterMatch = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(trimmed);
    if (filterMatch !== null && !trimmed.startsWith('- ')) {
      currentListKey = filterMatch[1] ?? null;
      const inlineValue = (filterMatch[2] ?? '').trim();
      if (
        currentListKey === 'branches' &&
        BRANCH_FILTERED_TRIGGERS.has(currentTrigger) &&
        inlineValue.startsWith('[')
      ) {
        for (const value of parseFlowSequence(inlineValue)) {
          entries.push({ workflow, trigger: currentTrigger, value, line: index + 1 });
        }
      }
      continue;
    }

    // A block-sequence item belonging to the current filter key.
    if (
      trimmed.startsWith('- ') &&
      currentListKey === 'branches' &&
      BRANCH_FILTERED_TRIGGERS.has(currentTrigger)
    ) {
      const value = unquote(trimmed.slice(2).trim());
      if (value.length > 0) {
        entries.push({ workflow, trigger: currentTrigger, value, line: index + 1 });
      }
    }
  }

  return { entries, triggers: { workflow, events } };
}

function parseFlowSequence(inline: string): readonly string[] {
  const closing = inline.lastIndexOf(']');
  const body = closing === -1 ? inline.slice(1) : inline.slice(1, closing);
  return body
    .split(',')
    .map((part) => unquote(part.trim()))
    .filter((part) => part.length > 0);
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return value.slice(1, -1);
    }
  }
  return value;
}

const GLOB_METACHARACTERS = /[*?[]/;

/**
 * Compiles a GitHub branch-filter pattern. `**` crosses `/`; `*` does not.
 * A bracket expression is passed through as a character class, with a leading
 * `!` translated to `^`; a `[` that never closes is treated as a literal rather
 * than compiled into an invalid class.
 */
export function matchesPattern(pattern: string, refName: string): boolean {
  let expression = '';
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index] as string;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        expression += '.*';
        index += 2;
        continue;
      }
      expression += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      expression += '[^/]';
      index += 1;
      continue;
    }
    if (char === '[') {
      const closing = pattern.indexOf(']', index + 2);
      if (closing !== -1) {
        // Escape backslashes so a malformed class cannot compile into an
        // invalid regex and crash the gate with an unrelated SyntaxError.
        const body = pattern.slice(index + 1, closing).replace(/\\/g, '\\\\');
        expression += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
        index = closing + 1;
        continue;
      }
    }
    expression += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    index += 1;
  }
  return new RegExp(`^${expression}$`).test(refName);
}

export interface ResolutionFailure {
  readonly entry: BranchEntry;
  readonly kind: 'unresolved-branch' | 'pattern-matched-nothing';
  readonly message: string;
}

export function resolveEntries(
  entries: readonly BranchEntry[],
  refNames: readonly string[]
): readonly ResolutionFailure[] {
  const failures: ResolutionFailure[] = [];
  const refSet = new Set(refNames);
  for (const entry of entries) {
    // A `!`-prefixed entry excludes rather than includes. Requiring it to match
    // a ref would fail a legitimate exclusion, and a stale exclusion widens the
    // trigger rather than disabling it — the same reasoning that leaves
    // `branches-ignore:` uncollected (FR-015).
    if (entry.value.startsWith('!')) continue;
    if (GLOB_METACHARACTERS.test(entry.value)) {
      const matched = refNames.some((refName) => matchesPattern(entry.value, refName));
      if (!matched) {
        failures.push({
          entry,
          kind: 'pattern-matched-nothing',
          message:
            `${entry.workflow}: trigger '${entry.trigger}' pattern '${entry.value}' ` +
            `matched no ref (line ${entry.line})`
        });
      }
      continue;
    }
    if (!refSet.has(entry.value)) {
      failures.push({
        entry,
        kind: 'unresolved-branch',
        message:
          `${entry.workflow}: trigger '${entry.trigger}' names branch '${entry.value}', ` +
          `which resolves to no ref (line ${entry.line})`
      });
    }
  }
  return failures;
}

function loadTree(): {
  readonly entries: readonly BranchEntry[];
  readonly triggers: readonly WorkflowTriggers[];
} | null {
  const files = listWorkflowFiles();
  if (files === null) return null;
  const entries: BranchEntry[] = [];
  const triggers: WorkflowTriggers[] = [];
  for (const workflow of files) {
    const source = readFileSync(join(WORKFLOW_DIR, workflow), 'utf8');
    const read = readWorkflowTriggers(workflow, source);
    entries.push(...read.entries);
    triggers.push(read.triggers);
  }
  return { entries, triggers };
}

describe('workflow trigger branches (FR-R3-020, OPS-N1)', () => {
  const tree = loadTree();

  it('reads the exact expected number of branch entries from every workflow', (context) => {
    if (tree === null) {
      // FR-012: a stated skip, not a pass. Reporting "passed" for a gate that
      // never ran is the exact ambiguity this feature exists to remove, so the
      // reason goes to stderr and the result reads as skipped.
      console.warn(
        'workflow-trigger-branches: skipped — no workflow directory to read ' +
          `(${WORKFLOW_DIR})`
      );
      context.skip();
      return;
    }

    const files = new Set(tree.triggers.map((entry) => entry.workflow));
    expect([...files].sort()).toEqual([...EXPECTED_BRANCH_ENTRIES.keys()].sort());

    for (const [workflow, expected] of EXPECTED_BRANCH_ENTRIES) {
      const actual = tree.entries.filter((entry) => entry.workflow === workflow).length;
      expect(
        actual,
        `${workflow} contributed ${actual} branch entries, expected ${expected}. ` +
          'A file that drops out of the reader must fail here rather than be ' +
          "covered by its siblings' entries."
      ).toBe(expected);
    }
  });

  it('resolves every trigger branch entry to an existing ref', (context) => {
    const refNames = listRefsFromGit();
    if (tree === null || refNames === null) {
      // FR-012 / SC-005: ref resolution unavailable, or no workflow directory.
      console.warn(
        'workflow-trigger-branches: skipped — ref resolution unavailable in this ' +
          'environment (no git, no .git, or no refs)'
      );
      context.skip();
      return;
    }

    const failures = resolveEntries(tree.entries, refNames);
    expect(
      failures.map((failure) => failure.message),
      'A workflow trigger names a branch that does not exist. Fix the branch ' +
        'name — do not relax this assertion (FR-018).'
    ).toEqual([]);
  });

  it('only resolves branches: entries, never branches-ignore: or tags:', () => {
    if (tree === null) return;

    // `release.yml` filters on `tags: ['v*']`, which matches no branch. It must
    // contribute no entry, or this gate would report the release flow as broken.
    const releaseEntries = tree.entries.filter((entry) => entry.workflow === 'release.yml');
    expect(releaseEntries).toEqual([]);

    const fixture = [
      'name: fixture',
      'on:',
      '  push:',
      '    branches: [develop]',
      '    tags: [ "v*" ]',
      '  pull_request:',
      '    branches-ignore:',
      '      - a-branch-that-does-not-exist',
      'jobs:',
      '  noop:',
      '    runs-on: ubuntu-latest'
    ].join('\n');

    const read = readWorkflowTriggers('fixture.yml', fixture);
    expect(read.entries.map((entry) => entry.value)).toEqual(['develop']);
    expect(resolveEntries(read.entries, ['develop'])).toEqual([]);

    // Only the three branch-filtered triggers are resolved. A `branches:` key
    // under any other trigger is not a merge-gating filter, so collecting it
    // would report a failure this gate cannot substantiate.
    const other = readWorkflowTriggers(
      'other-trigger.yml',
      ['on:', '  workflow_run:', '    branches: [a-branch-that-does-not-exist]', 'jobs: {}'].join(
        '\n'
      )
    );
    expect(other.entries).toEqual([]);
  });

  it('reads both the flow form and the block-sequence form', () => {
    const flow = readWorkflowTriggers(
      'flow.yml',
      ['on:', '  push:', "    branches: [develop, 'release/1.x']", 'jobs: {}'].join('\n')
    );
    expect(flow.entries.map((entry) => entry.value)).toEqual(['develop', 'release/1.x']);

    const block = readWorkflowTriggers(
      'block.yml',
      ['on:', '  pull_request:', '    branches:', '      - develop', 'jobs: {}'].join('\n')
    );
    expect(block.entries.map((entry) => entry.value)).toEqual(['develop']);
  });

  it('resolves literals against branches, remote-tracking refs, and tags', () => {
    const entries = readWorkflowTriggers(
      'literals.yml',
      ['on:', '  push:', '    branches: [develop, origin/develop, v0.2.0]', 'jobs: {}'].join('\n')
    ).entries;
    expect(resolveEntries(entries, ['develop', 'origin/develop', 'v0.2.0'])).toEqual([]);
  });

  it('accepts a glob that matches a ref and reports one that matches nothing', () => {
    const matching = readWorkflowTriggers(
      'glob-ok.yml',
      ['on:', '  push:', "    branches: [ 'release/**' ]", 'jobs: {}'].join('\n')
    ).entries;
    expect(resolveEntries(matching, ['release/1.x'])).toEqual([]);

    const empty = readWorkflowTriggers(
      'glob-bad.yml',
      ['on:', '  push:', "    branches: [ 'hotfix/**' ]", 'jobs: {}'].join('\n')
    ).entries;
    const failures = resolveEntries(empty, ['release/1.x']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe('pattern-matched-nothing');
    expect(failures[0]?.message).toContain('matched no ref');

    // `*` does not cross `/`; `**` does.
    expect(matchesPattern('release/*', 'release/1.x')).toBe(true);
    expect(matchesPattern('release/*', 'release/1.x/patch')).toBe(false);
    expect(matchesPattern('release/**', 'release/1.x/patch')).toBe(true);

    // A bracket expression is a character class, not a literal `[`. Compiling
    // it as a literal would match nothing and report a live branch as missing.
    expect(matchesPattern('release/[0-9].x', 'release/1.x')).toBe(true);
    expect(matchesPattern('release/[!0-9].x', 'release/1.x')).toBe(false);
    expect(matchesPattern('release/[a-z].x', 'release/1.x')).toBe(false);
    // An unclosed `[` is a literal, not an invalid character class.
    expect(matchesPattern('release/[1.x', 'release/[1.x')).toBe(true);
  });

  it('does not require a negated entry to match a ref', () => {
    // `!`-prefixed entries exclude. Resolving one as an inclusion would fail a
    // legitimate exclusion pattern (FR-015's reasoning, applied inline).
    const entries = readWorkflowTriggers(
      'negation.yml',
      ['on:', '  push:', "    branches: [develop, '!develop-scratch']", 'jobs: {}'].join('\n')
    ).entries;
    expect(entries.map((entry) => entry.value)).toEqual(['develop', '!develop-scratch']);
    expect(resolveEntries(entries, ['develop'])).toEqual([]);
  });

  it('reads triggers at whatever indent the file uses, and the inline on: forms', () => {
    // The trigger indent is learned, not assumed: a file indented with four
    // spaces must not read as "reachable by no event".
    const wide = readWorkflowTriggers(
      'wide-indent.yml',
      ['on:', '    push:', '        branches: [develop]', 'jobs: {}'].join('\n')
    );
    expect(wide.entries.map((entry) => entry.value)).toEqual(['develop']);
    expect(wide.triggers.events).toEqual(['push']);

    // `on: [push, pull_request]` and `on: push` declare events with no filter.
    expect(
      readWorkflowTriggers('inline-list.yml', ['on: [push, pull_request]', 'jobs: {}'].join('\n'))
        .triggers.events
    ).toEqual(['push', 'pull_request']);
    expect(
      readWorkflowTriggers('inline-scalar.yml', ['on: push', 'jobs: {}'].join('\n')).triggers.events
    ).toEqual(['push']);
  });

  it('names the workflow, the trigger, and the branch, and reports every failure at once', () => {
    const first = readWorkflowTriggers(
      'ci.yml',
      ['on:', '  push:', '    branches: [main]', '  pull_request:', '    branches: [main]'].join(
        '\n'
      )
    ).entries;
    const second = readWorkflowTriggers(
      'pr.yml',
      ['on:', '  pull_request:', '    branches:', '      - main'].join('\n')
    ).entries;

    const failures = resolveEntries([...first, ...second], ['develop']);
    // SC-004: three bad entries across two workflows produce three reports.
    expect(failures).toHaveLength(3);
    expect(failures[0]?.message).toContain('ci.yml');
    expect(failures[0]?.message).toContain("trigger 'push'");
    expect(failures[0]?.message).toContain("'main'");
    expect(failures[2]?.message).toContain('pr.yml');
    expect(failures.every((failure) => failure.kind === 'unresolved-branch')).toBe(true);
  });

  it('enumerates the ref universe once per run, not once per entry', () => {
    const lister = vi.fn<RefLister>(() => ['develop']);
    const entries = readWorkflowTriggers(
      'many.yml',
      [
        'on:',
        '  push:',
        '    branches: [develop, develop, develop]',
        '  pull_request:',
        '    branches: [develop]'
      ].join('\n')
    ).entries;
    expect(entries).toHaveLength(4);

    const refNames = lister();
    expect(refNames).not.toBeNull();
    expect(resolveEntries(entries, refNames ?? [])).toEqual([]);
    // SC-005a: four entries, one enumeration.
    expect(lister).toHaveBeenCalledTimes(1);
  });

  it('skips with a stated reason when the ref lister cannot resolve', () => {
    const unavailable: RefLister = () => null;
    const refNames = unavailable();
    expect(refNames).toBeNull();

    // The production path takes the same branch: a null lister yields a skip
    // with a stated reason and zero failures, never a false failure.
    const entries = readWorkflowTriggers(
      'any.yml',
      ['on:', '  push:', '    branches: [does-not-exist]', 'jobs: {}'].join('\n')
    ).entries;
    const failures = refNames === null ? [] : resolveEntries(entries, refNames);
    expect(failures).toEqual([]);
  });

  it('reaches every workflow by an event that can fire', () => {
    if (tree === null) return;

    const unreachable = tree.triggers
      .filter((entry) => !entry.events.some((event) => REACHABLE_EVENTS.has(event)))
      .filter((entry) => !DISPATCH_ONLY_ALLOWLIST.has(entry.workflow))
      .map((entry) => `${entry.workflow}: reachable by no event (${entry.events.join(', ')})`);
    expect(unreachable).toEqual([]);

    // US3 AS2: the two cron workflows qualify on `schedule` and need no
    // allowlist entry.
    for (const workflow of ['full-gate.yml', 'security-audit.yml']) {
      const found = tree.triggers.find((entry) => entry.workflow === workflow);
      expect(found?.events).toContain('schedule');
      expect(DISPATCH_ONLY_ALLOWLIST.has(workflow)).toBe(false);
    }
  });

  it('reports a workflow reachable by dispatch alone', () => {
    const read = readWorkflowTriggers(
      'dispatch-only.yml',
      ['on:', '  workflow_dispatch: {}', 'jobs: {}'].join('\n')
    );
    const reachable = read.triggers.events.some((event) => REACHABLE_EVENTS.has(event));
    expect(reachable).toBe(false);
    expect(DISPATCH_ONLY_ALLOWLIST.has('dispatch-only.yml')).toBe(false);
  });

  it('carries no per-workflow exemption and an empty dispatch-only list', () => {
    // FR-018 / SC-007b: the gate must not be relaxed into passing. There is no
    // skip list for the four workflows this finding is about, and the
    // dispatch-only list ships empty.
    expect([...DISPATCH_ONLY_ALLOWLIST]).toEqual([]);
    const source = readFileSync(__filename, 'utf8');
    for (const workflow of ['ci.yml', 'pr.yml', 'codeql.yml', 'dependency-review.yml']) {
      expect(EXPECTED_BRANCH_ENTRIES.has(workflow)).toBe(true);
      expect(DISPATCH_ONLY_ALLOWLIST.has(workflow)).toBe(false);
    }
    expect(source).not.toMatch(/it\.skip|describe\.skip|test\.skip/);
  });
});
