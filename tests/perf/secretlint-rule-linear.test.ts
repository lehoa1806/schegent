import { beforeAll, describe, expect, it } from 'vitest';
import { mulberry32, pick } from '../fixtures/seeded-rng';

/**
 * FR-R4-F10 (contract SC2 "Cost"; tasks TA4, P2) -- the local secretlint rule does work in
 * proportion to the text it reads.
 *
 * WHY IT EXISTS. The rule scans every tracked file on every `security:secrets` run and every staged
 * path on every commit, so a pattern that backtracks on near-match input would let one hostile file
 * stall the scan and, through the hook, every commit. The runtime redactor had exactly that defect in
 * two expressions (research R13). Each of the rule's expressions either starts only at the start of
 * a run of its token class or has bounded repeats, and this file holds that to a number: one
 * 1,048,576-unit run of near-matches per family, built from fixed seeds, must be read in under 250 ms
 * (the median of 7, with one retake). It runs under `vitest.perf.config.ts`, single-threaded, and
 * never in `test:host`, because a wall-clock assertion has no place in the hermetic suite (FR-R3-042).
 * `tests/perf/budgets.json` indexes the ceiling.
 *
 * The functional cases for the same function are in `tests/unit/build/secretlint-rule-schegent.test.ts`.
 * Each run prints its seed and median, so a failure reproduces from the seed alone.
 */

/** The size of one run, in UTF-16 units: the line bound the runtime redactor is held to. */
const RUN_UNITS = 1_048_576;
/** The ceiling for one `findLocalSecrets` call over one run. */
const RULE_CEILING_MS = 250;
const SAMPLES = 7;
/** A failed take is repeated once: preemption only adds time. */
const MAX_TAKES = 2;

/** The password word, assembled so this file holds no `<word>=` text for the repository's own scan to report. */
const WORD = ['pass', 'word'].join('');

/** Near-miss fragments per family: each begins a match that cannot complete, or completes it cheaply. */
const FAMILIES: ReadonlyArray<{ readonly name: string; readonly seed: number; readonly fragments: readonly string[] }> = [
  {
    name: 'anthropic',
    seed: 257_001,
    fragments: ['sk-ant-api03-', 'sk-ant-', 'sk-ant-admin01-', 'ZqK8vR2mN7pL4wT9yB6cD1fH5jX0aS7u', '-', '_', ' ', '\n', 'sk-ant-api03-short ']
  },
  {
    name: 'jwt',
    seed: 257_002,
    fragments: ['eyJ', 'eyJhbGciOiJIUzI1NiJ9', '.', 'eyJ.', '-', '_', 'x', ' ', '\n', 'eyJhbGci.eyJ']
  },
  {
    name: 'password-assignment',
    seed: 257_003,
    fragments: [
      `${WORD}=`,
      `${WORD.toUpperCase()}=`,
      `db_${WORD}: `,
      `db_${WORD}: '`,
      `${WORD}="`,
      '"',
      "'",
      '   ',
      'abcdefg',
      '\n',
      `MY_DB_${WORD.toUpperCase()}=`
    ]
  },
  {
    name: 'password-whitespace',
    seed: 257_004,
    fragments: [WORD, 'passwd', ' ', '        ', ':', '=', '\t', '\n']
  }
];

/** Join seeded fragments, then cut to exactly `length` units. */
function buildRun(seed: number, fragments: readonly string[], length: number): string {
  const rng = mulberry32(seed);
  const parts: string[] = [];
  let total = 0;
  while (total < length) {
    const fragment = pick(rng, fragments);
    parts.push(fragment);
    total += fragment.length;
  }
  return parts.join('').slice(0, length);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

function timeOnce(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

const loadRule = () => import('../../scripts/secretlint-rule-schegent.mjs');
type RuleModule = Awaited<ReturnType<typeof loadRule>>;
let rule: RuleModule;

beforeAll(async () => {
  rule = await loadRule();
});

describe('findLocalSecrets reads a 1 MiB near-match run in under 250 ms, per family', () => {
  it.each(FAMILIES.map((family) => [family.name, family] as const))('%s', (_name, family) => {
    const text = buildRun(family.seed, family.fragments, RUN_UNITS);
    expect(text.length).toBe(RUN_UNITS);
    const run = () => {
      rule.findLocalSecrets(text, 'near-match.txt', {});
    };
    run();
    let medianMs = Number.POSITIVE_INFINITY;
    for (let take = 0; take < MAX_TAKES && medianMs > RULE_CEILING_MS; take += 1) {
      medianMs = median(Array.from({ length: SAMPLES }, () => timeOnce(run)));
    }
    console.log(
      `[FR-R4-F10 P2] ${family.name}: seed ${family.seed}, ${RUN_UNITS} units, median of ${SAMPLES} = ${medianMs.toFixed(1)} ms (ceiling ${RULE_CEILING_MS} ms)`
    );
    expect(medianMs, `seed ${family.seed}`).toBeLessThan(RULE_CEILING_MS);
  }, 120_000);
});
