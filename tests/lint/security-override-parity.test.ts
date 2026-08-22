// FR-R3-034 — a security pin applied to one workspace is applied to both.
//
// The root manifest pinned `nanoid` past GHSA-2v37-7h3g-55p8 with an
// `overrides` block. `webview-ui` did not, because npm workspaces do not
// inherit `overrides` from a sibling manifest and nothing in this repository
// noticed. The result was a High advisory in the second workspace and a
// scheduled security workflow that had been failing on it — a red gate that
// stays red, which is how a team learns to stop reading red.
//
// This gate does NOT run `npm audit`. That already exists in
// `security-audit.yml`, and running it was never what was missing — reading its
// result was. A test that queries the advisory registry needs a network and
// changes its verdict when the database updates, so `test:host` would start
// failing for reasons unrelated to the change under test.
//
// It compares manifests, because the invariant is a DECISION: "this package is
// pinned for a security reason". Decisions live in manifests. Comparing
// resolved trees would flag the legitimate version differences that two
// independently-resolved dependency graphs always have.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');

interface Manifest {
  readonly path: string;
  readonly overrides: Record<string, string>;
}

/**
 * Every manifest in this repository that can carry an `overrides` block.
 *
 * Derived rather than hardcoded to the two that exist today: a third workspace
 * is covered the moment it is added, which is the point at which nobody would
 * think to update a pinned list.
 */
function manifests(): Manifest[] {
  const candidates = ['package.json'];
  for (const entry of readdirSync(REPO_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const nested = `${entry.name}/package.json`;
    if (existsSync(resolve(REPO_ROOT, nested))) candidates.push(nested);
  }
  return candidates.map((path) => {
    const parsed = JSON.parse(readFileSync(resolve(REPO_ROOT, path), 'utf8')) as {
      overrides?: Record<string, string>;
    };
    return { path, overrides: parsed.overrides ?? {} };
  });
}

/**
 * Overrides that exist for a security reason, as opposed to a build shim.
 *
 * A build-shim override legitimately belongs to one workspace — pinning a
 * bundler's internal dependency to make a local build work is not a statement
 * about the other workspace. A security pin is, because the advisory does not
 * care which manifest reached the package.
 *
 * Enumerated, with the advisory each one answers. An entry here is a line in a
 * diff carrying a reason, which is what makes the distinction reviewable rather
 * than a judgement call made silently at the moment someone adds an override.
 */
const SECURITY_OVERRIDES: ReadonlyArray<{ package: string; advisory: string }> = [
  { package: 'nanoid', advisory: 'GHSA-2v37-7h3g-55p8 — indefinite loop in a custom-generator path' }
];

/**
 * Overrides that are deliberately one-sided, by manifest, with the reason.
 *
 * A build shim pinning a bundler's internal dependency to make one workspace's
 * build work is not a statement about the other workspace, and forcing it into
 * both would be wrong. Empty today.
 */
const BUILD_SHIM_OVERRIDES: Readonly<Record<string, ReadonlyArray<{ package: string; why: string }>>> =
  {};

describe('security overrides are applied to every workspace', () => {
  it('finds more than one manifest, so the comparison is not vacuous', () => {
    // A derived list that resolved to one entry would make every assertion
    // below trivially true.
    expect(
      manifests().map((m) => m.path).sort(),
      'expected at least two manifests to compare; a single-manifest result makes this gate vacuous'
    ).toContain('webview-ui/package.json');
  });

  for (const entry of SECURITY_OVERRIDES) {
    it(`pins ${entry.package} identically in every manifest`, () => {
      const all = manifests();
      const holding = all.filter((m) => entry.package in m.overrides);
      const missing = all.filter((m) => !(entry.package in m.overrides));

      expect(
        missing.map((m) => m.path),
        `\`${entry.package}\` is pinned in ${holding.map((m) => m.path).join(', ')} but not in ` +
          `${missing.map((m) => m.path).join(', ')}. npm workspaces do not inherit \`overrides\` ` +
          `from a sibling manifest, so a pin applied to one is not applied to the other — which is ` +
          `how ${entry.advisory} stayed open in a second workspace while the first reported clean. ` +
          `Add the same \`overrides\` entry to the manifest(s) above.`
      ).toEqual([]);

      const constraints = new Set(holding.map((m) => m.overrides[entry.package]));
      expect(
        [...constraints],
        `\`${entry.package}\` is pinned to different constraints across manifests: ` +
          `${holding.map((m) => `${m.path} => ${m.overrides[entry.package]}`).join(', ')}. ` +
          `Present-in-both is not the invariant; agreeing is, or one workspace resolves a version ` +
          `the other has ruled out.`
      ).toHaveLength(1);
    });
  }

  it('classifies every override in every manifest, one way or the other', () => {
    // Union, not intersection.
    //
    // An earlier version compared only overrides present in EVERY manifest
    // against the enumerated list. That is blind to the exact incident this gate
    // exists to prevent: a pin added to ONE manifest and never enumerated
    // evades the per-entry loop (it is not on the list) and the reverse check
    // (it is not in the intersection) simultaneously. The dangerous window is
    // the moment right after someone adds an override and forgets the sibling,
    // and that window was invisible.
    //
    // Every override key in any manifest must therefore be classified: a
    // security pin that must appear in both, or a build shim declared one-sided
    // with a reason. An unclassified override is reported, because an override
    // nobody classified is an override nobody compared.
    const listed = new Set(SECURITY_OVERRIDES.map((entry) => entry.package));
    const unclassified: string[] = [];
    for (const manifest of manifests()) {
      const shims = new Set(
        (BUILD_SHIM_OVERRIDES[manifest.path] ?? []).map((entry) => entry.package)
      );
      for (const name of Object.keys(manifest.overrides)) {
        if (listed.has(name) || shims.has(name)) continue;
        unclassified.push(`${manifest.path}: ${name}`);
      }
    }
    expect(
      unclassified,
      `An \`overrides\` entry is not classified:\n  ${unclassified.join('\n  ')}\n` +
        `Add it to SECURITY_OVERRIDES with its advisory — which makes this gate require it in ` +
        `every manifest — or to BUILD_SHIM_OVERRIDES for that manifest with the reason it is ` +
        `deliberately one-sided. Leaving it unclassified is how a pin gets applied to one ` +
        `workspace and forgotten in the other, which is the defect this gate was written for.`
    ).toEqual([]);
  });
});
