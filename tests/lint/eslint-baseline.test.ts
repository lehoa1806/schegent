// Feature 112 (FR-013, FR-016, FR-017, FR-018) — the shape invariants of the lint
// ratchet, as opposed to its counts.
//
// scripts/lint.mjs already fails when a baselined count rises above its record or
// falls below it. That is the whole ratchet only if the record itself stays
// meaningful, and there are four ways it stops being meaningful while every gate
// still reports green:
//
//   1. An entry loses its owner or its reduction note and becomes a permanent
//      allowance nobody is accountable for. FR-016 asks for this to be
//      unrepresentable rather than reported, so the mechanism is the `Baseline`
//      interface below: the imported JSON is assigned to it, and an entry missing
//      either field fails `npm run typecheck:tests` before any test runs. The
//      assertions here cover what a type cannot — that the owner's reference
//      resolves on disk and still contains the decision it quotes, and that the
//      reduction note says something.
//   2. A rule is promoted to `error` while its entry still stands. Then the entry
//      is dead text: the run fails on the first finding, and "620 bounded and being
//      paid down" and "enforced at zero" have become indistinguishable in the one
//      file that is supposed to tell them apart (FR-017).
//   3. An entry names a rule the configuration does not enable. Its count is 0
//      forever, so it reads as debt under control while bounding nothing — and it
//      survives the runner's stale-record check only because the runner compares
//      counts, not configuration.
//   4. A rule count is lowered by suppressing sites rather than by fixing them.
//      That is invisible per rule and obvious in aggregate, which is why the total
//      number of in-source suppression directives is itself one baselined entry
//      (FR-018). It is checked here rather than in the runner because it spans both
//      trees and the runner lints one tree per invocation.
//
// This file resolves configuration; it lints no files, so it adds no ESLint pass to
// `verify:all` (FR-019a).
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';
import baselineJson from './eslint-baseline.json';

/**
 * Where a baseline entry's debt is owned: a decision a reader can grep for, and a
 * path this gate resolves. Not a person — FR-R3-027 established the shape after a
 * reference to "plan.md lines 26 and 66" pointed at the wrong lines within one
 * feature, and a name rots the same way the moment its holder moves on.
 */
interface Owner {
  readonly decision: string;
  readonly reference: string;
}

/**
 * Both `owner` and `reductionNote` are required, and that is the FR-016 mechanism:
 * the assignment of the imported JSON to `Baseline` is what rejects an unowned
 * entry, at `typecheck:tests` rather than at run time.
 *
 * Counts are optional individually because they are per tree — `host`, `webview`,
 * or the repo-wide `repo` for a total spanning both — but a non-vacuity test below
 * requires every entry to carry at least one of them.
 */
interface RuleEntry {
  readonly host?: number;
  readonly webview?: number;
  readonly repo?: number;
  readonly owner: Owner;
  readonly reductionNote: string;
}

interface Baseline {
  readonly about: readonly string[];
  readonly rules: Readonly<Record<string, RuleEntry>>;
}

const BASELINE: Baseline = baselineJson;

const REPO_ROOT = resolve(__dirname, '..', '..');
const ENVELOPE_ROOT = resolve(REPO_ROOT, '..');
const WEBVIEW_ROOT = resolve(REPO_ROOT, 'webview-ui');

/** The entry whose count is a repo-wide total rather than a per-tree one. */
const DIRECTIVE_TOTAL = 'suppressionDirectives';

const TREES = ['host', 'webview'] as const;
type Tree = (typeof TREES)[number];

const ENTRIES = Object.entries(BASELINE.rules);

// ---------------------------------------------------------------------------
// Effective severities, read from the configuration the runner uses.
// ---------------------------------------------------------------------------

/** Directories the linter walks, per tree — mirrors `TREES` in scripts/lint.mjs. */
const SOURCE_DIRS: Record<Tree, { root: string; dirs: readonly string[] }> = {
  host: { root: REPO_ROOT, dirs: ['src', 'tests', 'scripts'] },
  webview: { root: WEBVIEW_ROOT, dirs: ['src', 'tests'] }
};

const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'coverage', '.vscode-test']);

function walk(dir: string, onFile: (absolute: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(absolute, onFile);
      continue;
    }
    onFile(absolute);
  }
}

/**
 * A real file of the given extension, found rather than named, so that renaming
 * any one component does not silently turn this gate into a probe of nothing.
 */
function findProbe(root: string, dir: string, ext: string): string | null {
  let found: string | null = null;
  walk(resolve(root, dir), absolute => {
    if (found === null && extname(absolute) === ext) found = absolute;
  });
  return found;
}

/**
 * Probes per tree: one file of each kind whose rule set differs. A rule is enabled
 * in a tree if any probe reports it, because the Svelte rules are declared for the
 * whole webview tree while the type-aware rules only reach files inside a
 * TypeScript project.
 */
const PROBES: Record<Tree, ReadonlyArray<{ root: string; dir: string; ext: string }>> = {
  host: [{ root: REPO_ROOT, dir: 'src', ext: '.ts' }],
  webview: [
    { root: WEBVIEW_ROOT, dir: 'src', ext: '.ts' },
    { root: WEBVIEW_ROOT, dir: 'src', ext: '.svelte' }
  ]
};

/** ruleId -> the severities the configuration gives it across a tree's probes. */
type SeverityMap = Map<string, number[]>;

const severities = new Map<Tree, SeverityMap>();

beforeAll(async () => {
  // Imported through a computed specifier on purpose. The configuration is `.mjs`
  // with no declaration file and this tree does not set `allowJs`, so a literal
  // specifier would fail `typecheck:tests` on the import itself; widening
  // tsconfig.tests.json to cover `scripts/` would type-check nine build scripts
  // that were never written against it. Reading the configuration by parsing its
  // text instead would reimplement flat-config resolution, which is the one thing
  // a gate about the linter must not do.
  const specifier = pathToFileURL(resolve(REPO_ROOT, 'scripts', 'lint-config.mjs')).href;
  const config = (await import(specifier)) as {
    hostConfig: unknown[];
    createWebviewConfig: () => Promise<unknown[]>;
  };

  const resolved: Record<Tree, { cwd: string; overrideConfig: unknown }> = {
    host: { cwd: REPO_ROOT, overrideConfig: config.hostConfig },
    webview: { cwd: WEBVIEW_ROOT, overrideConfig: await config.createWebviewConfig() }
  };

  for (const tree of TREES) {
    const eslint = new ESLint({
      cwd: resolved[tree].cwd,
      overrideConfigFile: true,
      // The config array is typed by a module TypeScript cannot see; the runner is
      // what proves this shape, on every lint run.
      overrideConfig: resolved[tree].overrideConfig as ESLint.Options['overrideConfig']
    });

    const map: SeverityMap = new Map();
    for (const probe of PROBES[tree]) {
      const file = findProbe(probe.root, probe.dir, probe.ext);
      expect(file, `no ${probe.ext} file under ${probe.dir} of the ${tree} tree to probe`).not.toBeNull();
      const effective = await eslint.calculateConfigForFile(file as string);
      for (const [ruleId, setting] of Object.entries(effective.rules ?? {})) {
        const severity = Array.isArray(setting) ? setting[0] : setting;
        map.set(ruleId, [...(map.get(ruleId) ?? []), Number(severity)]);
      }
    }
    severities.set(tree, map);
  }
});

function treesOf(entry: RuleEntry): Tree[] {
  return TREES.filter(tree => typeof entry[tree] === 'number');
}

// ---------------------------------------------------------------------------
// In-source suppression directives.
// ---------------------------------------------------------------------------

/** The extensions the configuration declares, so the scan sees what the linter sees. */
const LINTED = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.svelte']);

/**
 * A suppression directive, anchored to the start of a comment. A prose mention of
 * the syntax mid-comment — which several of this repository's configuration
 * comments make deliberately — is not a directive, and anchoring is what tells the
 * two apart. It over-counts before it under-counts: a directive inside a template
 * literal would be caught, which fails loudly rather than quietly.
 */
const DIRECTIVE = /(?:\/\/|\/\*|<!--)\s*eslint-disable(?:-next-line|-line)?\b/;

/**
 * This file. Excluded from its own scan: the alternative is a gate that goes red
 * when someone documents the pattern it counts. A dead directive here is still
 * caught, by `reportUnusedDisableDirectives` on every lint run.
 */
const SELF = relative(REPO_ROOT, __filename).replace(/\\/g, '/');

function scanDirectives(): string[] {
  const sites: string[] = [];
  const record = (absolute: string): void => {
    if (!LINTED.has(extname(absolute))) return;
    const path = relative(REPO_ROOT, absolute).replace(/\\/g, '/');
    if (path === SELF) return;
    readFileSync(absolute, 'utf8')
      .split(/\r?\n/)
      .forEach((line, index) => {
        if (DIRECTIVE.test(line)) sites.push(`${path}:${index + 1}`);
      });
  };

  for (const tree of TREES) {
    const { root, dirs } = SOURCE_DIRS[tree];
    for (const dir of dirs) walk(resolve(root, dir), record);
    // Root-level files of each tree, which the linter also covers.
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile()) record(join(root, entry.name));
    }
  }
  return sites;
}

// ---------------------------------------------------------------------------

describe('Feature 112 eslint baseline shape', () => {
  it('records at least the six entries this feature measured', () => {
    expect(ENTRIES.length).toBeGreaterThanOrEqual(6);
  });

  it.each(ENTRIES)('%s carries a count for at least one tree', (ruleId, entry) => {
    const counts = (['host', 'webview', 'repo'] as const).filter(
      key => typeof entry[key] === 'number'
    );
    expect(
      counts,
      `${ruleId} records no count, so nothing about it is bounded; give it a host, ` +
        `webview or repo total`
    ).not.toEqual([]);
    for (const key of counts) {
      expect(Number.isInteger(entry[key]), `${ruleId}.${key} must be a whole number`).toBe(true);
      expect(entry[key] as number).toBeGreaterThanOrEqual(0);
    }
  });

  it.each(ENTRIES)('%s is owned by a decision that still exists', (ruleId, entry) => {
    const reference = resolve(ENVELOPE_ROOT, entry.owner.reference);
    let text: string;
    try {
      text = readFileSync(reference, 'utf8');
    } catch {
      throw new Error(
        `${ruleId} is owned by ${entry.owner.reference}, which does not exist. An owner ` +
          `that cannot be resolved is an unowned entry.`
      );
    }
    expect(entry.owner.decision.length, `${ruleId} quotes an empty decision`).toBeGreaterThan(0);
    expect(
      text.includes(entry.owner.decision),
      `${ruleId} quotes the decision "${entry.owner.decision}", which no longer appears ` +
        `in ${entry.owner.reference}. Requote it or record the decision that replaced it.`
    ).toBe(true);
  });

  it.each(ENTRIES)('%s says how the count comes down', (ruleId, entry) => {
    const note = entry.reductionNote.trim();
    expect(
      note.length,
      `${ruleId}'s reductionNote is too short to be a plan; say what the findings are ` +
        `and what clears them`
    ).toBeGreaterThan(80);
    expect(
      /^(todo|tbd|n\/?a|later|none)\b/i.test(note),
      `${ruleId}'s reductionNote is a placeholder, which is the permanent allowance ` +
        `this file exists to prevent`
    ).toBe(false);
  });
});

describe('Feature 112 eslint baseline agrees with the configuration', () => {
  it.each(ENTRIES.filter(([ruleId]) => ruleId !== DIRECTIVE_TOTAL))(
    '%s is enabled by the configuration in every tree it records',
    (ruleId, entry) => {
      const trees = treesOf(entry);
      expect(trees, `${ruleId} records no tree count`).not.toEqual([]);
      for (const tree of trees) {
        const found = severities.get(tree)?.get(ruleId) ?? [];
        expect(
          found.some(severity => severity > 0),
          `${ruleId} has a ${tree} count of ${String(entry[tree])} but the ${tree} ` +
            `configuration never enables it, so its count is 0 by construction and ` +
            `this entry bounds nothing. Enable the rule or delete the entry.`
        ).toBe(true);
      }
    }
  );

  it.each(ENTRIES.filter(([ruleId]) => ruleId !== DIRECTIVE_TOTAL))(
    '%s is not configured at error while its entry stands',
    (ruleId, entry) => {
      for (const tree of treesOf(entry)) {
        const found = severities.get(tree)?.get(ruleId) ?? [];
        expect(
          found.filter(severity => severity === 2),
          `${ruleId} is at error in the ${tree} tree while still carrying a baseline ` +
            `entry of ${String(entry[tree])}. Those say opposite things: error means ` +
            `enforced at zero, an entry means bounded and being paid down. Clear the ` +
            `count and delete the entry in the same change, or put the rule back at warn.`
        ).toEqual([]);
      }
    }
  );

  it(`${DIRECTIVE_TOTAL} matches the directives actually in the source`, () => {
    // Looked up through the entry list rather than by index, so that the type is
    // `RuleEntry | undefined` and the assertion below is a check the type checker
    // agrees can fail. Indexing the record types as present whatever the file holds,
    // which is the same `noUncheckedIndexedAccess` gap the baseline's own
    // no-unnecessary-condition note describes.
    const entry = ENTRIES.find(([ruleId]) => ruleId === DIRECTIVE_TOTAL)?.[1];
    expect(entry, `${DIRECTIVE_TOTAL} is missing; FR-018 requires it`).toBeDefined();
    const recorded = entry?.repo;
    expect(typeof recorded, `${DIRECTIVE_TOTAL} must record a repo-wide total`).toBe('number');

    const sites = scanDirectives();
    expect(
      sites.length,
      `${sites.length} suppression directives in the source against ${String(recorded)} ` +
        `recorded. A rise here is a rule count lowered by suppression rather than by a ` +
        `fix; a fall is a stale record that would hide the next one. Sites:\n  ` +
        sites.join('\n  ')
    ).toBe(recorded);
  });
});
