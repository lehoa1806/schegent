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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (relPath: string): string => readFileSync(resolve(REPO_ROOT, relPath), 'utf8');

/** The only dependency this feature is permitted to add, and why. */
const PERMITTED_ADDITIONS: ReadonlyMap<string, string> = new Map([
  [
    'axe-core',
    'FR-R3-091: the accessibility scan. Development-only, one package rather than two — ' +
      '@axe-core/playwright would be a second package for a wrapper around two lines. The ' +
      'active task names it, which is the constitution\'s stated condition for an install.'
  ]
]);

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
const SCANNER_SURFACES = [
  '.github/workflows/codeql.yml',
  '.github/workflows/dependency-review.yml',
  '.github/workflows/security-audit.yml'
] as const;

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

  it('the scanner workflows still exist and still run their credited checks', () => {
    // SUP-01 credits these; "keep the scanners" is a requirement, not an
    // assumption. A file deleted or a step renamed is what this catches.
    for (const surface of SCANNER_SURFACES) {
      const source = read(surface);
      expect(source.length, `${surface} must not be emptied`).toBeGreaterThan(200);
      expect(source, `${surface} must still declare a trigger`).toMatch(/^on:/m);
    }
    expect(read('.github/workflows/codeql.yml')).toMatch(/codeql-action/);
    expect(read('.github/workflows/dependency-review.yml')).toMatch(/dependency-review-action/);
    expect(read('.github/workflows/security-audit.yml')).toMatch(/npm audit|security:secrets/);
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
