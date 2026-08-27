import { describe, expect, it } from 'vitest';
// @ts-expect-error -- .mjs build script, typed by use rather than by declaration
import { decideManifestVersions, checkManifestVersions } from '../../../scripts/check-manifest-versions.mjs';

/**
 * FR-R3-120 (FR-014) — `release:preflight` refuses a tree whose manifests disagree
 * about what it is, or whose `v*` tag disagrees with them.
 *
 * `RELEASE.md` said it plainly: "Nothing mechanically checks the tag against the
 * manifest any more" — the check lived in the tag job FR-R3-099 retired. These are
 * the six obligations in
 * `specs/158-round-3-coda/contracts/manifest-agreement.md`.
 */
const site = (label: string, version: string | undefined) => ({ label, version });

describe('manifest/tag agreement (FR-R3-120)', () => {
  it('1. four agreeing manifests and no tag pass', () => {
    const result = decideManifestVersions({
      sites: [site('package.json', '1.2.3'), site('package-lock.json', '1.2.3')],
      tags: []
    });
    expect(result.ok).toBe(true);
    expect(result.version).toBe('1.2.3');
    expect(result.tagged).toBeNull();
  });

  it('2. one manifest bumped out of step refuses, naming it and both values', () => {
    const result = decideManifestVersions({
      sites: [
        site('package.json', '1.2.3'),
        site('package-lock.json', '1.2.3'),
        site('webview-ui/package.json', '1.2.4')
      ],
      tags: []
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('manifests disagree');
    expect(result.detail).toContain('1.2.3');
    expect(result.detail).toContain('1.2.4');
  });

  it('3. a tag disagreeing with agreed manifests refuses, naming both', () => {
    const result = decideManifestVersions({
      sites: [site('package.json', '1.2.3'), site('package-lock.json', '1.2.3')],
      tags: ['v0.9.9']
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('tag disagrees with manifests');
    expect(result.detail).toContain('0.9.9');
    expect(result.detail).toContain('1.2.3');
  });

  it('4. a matching tag passes and is reported', () => {
    const result = decideManifestVersions({
      sites: [site('package.json', '1.2.3'), site('package-lock.json', '1.2.3')],
      tags: ['v1.2.3']
    });
    expect(result.ok).toBe(true);
    expect(result.tagged).toBe('v1.2.3');
  });

  it('5. two disagreeing v* tags on HEAD refuse as ambiguous, rather than picking one', () => {
    // A release must not choose. Picking the first would make the outcome depend on
    // git's tag ordering, which is not a decision anybody made.
    const result = decideManifestVersions({
      sites: [site('package.json', '1.2.3'), site('package-lock.json', '1.2.3')],
      tags: ['v1.2.3', 'v2.0.0']
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ambiguous tags');
    expect(result.detail).toContain('2');
  });

  it('5a. the same v* tag listed twice is not ambiguous', () => {
    const result = decideManifestVersions({
      sites: [site('package.json', '1.2.3')],
      tags: ['v1.2.3', 'v1.2.3']
    });
    expect(result.ok).toBe(true);
  });

  it('6. it reports ALL disagreeing sites, not the first', () => {
    // Four files, and a partial fix is a second failed release.
    const result = decideManifestVersions({
      sites: [
        site('a', '1.0.0'),
        site('b', '1.0.1'),
        site('c', '1.0.2'),
        site('d', '1.0.3')
      ],
      tags: []
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(4);
    for (const label of ['a', 'b', 'c', 'd']) {
      expect(result.problems.some((p: string) => p.startsWith(`${label}:`))).toBe(true);
    }
  });

  it('refuses a site whose version cannot be read, rather than ignoring it', () => {
    const result = decideManifestVersions({
      sites: [site('package.json', '1.2.3'), site('package-lock.json', undefined)],
      tags: []
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('no version found');
  });

  it('the real tree agrees with itself', () => {
    // The non-vacuity control: if the decision function were wired to inputs it
    // never receives, every case above could pass while the shipped check did not.
    const result = checkManifestVersions();
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });
});
