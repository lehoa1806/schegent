#!/usr/bin/env node
// FR-R3-088 §5 — two coverage figures where there was one.
//
// THE CONCERN, in the reviewer brief's words: "A large share of the round's
// host-test growth is lint gates and their own vacuity controls — tests about
// the test suite. Coverage of product behaviour may not have moved at all, and
// it was never measured separately."
//
// THE RULE, and it is a rule a reader can apply rather than a hand-maintained
// list:
//
//   A test that IMPORTS a module under `src/` or `webview-ui/src/` executes
//   product code. It is a test **about the product**, and it is the only kind
//   that can move `src/**` coverage.
//
//   A test that imports no such module is a test **about the test suite**. It
//   reads source TEXT — with readFileSync, a directory walk, a regex — and
//   asserts a property of the tree. It executes no product statement, so it
//   contributes nothing to coverage no matter how many of them exist.
//
// That is why the split matters and why it is mechanical: the second kind can
// grow without limit while the first stands still, and a single reported
// coverage number cannot tell those apart. The rule needs no list, no
// annotation, and no author's intent — only the import graph.
//
// WHAT THIS DOES NOT MEASURE, printed with the result: a behavioural test that
// imports a module and asserts almost nothing about it still counts as
// behavioural here. This splits tests by what they CAN cover, not by how well
// they cover it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'dist', 'coverage', '.git', '__screenshots__']);

/** Every test file under a root. */
function testFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(test|spec)\.ts$/.test(entry.name)) out.push(full);
    }
  };
  if (statSyncSafe(root)) walk(root);
  return out;
}

function statSyncSafe(target) {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

/** Does this test import a module under src/ or webview-ui/src/? */
const IMPORTS_PRODUCT =
  /(?:^|\n)\s*(?:import|export)[^;\n]*from\s+['"][^'"]*(?:\.\.\/)*(?:src|webview-ui\/src)\/[^'"]+['"]/;
/** `vi.mock('../../src/...')` and `await import('../../src/...')` count too. */
const DYNAMIC_PRODUCT = /(?:vi\.mock|await import|require)\(\s*['"][^'"]*(?:src|webview-ui\/src)\/[^'"]+['"]/;

function classify(file) {
  const source = readFileSync(file, 'utf8');
  const executes = IMPORTS_PRODUCT.test(source) || DYNAMIC_PRODUCT.test(source);
  const cases = (source.match(/^\s*(?:it|test)(?:\.\w+)*\s*\(/gm) ?? []).length;
  return { file: path.relative(REPO_ROOT, file).replaceAll('\\', '/'), executes, cases };
}

const roots = [
  path.join(REPO_ROOT, 'tests'),
  path.join(REPO_ROOT, 'webview-ui', 'src'),
  path.join(REPO_ROOT, 'webview-ui', 'tests')
];
const classified = roots.flatMap((root) => testFiles(root)).map(classify);

const product = classified.filter((entry) => entry.executes);
const suite = classified.filter((entry) => !entry.executes);
const sum = (entries) => entries.reduce((total, entry) => total + entry.cases, 0);

const pct = (part, whole) => (whole === 0 ? '0.0' : ((part / whole) * 100).toFixed(1));

process.stdout.write(
  `test-census — FR-R3-088 §5, two figures where there was one\n\n` +
    `  ABOUT THE PRODUCT   ${String(product.length).padStart(4)} file(s)  ` +
    `${String(sum(product)).padStart(5)} case(s)   ` +
    `${pct(sum(product), sum(classified))}% of cases\n` +
    `  ABOUT THE SUITE     ${String(suite.length).padStart(4)} file(s)  ` +
    `${String(sum(suite)).padStart(5)} case(s)   ` +
    `${pct(sum(suite), sum(classified))}% of cases\n` +
    `  TOTAL               ${String(classified.length).padStart(4)} file(s)  ` +
    `${String(sum(classified)).padStart(5)} case(s)\n\n` +
    `  RULE: a test that imports a module under src/ or webview-ui/src/ executes product\n` +
    `  code and is ABOUT THE PRODUCT. One that imports none reads source TEXT and is ABOUT\n` +
    `  THE SUITE. Only the first kind can move src/** coverage, which is why a single\n` +
    `  reported number cannot tell the two apart.\n\n` +
    `  NOT measured: how WELL a behavioural test covers what it imports. This splits tests\n` +
    `  by what they CAN cover, not by how much they do.\n`
);

if (process.argv.includes('--list-suite')) {
  process.stdout.write('\n  tests about the suite:\n');
  for (const entry of suite) process.stdout.write(`    ${entry.file}\n`);
}
