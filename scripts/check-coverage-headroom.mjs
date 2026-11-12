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
// Run as part of both `test:coverage` scripts, after the coverage run has written its report:
// `node scripts/check-coverage-headroom.mjs` checks the webview, and `... host` the host suite
// (review gap GC-17: the host floors had sat 10-13 points below measured with no ratchet).
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokedAsScript } from './invoked-as-script.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Where each suite's raw report and floors live, relative to the repository root. */
export const COVERAGE_TARGETS = Object.freeze({
  webview: Object.freeze({ report: 'webview-ui/coverage/coverage-final.json', config: 'webview-ui/vitest.config.ts' }),
  host: Object.freeze({ report: 'coverage/coverage-final.json', config: 'vitest.config.ts' })
});

/** The headroom the floors are meant to carry, in percentage points. */
export const HEADROOM = 5;

/**
 * How far below the intended floor a configured one may sit before this fails.
 *
 * Zero would make every fractional movement in coverage a red build, which is
 * the churn the headroom exists to prevent. One point means a floor may lag by
 * at most a point before it must be banked.
 */
export const TOLERANCE = 1;

export const METRICS = Object.freeze(['statements', 'branches', 'functions', 'lines']);

/** Measured percentages, computed from a raw `coverage-final.json` object rather than a summary. */
export function measuredPercentages(report) {
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

/** The floors a vitest config's `thresholds` block declares; `null` when it has no such block. */
export function declaredFloors(source) {
  const block = /thresholds:\s*\{([^}]*)\}/.exec(source);
  if (block === null) return null;
  const floors = {};
  for (const [, metric, value] of block[1].matchAll(/(\w+)\s*:\s*(\d+)/g)) {
    floors[metric] = Number(value);
  }
  return floors;
}

/** One line per metric whose floor lags `floor(measured) - HEADROOM` by more than the tolerance. */
export function staleFloors(measured, floors) {
  const stale = [];
  for (const metric of METRICS) {
    const intended = Math.floor(measured[metric]) - HEADROOM;
    if (floors[metric] < intended - TOLERANCE) {
      stale.push(
        `${metric}: measured ${measured[metric].toFixed(2)}%, floor ${floors[metric]}, ` +
          `intended ${intended} (floor(measured) − ${HEADROOM})`
      );
    }
  }
  return stale;
}

function main(targetName) {
  if (!Object.hasOwn(COVERAGE_TARGETS, targetName)) {
    console.error(
      `coverage-headroom: unknown target "${targetName}"; expected one of ${Object.keys(COVERAGE_TARGETS).join(', ')}.`
    );
    return 2;
  }
  const { report, config } = COVERAGE_TARGETS[targetName];
  const now = measuredPercentages(JSON.parse(readFileSync(resolve(ROOT, report), 'utf8')));
  const floors = declaredFloors(readFileSync(resolve(ROOT, config), 'utf8'));
  if (floors === null) {
    console.error(
      `coverage-headroom: ${config} declares no \`thresholds\` block. This check reads the floors from there; if the ` +
        `config changed shape, teach it the new one rather than deleting the check.`
    );
    return 1;
  }

  const missing = METRICS.filter((m) => floors[m] === undefined);
  if (missing.length > 0) {
    console.error(`coverage-headroom: ${config} declares no floor for ${missing.join(', ')}.`);
    return 1;
  }

  const stale = staleFloors(now, floors);
  if (stale.length > 0) {
    console.error(`coverage-headroom (${targetName}): the floors have fallen behind the measurement.\n`);
    for (const line of stale) console.error(`  ${line}`);
    console.error(
      `\n  Raise them in ${config}. The ${HEADROOM}-point headroom is room for a legitimate refactor,` +
        `\n  not a place for coverage to quietly drain into: without this check, coverage could fall` +
        `\n  ${HEADROOM} points run after run and every run would stay green.` +
        `\n  Lowering a floor is still possible and still deliberate — it is an edit in a diff, which` +
        `\n  is where a decision to accept less coverage belongs.`
    );
    return 1;
  }

  console.log(
    `coverage-headroom (${targetName}): ok (${METRICS.map((m) => `${m} ${now[m].toFixed(2)}% ≥ ${floors[m]}`).join(', ')})`
  );
  return 0;
}

if (invokedAsScript(import.meta.url)) {
  process.exitCode = main(process.argv[2] ?? 'webview');
}
