// Feature 091 T021 (US2, FR-019 to FR-027) — a shipped view no entry point can
// reach is dead code that looks alive.
//
// It type-checks, its own tests pass, the LOC budget covers it, and no operator
// can ever see it. `WorkflowRun.svelte` and `RunLauncher.svelte` sat in exactly
// that state through two features: complete, tested, imported by nothing outside
// `__tests__/`. Nothing in the suite could say so, because every check in it
// asks whether a component is correct and none asks whether it is connected.
//
// This walks the import graph from the two shipped bundle entry points and fails
// on any `.svelte` file it cannot arrive at.
//
// THE ALLOWLIST IS EMPTY, AND EMPTY IS THE TARGET STATE (FR-R3-140). It used to
// hold ten components under feature 091's FR-040, which forbade deleting them —
// a scope constraint on that feature, never a finding that the code had value.
// FR-R3-140 deleted all ten, and the escape hatch changed shape with them: an
// entry is now a dated exception with a named owner, not a recorded reason that
// can outlive the person who recorded it. Adding one is a deliberate act with an
// expiry date attached, and the direction of travel is down. See
// ../../docs/architecture/webview-dead-surface-removal.md.
//
// A2 and A3 below are therefore empty against the shipping tree, and will stay
// empty until someone adds an entry. That is stated rather than left to be
// discovered: what those blocks execute is their *rules*, through
// `allowlistProblems`, and the synthetic set at the bottom of this file is what
// runs those rules against entries that actually break them. A loop over an
// empty map proves nothing, and the vacuity census cannot say so — it is a
// regex, and A4's `toBeGreaterThan(0)` keeps this file reading as controlled
// whatever A2 and A3 do.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WEBVIEW_SRC = resolve(REPO_ROOT, 'webview-ui', 'src');

/**
 * Both shipped bundles (FR-021). A named constant rather than a glob: a third
 * bundle added later must be added here deliberately, because a walker that
 * silently misses an entry root reports its whole subtree as unreachable and
 * teaches the next reader to widen the allowlist instead.
 */
const ENTRY_POINTS: readonly string[] = [
  join(WEBVIEW_SRC, 'main.ts'),
  join(WEBVIEW_SRC, 'dashboard', 'main.ts')
];

/**
 * A component reachable only from a dynamic import is still reachable (FR-022),
 * and this is the positive control for it: every lazily-loaded dashboard route
 * arrives this way. A walker that resolves `from '…'` but drops `import('…')`
 * would pass the main assertion — every lazy route would simply look
 * unreachable and get allowlisted — so the control names one such leaf and
 * requires it in the reachable set.
 */
const DYNAMIC_ONLY_LEAF = 'webview-ui/src/components/RunsSurface.svelte';

/** FR-027 — the two components this feature exists to mount. */
const MUST_NOT_BE_ALLOWLISTED: readonly string[] = [
  'webview-ui/src/components/WorkflowRun/WorkflowRun.svelte',
  'webview-ui/src/components/RunLauncher/RunLauncher.svelte'
];

/**
 * FR-R3-140 — an exception is owned, justified and dated. A bare reason string
 * was the old shape; it recorded why without recording who, and nothing made it
 * expire, so the ten entries it held sat unchallenged across two features.
 */
interface Exception {
  /** A person. Not a team, not a feature id — someone who can be asked. */
  readonly owner: string;
  readonly reason: string;
  /** `YYYY-MM-DD`. Past this date the entry fails until it is renewed or removed. */
  readonly reviewBy: string;
}

/**
 * Empty, and that is the target state — not a list waiting to be refilled.
 * Adding an entry is allowed and is meant to cost something: name yourself, say
 * why, and say when you will have dealt with it.
 */
const ALLOWLIST: ReadonlyMap<string, Exception> = new Map();

/** The six ways an entry can be wrong. */
type ProblemKind =
  | 'no owner'
  | 'no reason'
  | 'malformed reviewBy'
  | 'expired'
  | 'no such file'
  | 'now reachable';

/**
 * The same six, as a value the tests can iterate.
 *
 * A `Record<ProblemKind, …>` is the point: TypeScript rejects this literal if a
 * kind is added to the union and not listed here, so the runtime list cannot
 * fall behind the type. The synthetic suite's coverage guard reads this rather
 * than a second hand-written array — a hand-written one would happily agree
 * with itself about a kind neither knew existed.
 *
 * `true` means the kind is about the *record* — a field the author of the entry
 * got wrong, fixable by editing the entry. `false` means it is about the
 * *tree* — the entry may be perfectly well written and the code moved under it.
 * A6 asserts the first group, A2 and A3 the second, because the fixes differ.
 */
const PROBLEM_KIND_IS_RECORD_HYGIENE: Record<ProblemKind, boolean> = {
  'no owner': true,
  'no reason': true,
  'malformed reviewBy': true,
  expired: true,
  'no such file': false,
  'now reachable': false
};

const ALL_PROBLEM_KINDS = Object.keys(PROBLEM_KIND_IS_RECORD_HYGIENE) as readonly ProblemKind[];

const RECORD_HYGIENE_KINDS: readonly ProblemKind[] = ALL_PROBLEM_KINDS.filter(
  (kind) => PROBLEM_KIND_IS_RECORD_HYGIENE[kind]
);

interface Problem {
  readonly path: string;
  readonly kind: ProblemKind;
  readonly detail: string;
}

/**
 * True for a string that is both shaped like `YYYY-MM-DD` and an actual day.
 *
 * Written with no indexed read anywhere in it, deliberately. The obvious
 * version — `/^(\d{4})-(\d{2})-(\d{2})$/.exec(value)` then `m[1]`, `m[2]`,
 * `m[3]` — is three diagnostics against `--noUncheckedIndexedAccess` (pinned at
 * 1277), and guarding each one is findings against `no-unnecessary-condition`
 * (pinned at 341, and linted *without* that compiler flag). Only code that
 * reads nothing by index owes neither pin.
 *
 * All three clauses earn their place, verified rather than assumed:
 * `2026-13-01` and `2026-00-10` give an invalid `Date` and are caught by the
 * `getTime()` clause; `2026-02-30` parses fine, rolls forward to `2026-03-02`,
 * and is caught only by the `startsWith` clause.
 */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().startsWith(value);
}

/**
 * Every rule the allowlist enforces, in one pure function.
 *
 * `today`, `existsOnDisk` and `isUnreachable` are all parameters — never
 * `new Date()`, `existsSync` or the walk read from inside. That is not
 * testability for its own sake: with the real allowlist empty, an assertion
 * that reaches for the real tree can only ever iterate nothing, and the two
 * rules that used to live in A2 and A3 as hand-rolled loops would become
 * permanently green while still looking like checks. Injected, they can be
 * demonstrated against entries built in memory, which is what the synthetic set
 * does.
 *
 * `reviewBy` is compared lexicographically. That is exact for `YYYY-MM-DD` and
 * sidesteps the timezone question a `Date` comparison would introduce. The
 * boundary is inclusive: an entry due for review *today* is not yet expired.
 */
function allowlistProblems(
  entries: ReadonlyMap<string, Exception>,
  today: string,
  existsOnDisk: (path: string) => boolean,
  isUnreachable: (path: string) => boolean
): Problem[] {
  const problems: Problem[] = [];
  for (const [path, entry] of entries) {
    const attribution = `owner "${entry.owner}", review by ${entry.reviewBy}`;

    if (entry.owner.trim() === '') {
      problems.push({
        path,
        kind: 'no owner',
        detail: 'no owner — name a person who can be asked, not a team or a feature id'
      });
    }
    if (entry.reason.trim() === '') {
      problems.push({ path, kind: 'no reason', detail: 'no reason recorded' });
    }
    if (!isCalendarDate(entry.reviewBy)) {
      problems.push({
        path,
        kind: 'malformed reviewBy',
        detail: `reviewBy "${entry.reviewBy}" is not a YYYY-MM-DD calendar date`
      });
    } else if (entry.reviewBy < today) {
      problems.push({
        path,
        kind: 'expired',
        detail: `expired — reviewBy ${entry.reviewBy} is before ${today}. Renew it with a new date, or remove the entry`
      });
    }
    if (!existsOnDisk(path)) {
      problems.push({
        path,
        kind: 'no such file',
        detail: `no such file — the entry outlived what it excused (${attribution})`
      });
    }
    if (!isUnreachable(path)) {
      problems.push({
        path,
        kind: 'now reachable',
        detail: `now reachable, so this excuses nothing (${attribution}; "${entry.reason.trim()}")`
      });
    }
  }
  return problems;
}

const renderProblems = (problems: readonly Problem[]): string =>
  problems.map((problem) => `  - ${problem.path}: ${problem.detail}`).join('\n');

/**
 * FR-023 — a test file is not an entry point, and a component reachable only
 * from a test is not reachable. Skipped as both a node and an edge, which is
 * why `__tests__/HoverTextHarness.svelte` is not counted at all.
 *
 * The example this comment used to give for the *edge* half was
 * `AuditTail.svelte`, unreachable despite its own test importing it. FR-R3-140
 * deleted it, and no component in the shipping tree is now reachable only from
 * a test — which is the state this rule exists to keep, not evidence the rule
 * is idle. Remove the edge half only when a component is allowed to count a
 * test import as reachability, which is what FR-023 forbids.
 */
function isTestPath(path: string): boolean {
  return path.split(/[\\/]/).includes('__tests__');
}

function collectSvelteFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      files.push(...collectSvelteFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.svelte')) {
      files.push(path);
    }
  }
  return files;
}

/**
 * The four specifier shapes that carry a real edge in this codebase. Bare
 * side-effect imports count because they can pull a module — and transitively a
 * component — into a bundle; `export … from` counts because it is an import
 * edge wearing a different keyword.
 */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s;}])(?:import|export)\s[^'"();]*?\sfrom\s*['"]([^'"]+)['"]/g,
  /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
];

function specifiersIn(source: string): string[] {
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    // Each RegExp is stateful (`g`); reset before reuse across files.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1] !== undefined) found.push(match[1]);
    }
  }
  return found;
}

/**
 * Extension-less specifiers resolve by trying `.ts`, then `.svelte.ts`, then
 * `.svelte`, then `/index.ts` — the order the bundler uses, and the order that
 * matters: `lib/foo` next to both `foo.ts` and `foo.svelte` must resolve to the
 * module the import actually gets.
 */
const RESOLUTION_SUFFIXES: readonly string[] = ['.ts', '.svelte.ts', '.svelte', '/index.ts'];

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null; // package import — nothing local to walk
  const base = resolve(dirname(fromFile), specifier);
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Breadth-first from the entry roots over both `.ts` and `.svelte` (FR-020).
 *
 * Traversing `.ts` is mandatory, not thoroughness for its own sake: two real
 * edges in this codebase are TS-mediated — `lib/use-confirm.ts` reaches
 * `ConfirmDialog.svelte`, and `hover-text-anchor-action.ts` reaches
 * `HoverTextPortal.svelte`. A `.svelte`-only walker reports both as unreachable
 * on day one.
 */
function walkReachable(): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = ENTRY_POINTS.filter((entry) => existsSync(entry));

  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current) || isTestPath(current)) continue;
    seen.add(current);

    if (!/\.(ts|svelte)$/.test(current)) continue;
    const source = readFileSync(current, 'utf8');
    for (const specifier of specifiersIn(source)) {
      const target = resolveSpecifier(current, specifier);
      if (target !== null && !seen.has(target) && !isTestPath(target)) queue.push(target);
    }
  }
  return seen;
}

const reachable = walkReachable();
const components = collectSvelteFiles(WEBVIEW_SRC);
const rel = (path: string): string => relative(REPO_ROOT, path).split('\\').join('/');
const unreachable = components.filter((path) => !reachable.has(path)).map(rel);

/**
 * The real-tree predicates, lifted out of the loops A2 and A3 used to hand-roll
 * so both now run the same rules the synthetic set demonstrates.
 */
// UTC, matching `isCalendarDate`'s `T00:00:00Z` parse, so the comparison never
// straddles two calendars. On a machine east of Greenwich this can be yesterday
// in local terms, which makes an entry expire up to a day late — the harmless
// direction for a review deadline, and the wrong one to fix by mixing zones.
const TODAY = new Date().toISOString().slice(0, 10);
const liveProblems = allowlistProblems(
  ALLOWLIST,
  TODAY,
  (path) => existsSync(resolve(REPO_ROOT, path)),
  (path) => unreachable.includes(path)
);
const liveProblemsOfKind = (kind: ProblemKind): Problem[] =>
  liveProblems.filter((problem) => problem.kind === kind);

describe('Feature 091 — every shipped Svelte view is reachable from an entry point', () => {
  it('A1: no component outside the allowlist is unreachable', () => {
    const offenders = unreachable.filter((path) => !ALLOWLIST.has(path));
    expect(
      offenders,
      `No shipped entry point imports these components, so no operator can reach them. ` +
        `Mount each one — that is the expected fix. An allowlist entry is the other ` +
        `option and costs three fields: { owner: a person who can be asked, reason: ` +
        `why it is not mounted, reviewBy: 'YYYY-MM-DD' }, and it fails once reviewBy ` +
        `is in the past:\n` +
        offenders.map((path) => `  - ${path}`).join('\n')
    ).toEqual([]);
  });

  it('A2: every allowlist entry still exists on disk', () => {
    const missing = liveProblemsOfKind('no such file');
    expect(
      missing,
      `These allowlist entries name files that no longer exist. Remove the entries:\n` +
        renderProblems(missing)
    ).toEqual([]);
  });

  it('A3: every allowlist entry is still unreachable', () => {
    // The more insidious direction: a component got mounted while its entry
    // stayed, so the entry now excuses nothing and the next genuinely
    // unreachable file inherits a stale excuse.
    const nowReachable = liveProblemsOfKind('now reachable');
    expect(
      nowReachable,
      `These components are now reachable, so their allowlist entries excuse nothing. ` +
        `Remove them from ALLOWLIST:\n` + renderProblems(nowReachable)
    ).toEqual([]);
  });

  it('A6: every allowlist entry is owned, justified and unexpired', () => {
    // The record's own hygiene, as opposed to A2 and A3, which are about the
    // tree. Separated because the fixes differ: these are edits to the entry,
    // those are edits to the code or deletions of the entry.
    const malformed = liveProblems.filter((problem) =>
      RECORD_HYGIENE_KINDS.includes(problem.kind)
    );
    expect(
      malformed,
      `These allowlist entries are not usable exceptions. Every entry needs an ` +
        `owner who can be asked, a reason, and a reviewBy date in YYYY-MM-DD that ` +
        `has not passed:\n` + renderProblems(malformed)
    ).toEqual([]);
  });

  it('A7: A2, A3 and A6 between them assert every problem kind', () => {
    // `allowlistProblems` can report a kind that no assertion above reads, and
    // nothing would say so: `liveProblems` is computed once and each block
    // filters it down to the kinds it cares about, so an unclaimed kind is
    // simply never looked at. A2 takes one kind, A3 takes one, A6 takes the
    // hygiene group; a seventh kind added outside that group would be produced
    // and silently dropped. This is the live-tree counterpart of the synthetic
    // suite's coverage guard, and it is the same argument: a rule nothing reads
    // is not a rule.
    const claimed = new Set<ProblemKind>([
      'no such file', // A2
      'now reachable', // A3
      ...RECORD_HYGIENE_KINDS // A6
    ]);
    expect(
      [...claimed].sort(),
      'Every ProblemKind must be claimed by A2, A3 or A6. Add the new kind to ' +
        'one of them — or to PROBLEM_KIND_IS_RECORD_HYGIENE as `true`, which ' +
        'puts it in A6 — and say so here.'
    ).toEqual([...ALL_PROBLEM_KINDS].sort());
  });

  it('A4: the walk examined components and followed a dynamic import', () => {
    // Two halves, each failing a different broken walker: a count of zero fails
    // a collector that silently matched nothing; the dynamic-only leaf fails a
    // walker that resolves static imports and drops `import('…')`.
    expect(components.length).toBeGreaterThan(0);
    expect(
      reachable.has(resolve(REPO_ROOT, DYNAMIC_ONLY_LEAF)),
      `${DYNAMIC_ONLY_LEAF} is reached only through a dynamic import. ` +
        `If it reads as unreachable, the walker stopped following import('…').`
    ).toBe(true);
  });

  it('A5: neither component this feature mounts is allowlisted', () => {
    // The cheapest way to make this check pass is to allowlist the two views it
    // was written to mount. FR-027 forbids it; this is the forbidding.
    const excused = MUST_NOT_BE_ALLOWLISTED.filter((path) => ALLOWLIST.has(path));
    expect(
      excused,
      `FR-027: these must be mounted, not excused:\n` +
        excused.map((path) => `  - ${path}`).join('\n')
    ).toEqual([]);
  });
});

/**
 * FR-R3-140 — the policy above, executed.
 *
 * A1 through A6 all run against an empty map, so every one of them passes by
 * having nothing to look at. These do not: each builds a one-entry map in
 * memory that breaks exactly one rule, and asserts that rule fires. E-h and E-i
 * are what give A2's and A3's rules a live demonstration, which is the whole
 * reason `existsOnDisk` and `isUnreachable` are parameters rather than reads.
 */
describe('FR-R3-140 — the allowlist policy, demonstrated', () => {
  // Composed at runtime, never written as a `webview-ui/…` literal:
  // `lint-anchor-grounding.test.ts` matches any such string literal in a gate
  // file and requires the path to exist. These paths deliberately do not.
  const SYNTHETIC_DIR = ['webview', 'ui'].join('-') + '/src/components/__nowhere__/';
  const syntheticPath = (name: string): string => `${SYNTHETIC_DIR}${name}.svelte`;

  const SYNTHETIC_TODAY = '2026-06-15';
  // A deliberately fictitious owner. A real name here would read as a real
  // exception owned by a real person, and would rot when they moved on.
  const VALID: Exception = {
    owner: 'A. Maintainer',
    reason: 'Kept for one sprint while the replacement route lands.',
    reviewBy: '2027-01-01'
  };

  interface SyntheticCase {
    readonly id: string;
    readonly label: string;
    readonly entry: Exception;
    readonly existsOnDisk: boolean;
    readonly isUnreachable: boolean;
    readonly expected: readonly ProblemKind[];
  }

  const CASES: readonly SyntheticCase[] = [
    {
      id: 'E-a',
      label: 'an owned, justified, unexpired entry is accepted',
      entry: VALID,
      existsOnDisk: true,
      isUnreachable: true,
      expected: []
    },
    {
      id: 'E-b',
      label: 'an empty owner is rejected',
      entry: { ...VALID, owner: '' },
      existsOnDisk: true,
      isUnreachable: true,
      expected: ['no owner']
    },
    {
      id: 'E-c',
      label: 'a whitespace-only reason is rejected',
      entry: { ...VALID, reason: '   ' },
      existsOnDisk: true,
      isUnreachable: true,
      expected: ['no reason']
    },
    {
      id: 'E-d',
      label: 'a reviewBy that is not a date at all is rejected',
      entry: { ...VALID, reviewBy: 'soon' },
      existsOnDisk: true,
      isUnreachable: true,
      expected: ['malformed reviewBy']
    },
    {
      id: 'E-e',
      label: 'a well-formed reviewBy that is not a real day is rejected',
      // The case a shape-only regex waves through: `2026-02-30` matches
      // `\d{4}-\d{2}-\d{2}`, parses, and silently becomes 2026-03-02.
      entry: { ...VALID, reviewBy: '2026-02-30' },
      existsOnDisk: true,
      isUnreachable: true,
      expected: ['malformed reviewBy']
    },
    {
      id: 'E-f',
      label: 'a reviewBy equal to today is still valid — the boundary is inclusive',
      entry: { ...VALID, reviewBy: SYNTHETIC_TODAY },
      existsOnDisk: true,
      isUnreachable: true,
      expected: []
    },
    {
      id: 'E-g',
      label: 'a reviewBy one day before today has expired',
      entry: { ...VALID, reviewBy: '2026-06-14' },
      existsOnDisk: true,
      isUnreachable: true,
      expected: ['expired']
    },
    {
      id: 'E-h',
      label: "A2's rule: a valid entry naming a file that is gone is rejected",
      entry: VALID,
      existsOnDisk: false,
      isUnreachable: true,
      expected: ['no such file']
    },
    {
      id: 'E-i',
      label: "A3's rule: a valid entry whose component is now reachable is rejected",
      entry: VALID,
      existsOnDisk: true,
      isUnreachable: false,
      expected: ['now reachable']
    }
  ];

  for (const testCase of CASES) {
    it(`${testCase.id}: ${testCase.label}`, () => {
      const path = syntheticPath(testCase.id);
      const problems = allowlistProblems(
        new Map([[path, testCase.entry]]),
        SYNTHETIC_TODAY,
        () => testCase.existsOnDisk,
        () => testCase.isUnreachable
      );
      expect(
        problems.map((problem) => problem.kind),
        `${testCase.id} produced:\n${renderProblems(problems)}`
      ).toEqual(testCase.expected);
      for (const problem of problems) {
        expect(problem.path).toBe(path);
        expect(problem.detail.trim()).not.toBe('');
      }
    });
  }

  it('the cases cover every problem kind, so none of the rules is unexercised', () => {
    // Two failure modes, both silent without this. Deleting a rule and its one
    // case leaves a green suite. Adding a kind and forgetting a case does the
    // same — and that half only works because the expected set is derived from
    // `PROBLEM_KIND_IS_RECORD_HYGIENE`, which the compiler forces to stay
    // complete. A second hand-written list here would agree with the first
    // about a kind neither had heard of.
    const covered = new Set(CASES.flatMap((testCase) => testCase.expected));
    expect(
      [...covered].sort(),
      'Every ProblemKind needs at least one synthetic case that provokes it'
    ).toEqual([...ALL_PROBLEM_KINDS].sort());
  });

  it('the synthetic paths are not on disk, so E-h tests what it claims to', () => {
    // If one of these ever existed, E-h's `existsOnDisk: false` would be a lie
    // the injected predicate hides.
    for (const testCase of CASES) {
      expect(existsSync(resolve(REPO_ROOT, syntheticPath(testCase.id)))).toBe(false);
    }
  });
});
