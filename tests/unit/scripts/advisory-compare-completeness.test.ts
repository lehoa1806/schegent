import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * FR-R4-F21 (feature 249; FR-006 to FR-009, FR-016, SC-002, SC-003, K2, K4) — an incomplete
 * comparison never reads as clean.
 *
 * `compareTrees` checks every capture before it trusts one: that it was supplied, can be read,
 * describes the commit and the files it claims to, did not fail or get rejected, is fresh, and is
 * comparable with and paired to the other side. Any defect makes its tree incomplete with a named
 * reason, lists what could be read as not determined, and states no zero. This pins contract T4,
 * once for each of the thirteen reasons.
 *
 * Each case reads a fixture under `tests/fixtures/advisory-diff/completeness/` that carries its
 * inputs and declares its own expectation. This file builds the call from the fixture and reads the
 * declaration rather than restating it.
 *
 * Loaded dynamically for the same TS1479 reason `gate-distance.test.ts` records.
 */
async function loadCompare() {
  return import('../../../scripts/advisory-compare.mjs');
}
async function loadModel() {
  return import('../../../scripts/advisory-model.mjs');
}

let compare: Awaited<ReturnType<typeof loadCompare>>;
let model: Awaited<ReturnType<typeof loadModel>>;

beforeAll(async () => {
  compare = await loadCompare();
  model = await loadModel();
});

type RawCapture = { readonly raw: string } | { readonly overBound: true } | Record<string, unknown> | null;

interface DeclaredTree {
  readonly complete: boolean;
  readonly totals?: Readonly<Record<string, number>> | null;
  readonly findings?: readonly { readonly package: string; readonly class: string; readonly sides: readonly string[] }[];
}

interface CompletenessFixture {
  readonly declares: {
    readonly description: string;
    readonly complete: boolean;
    readonly reasons: readonly { readonly tree: string | null; readonly code: string; readonly side?: string; readonly detail?: string }[];
    readonly totals: Readonly<Record<string, number>> | null;
    readonly trees?: Readonly<Record<string, DeclaredTree>>;
  };
  readonly inputs: {
    readonly candidate: { readonly commit: string };
    readonly base: {
      readonly commit: string | null;
      readonly rule: 'merge-base' | 'explicit';
      readonly target: string | null;
      readonly reason?: 'base-not-selected';
      readonly detail?: string;
    };
    readonly evaluatedAt: string;
    readonly captures: Readonly<Record<string, { readonly base: RawCapture; readonly candidate: RawCapture }>>;
    readonly lockfiles: Readonly<Record<string, { readonly base: Record<string, string>; readonly candidate: Record<string, string> }>>;
    readonly blobs: Readonly<Record<string, string | null>>;
  };
}

const FIXTURES = resolve(__dirname, '..', '..', 'fixtures', 'advisory-diff', 'completeness');

function fixture(name: string): CompletenessFixture {
  return JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8')) as CompletenessFixture;
}

/** A capture as the CLI hands it to compare: text, over the bound, or absent. */
function asInput(value: RawCapture) {
  if (value === null) return null;
  if ('raw' in value && typeof value['raw'] === 'string') return { text: value['raw'] };
  if ('overBound' in value) return { overBound: true as const };
  return { text: JSON.stringify(value) };
}

function lockfileOf(versions: Readonly<Record<string, string>>) {
  return {
    lockfileVersion: 3,
    packages: {
      '': {},
      ...Object.fromEntries(Object.entries(versions).map(([location, version]) => [location, { version }]))
    }
  };
}

function run(name: string, withoutLockfile?: { readonly tree: string; readonly side: 'base' | 'candidate' }) {
  const fx = fixture(name);
  const { inputs } = fx;
  const captures: Record<string, { base: ReturnType<typeof asInput>; candidate: ReturnType<typeof asInput> }> = {};
  const lockfiles: Record<string, { base: ReturnType<typeof lockfileOf> | null; candidate: ReturnType<typeof lockfileOf> | null }> = {};
  for (const tree of Object.keys(inputs.captures)) {
    const pair = inputs.captures[tree] as (typeof inputs.captures)[string] | undefined;
    const locks = inputs.lockfiles[tree] as (typeof inputs.lockfiles)[string] | undefined;
    captures[tree] = { base: asInput(pair?.base ?? null), candidate: asInput(pair?.candidate ?? null) };
    lockfiles[tree] = { base: lockfileOf(locks?.base ?? {}), candidate: lockfileOf(locks?.candidate ?? {}) };
    if (withoutLockfile?.tree === tree) lockfiles[tree] = { ...lockfiles[tree], [withoutLockfile.side]: null } as (typeof lockfiles)[string];
  }
  const result = compare.compareTrees({
    candidate: inputs.candidate,
    base: inputs.base,
    captures,
    lockfiles,
    evaluatedAt: inputs.evaluatedAt,
    blobAt: (commit, path) => inputs.blobs[`${commit}:${path}`] ?? null
  });
  return { fx, result };
}

/** Assert everything a fixture declares, and the invariants every result keeps. */
function expectDeclared(name: string) {
  const { fx, result } = run(name);
  const why = `${name}: ${fx.declares.description}`;
  expect(result.complete, why).toBe(fx.declares.complete);
  expect(
    result.reasons.map((r) => ({ tree: r.tree, code: r.code, side: r.side, detail: r.detail })),
    why
  ).toEqual(
    fx.declares.reasons.map((r) => ({ tree: r.tree, code: r.code, side: r.side, detail: r.detail }))
  );
  expect(result.totals, why).toEqual(fx.declares.totals);
  for (const [tree, declared] of Object.entries(fx.declares.trees ?? {})) {
    const found = result.trees.find((t) => t.tree === tree);
    expect(found?.complete, `${why} (${tree} complete)`).toBe(declared.complete);
    if (declared.totals !== undefined) expect(found?.totals, `${why} (${tree} totals)`).toEqual(declared.totals);
    if (declared.findings !== undefined) {
      expect(
        found?.findings.map((f) => ({ package: f.package, class: f.class, sides: f.sides })),
        `${why} (${tree} findings)`
      ).toEqual(declared.findings);
    }
  }
  for (const tree of result.trees) {
    if (tree.complete) {
      expect(tree.totals, `${why} (${tree.tree}: a complete tree has numeric totals)`).not.toBeNull();
      expect(tree.reasons, why).toEqual([]);
      continue;
    }
    expect(tree.totals, `${why} (${tree.tree}: an incomplete tree states no totals)`).toBeNull();
    expect(tree.reasons.length, why).toBeGreaterThan(0);
    for (const finding of tree.findings) {
      expect(finding.class, `${why} (${tree.tree})`).toBe('not-determined');
      expect(finding.sides?.length, `${why} (${tree.tree})`).toBeGreaterThan(0);
    }
  }
  return { fx, result };
}

/** Each of the thirteen reasons, with the fixtures that raise it and nothing else. */
const BY_CODE: Readonly<Record<string, readonly string[]>> = {
  'base-not-selected': ['base-not-selected'],
  'missing-baseline': ['missing-baseline'],
  'missing-candidate': ['missing-candidate'],
  'tree-missing': ['tree-missing'],
  mismatch: ['mismatch-tree', 'mismatch-commit', 'mismatch-manifest', 'mismatch-lockfile-one-byte'],
  'missing-provenance': ['missing-provenance'],
  malformed: ['malformed-not-json', 'malformed-wrong-shape'],
  'unsupported-format': ['unsupported-format', 'unsupported-format-rejected-capture'],
  'over-bound': ['over-bound-capture-file', 'over-bound-rejected-capture'],
  'audit-failure': ['audit-failure'],
  'not-comparable': ['not-comparable-tool-major', 'not-comparable-registry'],
  'observation-skew': ['observation-skew-61'],
  stale: ['stale-older-than-budget', 'stale-observed-after-evaluation']
};

describe('a complete comparison states its totals (the control)', () => {
  it('counts introduced and pre-existing findings for matching, fresh, paired captures', () => {
    const { result } = expectDeclared('good-complete');
    expect(result.complete).toBe(true);
    expect(result.totals?.['introduced']).toBe(1);
    expect(result.totals?.['pre-existing']).toBe(1);
  });
});

describe('each of the thirteen reasons gives an incomplete result and no zero (SC-003, R11)', () => {
  it('has a fixture for every reason in the closed set, and for no other', () => {
    expect(Object.keys(BY_CODE).sort()).toEqual([...model.COMPLETENESS_REASONS].sort());
    expect(model.COMPLETENESS_REASONS).toHaveLength(13);
  });

  for (const [code, names] of Object.entries(BY_CODE)) {
    for (const name of names) {
      it(`${code}: ${name} is incomplete, names exactly that code, and states totals of null`, () => {
        const { result } = expectDeclared(name);
        expect(result.complete).toBe(false);
        expect(result.totals).toBeNull();
        const codes = new Set(result.reasons.map((reason) => reason.code));
        expect([...codes]).toEqual([code]);
      });
    }
  }
});

describe('what an incomplete tree lists (K4, FR-016)', () => {
  it('lists the candidate findings as not determined when there is no base capture, never as introduced (US2-1)', () => {
    const { result } = expectDeclared('missing-baseline');
    const root = result.trees.find((tree) => tree.tree === 'root');
    expect(root?.findings.map((f) => f.class)).toEqual(['not-determined', 'not-determined']);
    expect(root?.findings.every((f) => f.sides?.join() === 'candidate')).toBe(true);
    expect(result.trees.flatMap((tree) => tree.findings).some((f) => f.class === 'introduced')).toBe(false);
  });

  it('names missing-candidate for the one tree that lacks it', () => {
    const { result } = expectDeclared('missing-candidate');
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatchObject({ tree: 'root', code: 'missing-candidate' });
  });

  it('keeps root complete and leaves webview-ui with no totals when only webview-ui is stale (US2-5)', () => {
    const { result } = expectDeclared('root-complete-webview-stale');
    const root = result.trees.at(0);
    const webview = result.trees.at(1);
    expect(result.complete).toBe(false);
    expect(root?.complete).toBe(true);
    expect(root?.totals).toMatchObject({ introduced: 1, 'pre-existing': 1 });
    expect(webview?.complete).toBe(false);
    expect(webview?.totals).toBeNull();
    expect(result.reasons).toEqual([
      { tree: 'webview-ui', code: 'stale', side: 'base', detail: 'older-than-budget' }
    ]);
  });
});

describe('a changed input turns a complete comparison into mismatch (SC-002)', () => {
  it('is complete before the change', () => {
    expect(run('good-complete').result.complete).toBe(true);
  });

  it('turns a changed base commit into mismatch, naming the commit', () => {
    const { result } = expectDeclared('mismatch-commit');
    expect(result.reasons).toEqual([{ tree: 'root', code: 'mismatch', side: 'base', detail: 'commit' }]);
  });

  it('turns a lockfile that differs by one byte into mismatch, naming the lockfile', () => {
    const { result } = expectDeclared('mismatch-lockfile-one-byte');
    expect(result.reasons).toEqual([{ tree: 'root', code: 'mismatch', side: 'base', detail: 'lockfile' }]);
  });

  it('names the manifest, and the tree, when those are what differ', () => {
    expect(expectDeclared('mismatch-manifest').result.reasons[0]).toMatchObject({ detail: 'manifest' });
    expect(expectDeclared('mismatch-tree').result.reasons[0]).toMatchObject({ detail: 'tree' });
  });
});

describe('pairing and freshness have exact edges (R9, FR-008)', () => {
  it('pairs captures exactly 60 minutes apart and refuses 61', () => {
    expect(expectDeclared('observation-skew-60-paired').result.complete).toBe(true);
    expect(expectDeclared('observation-skew-61').result.reasons).toEqual([
      { tree: 'root', code: 'observation-skew' }
    ]);
  });

  it('keeps a capture exactly 24 hours old fresh and refuses one 24 hours and 1 ms old', () => {
    expect(expectDeclared('stale-exactly-24h').result.complete).toBe(true);
    expect(expectDeclared('stale-older-than-budget').result.reasons).toEqual([
      { tree: 'root', code: 'stale', side: 'base', detail: 'older-than-budget' }
    ]);
  });

  it('refuses a capture observed after the evaluation time', () => {
    expect(expectDeclared('stale-observed-after-evaluation').result.reasons).toEqual([
      { tree: 'root', code: 'stale', side: 'candidate', detail: 'observed-after-evaluation' }
    ]);
  });

  it('names the differing field when two captures are not comparable', () => {
    expect(expectDeclared('not-comparable-tool-major').result.reasons[0]).toMatchObject({ detail: 'tool-major' });
    expect(expectDeclared('not-comparable-registry').result.reasons[0]).toMatchObject({ detail: 'registry-host' });
  });
});

describe('a lockfile that cannot be read leaves the tree incomplete, not classified on a guess', () => {
  it('names tree-missing for the side whose lockfile is absent, though both captures are good', () => {
    const { result } = run('good-complete', { tree: 'root', side: 'candidate' });
    expect(result.complete).toBe(false);
    expect(result.totals).toBeNull();
    expect(result.reasons).toEqual([{ tree: 'root', code: 'tree-missing', side: 'candidate', detail: undefined }]);
    expect(result.trees.find((tree) => tree.tree === 'root')?.totals).toBeNull();
  });
});

describe('a valid but empty report (edge case, FR-016)', () => {
  it('is reported as a real zero when the whole comparison is complete', () => {
    const { result } = expectDeclared('empty-report-complete');
    expect(result.complete).toBe(true);
    expect(result.totals).toEqual({
      introduced: 0,
      worsened: 0,
      uncertain: 0,
      'pre-existing': 0,
      resolved: 0,
      'not-determined': 0
    });
  });

  it('is not reported as the comparison total when another tree is incomplete', () => {
    const { result } = expectDeclared('empty-report-other-tree-incomplete');
    expect(result.complete).toBe(false);
    expect(result.totals).toBeNull();
    // The complete tree keeps its own zeros, stated for that tree only.
    expect(result.trees.find((tree) => tree.tree === 'root')?.totals).toMatchObject({ introduced: 0 });
    expect(result.trees.find((tree) => tree.tree === 'webview-ui')?.totals).toBeNull();
  });
});
