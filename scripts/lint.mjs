#!/usr/bin/env node
// The only ESLint invoker in this repository.
//
//   node scripts/lint.mjs host      # src, tests, scripts, root-level tooling
//   node scripts/lint.mjs webview   # webview-ui
//   node scripts/lint.mjs <tree> --sites     # expand baselined rules to their sites
//   node scripts/lint.mjs <tree> --census    # per-rule counts, never fails
//
// One ESLint pass per tree does three jobs at once (plan D7): it enforces every
// `error`-severity rule, it produces the per-rule counts the ratchet compares
// against tests/lint/eslint-baseline.json, and it collapses each baselined rule to
// a single summary line. Counting in a second pass would have turned this feature's
// +15s into +43s, and a count taken by a different run than the one that enforces
// the errors is a count that can disagree with the gate (FR-019a, SC-013a).
//
// The baseline's `suppressionDirectives` entry is not checked here: it is a
// repo-wide total spanning both trees, so no single-tree pass can see it. It is
// checked by tests/lint/eslint-baseline.test.ts (FR-018).
import { ESLint } from 'eslint';
import fs from 'node:fs';
import path from 'node:path';
import {
  hostConfig,
  createWebviewConfig,
  REPO_ROOT,
  WEBVIEW_ROOT
} from './lint-config.mjs';

const BASELINE_PATH = path.join(REPO_ROOT, 'tests', 'lint', 'eslint-baseline.json');

// Pseudo-rule id for directive reports, which ESLint emits with a null ruleId.
export const DIRECTIVE_RULE = 'eslint/unused-disable-directive';

// `config` is a thunk so that linting the host never loads the Svelte plugin, and
// so that a broken webview install cannot fail the host gate.
const TREES = {
  host: { cwd: REPO_ROOT, config: () => hostConfig, dirs: ['src', 'tests', 'scripts'] },
  webview: { cwd: WEBVIEW_ROOT, config: createWebviewConfig, dirs: ['src', 'tests'] }
};

/**
 * Files at a tree's root, passed individually so the configuration decides which
 * are linted. Naming an extension set here instead would mean a new build script
 * of an already-declared extension silently escaped the linter (FR-006).
 *
 * @param {string} cwd tree root
 * @returns {string[]} bare filenames
 */
function rootFiles(cwd) {
  return fs
    .readdirSync(cwd, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name);
}

/**
 * @param {string} tree
 * @returns {{rules: Record<string, Record<string, number|string>>}} parsed baseline
 */
function readBaseline(tree) {
  // Fail closed. Skipping the comparison when the record is missing would be the
  // one failure mode that hides itself: the baselined rules sit at `warn`, so a
  // deleted baseline would print 620 findings, bound none of them, and still exit
  // 0 — a lint run that looks like it passed. A checkout without this file is
  // broken, never a state to lint in.
  if (!fs.existsSync(BASELINE_PATH)) {
    process.stderr.write(
      `[lint] no baseline at ${path.relative(REPO_ROOT, BASELINE_PATH)}. The ratchet ` +
        'record is not optional: restore it from git rather than linting without it.\n'
    );
    process.exit(2);
  }

  const parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const rules = {};
  for (const [ruleId, entry] of Object.entries(parsed.rules ?? {})) {
    if (typeof entry[tree] === 'number') {
      rules[ruleId] = entry;
    }
  }
  return { rules };
}

/**
 * @param {import('eslint').ESLint.LintResult[]} results
 * @param {string} cwd
 */
function tally(results, cwd) {
  /** @type {Map<string, {severity: number, sites: string[]}>} */
  const byRule = new Map();
  const fatals = [];

  for (const result of results) {
    for (const message of result.messages) {
      const where = `${path.relative(cwd, result.filePath)}:${message.line}:${message.column}`;
      if (message.fatal) {
        fatals.push(`${where}  ${message.message}`);
        continue;
      }
      // A directive report — an unused or redundant `eslint-disable` — carries no
      // ruleId, because it is about the comment rather than about the code. It is
      // still a finding with a count, so it gets a pseudo-rule id it can be
      // baselined and gated under (FR-020).
      const ruleId = message.ruleId ?? DIRECTIVE_RULE;
      const seen = byRule.get(ruleId) ?? { severity: message.severity, sites: [] };
      seen.severity = Math.max(seen.severity, message.severity);
      seen.sites.push(`${where}  ${message.message}`);
      byRule.set(ruleId, seen);
    }
  }

  return { byRule, fatals };
}

/** How many files a regression message names before it summarises the rest. */
const FILES_SHOWN = 10;

/**
 * Which files carry a rule's findings, most first. A regression message used to
 * print `sites.slice(recorded)` under the heading "New sites", which is arithmetic
 * masquerading as identification: the sites are ordered by traversal, so slicing at
 * the recorded count names whichever files happen to sort last. It named an
 * untouched visual spec as the new site of a finding added in `src`. Naming the
 * wrong file is worse than naming none, so this says only what a count can support.
 *
 * @param {{sites: string[]} | undefined} found
 * @returns {string} indented lines, one per file, newline-terminated
 */
function byFile(found) {
  if (!found) return '';
  const counts = new Map();
  for (const site of found.sites) {
    const file = site.slice(0, site.indexOf(':'));
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = ordered
    .slice(0, FILES_SHOWN)
    .map(([file, count]) => `        ${String(count).padStart(4)}  ${file}\n`)
    .join('');
  const rest = ordered.length - FILES_SHOWN;
  return rest > 0 ? `${shown}        and ${rest} more file(s)\n` : shown;
}

async function main() {
  const [treeName, ...flags] = process.argv.slice(2);
  const tree = TREES[treeName];
  if (!tree) {
    process.stderr.write(`usage: node scripts/lint.mjs <host|webview> [--sites] [--census]\n`);
    process.exit(2);
  }

  const showSites = flags.includes('--sites');
  const censusOnly = flags.includes('--census');

  const eslint = new ESLint({
    cwd: tree.cwd,
    overrideConfigFile: true,
    overrideConfig: await tree.config(),
    errorOnUnmatchedPattern: false,
    warnIgnored: false
  });

  const targets = [...tree.dirs, ...rootFiles(tree.cwd)];
  const results = await eslint.lintFiles(targets);
  const { byRule, fatals } = tally(results, tree.cwd);
  const baseline = readBaseline(treeName);

  if (censusOnly) {
    const ordered = [...byRule.entries()].sort((a, b) => b[1].sites.length - a[1].sites.length);
    process.stdout.write(`[lint:${treeName}] census over ${results.length} files\n`);
    for (const [ruleId, { severity, sites }] of ordered) {
      process.stdout.write(
        `  ${String(sites.length).padStart(5)}  ${severity === 2 ? 'error' : 'warn '}  ${ruleId}\n`
      );
      if (showSites) {
        for (const site of sites) process.stdout.write(`           ${site}\n`);
      }
    }
    for (const fatal of fatals) process.stdout.write(`  FATAL  ${fatal}\n`);
    return 0;
  }

  const failures = [];

  for (const fatal of fatals) {
    failures.push(`parse failure  ${fatal}`);
  }

  // Baselined rules: one summary line each, and a comparison that fails in both
  // directions. A count above the record is a regression; a count below it is a
  // stale record that would let the next regression hide behind this fix
  // (FR-010b, FR-014, FR-015, SC-013b).
  for (const [ruleId, entry] of Object.entries(baseline.rules)) {
    const recorded = entry[treeName];
    const found = byRule.get(ruleId);
    const actual = found ? found.sites.length : 0;
    process.stdout.write(`  ${ruleId}: ${actual}/${recorded} baselined\n`);

    if (actual > recorded) {
      failures.push(
        `${ruleId} rose from ${recorded} to ${actual} in ${treeName}: a regression. ` +
          `Fix the new site(s) or, if they are deliberate, raise the record and say why ` +
          `in its reductionNote.\n` +
          `      The record holds a count, not a list of sites, so it cannot say which ` +
          `${actual - recorded} of the ${actual} are new. Where they are:\n` +
          byFile(found) +
          `      To pinpoint: node scripts/lint.mjs ${treeName} --sites here and on the ` +
          `merge base, then diff.`
      );
    } else if (actual < recorded) {
      failures.push(
        `${ruleId} fell from ${recorded} to ${actual} in ${treeName}: the record is ` +
          `stale. Write ${actual} into tests/lint/eslint-baseline.json so the next ` +
          `regression cannot hide behind this fix.`
      );
    }
    if (showSites && found) {
      for (const site of found.sites) process.stdout.write(`      ${site}\n`);
    }
  }

  // Everything not baselined must be at zero if it is an error, and is printed in
  // full if it is a warning — an unbudgeted warning is one nobody has decided
  // about yet, so it stays visible.
  for (const [ruleId, { severity, sites }] of byRule) {
    if (ruleId in baseline.rules) continue;
    const label = severity === 2 ? 'error' : 'warning';
    process.stdout.write(`  ${ruleId}: ${sites.length} ${label}${sites.length === 1 ? '' : 's'}\n`);
    for (const site of sites) process.stdout.write(`      ${site}\n`);
    if (severity === 2) {
      failures.push(`${ruleId} reported ${sites.length} error-severity finding(s)`);
    }
  }

  if (failures.length > 0) {
    process.stderr.write(`\n[lint:${treeName}] FAILED\n`);
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    return 1;
  }

  process.stdout.write(`[lint:${treeName}] clean over ${results.length} files\n`);
  return 0;
}

process.exitCode = await main();
