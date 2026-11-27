import { beforeAll, describe, expect, it } from 'vitest';

/**
 * FR-R4-F21 (feature 249) — `compareTrees` does work in proportion to the capture it reads.
 *
 * A capture is an unsigned file the operator names: a blob id identifies content and authenticates
 * nothing, so its findings are untrusted input, and nothing but the 16 MiB capture bound limits how
 * many findings it holds or how many locations a finding names. Two steps of the comparison were
 * quadratic in those counts. Grouping the findings of one package by shared advisory identifier
 * compared each finding with every group before it, and the "still installed on the candidate" row
 * (row 2) tried every version of a finding at every one of its locations. A forged capture of fifteen
 * thousand findings held `npm run security:advisory-diff -- compare` for seven seconds, and one
 * finding with fifteen thousand locations held it for twenty-five, with nothing printed; the 16 MiB
 * capture bound allows more of either.
 *
 * The budgets sit far above what linear work costs at this size and far below what quadratic work
 * costs, so they separate the two on a loaded machine; neither is a claim about absolute speed. The
 * index is `tests/perf/budgets.json`.
 *
 * Loaded dynamically for the same TS1479 reason `advisory-compare-classify.test.ts` records.
 */
async function loadCompare() {
  return import('../../scripts/advisory-compare.mjs');
}

let compare: Awaited<ReturnType<typeof loadCompare>>;

beforeAll(async () => {
  compare = await loadCompare();
});

const FINDINGS = 15_000;
const LOCATIONS = 15_000;
/**
 * MEASURED 2026-10-30 on darwin/arm64 (macOS 27.0.1, Node 24.19.0, 10 cores) under a load average of
 * 54: seven samples of the linear code took 56 to 167 ms (median 105 ms) to group 15,000 findings and
 * 17 to 54 ms (median 25 ms) to classify 15,000 locations. The quadratic code it replaced took 7.1 s
 * and 25.5 s, the quicker of two samples each.
 *
 * Each budget is one second: at least five times the slowest linear sample under that load, and at
 * most a seventh of what the quadratic code took. A busy machine passes the one and not the other.
 */
const GROUPING_BUDGET_MS = 1_000;
const LOCATIONS_BUDGET_MS = 1_000;
/** A sample over budget is taken again, once: preemption and garbage collection only add time. */
const MAX_SAMPLES = 2;

const BASE_COMMIT = '1'.repeat(40);
const CANDIDATE_COMMIT = '2'.repeat(40);
const EVALUATED_AT = '2026-10-30T09:30:00.000Z';
const OBSERVED_AT = '2026-10-30T09:00:00.000Z';
const BLOB = 'a1'.repeat(20);
const FILES = {
  root: { manifest: 'package.json', lockfile: 'package-lock.json' },
  'webview-ui': { manifest: 'webview-ui/package.json', lockfile: 'webview-ui/package-lock.json' }
} as const;
type Tree = keyof typeof FILES;

interface Place {
  readonly location: string;
  readonly version: string;
}

/** A capture that passes every check, around the findings a case names. */
function makeCapture(tree: Tree, commit: string, findings: readonly unknown[]) {
  return {
    captureVersion: 1,
    tree,
    ecosystem: 'npm',
    commit,
    objectFormat: 'sha1',
    manifest: { path: FILES[tree].manifest, blob: BLOB },
    lockfile: { path: FILES[tree].lockfile, blob: BLOB },
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

function makeFinding(canonical: string, places: readonly Place[]) {
  return {
    package: 'lib-a',
    ids: { canonical, aliases: [] },
    severity: 'high',
    range: '<9.0.0',
    title: 'Forged advisory',
    url: '',
    locations: places.map((place) => ({ ...place, direct: false, production: true })),
    direct: false,
    production: true,
    dependents: [],
    notes: []
  };
}

/** A lockfile object from a location to version map. */
function lockfileOf(places: readonly Place[]) {
  return {
    lockfileVersion: 3,
    packages: {
      '': {},
      ...Object.fromEntries(places.map((place) => [place.location, { version: place.version }]))
    }
  };
}

/** Compare the `root` tree over a complete, matching, fresh pair of captures; `webview-ui` is empty. */
function comparison(sides: {
  readonly baseFindings: readonly unknown[];
  readonly candidateFindings: readonly unknown[];
  readonly baseInstalled: readonly Place[];
  readonly candidateInstalled: readonly Place[];
}) {
  const read = (value: unknown) => ({ text: JSON.stringify(value) });
  const captures = {
    root: {
      base: read(makeCapture('root', BASE_COMMIT, sides.baseFindings)),
      candidate: read(makeCapture('root', CANDIDATE_COMMIT, sides.candidateFindings))
    },
    'webview-ui': {
      base: read(makeCapture('webview-ui', BASE_COMMIT, [])),
      candidate: read(makeCapture('webview-ui', CANDIDATE_COMMIT, []))
    }
  };
  const lockfiles = {
    root: { base: lockfileOf(sides.baseInstalled), candidate: lockfileOf(sides.candidateInstalled) },
    'webview-ui': { base: lockfileOf([]), candidate: lockfileOf([]) }
  };
  return () =>
    compare.compareTrees({
      candidate: { commit: CANDIDATE_COMMIT },
      base: { commit: BASE_COMMIT, rule: 'merge-base', target: 'develop' },
      captures,
      lockfiles,
      evaluatedAt: EVALUATED_AT,
      blobAt: () => BLOB
    });
}

function timed<T>(work: () => T) {
  const start = performance.now();
  const result = work();
  return { elapsedMs: performance.now() - start, result };
}

/** The quicker of at most `MAX_SAMPLES` runs, stopping at the first inside the budget. */
function measure<T>(work: () => T, budgetMs: number) {
  let best = timed(work);
  for (let sample = 1; sample < MAX_SAMPLES && best.elapsedMs >= budgetMs; sample += 1) {
    const next = timed(work);
    if (next.elapsedMs < best.elapsedMs) best = next;
  }
  return best;
}

describe('compareTrees: bounded work on a capture with many findings or locations (feature 249)', () => {
  it(`groups ${FINDINGS} unrelated findings of one package in under ${GROUPING_BUDGET_MS} ms`, () => {
    const place = { location: 'node_modules/lib-a', version: '1.0.0' };
    const findings = Array.from({ length: FINDINGS }, (_, index) => makeFinding(`npm:${index}`, [place]));
    const { elapsedMs, result } = measure(
      comparison({ baseFindings: [], candidateFindings: findings, baseInstalled: [], candidateInstalled: [place] }),
      GROUPING_BUDGET_MS
    );
    const root = result.trees.find((tree) => tree.tree === 'root');
    expect(result.complete).toBe(true);
    expect(root?.findings).toHaveLength(FINDINGS);
    expect(root?.totals).toMatchObject({ introduced: FINDINGS });
    expect(elapsedMs).toBeLessThan(GROUPING_BUDGET_MS);
  });

  it(`classifies a base finding with ${LOCATIONS} locations and versions in under ${LOCATIONS_BUDGET_MS} ms`, () => {
    const places = Array.from({ length: LOCATIONS }, (_, index) => ({
      location: `node_modules/host-${index}/node_modules/lib-a`,
      version: `1.0.${index}`
    }));
    const { elapsedMs, result } = measure(
      comparison({
        baseFindings: [makeFinding('npm:1', places)],
        candidateFindings: [],
        baseInstalled: places,
        candidateInstalled: []
      }),
      LOCATIONS_BUDGET_MS
    );
    const root = result.trees.find((tree) => tree.tree === 'root');
    expect(result.complete).toBe(true);
    expect(root?.findings.map((finding) => [finding.class, finding.reasons.map((reason) => reason.code)])).toEqual([
      ['resolved', ['absent-on-candidate']]
    ]);
    expect(elapsedMs).toBeLessThan(LOCATIONS_BUDGET_MS);
  });
});
