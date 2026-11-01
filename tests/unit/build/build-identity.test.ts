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
