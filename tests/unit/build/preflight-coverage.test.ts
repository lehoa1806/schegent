/**
 * Feature 106 (T595, FR-025 to FR-028) — every gate CI runs is a gate the
 * preflight runs.
 *
 * `package:smoke` sat at step 12 of `ci`'s 13 and nowhere in `ci:fast`. That is
 * why its allowlist drifted through features 081-095 unnoticed while
 * `test:visual` — one step earlier in `ci`, but *inside* `ci:fast` — caught its
 * own regression the moment anyone ran the preflight. The difference was reach,
 * not severity, and nothing asserted it.
 *
 * The rule is comparison in one direction only (FR-026): a script the preflight
 * runs and CI does not is not a gap, it is a preflight that does more. What must
 * not exist is a script `ci` runs that `ci:fast` cannot reach.
 *
 * Two clauses make the rule applicable to the real graph. Resolving it against
 * `package.json` is what found the second — a naive comparison reports a script
 * reachable only through an excluded one, so the exclusion list below could not
 * have been three entries:
 *
 *   * **recursive coverage** (FR-025) — a composite script whose every
 *     constituent is covered is covered. `build` is `build:webview && build:host`
 *     and the preflight reaches both, so running `build` would add nothing.
 *   * **exclusions prune their subtree** (FR-025a) — `test:integration:compile` is
 *     reachable only through `test:integration`, which is excluded. Counting it
 *     separately would mean excluding it separately, for the same reason, twice.
 *
 * A third clause was specified and then removed, because it was measured and
 * removed nothing: "the chain roots are the subject, not members". The subject is
 * walked *from* `ci`, so neither root enters it unless something references it,
 * and under the one refactor that would — `ci` redefined as `ci:fast` plus the
 * heavy tiers — the recursive clause already covers `ci:fast` through its own
 * constituents. A filter that cannot change an outcome is the kind of fence this
 * feature exists to remove, so it is not here.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');

const FULL_GATE = 'ci';
const PREFLIGHT = 'ci:fast';

/**
 * The scripts `ci` runs that the preflight deliberately does not, each with the
 * reason it is out.
 *
 * This list lives here, beside the assertion that checks it, and its exact
 * contents are asserted below (FR-027a). Extending it to silence a real gap is a
 * visible diff in a file whose only job is to notice gaps — which is the property
 * an escape hatch has to have to be worth having.
 */
const EXCLUDED: ReadonlyArray<{ readonly script: string; readonly reason: string }> = [
  {
    script: 'test:e2e',
    reason: 'a separate Vitest project with a 120s per-test timeout; minutes of wall clock per run'
  },
  {
    script: 'test:integration',
    reason: 'downloads and launches a real VS Code, after a full build and a second tsc program'
  },
  {
    script: 'test:perf',
    reason: 'timing assertions are unreliable on a developer machine under load'
  }
];

type Scripts = Readonly<Record<string, string>>;

function scripts(): Scripts {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
    readonly scripts: Scripts;
  };
  return pkg.scripts;
}

const NPM_RUN = /npm run ([A-Za-z0-9:_.-]+)/g;

/**
 * Feature 106 (T595b, FR-028) — the parse reports what it could not read.
 *
 * `occurrences` counts `npm run ` literally; `names` counts what the pattern
 * captured. A body the pattern stops understanding makes the two disagree, and
 * the assertion below fails — rather than reporting full coverage over a graph it
 * silently read as empty. `npm --prefix webview-ui run build` is not a reference
 * to a root script and is deliberately not matched.
 */
function referenced(body: string): { readonly names: readonly string[]; readonly occurrences: number } {
  return {
    names: [...body.matchAll(NPM_RUN)].map((match) => match[1]),
    occurrences: body.split('npm run ').length - 1
  };
}

function reachableFrom(all: Scripts, root: string, pruned: ReadonlySet<string>): ReadonlySet<string> {
  const seen = new Set<string>();
  const pending = [...referenced(all[root] ?? '').names];
  while (pending.length > 0) {
    const name = pending.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    if (pruned.has(name)) continue;
    pending.push(...referenced(all[name] ?? '').names);
  }
  return seen;
}

/**
 * A leaf is covered only by being reached. Returning `true` for a script with no
 * constituents would make `every` vacuously true and mark the whole graph covered
 * — the failure mode this file is one of several closing.
 */
function isCovered(
  all: Scripts,
  name: string,
  covered: ReadonlySet<string>,
  visiting: ReadonlySet<string> = new Set()
): boolean {
  if (covered.has(name)) return true;
  if (visiting.has(name)) return false;
  const constituents = referenced(all[name] ?? '').names;
  if (constituents.length === 0) return false;
  const deeper = new Set([...visiting, name]);
  return constituents.every((constituent) => isCovered(all, constituent, covered, deeper));
}

describe('the preflight chain reaches every gate CI runs', () => {
  it('parses every script body it walks', () => {
    const all = scripts();
    const unreadable = Object.entries(all)
      .filter(([, body]) => referenced(body).names.length !== referenced(body).occurrences)
      .map(([name]) => name);
    expect(
      unreadable,
      'these script bodies contain an `npm run` the reachability walk could not ' +
        'read; an unparsed body drops out of the graph and reports as full coverage'
    ).toEqual([]);
  });

  it('leaves no script that ci runs and the preflight cannot reach', () => {
    const all = scripts();
    const excluded = new Set(EXCLUDED.map((entry) => entry.script));
    const subject = [...reachableFrom(all, FULL_GATE, excluded)]
      .filter((name) => !excluded.has(name))
      .sort();
    const covered = reachableFrom(all, PREFLIGHT, excluded);
    const uncovered = subject.filter((name) => !isCovered(all, name, covered));
    expect(
      uncovered,
      'these scripts run in `ci` but are unreachable from `ci:fast`, so a regression ' +
        'in one of them survives every local preflight and surfaces only in CI — ' +
        'which is exactly how the VSIX allowlist drifted through features 081-095. ' +
        'Add each to the preflight chain, or to EXCLUDED above with a reason'
    ).toEqual([]);
    expect(subject.length, 'the subject is empty, so the check above proved nothing').toBeGreaterThan(
      0
    );
  });

  it('excludes exactly three scripts, each with a reason', () => {
    expect(EXCLUDED.map((entry) => entry.script).sort()).toEqual([
      'test:e2e',
      'test:integration',
      'test:perf'
    ]);
    for (const entry of EXCLUDED) {
      expect(entry.reason.length, `${entry.script} is excluded without a reason`).toBeGreaterThan(20);
    }
  });

  it('runs the packaging gate in the preflight, after the step that builds the webview', () => {
    const preflight = scripts()[PREFLIGHT];
    expect(preflight).toContain('npm run build:host && npm run package:smoke');
    expect(preflight.indexOf('test:visual')).toBeLessThan(preflight.indexOf('package:smoke'));
    // FR-024 — `verify:all` stays build-free. The preflight calls it, so a build
    // moved in there would make the preflight build twice.
    expect(scripts()['verify:all']).not.toContain('npm run build');
  });
});
