import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * FR-R4-F21 (feature 249; FR-010, FR-013, FR-014, K3) — which class each finding lands in.
 *
 * `compareTrees` groups the base and candidate findings of a package whose identifier sets
 * intersect, then classifies each group by the first matching row of the decision table. This pins
 * contract T5. A candidate and a base capture decide four classes on their own: introduced (row 4),
 * worsened (row 5), pre-existing (row 6) and resolved (row 7). Rows 1 to 3 need the two lockfiles
 * as well, and set database drift apart as uncertain: a finding that appears, disappears or changes
 * severity while the lockfiles say the candidate changed nothing is not blamed on the candidate.
 *
 * Each case reads a fixture under `tests/fixtures/advisory-diff/classify/` that declares its own
 * expected class and reason codes. This file builds valid captures around the fixture's findings
 * and reads the declaration rather than restating it. No fixture holds a group that rows 1 to 3
 * would catch, so none of them changes class when those rows are applied ahead of them.
 *
 * Loaded dynamically for the same TS1479 reason `gate-distance.test.ts` records.
 */
async function loadCompare() {
  return import('../../../scripts/advisory-compare.mjs');
}

let compare: Awaited<ReturnType<typeof loadCompare>>;

beforeAll(async () => {
  compare = await loadCompare();
});

const BASE_COMMIT = '1'.repeat(40);
const CANDIDATE_COMMIT = '2'.repeat(40);
const EVALUATED_AT = '2026-10-30T09:30:00.000Z';
const OBSERVED_AT = '2026-10-30T09:00:00.000Z';
const BLOBS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [BASE_COMMIT]: {
    'package.json': 'a1'.repeat(20),
    'package-lock.json': 'a2'.repeat(20),
    'webview-ui/package.json': 'a3'.repeat(20),
    'webview-ui/package-lock.json': 'a4'.repeat(20)
  },
  [CANDIDATE_COMMIT]: {
    'package.json': 'b1'.repeat(20),
    'package-lock.json': 'b2'.repeat(20),
    'webview-ui/package.json': 'b3'.repeat(20),
    'webview-ui/package-lock.json': 'b4'.repeat(20)
  }
};
const FILES = {
  root: { manifest: 'package.json', lockfile: 'package-lock.json' },
  'webview-ui': { manifest: 'webview-ui/package.json', lockfile: 'webview-ui/package-lock.json' }
} as const;
type Tree = keyof typeof FILES;

function blobAt(commit: string, path: string): string | null {
  const files = BLOBS[commit] as Readonly<Record<string, string>> | undefined;
  return files?.[path] ?? null;
}

/** A capture that passes every check, around the findings a fixture names. */
function makeCapture(tree: Tree, commit: string, findings: readonly unknown[]) {
  return {
    captureVersion: 1,
    tree,
    ecosystem: 'npm',
    commit,
    objectFormat: 'sha1',
    manifest: { path: FILES[tree].manifest, blob: blobAt(commit, FILES[tree].manifest) },
    lockfile: { path: FILES[tree].lockfile, blob: blobAt(commit, FILES[tree].lockfile) },
    tool: 'npm',
    toolVersion: '11.17.0',
    command: 'npm audit --json --offline=false --include=dev --include=optional --include=peer',
    registryHost: 'registry.example.test',
    observedAt: OBSERVED_AT,
    reportFormat: 'npm-audit-report-2',
    outcome: { status: 'succeeded' },
    limitations: ['Advisory data is the registry\'s at observedAt.', 'npm may have written to its own cache.'],
    findings
  };
}

/** A lockfile object from a location to version map. */
function lockfileOf(versions: Readonly<Record<string, string>>) {
  return {
    lockfileVersion: 3,
    packages: {
      '': {},
      ...Object.fromEntries(Object.entries(versions).map(([location, version]) => [location, { version }]))
    }
  };
}

interface Group {
  readonly package: string;
  readonly class: string;
  readonly reasons: readonly string[];
  readonly pairs?: Readonly<Record<string, readonly { location: string; version: string }[]>>;
  readonly severity?: { readonly base: string | null; readonly candidate: string | null };
  readonly ids?: { readonly canonical: string; readonly aliases: readonly string[] };
}

interface ClassifyFixture {
  readonly declares: { readonly description: string; readonly groups: readonly Group[] };
  readonly base: { readonly findings: readonly unknown[] };
  readonly candidate: { readonly findings: readonly unknown[] };
  readonly lockfiles: {
    readonly base: Readonly<Record<string, string>>;
    readonly candidate: Readonly<Record<string, string>>;
  };
}

const FIXTURES = resolve(__dirname, '..', '..', 'fixtures', 'advisory-diff', 'classify');

function fixture(name: string): ClassifyFixture {
  return JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8')) as ClassifyFixture;
}

/** Compare a fixture's two sides over a complete, matching, fresh pair of captures. */
function classify(name: string) {
  const fx = fixture(name);
  const read = (value: unknown) => ({ text: JSON.stringify(value) });
  const result = compare.compareTrees({
    candidate: { commit: CANDIDATE_COMMIT },
    base: { commit: BASE_COMMIT, rule: 'merge-base', target: 'develop' },
    captures: {
      root: {
        base: read(makeCapture('root', BASE_COMMIT, fx.base.findings)),
        candidate: read(makeCapture('root', CANDIDATE_COMMIT, fx.candidate.findings))
      },
      'webview-ui': {
        base: read(makeCapture('webview-ui', BASE_COMMIT, [])),
        candidate: read(makeCapture('webview-ui', CANDIDATE_COMMIT, []))
      }
    },
    lockfiles: {
      root: { base: lockfileOf(fx.lockfiles.base), candidate: lockfileOf(fx.lockfiles.candidate) },
      'webview-ui': { base: lockfileOf({}), candidate: lockfileOf({}) }
    },
    evaluatedAt: EVALUATED_AT,
    blobAt
  });
  return { fx, result };
}

/** Assert a fixture's declared groups against what `compareTrees` classified, in order. */
function expectDeclared(name: string): void {
  const { fx, result } = classify(name);
  expect(result.complete, `${name}: ${fx.declares.description}`).toBe(true);
  const root = result.trees.find((tree) => tree.tree === 'root');
  const findings = root?.findings ?? [];
  expect(
    findings.map((finding) => finding.package),
    `${name}: the groups found`
  ).toEqual(fx.declares.groups.map((group) => group.package));
  fx.declares.groups.forEach((group, index) => {
    const found = findings.at(index);
    expect(found?.class, `${name}: ${group.package} class`).toBe(group.class);
    expect(
      found?.reasons.map((reason) => reason.code),
      `${name}: ${group.package} reasons`
    ).toEqual(group.reasons);
    for (const [code, pairs] of Object.entries(group.pairs ?? {})) {
      expect(
        found?.reasons.find((reason) => reason.code === code)?.pairs,
        `${name}: ${group.package} ${code} pairs`
      ).toEqual(pairs);
    }
    if (group.severity !== undefined) expect(found?.severity).toEqual(group.severity);
    if (group.ids !== undefined) expect(found?.ids).toEqual(group.ids);
  });
}

/** The first finding of the first tree, or the failure that says the fixture classified none. */
function firstFinding(name: string) {
  const finding = classify(name).result.trees.at(0)?.findings.at(0);
  if (finding === undefined) throw new Error(`${name}: no finding was classified`);
  return finding;
}

describe('compareTrees: the classes a base and a candidate capture decide (T5, rows 4 to 7)', () => {
  it('classifies a finding on the candidate only as introduced (row 4)', () => {
    expectDeclared('introduced-new-dependency');
  });

  it('classifies each cause of worsening, naming it and listing its pairs (row 5)', () => {
    for (const name of [
      'worsened-new-pair',
      'worsened-severity-raised',
      'worsened-newly-direct',
      'worsened-newly-production'
    ]) {
      expectDeclared(name);
    }
  });

  it('FR-014: a matching advisory id with a new pair is worsened, never pre-existing', () => {
    expectDeclared('worsened-new-pair');
    const { result } = classify('worsened-new-pair');
    expect(result.trees[0]?.findings.map((finding) => finding.class)).not.toContain('pre-existing');
  });

  it('classifies an unchanged finding as pre-existing, and notes each way it narrowed (row 6)', () => {
    for (const name of [
      'pre-existing-equal',
      'pre-existing-severity-lowered',
      'pre-existing-fewer-pairs',
      'pre-existing-no-longer-direct',
      'pre-existing-no-longer-production'
    ]) {
      expectDeclared(name);
    }
  });

  it('keeps one of two paths removed, with the version kept at the other, as pre-existing', () => {
    expectDeclared('pre-existing-fewer-pairs');
  });

  it('classifies a finding on the base only, with its version gone from the candidate, as resolved (row 7)', () => {
    expectDeclared('resolved-version-gone');
  });

  it('matches one finding across an alias: GHSA on one side and npm:<source> only on the other (US1-6)', () => {
    expectDeclared('alias-pair');
  });

  it('makes a renamed package a resolved finding plus an introduced one, with no fuzzy match', () => {
    expectDeclared('renamed-package');
  });

  it('finds no introduced group when the candidate equals the base', () => {
    expectDeclared('candidate-equal-to-base');
    const { result } = classify('candidate-equal-to-base');
    expect(result.trees[0]?.totals).toMatchObject({ introduced: 0, worsened: 0, 'pre-existing': 2 });
  });

  it('groups transitively across both sides: {A} and {B} against {A, B} is one group (R5)', () => {
    expectDeclared('transitive-grouping');
  });
});

describe('compareTrees: database drift is uncertain, not blamed on the candidate (T5, rows 1 to 3)', () => {
  it('classifies a candidate-only finding whose every pair is already in the base lockfile as uncertain (US3-1)', () => {
    expectDeclared('uncertain-disclosed-between-captures');
  });

  it('classifies a base-only finding whose version is still installed on the candidate as uncertain (US3-2)', () => {
    expectDeclared('uncertain-still-installed');
  });

  it('reads "any of its versions at any of its locations" literally: one still installed is enough (US3-5)', () => {
    expectDeclared('uncertain-still-installed-any-location');
  });

  it('classifies equal pairs with a revised severity as uncertain, severity-revised (US3-3)', () => {
    expectDeclared('uncertain-severity-revised');
  });

  it('classifies an unknown severity on one side, or on both, as uncertain, severity-not-comparable', () => {
    expectDeclared('uncertain-severity-unknown-one-side');
    expectDeclared('uncertain-candidate-equal-unknown-severity');
  });

  it('counts the uncertain findings in their own class, and in no other', () => {
    const { result } = classify('uncertain-disclosed-between-captures');
    expect(result.totals).toMatchObject({ uncertain: 1, introduced: 0, resolved: 0, 'pre-existing': 0 });
  });
});

describe('compareTrees: partial overlap is introduced with its reason (clarify Q2, US3-4)', () => {
  it('names the overlapping pairs when some, but not all, of the candidate pairs are in the base lockfile', () => {
    expectDeclared('introduced-partly-in-base-lockfile');
  });

  it('adds severity-not-comparable to a worsened group when either severity is unknown (row 5)', () => {
    expectDeclared('worsened-with-unknown-severity');
  });
});

describe('compareTrees: what every classification guarantees', () => {
  const names = [
    'introduced-new-dependency',
    'worsened-new-pair',
    'worsened-severity-raised',
    'worsened-newly-direct',
    'worsened-newly-production',
    'pre-existing-equal',
    'pre-existing-severity-lowered',
    'pre-existing-fewer-pairs',
    'pre-existing-no-longer-direct',
    'pre-existing-no-longer-production',
    'resolved-version-gone',
    'alias-pair',
    'renamed-package',
    'candidate-equal-to-base',
    'transitive-grouping'
  ];

  it('lands every group in exactly one class, and the totals count each (FR-013)', () => {
    for (const name of names) {
      const { fx, result } = classify(name);
      const root = result.trees.find((tree) => tree.tree === 'root');
      expect(root?.findings, name).toHaveLength(fx.declares.groups.length);
      const total = Object.values(root?.totals ?? {}).reduce((sum, count) => sum + count, 0);
      expect(total, name).toBe(fx.declares.groups.length);
    }
  });

  it('counts every class in the totals, zeros included', () => {
    const { result } = classify('introduced-new-dependency');
    expect(result.totals).toEqual({
      introduced: 1,
      worsened: 0,
      uncertain: 0,
      'pre-existing': 0,
      resolved: 0,
      'not-determined': 0
    });
  });

  it('writes each classified finding with the contract keys, and a not-recorded disposition (TA4)', () => {
    const finding = firstFinding('worsened-newly-direct');
    expect(Object.keys(finding)).toEqual([
      'class',
      'tree',
      'package',
      'ids',
      'severity',
      'base',
      'candidate',
      'reasons',
      'notes',
      'title',
      'dependents',
      'disposition'
    ]);
    expect(finding.disposition).toEqual({ verdict: 'not-recorded', entries: [] });
    expect(finding.tree).toBe('root');
  });

  it('sets the absent side of an introduced and a resolved finding to null, severity included', () => {
    const introduced = firstFinding('introduced-new-dependency');
    expect(introduced.base).toBeNull();
    expect(introduced.severity.base).toBeNull();
    const resolved = firstFinding('resolved-version-gone');
    expect(resolved.candidate).toBeNull();
    expect(resolved.severity.candidate).toBeNull();
  });
});

interface Place {
  readonly location: string;
  readonly version: string;
  readonly direct?: boolean;
}

/** A finding of `lib-a` built in code, for the cases a fixture cannot hold: its pairs, and a flag for each. */
function inlineFinding(canonical: string, aliases: readonly string[], places: readonly Place[]) {
  return {
    package: 'lib-a',
    ids: { canonical, aliases },
    severity: 'high',
    range: '<9.0.0',
    title: 'Inline classification advisory',
    url: '',
    locations: places.map((place) => ({ ...place, direct: place.direct ?? true, production: true })),
    direct: true,
    production: true,
    dependents: [],
    notes: []
  };
}

/** Compare the `root` tree of findings built in code, over a complete, matching, fresh pair of captures. */
function classifyInline(sides: {
  readonly base: readonly unknown[];
  readonly candidate: readonly unknown[];
  readonly baseInstalled?: Readonly<Record<string, string>>;
  readonly candidateInstalled?: Readonly<Record<string, string>>;
}) {
  const read = (value: unknown) => ({ text: JSON.stringify(value) });
  const result = compare.compareTrees({
    candidate: { commit: CANDIDATE_COMMIT },
    base: { commit: BASE_COMMIT, rule: 'merge-base', target: 'develop' },
    captures: {
      root: {
        base: read(makeCapture('root', BASE_COMMIT, sides.base)),
        candidate: read(makeCapture('root', CANDIDATE_COMMIT, sides.candidate))
      },
      'webview-ui': {
        base: read(makeCapture('webview-ui', BASE_COMMIT, [])),
        candidate: read(makeCapture('webview-ui', CANDIDATE_COMMIT, []))
      }
    },
    lockfiles: {
      root: { base: lockfileOf(sides.baseInstalled ?? {}), candidate: lockfileOf(sides.candidateInstalled ?? {}) },
      'webview-ui': { base: lockfileOf({}), candidate: lockfileOf({}) }
    },
    evaluatedAt: EVALUATED_AT,
    blobAt
  });
  const findings = result.trees.find((tree) => tree.tree === 'root')?.findings ?? [];
  return { result, findings };
}

/** The class and reason codes of each finding, which is what a lockfile row decides. */
function verdicts(findings: ReturnType<typeof classifyInline>['findings']) {
  return findings.map((finding) => [finding.class, finding.reasons.map((reason) => reason.code)]);
}

/**
 * A chain this long is a group this deep, past what a walk of it by recursion survives. The time it
 * takes is asserted in `tests/perf/advisory-compare-bounded-work.test.ts`, not here.
 */
const CHAIN_LENGTH = 20_000;

describe('compareTrees: what the linear lockfile rows and grouping keep exact (feature 249)', () => {
  it('does not take a candidate pair for one in the base lockfile when the base holds its location at another version (row 1)', () => {
    const { result, findings } = classifyInline({
      base: [],
      candidate: [inlineFinding('GHSA-ab12-cd34-ef56', [], [{ location: 'node_modules/lib-a', version: '1.0.1' }])],
      baseInstalled: { 'node_modules/lib-a': '1.0.0' },
      candidateInstalled: { 'node_modules/lib-a': '1.0.1' }
    });
    expect(result.complete).toBe(true);
    expect(verdicts(findings)).toEqual([['introduced', ['new-on-candidate']]]);
  });

  it('counts a version of a base finding found at another of its locations as still installed (row 2, US3-5)', () => {
    const { result, findings } = classifyInline({
      base: [
        inlineFinding(
          'GHSA-ab12-cd34-ef56',
          [],
          [
            { location: 'node_modules/lib-a', version: '1.0.0' },
            { location: 'node_modules/host/node_modules/lib-a', version: '1.0.1' }
          ]
        )
      ],
      candidate: [],
      baseInstalled: { 'node_modules/lib-a': '1.0.0', 'node_modules/host/node_modules/lib-a': '1.0.1' },
      // `node_modules/lib-a` now holds 1.0.1, the version the finding names at its other location.
      candidateInstalled: { 'node_modules/lib-a': '1.0.1' }
    });
    expect(result.complete).toBe(true);
    expect(verdicts(findings)).toEqual([['uncertain', ['still-installed-on-candidate']]]);
  });

  it('lists a merged group newest finding first, then the groups it joined in the order they began', () => {
    const shared = { location: 'node_modules/lib-a', version: '1.0.0' };
    const host = { location: 'node_modules/host/node_modules/lib-a', version: '1.0.0' };
    const { result, findings } = classifyInline({
      base: [],
      candidate: [
        inlineFinding('npm:1', [], [{ ...shared, direct: true }]),
        inlineFinding('npm:2', [], [{ ...shared, direct: false }]),
        // Names the second group's identifier before the first group's, which must not reorder them.
        inlineFinding('npm:2', ['npm:1'], [host])
      ]
    });
    expect(result.complete).toBe(true);
    expect(findings).toHaveLength(1);
    // The group lists the third finding, then the first, then the second. Both of the last two hold
    // `shared`, and the one listed last decides the flags it reports.
    expect(findings.at(0)?.candidate?.locations).toEqual([
      { ...host, direct: true, production: true },
      { ...shared, direct: false, production: true }
    ]);
  });

  it('joins a finding to an earlier one that names its canonical identifier only as an alias', () => {
    const place = { location: 'node_modules/lib-a', version: '1.0.0' };
    const installed = { [place.location]: place.version };
    const { result, findings } = classifyInline({
      base: [inlineFinding('GHSA-ab12-cd34-ef56', ['npm:5555'], [place])],
      candidate: [inlineFinding('npm:5555', [], [place])],
      baseInstalled: installed,
      candidateInstalled: installed
    });
    expect(result.complete).toBe(true);
    expect(verdicts(findings)).toEqual([['pre-existing', []]]);
    expect(findings.at(0)?.ids).toEqual({ canonical: 'GHSA-ab12-cd34-ef56', aliases: ['npm:5555'] });
  });

  it(`keeps a chain of ${CHAIN_LENGTH} findings, each naming the one before it, as one group`, () => {
    const place = { location: 'node_modules/lib-a', version: '1.0.0' };
    const chain = Array.from({ length: CHAIN_LENGTH }, (_, index) =>
      inlineFinding(`npm:${index}`, index === 0 ? [] : [`npm:${index - 1}`], [place])
    );
    const { result, findings } = classifyInline({
      base: [],
      candidate: chain,
      candidateInstalled: { [place.location]: place.version }
    });
    expect(result.complete).toBe(true);
    expect(findings).toHaveLength(1);
    expect(findings.at(0)?.ids.canonical).toBe('npm:0');
    expect(findings.at(0)?.ids.aliases).toHaveLength(CHAIN_LENGTH - 1);
  });
});
