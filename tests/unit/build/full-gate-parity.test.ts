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
import { describe, expect, it } from 'vitest';

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
