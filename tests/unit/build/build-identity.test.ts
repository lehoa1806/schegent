import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * FR-R4-F09 (FR-032, SC-010; contract BI1, test T1) — the build-time read of the build identity.
 *
 * WHAT IT PINS. `readBuildIdentity({ readTreeState, env })` is the one place the commit, the dirty
 * flag and the mode of a build are decided before they are stamped into the bundle and copied into
 * the module graphs and the release record. The properties worth a test are the refusals: a
 * commit that git cannot name, or that is not a full 40-character lowercase hex id, is `unknown`
 * and is never truncated, because an abbreviated id in a record reads as an identity and is not
 * one; and `dirty` is `unknown` exactly when the commit is, so no record can say "clean" about a
 * tree it could not read.
 *
 * Both git and the environment are injected. Nothing here runs git, so the cases are the same on a
 * machine with no checkout. Loaded dynamically for the same TS1479 reason its siblings record.
 */
async function loadIdentity() {
  return import('../../../scripts/build-identity.mjs');
}

const HEAD = 'a'.repeat(40);
const clean = () => ({ head: HEAD, treeClean: true });

describe('readBuildIdentity', () => {
  it('reads a clean tree as commit, dirty false, development', async () => {
    const { readBuildIdentity } = await loadIdentity();
    expect(readBuildIdentity({ readTreeState: clean, env: {} })).toEqual({
      commit: HEAD,
      dirty: false,
      mode: 'development'
    });
  });

  it('reads a tree with uncommitted changes as dirty true', async () => {
    const { readBuildIdentity } = await loadIdentity();
    const identity = readBuildIdentity({
      readTreeState: () => ({ head: HEAD, treeClean: false }),
      env: {}
    });
    expect(identity).toEqual({ commit: HEAD, dirty: true, mode: 'development' });
  });

  it('gives unknown for the commit and the dirty flag when git throws', async () => {
    const { readBuildIdentity } = await loadIdentity();
    const identity = readBuildIdentity({
      readTreeState: () => {
        throw new Error('not a git repository');
      },
      env: {}
    });
    expect(identity).toEqual({ commit: 'unknown', dirty: 'unknown', mode: 'development' });
  });

  it.each([
    ['a 7-character abbreviation', 'abcdef0'],
    ['an uppercase 40-hex id', 'A'.repeat(40)],
    ['a 41-character id', 'a'.repeat(41)],
    ['an empty string', ''],
    ['text that is not hex', 'z'.repeat(40)]
  ])('gives unknown when HEAD is %s, and never truncates or lowercases it', async (_name, head) => {
    const { readBuildIdentity } = await loadIdentity();
    const identity = readBuildIdentity({
      readTreeState: () => ({ head, treeClean: true }),
      env: {}
    });
    expect(identity.commit).toBe('unknown');
    expect(identity.dirty).toBe('unknown');
  });

  it('keeps dirty unknown exactly when the commit is unknown', async () => {
    const { readBuildIdentity } = await loadIdentity();
    for (const treeClean of [true, false]) {
      const unknownCommit = readBuildIdentity({
        readTreeState: () => ({ head: 'nope', treeClean }),
        env: {}
      });
      expect(unknownCommit.dirty).toBe('unknown');
      const knownCommit = readBuildIdentity({
        readTreeState: () => ({ head: HEAD, treeClean }),
        env: {}
      });
      expect(knownCommit.dirty).toBe(!treeClean);
    }
  });

  it('chooses production exactly when NODE_ENV is the string production', async () => {
    const { readBuildIdentity } = await loadIdentity();
    const modeOf = (env: Record<string, string | undefined>) =>
      readBuildIdentity({ readTreeState: clean, env }).mode;
    expect(modeOf({ NODE_ENV: 'production' })).toBe('production');
    expect(modeOf({ NODE_ENV: 'development' })).toBe('development');
    expect(modeOf({ NODE_ENV: 'Production' })).toBe('development');
    expect(modeOf({ NODE_ENV: 'prod' })).toBe('development');
    expect(modeOf({ NODE_ENV: '' })).toBe('development');
    expect(modeOf({})).toBe('development');
  });

  it('still reports the mode when the commit is unknown', async () => {
    const { readBuildIdentity } = await loadIdentity();
    const identity = readBuildIdentity({
      readTreeState: () => {
        throw new Error('git is not installed');
      },
      env: { NODE_ENV: 'production' }
    });
    expect(identity).toEqual({ commit: 'unknown', dirty: 'unknown', mode: 'production' });
  });

  it('emits its fields in the order the module graph and the SBOM write them', async () => {
    const { readBuildIdentity } = await loadIdentity();
    const identity = readBuildIdentity({ readTreeState: clean, env: {} });
    expect(Object.keys(identity)).toEqual(['commit', 'dirty', 'mode']);
  });
});

/**
 * The host bundle reads the mode a second time.
 *
 * `readBuildIdentity` decides the mode that is stamped into the bundle, the module graphs, the SBOM
 * and the release record, and the cases above pin that decision. The build configuration decides,
 * by its own comparison, whether the host bundle is minified and keeps its source map. If the two
 * disagree, a record names `production` for a bundle that was not minified, or the reverse.
 * RELEASE.md and the system-config reference state the outcome: no repository script sets
 * `NODE_ENV`, so the host bundle is not minified. These cases tie the three together by reading the
 * configuration's own text and the package scripts, because the configuration runs a build when
 * imported and cannot be loaded as a unit. The modules under the scripts directory are not scanned
 * for an assignment.
 */
describe('the host bundle reads the same mode', () => {
  const readFromRoot = (name: string) => readFileSync(resolve(__dirname, '..', '..', '..', name), 'utf8');
  const MODE_COMPARISON = /^const isProduction = process\.env\.NODE_ENV === 'production';$/m;
  const MINIFY_OPTION = /^\s*minify: isProduction,$/m;
  const SOURCEMAP_OPTION = /^\s*sourcemap: !isProduction,$/m;

  it('compares NODE_ENV with the string production, the comparison the identity makes', () => {
    expect(readFromRoot('esbuild.config.mjs')).toMatch(MODE_COMPARISON);
  });

  it('minifies the host bundle and drops its source map exactly when that comparison holds', () => {
    const config = readFromRoot('esbuild.config.mjs');
    expect(config).toMatch(MINIFY_OPTION);
    expect(config).toMatch(SOURCEMAP_OPTION);
  });

  it('is not given production by any package script, so the documented default holds', () => {
    const parsed: unknown = JSON.parse(readFromRoot('package.json'));
    const scripts = (parsed as { scripts: Record<string, string> }).scripts;
    expect(Object.keys(scripts)).toContain('build:host');
    const naming = Object.entries(scripts)
      .filter(([, command]) => command.includes('NODE_ENV'))
      .map(([name]) => name);
    expect(naming).toEqual([]);
  });

  it('NON-VACUITY: a different comparison, a forced minify and a forced source map are each detected', () => {
    expect("const isProduction = process.env.NODE_ENV !== 'development';").not.toMatch(MODE_COMPARISON);
    expect("const isProduction = process.env.NODE_ENV == 'production';").not.toMatch(MODE_COMPARISON);
    expect('  minify: true,').not.toMatch(MINIFY_OPTION);
    expect('  sourcemap: true,').not.toMatch(SOURCEMAP_OPTION);
    expect('  sourcemap: isProduction,').not.toMatch(SOURCEMAP_OPTION);
  });
});
