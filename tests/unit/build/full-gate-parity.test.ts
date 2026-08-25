// FR-R3-074 (US5) — the full gate must contain the checks its release binding
// names, and the binding's wording must not name a check the gate does not run.
//
// `release.yml` refuses to publish without a green `full-gate.yml` run at the
// exact release SHA (scripts/require-full-gate.mjs), and its requirement
// comment describes that workflow as "the eval / e2e / perf / visual /
// full-coverage gate". Before this test existed, three of those five words were
// aspiration: `full-gate.yml` ran the bare `npm run test` with no coverage
// thresholds, no perf budgets, and no webview lint, so a release could bind —
// with signed provenance — to a gate narrower than the one its own comment
// promised. Each rule below forbids one way back to that state:
//
//   1. a named check disappearing from the workflow (a job deleted, a step
//      renamed, `test:coverage` quietly downgraded to `test`);
//   2. the requirement text growing a sixth name no workflow step discharges,
//      or dropping a name so the wording shrinks to fit a narrowed gate;
//   3. `require-full-gate.mjs` detaching from `full-gate.yml` by rename, which
//      would leave both sides of the parity holding a file the release no
//      longer queries.
//
// Workflow sources are read by line scanning only — FR-017 forbids adding a
// YAML dependency for a gate, and `scripts/check-workflow-pins.mjs` plus
// tests/lint/workflow-trigger-branches.test.ts already read these files the
// same way.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');

const FULL_GATE = readFileSync(resolve(ROOT, '.github/workflows/full-gate.yml'), 'utf8');
const RELEASE = readFileSync(resolve(ROOT, '.github/workflows/release.yml'), 'utf8');
const REQUIRE_GATE = readFileSync(resolve(ROOT, 'scripts/require-full-gate.mjs'), 'utf8');

// The release requirement's five names, each mapped to the npm target whose
// executed step discharges it. The map is the contract: a name added to the
// requirement wording must gain a row here AND an executed step in the
// workflow, or the reverse-direction assertion below fails.
//
//   requirement name  -> npm target executed by full-gate.yml
//   eval              -> test:evals     (deterministic backend evaluations)
//   e2e               -> test:e2e      (deterministic E2E smoke)
//   perf              -> test:perf     (blocking wall-clock budgets)
//   visual            -> test:visual   (browser visual regression)
//   full-coverage     -> test:coverage (thresholded host coverage)
const RELEASE_CHECK_TARGETS: ReadonlyMap<string, string> = new Map([
  ['eval', 'test:evals'],
  ['e2e', 'test:e2e'],
  ['perf', 'test:perf'],
  ['visual', 'test:visual'],
  ['full-coverage', 'test:coverage']
]);

/**
 * Every command a workflow executes: each `run:` line, split on `&&` so a
 * chained step contributes each of its commands as a separate entry.
 */
function executedSteps(workflowSource: string): readonly string[] {
  const steps: string[] = [];
  for (const rawLine of workflowSource.split('\n')) {
    const match = /^\s*(?:-\s+)?run:\s*(\S.*)$/.exec(rawLine);
    if (match === null) continue;
    for (const command of (match[1] as string).split('&&')) {
      const trimmed = command.trim();
      if (trimmed.length > 0) steps.push(trimmed);
    }
  }
  return steps;
}

/**
 * Whether some executed step ends with `npm run <target>` as a whole token.
 *
 * End-anchored over the `&&`-split step rather than `String#includes` over the
 * file, for the same reason release-gate.test.ts parses its chains: a substring
 * match lets `npm run test` be satisfied by `npm run test:coverage` — the
 * parity would then survive the exact downgrade (thresholded coverage back to
 * the bare suite) it exists to forbid. The leading `(?:^|\s)` admits a wrapper
 * such as `xvfb-run -a npm run test:integration` without admitting a longer
 * target name.
 */
function runsTarget(steps: readonly string[], target: string): boolean {
  const pattern = new RegExp(`(?:^|\\s)npm run ${target}$`);
  return steps.some((step) => pattern.test(step));
}

const FULL_GATE_STEPS = executedSteps(FULL_GATE);

/**
 * The slash-separated check list in a requirement sentence of the form
 * "... eval / e2e / perf / visual / full-coverage gate". Exactly one such
 * sentence may exist per document: zero means the wording moved and this test
 * is no longer reading the requirement, two means the requirement is stated
 * twice and can drift against itself. Prose such as "the full gate" carries no
 * ` / `-separated list, so it cannot satisfy this shape by accident.
 */
function namedChecks(source: string, document: string): readonly string[] {
  const matches = [...source.matchAll(/((?:[a-z0-9-]+ \/ )+[a-z0-9-]+) gate\b/g)];
  expect(
    matches,
    `${document} must state the full-gate requirement exactly once as ` +
      '"<name> / <name> / ... gate"; the reverse-direction parity reads that sentence.'
  ).toHaveLength(1);
  return (matches[0]?.[1] as string).split('/').map((name) => name.trim());
}

describe('full gate / release binding parity (FR-R3-074)', () => {
  it('executes every check the release requirement names', () => {
    for (const [name, target] of RELEASE_CHECK_TARGETS) {
      expect(
        runsTarget(FULL_GATE_STEPS, target),
        `full-gate.yml executes no \`npm run ${target}\` step, but the release ` +
          `requirement names "${name}". A release would bind to a gate narrower than ` +
          'its own wording promises — widen the gate, do not edit the wording down.'
      ).toBe(true);
    }
  });

  it('executes the webview lint baseline inside the gate', () => {
    // Not one of the five release names, but the same regression: `lint` covers
    // the host tree only, so dropping this step silently removes the webview
    // baseline from the gate the release binds to (gate-parity contract, rule 1).
    expect(runsTarget(FULL_GATE_STEPS, 'lint:webview')).toBe(true);
  });

  it('keeps the release evidence script bound to full-gate.yml by filename', () => {
    // Renaming the workflow would leave every assertion above green while the
    // release queried runs of a file that no longer exists — fail-closed, so
    // every release would block, but for a reason no assertion names.
    expect(REQUIRE_GATE).toContain("FULL_GATE_WORKFLOW = 'full-gate.yml'");
  });

  it('reads a step list wide enough to be the full gate', () => {
    // Anti-vacuity floor. The step reader above is a line scanner, not a YAML
    // parser: a rewrite of the workflow into a grammar it does not read (block
    // scalars via `run: |`, steps composed through a reusable workflow) could
    // leave the five asserted targets extracted while silently losing the rest
    // of the file. The named-target assertions cannot see partial blindness —
    // they only need five hits — so the floor is what makes a reader that
    // stops seeing most of the gate fail loudly. 35 executed commands and 11
    // jobs at the time of writing; the floors sit below both so routine step
    // additions and removals do not touch this test.
    expect(FULL_GATE_STEPS.length).toBeGreaterThanOrEqual(30);
    expect(FULL_GATE.split('runs-on:').length - 1).toBeGreaterThanOrEqual(11);
  });

  it('release.yml names exactly the five checks the mapping table holds', () => {
    // Reverse direction (gate-parity contract, rule 2): a sixth name added to
    // the requirement comment without a mapped, executed target must fail here
    // — otherwise the wording promises a check no gate runs, which is the
    // defect FR-R3-074 started from.
    expect(namedChecks(RELEASE, 'release.yml')).toEqual([...RELEASE_CHECK_TARGETS.keys()]);
  });

  it('require-full-gate.mjs repeats the same five names, unmutated', () => {
    // The evidence script's header restates the requirement. Two documents
    // stating one requirement is one drift away from two requirements, so the
    // restatement is held to the same list (gate-parity contract, rule 4).
    expect(namedChecks(REQUIRE_GATE, 'scripts/require-full-gate.mjs')).toEqual([
      ...RELEASE_CHECK_TARGETS.keys()
    ]);
  });
});

/**
 * FR-R3-087 — the release binding's job list and this file's target map are ONE
 * list, checked from both ends.
 *
 * Before this, the parity test asserted the workflow's *text* and the release
 * binding asserted the run's *conclusion*. Nothing asserted that the jobs the
 * text names actually ran — which is precisely the gap a job-level `if:` would
 * open. Two lists that agree by coincidence is the duplicate-authority shape
 * FR-R3-066 exists to remove.
 */
describe('FR-R3-087 — the per-job list and the target map are one authority', () => {
  /**
   * Every `name:` that belongs to a job, i.e. the `name:` at job indentation
   * (four spaces) rather than a step's `- name:` at six or more.
   */
  function jobNames(workflowSource: string): readonly string[] {
    const names: string[] = [];
    for (const line of workflowSource.split('\n')) {
      const match = /^ {4}name:\s*(\S.*?)\s*$/.exec(line);
      if (match !== null) names.push(match[1] as string);
    }
    return names;
  }

  /**
   * The blocks a job occupies, keyed by its `name:` — so a target executed in
   * one job is not credited to another.
   */
  function jobBlocks(workflowSource: string): ReadonlyMap<string, string> {
    const blocks = new Map<string, string>();
    const lines = workflowSource.split('\n');
    let current: string | null = null;
    let buffer: string[] = [];
    const flush = (): void => {
      if (current !== null) blocks.set(current, buffer.join('\n'));
      current = null;
      buffer = [];
    };
    for (const line of lines) {
      if (/^ {2}[\w-]+:\s*$/.test(line)) flush();
      const named = /^ {4}name:\s*(\S.*?)\s*$/.exec(line);
      if (named !== null) {
        current = named[1] as string;
        buffer = [];
        continue;
      }
      if (current !== null) buffer.push(line);
    }
    flush();
    return blocks;
  }

  let requiredJobNames: readonly string[];

  beforeAll(async () => {
    const gate = await import('../../../scripts/require-full-gate.mjs');
    requiredJobNames = gate.REQUIRED_JOB_NAMES as readonly string[];
  });

  it('scanned a workflow with jobs in it', () => {
    // Anti-vacuity floor: an indentation change that stopped the reader seeing
    // jobs would make every assertion below pass on an empty set.
    expect(jobNames(FULL_GATE).length).toBeGreaterThanOrEqual(11);
    expect(jobBlocks(FULL_GATE).size).toBe(jobNames(FULL_GATE).length);
  });

  it('every required job name resolves to a job in full-gate.yml', () => {
    const actual = new Set(jobNames(FULL_GATE));
    const unresolved = requiredJobNames.filter((name) => !actual.has(name));
    expect(unresolved).toEqual([]);
  });

  it('every job NOT required carries an explicit optional marker with a reason', () => {
    // A subset stays a DECISION rather than an omission. Without this, a job
    // added by a later change is silently outside the release binding and
    // nobody chose that.
    const required = new Set(requiredJobNames);
    const unmarked: string[] = [];
    for (const [name, block] of jobBlocks(FULL_GATE)) {
      if (required.has(name)) continue;
      if (!/#\s*release-binding:\s*optional/.test(block)) unmarked.push(name);
    }
    expect(unmarked).toEqual([]);
  });

  it('every release-named target is executed inside a job the binding requires', () => {
    // The two ends meet here: RELEASE_CHECK_TARGETS is the release wording's
    // list, REQUIRED_JOB_NAMES is the binding's, and this asserts they describe
    // the same jobs. Diverge either and this fails.
    const blocks = jobBlocks(FULL_GATE);
    const required = new Set(requiredJobNames);
    const orphaned: string[] = [];
    for (const target of RELEASE_CHECK_TARGETS.values()) {
      const hosts = [...blocks.entries()]
        .filter(([, block]) => block.includes(`npm run ${target}`))
        .map(([name]) => name);
      if (hosts.length === 0 || !hosts.some((name) => required.has(name))) {
        orphaned.push(target);
      }
    }
    expect(orphaned).toEqual([]);
  });

  it('NON-VACUITY: an unmarked extra job and an unresolvable required name are both detected', () => {
    const withExtra = FULL_GATE + '\n  surprise:\n    name: surprise job\n    runs-on: ubuntu-latest\n';
    const required = new Set(requiredJobNames);
    const unmarked = [...jobBlocks(withExtra).keys()].filter(
      (name) => !required.has(name) && !/#\s*release-binding:\s*optional/.test(jobBlocks(withExtra).get(name) ?? '')
    );
    expect(unmarked).toContain('surprise job');

    const actual = new Set(jobNames(FULL_GATE));
    expect(['a job that does not exist'].filter((name) => !actual.has(name))).toHaveLength(1);
  });
});
