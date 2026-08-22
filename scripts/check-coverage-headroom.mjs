#!/usr/bin/env node
// FR-R3-044 — the coverage floors must follow the measurement upward.
//
// `webview-ui/vitest.config.ts` sets each floor at `floor(measured) - 5`, and
// the five points are deliberate: pinning a floor to what the tree happens to
// measure today makes the next legitimate refactor red for nothing. The residual
// FR-R3-027 recorded is that nothing ever raises them. Coverage can fall four
// points, run after run, and every run stays green.
//
// This is the ratchet, expressed as an assertion rather than an automated edit.
// A configured floor more than the intended headroom below the measured value
// fails, so a rise in coverage must be banked by raising the floor. Lowering a
// floor stays possible and stays deliberate: it is an edit to a config file in a
// diff, which is exactly where a decision to accept less coverage belongs.
//
// Run as part of `test:coverage`, after the coverage run has written its report.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = 'webview-ui/coverage/coverage-final.json';
const CONFIG = 'webview-ui/vitest.config.ts';

/** The headroom the floors are meant to carry, in percentage points. */
const HEADROOM = 5;

/**
 * How far below the intended floor a configured one may sit before this fails.
 *
 * Zero would make every fractional movement in coverage a red build, which is
 * the churn the headroom exists to prevent. One point means a floor may lag by
 * at most a point before it must be banked.
 */
const TOLERANCE = 1;

function readJson(rel) {
  return JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8'));
}

/** Measured percentages, computed from the raw report rather than a summary. */
function measured() {
  const report = readJson(REPORT);
  const totals = { statements: [0, 0], branches: [0, 0], functions: [0, 0] };
  for (const record of Object.values(report)) {
    for (const [metric, counts] of [
      ['statements', record.s],
      ['functions', record.f]
    ]) {
      for (const hit of Object.values(counts ?? {})) {
        totals[metric][1] += 1;
        if (hit > 0) totals[metric][0] += 1;
      }
    }
    for (const hits of Object.values(record.b ?? {})) {
      for (const hit of hits) {
        totals.branches[1] += 1;
        if (hit > 0) totals.branches[0] += 1;
      }
    }
  }
  const pct = ([covered, total]) => (total === 0 ? 100 : (covered / total) * 100);
  const statements = pct(totals.statements);
  return {
    statements,
    branches: pct(totals.branches),
    functions: pct(totals.functions),
    // v8 reports lines and statements as the same measure; the config records
    // this, and computing it twice would invite the two to disagree.
    lines: statements
  };
}

/** The floors the config declares. */
function configured() {
  const source = readFileSync(resolve(ROOT, CONFIG), 'utf8');
  const block = /thresholds:\s*\{([^}]*)\}/.exec(source);
  if (block === null) {
    throw new Error(
      `${CONFIG} declares no \`thresholds\` block. This check reads the floors from there; if the ` +
        `config changed shape, teach it the new one rather than deleting the check.`
    );
  }
  const floors = {};
  for (const [, metric, value] of block[1].matchAll(/(\w+)\s*:\s*(\d+)/g)) {
    floors[metric] = Number(value);
  }
  return floors;
}

const now = measured();
const floors = configured();
const metrics = ['statements', 'branches', 'functions', 'lines'];

const missing = metrics.filter((m) => floors[m] === undefined);
if (missing.length > 0) {
  console.error(`coverage-headroom: ${CONFIG} declares no floor for ${missing.join(', ')}.`);
  process.exit(1);
}

const stale = [];
for (const metric of metrics) {
  const intended = Math.floor(now[metric]) - HEADROOM;
  if (floors[metric] < intended - TOLERANCE) {
    stale.push(
      `${metric}: measured ${now[metric].toFixed(2)}%, floor ${floors[metric]}, ` +
        `intended ${intended} (floor(measured) − ${HEADROOM})`
    );
  }
}

if (stale.length > 0) {
  console.error('coverage-headroom: the floors have fallen behind the measurement.\n');
  for (const line of stale) console.error(`  ${line}`);
  console.error(
    `\n  Raise them in ${CONFIG}. The ${HEADROOM}-point headroom is room for a legitimate refactor,` +
      `\n  not a place for coverage to quietly drain into: without this check, coverage could fall` +
      `\n  ${HEADROOM} points run after run and every run would stay green.` +
      `\n  Lowering a floor is still possible and still deliberate — it is an edit in a diff, which` +
      `\n  is where a decision to accept less coverage belongs.`
  );
  process.exit(1);
}

console.log(
  `coverage-headroom: ok (${metrics
    .map((m) => `${m} ${now[m].toFixed(2)}% ≥ ${floors[m]}`)
    .join(', ')})`
);
