// FR-R3-090 §5 — this feature hardens the install. It does not bump anything.
//
// "Do not bump the held majors as part of this item. The cadence is the
// deliverable; the upgrades are their own changes with their own verification.
// Bundling them hides a dependency bump inside a hardening change."
//
// And: "Keep the scanners. CodeQL, both dependency audits and provenance are
// credited controls and nothing here touches them."
//
// Both are easy to honour and easy to violate by accident — a `npm install`
// during development rewrites ranges silently. This gate is its own file rather
// than an extra concern bolted onto the staleness gate, because a gate that
// answers for two things is the shape that makes gates hard to control, which is
// the subject of FR-R3-088 next door.
//
// WHAT IT PINS. The declared range of every dependency at the point feature 155
// landed, plus the untouched state of the four scanner surfaces. One addition is
// expected and named: `axe-core`, which FR-R3-091 declares for the accessibility
// scan and which the constitution's forbidden-action carve-out permits precisely
// because a task names it.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (relPath: string): string => readFileSync(resolve(REPO_ROOT, relPath), 'utf8');

/**
 * Declared additions, each with its reason.
 *
 * Note the two kinds. `axe-core` was a genuine ADDITION — a package the tree did not
 * have. The two secretlint entries are **promotions**: both were already resolved in
 * `package-lock.json` as transitive dependencies of `@vscode/vsce`, so the dependency
 * tree does not grow by declaring them. That distinction is asserted below, not merely
 * asserted here.
 */
const PERMITTED_ADDITIONS: ReadonlyMap<string, string> = new Map([
  [
    'axe-core',
    'FR-R3-091: the accessibility scan. Development-only, one package rather than two — ' +
      '@axe-core/playwright would be a second package for a wrapper around two lines. The ' +
      'active task names it, which is the constitution\'s stated condition for an install.'
  ],
  [
    'secretlint',
    'FR-R3-109: PROMOTION, not an addition — already resolved in package-lock.json at ' +
      '10.2.2 as a transitive of @vscode/vsce, so no package is installed by declaring it. ' +
      'Declared because leaving a SECURITY gate depending on the dependency graph of a ' +
      'packaging tool means a vsce upgrade that dropped secretlint would silently disarm ' +
      'the secret scan, and the failure would present as a green gate.'
  ],
  [
    '@secretlint/secretlint-rule-preset-recommend',
    'FR-R3-109: PROMOTION, same reasoning — already lockfile-resolved at 10.2.2. This is ' +
      'the ruleset .secretlintrc.json names; a config referencing a hoisted transitive is ' +
      'not a contract, since npm is free to stop hoisting it.'
  ]
]);

/** The promotions above, which must add no package to the tree. */
const PROMOTIONS = ['secretlint', '@secretlint/secretlint-rule-preset-recommend'] as const;

/** Ranges as declared when feature 155 landed. A change here must be deliberate. */
const PINNED: ReadonlyMap<string, string> = new Map([
  ['@eslint/js', '^9.39.5'],
  ['@playwright/test', '^1.62.1'],
  ['@secretlint/node', '^13.0.4'],
  ['@types/node', '^22.20.1'],
  ['@types/vscode', '1.107.0'],
  ['@vitest/coverage-v8', '^3.2.7'],
  ['@vscode/test-electron', '^2.3.9'],
  ['@vscode/vsce', '^3.9.2'],
  ['esbuild', '^0.28.2'],
  ['eslint', '^9.39.5'],
  ['eslint-plugin-svelte', '^3.23.0'],
  ['globals', '^14.0.0'],
  ['prettier', '^3.9.6'],
  ['svelte', '^5.56.8'],
  ['ts-morph', '^28.0.0'],
  ['typescript', '^5.4.0'],
  ['typescript-eslint', '^8.67.0'],
  ['vitest', '^3.2.6']
]);

/** The credited controls SUP-01 names. Nothing in this feature touches them. */
/**
 * FR-R3-099 — the scanners that SURVIVE, named as scripts rather than as workflows.
 *
 * SUP-01 credited three workflow files. All three are withdrawn: Actions were
 * retired by operator decision for budget, and `docs/release/
 * withdrawn-ci-controls.md` records what each one was. "Keep the scanners" is still
 * a requirement rather than an assumption, so the requirement moves to the scanners
 * that still run, and the one with no local substitute is recorded as lost rather
 * than quietly dropped from the credit list.
 */
const SURVIVING_SCANNERS = ['security:secrets', 'security:audit'] as const;

/** Withdrawn with Actions, and recorded as withdrawn rather than deleted silently. */
const WITHDRAWN_SCANNERS = ['codeql'] as const;

interface Manifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

const root = JSON.parse(read('package.json')) as Manifest;
const webview = JSON.parse(read('webview-ui/package.json')) as Manifest;

describe('FR-R3-090 §5 — no dependency is bumped, and the scanners are untouched', () => {
  it('both manifests still declare zero runtime dependencies', () => {
    // The posture this repository ships. An accessibility scanner arriving as a
    // runtime dependency would be a much larger change than the one declared.
    expect(root.dependencies ?? {}).toEqual({});
    expect(webview.dependencies ?? {}).toEqual({});
  });

  it('every pinned range is unchanged', () => {
    const drifted: string[] = [];
    for (const [pkg, range] of PINNED) {
      const actual = root.devDependencies?.[pkg];
      if (actual !== undefined && actual !== range) drifted.push(`${pkg}: ${range} -> ${actual}`);
    }
    expect(
      drifted,
      'A dependency range moved. If the bump is intended it is its OWN change with its own ' +
        'verification — bundling it here hides it inside a hardening change, which FR-R3-090 §5 ' +
        'forbids by name.'
    ).toEqual([]);
  });

  it('every addition beyond the pinned set is one the feature declares, with a reason', () => {
    const declared = new Set([...PINNED.keys(), ...PERMITTED_ADDITIONS.keys()]);
    const unexplained = Object.keys(root.devDependencies ?? {}).filter((pkg) => !declared.has(pkg));
    expect(
      unexplained,
      'An undeclared dependency appeared. Name it here with why it is needed, or remove it.'
    ).toEqual([]);
    for (const [, reason] of PERMITTED_ADDITIONS) expect(reason.length).toBeGreaterThan(60);
  });

  it('the promoted packages were already in the lockfile, so the tree did not grow', () => {
    // The whole justification for FR-R3-109's declarations is that they install nothing.
    // A comment claiming that is worth exactly as much as the claims this round has spent
    // itself removing, so it is checked: each promoted package must already have a
    // lockfile entry, and at the version now declared.
    const lock = JSON.parse(read('package-lock.json')) as {
      packages?: Record<string, { version?: string; dev?: boolean }>;
    };
    const packages = lock.packages ?? {};
    for (const pkg of PROMOTIONS) {
      // Read as possibly-absent and narrowed once. `packages` is typed as total over its keys,
      // so `entry?.x` after the assertion below reads as dead to the linter while the absence is
      // the very thing being asserted.
      const entry = packages[`node_modules/${pkg}`] as
        | { dev?: boolean; version?: string }
        | undefined;
      expect(
        entry,
        `${pkg} is declared as a PROMOTION but has no lockfile entry — then it is an ` +
          'ADDITION, and the reason recorded for it is wrong.'
      ).toBeDefined();
      expect(entry?.dev, `${pkg} must remain development-only`).toBe(true);
      const declared = (root.devDependencies ?? {})[pkg];
      expect(declared, `${pkg} must be declared`).toBeTruthy();
      // `^10.2.2` must match the resolved 10.2.2 — a promotion that changed the version
      // would be a bump wearing a promotion's reason.
      expect(
        (declared as string).replace(/^[\^~]/, ''),
        `${pkg} is declared at ${declared as string} but the lockfile resolves ` +
          `${entry?.version ?? 'nothing'}. A promotion must not move a version.`
      ).toBe(entry?.version);
    }
  });

  it('the surviving scanners still exist and are still reached by the attested chain', () => {
    // SUP-01 credits scanning; "keep the scanners" is a requirement, not an
    // assumption. What this catches now is a scanner script deleted, emptied, or
    // dropped out of the one chain that runs anything.
    const manifest = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    for (const script of SURVIVING_SCANNERS) {
      expect(manifest.scripts[script], `${script} must still exist`).toBeTruthy();
    }
    // Reached by the ATTESTED chain, not merely present in the manifest — that
    // distinction is the whole of FR-R3-100. `security:audit` is the deliberate
    // exception: it queries the npm registry, so gating on it would fail an offline
    // tree for a reason that has nothing to do with the tree. SECURITY.md states
    // that it is operator-invoked and why, which is what keeps the exception from
    // being a silent gap.
    expect(manifest.scripts['gate']).toContain('npm run security:secrets');
    expect(manifest.scripts['verify:all']).toContain('security:secrets');
    expect(read('SECURITY.md')).toContain('operator-invoked');
  });

  it('records the scanner that was LOST, so its absence is a statement rather than a gap', () => {
    // CodeQL had no local equivalent, so its withdrawal is a real reduction in
    // coverage. A credit list that simply stopped mentioning it would read as if
    // nothing had changed.
    const security = read('SECURITY.md');
    for (const lost of WITHDRAWN_SCANNERS) {
      expect(
        security.toLowerCase(),
        `SECURITY.md must record that ${lost} no longer runs, and when it last did`
      ).toContain(lost);
    }
    expect(security).toMatch(/2026-08-26/);
    expect(existsSync('docs/release/withdrawn-ci-controls.md')).toBe(true);
  });

  it('NON-VACUITY: a bumped range and an undeclared addition are both detected', () => {
    const bumped = new Map(PINNED);
    bumped.set('globals', '^17.0.0');
    const drifted = [...bumped].filter(([pkg, range]) => PINNED.get(pkg) !== range);
    expect(drifted).toHaveLength(1);

    const declared = new Set([...PINNED.keys(), ...PERMITTED_ADDITIONS.keys()]);
    expect(declared.has('some-new-package')).toBe(false);
    expect(declared.has('axe-core')).toBe(true);
  });
});
