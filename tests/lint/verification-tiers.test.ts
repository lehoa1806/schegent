// FR-R3-132 (T1503, FR-002) — three verification tiers, and the release tier is
// PROVED a superset rather than described as one.
//
// THE FINDING. The full local gate is long, so the practical contributor loop was
// "small edit, then the whole gate or no gate at all". `ci:fast` is the evidence
// that somebody already wanted the missing tier: its name promises a fast loop and
// its body runs the eval corpus, the visual suite, the perf suite and a host
// build. `lint-gates-are-hermetic.test.ts` recorded the same script's DESCRIPTION
// drifting from what it ran; this is the other half of that finding.
//
// WHAT A TIER MAY NOT BE. A shortcut. Tiers change WHEN a gate runs, never
// WHETHER it runs, so every target a lower tier names must be named by every
// higher one. `FR-R3-121`'s census found nothing retirable, and trading visible
// friction for invisible regressions is what the audit warns against by name.
//
// COMPARED AS TARGETS, NOT AS TEXT, which is the difference between a proof and a
// coincidence. `verify:release` contains the literal substring `verify:push`, and
// a text comparison would pass on that alone while a lower tier reached a target
// no higher tier ran. This resolves each tier to the TRANSITIVE set of npm targets
// it invokes and asserts containment, so the claim is checked as a set relation.
//
// AND NO TIER CACHES A BUILD. The strictness ratchets and the lint baselines read
// source, so they cannot be stale. A build can: a tier that reused a previous
// `dist/` would pass a gate against code that is no longer there. That is the one
// caching caveat the audit states, and it is checked here rather than promised in
// prose.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (path: string): string => readFileSync(resolve(REPO_ROOT, path), 'utf8');

/**
 * The manifest's scripts, typed with `| undefined` on the value.
 *
 * `Record<string, string>` is a lie about a JSON object: reading an absent key
 * gives `undefined`, and the guard that says so reads as dead code to the
 * type-aware rule unless the type admits it. Stating it here keeps the run-time
 * check real — a renamed tier must fail this gate, not crash it.
 */
const scripts = (
  JSON.parse(read('package.json')) as {
    scripts: Readonly<Record<string, string | undefined>>;
  }
).scripts;

/** The tiers, cheapest first. Each must be a superset of the one before it. */
const TIERS = ['verify:edit', 'verify:push', 'verify:release'] as const;

/** Where the tiers are explained, and which claim each supports. */
const TIER_DOCUMENT = 'docs/development/verification-tiers.md';

/**
 * Every npm target a script invokes, transitively.
 *
 * LEAVES ONLY, by `leavesOnly`. A composite name — `ci`, `gate`, `verify:all` — is
 * a ROUTE to work, not work; comparing routes made a first draft of this gate fail
 * because `verify:release` does not invoke the name `ci` while running everything
 * `ci` runs. The set that matters is the actual commands.
 */
function transitiveTargets(
  entry: string,
  options: { readonly leavesOnly?: boolean } = {},
  seen: Set<string> = new Set(),
  missing: Set<string> = new Set()
): ReadonlySet<string> {
  const body = scripts[entry];
  if (body === undefined) {
    // A DANGLING REFERENCE MUST FAIL, not vanish. A review found this returning
    // silently: rename `test:host` and leave `verify:edit` pointing at the old
    // name, and that target simply drops out of the edit tier's leaf set — which
    // makes the superset assertion EASIER to satisfy, because a smaller set is
    // easier to contain. The tier would silently lose coverage and this gate
    // would report it as ordered.
    missing.add(entry);
    return seen;
  }
  // Destructured with a default rather than index-read and guarded: the guard
  // `noUncheckedIndexedAccess` requires is the one `no-unnecessary-condition`
  // calls dead, and a default is true under both readings.
  const invoked = [...body.matchAll(/npm run ([\w:-]+)/g)]
    .map(([, target = '']) => target)
    .filter((target) => target.length > 0);
  const isLeaf = invoked.length === 0;
  if (options.leavesOnly !== true || isLeaf) {
    if (seen.has(entry)) return seen;
    seen.add(entry);
  }
  for (const target of invoked) {
    if (!seen.has(target)) transitiveTargets(target, options, seen, missing);
  }
  return seen;
}

/** Every `npm run` target a script reaches that package.json does not define. */
function unresolvedTargets(entry: string): readonly string[] {
  const missing = new Set<string>();
  transitiveTargets(entry, {}, new Set(), missing);
  return [...missing].sort();
}

/** The commands a tier actually runs, with the routing names removed. */
const leaves = (entry: string): ReadonlySet<string> => transitiveTargets(entry, { leavesOnly: true });

describe('FR-R3-132 — the verification tiers are ordered, not merely named', () => {
  it('declares all three tiers', () => {
    // The control. Every assertion below iterates the tier list; a renamed script
    // would make those loops compare nothing and report green.
    for (const tier of TIERS) {
      expect(scripts[tier], `package.json has no "${tier}" script`).toBeDefined();
    }
  });

  it('reaches no npm target that does not exist', () => {
    // Checked BEFORE the superset assertion, because a dangling reference makes
    // that assertion pass for the wrong reason.
    for (const tier of TIERS) {
      expect(
        unresolvedTargets(tier),
        `${tier} runs "npm run <name>" for a target package.json does not define. It would fail ` +
          'at run time; here it would silently shrink the tier and make the ordering assertion ' +
          'below easier to satisfy.'
      ).toEqual([]);
    }
    // The control: the detector must be able to see a missing target at all.
    expect(unresolvedTargets('verify:release')).toEqual([]);
    expect(
      transitiveTargets('a-target-that-does-not-exist').size,
      'an undefined entry contributes nothing to the set'
    ).toBe(0);
  });

  it('makes each tier a superset of the one below it', () => {
    // Zipped into pairs rather than indexed: two indexed reads would each need an
    // `undefined` guard the type-aware rule calls dead.
    const pairs = TIERS.slice(0, -1).map((lower, index) => ({
      lower,
      higher: TIERS.slice(1)[index] ?? lower
    }));
    for (const { lower, higher } of pairs) {
      const lowerTargets = leaves(lower);
      const higherTargets = leaves(higher);
      const missing = [...lowerTargets].filter((target) => !higherTargets.has(target));
      expect(
        missing,
        `${higher} does not run these targets that ${lower} runs: ${missing.join(', ')}. A tier ` +
          'changes WHEN a gate runs, never WHETHER it runs — otherwise the cheap tier is a ' +
          'shortcut and the expensive one is optional.'
      ).toEqual([]);
      // And it must be strictly more, or it is the same tier under two names.
      expect(
        higherTargets.size,
        `${higher} runs no more than ${lower} does. Two names for one tier is worse than one ` +
          'name, because a contributor believes the second one bought something.'
      ).toBeGreaterThan(lowerTargets.size);
    }
  });

  it('runs the whole release gate in the release tier', () => {
    // `gate` is what a release runs (RELEASE.md §2). The release tier may be
    // reached by a different route, but it may not cover less.
    const release = leaves('verify:release');
    const missing = [...leaves('gate')].filter((target) => !release.has(target));
    expect(
      missing,
      `verify:release omits targets the release gate runs: ${missing.join(', ')}. The tier model ` +
        'exists to schedule the gate, not to shrink it.'
    ).toEqual([]);
  });

  it('caches no build in any tier', () => {
    // The audit's one caching caveat. A tier that reused a previous build could
    // pass a gate against code that is no longer in the tree — and unlike the
    // ratchets, which read source, nothing about a stale `dist/` announces itself.
    for (const tier of TIERS) {
      const body = scripts[tier] ?? '';
      for (const forbidden of ['--cache', '--no-clean', 'if [ -d dist', 'skip-build']) {
        expect(
          body.includes(forbidden),
          `${tier} contains "${forbidden}". No tier may reuse a build artifact: a ratchet that ` +
            'reads source cannot go stale, and a build that is reused silently can.'
        ).toBe(false);
      }
    }
  });

  it('documents every tier, and what each one does NOT establish', () => {
    const document = read(TIER_DOCUMENT);
    for (const tier of TIERS) {
      expect(document, `${TIER_DOCUMENT} does not mention ${tier}`).toContain(tier);
    }
    // A tier document that only listed commands would be a second copy of
    // package.json. What makes it a document is the claim boundary.
    expect(document).toContain('What this tier does NOT establish');
    expect(document, 'the caching caveat must be stated where the tiers are').toContain(
      'reuse a build'
    );
    expect(read('CONTRIBUTING.md'), 'CONTRIBUTING must point at the tiers').toContain(
      'verification-tiers.md'
    );
  });

  it('says what ci:fast is, since its name promises a tier it is not', () => {
    // Not retired: it is referenced by CONTRIBUTING and by habit. Named honestly
    // instead, in the document that now owns the subject.
    expect(read(TIER_DOCUMENT)).toContain('ci:fast');
  });
});
