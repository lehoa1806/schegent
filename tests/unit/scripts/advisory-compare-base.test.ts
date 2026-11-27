import { beforeAll, describe, expect, it } from 'vitest';

/**
 * FR-R4-F21 (feature 249; FR-005, K1) — which commit is the base.
 *
 * `selectBase` is pure over a git seam, so these cases run over a fake that records every argument
 * list it is given. This pins contract T3: the default is the merge-base with the target branch, an
 * explicit `--base` is taken as given, every way of finding no base gives `base-not-selected` with
 * its detail and no commit, and no ref other than `refs/heads/<target>` is ever asked for: there is
 * no fallback to a remote-tracking ref or another branch, because choosing one silently is the
 * arbitrary base the feature exists to refuse.
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

const CANDIDATE = 'c'.repeat(40);
const MERGE_BASE = 'a'.repeat(40);
const OTHER_BASE = 'b'.repeat(40);
const EXPLICIT = 'd'.repeat(40);

type Answer = string | null;

interface GitScript {
  readonly checkRefFormat?: Answer;
  readonly targetResolves?: Answer;
  readonly mergeBase?: Answer;
  readonly explicit?: Answer;
}

/** A fake git that answers by subcommand and records every argument list it is given. */
function fakeGit(script: GitScript = {}) {
  const calls: (readonly string[])[] = [];
  const git = (args: readonly string[]): string | null => {
    calls.push([...args]);
    switch (args[0]) {
      case 'check-ref-format':
        return script.checkRefFormat === undefined ? (args[2] ?? null) : script.checkRefFormat;
      case 'merge-base':
        return script.mergeBase === undefined ? MERGE_BASE : script.mergeBase;
      case 'rev-parse': {
        const rev = args[args.length - 1] ?? '';
        if (rev.startsWith('refs/heads/')) {
          return script.targetResolves === undefined ? CANDIDATE : script.targetResolves;
        }
        return script.explicit === undefined ? EXPLICIT : script.explicit;
      }
      default:
        return null;
    }
  };
  return { git, calls };
}

describe('selectBase: the default is the merge-base with the target branch (T3)', () => {
  it('returns the single merge-base of the candidate and refs/heads/develop', () => {
    const { git, calls } = fakeGit();
    const base = compare.selectBase({ candidate: CANDIDATE, target: 'develop' }, git);
    expect(base).toEqual({ commit: MERGE_BASE, rule: 'merge-base', target: 'develop' });
    expect(calls).toContainEqual(['merge-base', '--all', CANDIDATE, 'refs/heads/develop']);
  });

  it('uses develop when no target is given', () => {
    const { git, calls } = fakeGit();
    const base = compare.selectBase({ candidate: CANDIDATE }, git);
    expect(base.target).toBe('develop');
    expect(calls).toContainEqual(['merge-base', '--all', CANDIDATE, 'refs/heads/develop']);
  });

  it('takes an explicit --base as given, with no target', () => {
    const { git } = fakeGit();
    const base = compare.selectBase({ candidate: CANDIDATE, base: 'v1.0' }, git);
    expect(base).toEqual({ commit: EXPLICIT, rule: 'explicit', target: null });
  });
});

describe('selectBase: every way of finding no base is base-not-selected, with its detail (K1)', () => {
  it('gives target-missing when refs/heads/<target> does not exist, and asks nothing further', () => {
    const { git, calls } = fakeGit({ targetResolves: null });
    const base = compare.selectBase({ candidate: CANDIDATE, target: 'develop' }, git);
    expect(base).toEqual({
      commit: null,
      rule: 'merge-base',
      target: 'develop',
      reason: 'base-not-selected',
      detail: 'target-missing'
    });
    expect(calls.map((c) => c[0])).not.toContain('merge-base');
  });

  it('gives no-merge-base when the histories share no commit', () => {
    const { git } = fakeGit({ mergeBase: null });
    const base = compare.selectBase({ candidate: CANDIDATE, target: 'develop' }, git);
    expect(base).toMatchObject({ commit: null, reason: 'base-not-selected', detail: 'no-merge-base' });
    const empty = compare.selectBase({ candidate: CANDIDATE, target: 'develop' }, fakeGit({ mergeBase: '' }).git);
    expect(empty).toMatchObject({ commit: null, detail: 'no-merge-base' });
  });

  it('gives several-merge-bases when git returns more than one, and picks none of them', () => {
    const { git } = fakeGit({ mergeBase: `${MERGE_BASE}\n${OTHER_BASE}` });
    const base = compare.selectBase({ candidate: CANDIDATE, target: 'develop' }, git);
    expect(base).toMatchObject({
      commit: null,
      reason: 'base-not-selected',
      detail: 'several-merge-bases'
    });
  });

  it('gives base-unresolved when an explicit --base does not resolve', () => {
    const { git } = fakeGit({ explicit: null });
    const base = compare.selectBase({ candidate: CANDIDATE, base: 'no-such-rev' }, git);
    expect(base).toEqual({
      commit: null,
      rule: 'explicit',
      target: null,
      reason: 'base-not-selected',
      detail: 'base-unresolved'
    });
  });
});

describe('selectBase: there is no fallback to another ref (edge case)', () => {
  it('asks only for refs/heads/<target>, whatever the outcome', () => {
    for (const script of [{}, { targetResolves: null }, { mergeBase: null }, { mergeBase: `${MERGE_BASE}\n${OTHER_BASE}` }]) {
      const { git, calls } = fakeGit(script);
      compare.selectBase({ candidate: CANDIDATE, target: 'release' }, git);
      const refs = calls
        .flat()
        .filter((arg) => arg.includes('release') || arg.startsWith('refs/') || arg.includes('origin'));
      for (const ref of refs) {
        expect(
          ref === 'release' || ref === 'refs/heads/release' || ref === 'refs/heads/release^{commit}',
          `unexpected ref ${ref}`
        ).toBe(true);
      }
      expect(calls.flat().join(' ')).not.toMatch(/origin|remotes|refs\/tags/);
    }
  });

  it('never falls back to a remote-tracking branch when the local target is missing', () => {
    const { git, calls } = fakeGit({ targetResolves: null });
    const base = compare.selectBase({ candidate: CANDIDATE, target: 'develop' }, git);
    expect(base.commit).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls.flat().join(' ')).not.toContain('origin');
  });
});

describe('selectBase: operator input is refused before it can be read as an option (R8)', () => {
  it('refuses a target that git check-ref-format rejects, before any ref is looked up', () => {
    const { git, calls } = fakeGit({ checkRefFormat: null });
    expect(() => compare.selectBase({ candidate: CANDIDATE, target: 'bad..name' }, git)).toThrow(
      /target/i
    );
    expect(calls.map((c) => c[0])).toEqual(['check-ref-format']);
  });

  it('refuses a target that git rewrites, such as @{-1}, rather than following it', () => {
    const { git, calls } = fakeGit({ checkRefFormat: 'previous-branch' });
    expect(() => compare.selectBase({ candidate: CANDIDATE, target: '@{-1}' }, git)).toThrow(/target/i);
    expect(calls.map((c) => c[0])).toEqual(['check-ref-format']);
  });

  it('refuses a target beginning with a dash without calling git at all', () => {
    const { git, calls } = fakeGit();
    expect(() => compare.selectBase({ candidate: CANDIDATE, target: '--upload-pack=x' }, git)).toThrow(
      /target/i
    );
    expect(calls).toEqual([]);
  });

  it('refuses a candidate beginning with a dash without calling git at all', () => {
    const { git, calls } = fakeGit();
    expect(() => compare.selectBase({ candidate: '--output=x' }, git)).toThrow();
    expect(calls).toEqual([]);
  });

  it('gives base-unresolved for an explicit --base beginning with a dash, without calling git', () => {
    const { git, calls } = fakeGit();
    const base = compare.selectBase({ candidate: CANDIDATE, base: '--exec=x' }, git);
    expect(base).toMatchObject({ commit: null, reason: 'base-not-selected', detail: 'base-unresolved' });
    expect(calls).toEqual([]);
  });

  it('passes an explicit --base to git after --end-of-options', () => {
    const { git, calls } = fakeGit();
    compare.selectBase({ candidate: CANDIDATE, base: 'v1.0' }, git);
    expect(calls).toContainEqual(['rev-parse', '--verify', '--end-of-options', 'v1.0^{commit}']);
  });

  it('refuses a --target given together with --base: the two are mutually exclusive', () => {
    const { git, calls } = fakeGit();
    expect(() => compare.selectBase({ candidate: CANDIDATE, target: 'develop', base: 'v1.0' }, git)).toThrow();
    expect(calls).toEqual([]);
  });
});
