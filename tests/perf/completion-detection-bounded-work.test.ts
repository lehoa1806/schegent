import { describe, expect, it } from 'vitest';
import { parseAuditLogBlock } from '../../src/parser/audit-log-parser';
import { parseInvocation, type ParseInputs } from '../../src/parser/stdout-parser';
import { mulberry32, pick } from '../fixtures/seeded-rng';

/**
 * FR-R4-F12 (contract CI6; FR-023; tests-and-gates P1) -- deciding whether a Phase completed does
 * work in proportion to its input, on hostile output, at the sizes the host actually delivers.
 *
 * WHY IT EXISTS. `parseAuditLogBlock` and `parseInvocation` read every captured byte of a turn. The
 * stream retention bound is 64 MiB, and the completion decision splits the text, scans each line for
 * a token and, since FR-R4-F12, reports tokens it does not accept. A scan that restarts from each
 * hostile fragment would let one crafted turn stall the extension host. At plan the worst of the
 * five shapes below took 295.7 ms at 16 MiB with a 16/8 MiB ratio of 2.4 (research R0).
 *
 * WHAT IS BUDGETED. For each of five seeded shapes and each of two policies (defaulted, and
 * `best-effort`, which adds the last-line scan): the median of 3 runs of `parseAuditLogBlock` plus
 * `parseInvocation` at 8 MiB and at 16 MiB. At most 1,500 ms at 16 MiB, and a 16/8 MiB ratio of at
 * most 3.0. Linear work doubles per doubling; quadratic work quadruples, and the ratio cancels the
 * machine's speed.
 *
 * THE CONTROL. `quadraticReferenceScan` restarts a scan to the end of the text from every token
 * opener, which is quadratic. It is run on the same `[SCHEGENT_STATUS:` run shape, capped to the
 * first 1/64 of each input (128 KiB and 256 KiB) so that it stops after a bounded time, and it must
 * report a ratio ABOVE 3.0. A check that cannot tell quadratic from linear here proves nothing.
 *
 * Fixed seeds are printed, so a failure reproduces from its seed alone. This runs under
 * `vitest.perf.config.ts`, single-threaded, and never in `test:host` (FR-R3-042).
 */
const MIB = 1024 * 1024;
/** The largest input: the perf case that already distinguishes linear from quadratic. */
const FULL_BYTES = 16 * MIB;
const HALF_BYTES = 8 * MIB;
/** The budget at 16 MiB for one parse, in milliseconds. About 5 times today's worst shape. */
const MAX_MS_AT_16_MIB = 1_500;
/** The largest 16/8 MiB time ratio a linear scan may show. */
const MAX_DOUBLING_RATIO = 3.0;
const RUNS_PER_MEDIAN = 3;
/** A measurement is retaken once when it fails: preemption only adds time. */
const MAX_TAKES = 2;
const TEST_TIMEOUT_MS = 120_000;
/** The reference scan reads this fraction of each input, so its quadratic work stays bounded. */
const ORACLE_PREFIX_DIVISOR = 64;
const SEED = 259_039;

const OPEN = '=== SCHEGENT AUDIT LOG ===';
const CLOSE = '=== END AUDIT LOG ===';
const TOKEN = '[SCHEGENT_STATUS: CLEAR]';

type Generator = (rng: () => number, bytes: number) => string;

interface Shape {
  readonly id: string;
  readonly seed: number;
  readonly generate: Generator;
}

/** Join pieces chosen by `rng` until `bytes`, then cut to exactly `bytes`. */
function build(rng: () => number, bytes: number, pieces: readonly string[]): string {
  const parts: string[] = [];
  let total = 0;
  while (total < bytes) {
    const piece = pick(rng, pieces);
    parts.push(piece);
    total += piece.length;
  }
  return parts.join('').slice(0, bytes);
}

/** The five shapes of research R0. */
const SHAPES: readonly Shape[] = [
  {
    id: 'prose with scattered tokens',
    seed: SEED + 1,
    generate: (rng, bytes) =>
      build(rng, bytes, [
        'I read the file and the tests, and the change touches two modules.\n',
        'Next I will run the checks.\n',
        `Remember that the completion line reads ${TOKEN} at the very end.\n`,
        '\n'
      ])
  },
  {
    id: 'token-dense',
    seed: SEED + 2,
    generate: (rng, bytes) => build(rng, bytes, [`${TOKEN}\n`, `**${TOKEN}**\n`, `ok ${TOKEN} ok\n`])
  },
  {
    id: 'one long line',
    seed: SEED + 3,
    generate: (rng, bytes) => `${build(rng, bytes - TOKEN.length - 1, ['x', 'yy', ' z '])}\n${TOKEN}`
  },
  {
    id: 'token openers with no close',
    seed: SEED + 4,
    generate: (rng, bytes) => build(rng, bytes, ['[SCHEGENT_STATUS:', '[SCHEGENT_STATUS:   ', 'a'])
  },
  {
    id: 'CRLF audit markers',
    seed: SEED + 5,
    generate: (rng, bytes) =>
      build(rng, bytes, [`${OPEN}\r\n`, `${CLOSE}\r\n`, 'phase: speckit-implement\r\n', `${TOKEN}\r\n`])
  }
];

const POLICIES: ReadonlyArray<{ readonly name: string; readonly inputs: Partial<ParseInputs> }> = [
  { name: 'defaulted', inputs: {} },
  { name: 'best-effort', inputs: { evidencePolicy: 'best-effort' } }
];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

function timeOnce(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

/** The completion decision as the runner makes it: the audit parse, then the invocation parse. */
function decide(text: string, inputs: Partial<ParseInputs>): void {
  const audit = parseAuditLogBlock(text);
  parseInvocation({
    stdout: text,
    stderr: '',
    exitCode: 0,
    rateLimit: { matched: false, cause: '' },
    auditEntry: audit.entry,
    auditWarnings: audit.warnings,
    region: audit.region,
    ...inputs
  });
}

function medianMs(run: () => void): number {
  run();
  return median(Array.from({ length: RUNS_PER_MEDIAN }, () => timeOnce(run)));
}

function withRetake<T>(measure: () => T, passes: (taken: T) => boolean): T {
  let taken = measure();
  for (let take = 1; take < MAX_TAKES && !passes(taken); take += 1) taken = measure();
  return taken;
}

/**
 * A deliberately quadratic reference: from every token opener, scan on to the end of the text for
 * the closing bracket, restarting at each opener. Used only as the control.
 */
function quadraticReferenceScan(text: string): number {
  let found = 0;
  let from = text.indexOf('[SCHEGENT_STATUS:');
  while (from !== -1) {
    if (text.indexOf(']', from) !== -1) found += 1;
    from = text.indexOf('[SCHEGENT_STATUS:', from + 1);
  }
  return found;
}

console.log(
  `[FR-R4-F12 P1] Node ${process.version}; budget ${MAX_MS_AT_16_MIB} ms at 16 MiB, ratio <= ${MAX_DOUBLING_RATIO}, base seed ${SEED}`
);

describe('completion detection stays proportional to its input (FR-R4-F12, FR-023)', () => {
  it('declares five shapes with distinct integer seeds and two policies', () => {
    expect(SHAPES).toHaveLength(5);
    expect(new Set(SHAPES.map((shape) => shape.seed)).size).toBe(5);
    expect(SHAPES.every((shape) => Number.isInteger(shape.seed))).toBe(true);
    expect(POLICIES.map((policy) => policy.name)).toEqual(['defaulted', 'best-effort']);
  });

  describe.each(SHAPES)('shape: $id', (shape) => {
    const half = shape.generate(mulberry32(shape.seed), HALF_BYTES);
    const full = shape.generate(mulberry32(shape.seed), FULL_BYTES);

    it('generates exactly the sizes it measures', () => {
      expect(half.length).toBe(HALF_BYTES);
      expect(full.length).toBe(FULL_BYTES);
    });

    it.each(POLICIES)(
      '$name policy: at most 1,500 ms at 16 MiB, ratio at most 3.0',
      (policy) => {
        const taken = withRetake(
          () => ({
            halfMs: medianMs(() => decide(half, policy.inputs)),
            fullMs: medianMs(() => decide(full, policy.inputs))
          }),
          (t) => t.fullMs < MAX_MS_AT_16_MIB && t.fullMs / Math.max(t.halfMs, 0.001) <= MAX_DOUBLING_RATIO
        );
        const ratio = taken.fullMs / Math.max(taken.halfMs, 0.001);
        console.log(
          `[FR-R4-F12 P1] ${shape.id} / ${policy.name}: seed ${shape.seed}, 8 MiB ${taken.halfMs.toFixed(1)} ms, 16 MiB ${taken.fullMs.toFixed(1)} ms, ratio ${ratio.toFixed(2)}`
        );

        expect(taken.fullMs, `${shape.id} / ${policy.name}, seed ${shape.seed}`).toBeLessThan(MAX_MS_AT_16_MIB);
        expect(ratio, `${shape.id} / ${policy.name}, seed ${shape.seed}`).toBeLessThanOrEqual(MAX_DOUBLING_RATIO);
      },
      TEST_TIMEOUT_MS
    );
  });

  it(
    'control: a quadratic reference scan shows a ratio above 3.0 on the same run shape',
    () => {
      const runs = SHAPES.find((shape) => shape.id === 'token openers with no close') as Shape;
      const smallCap = runs.generate(mulberry32(runs.seed), HALF_BYTES).slice(0, HALF_BYTES / ORACLE_PREFIX_DIVISOR);
      const largeCap = runs.generate(mulberry32(runs.seed), FULL_BYTES).slice(0, FULL_BYTES / ORACLE_PREFIX_DIVISOR);

      const taken = withRetake(
        () => ({
          smallMs: medianMs(() => void quadraticReferenceScan(smallCap)),
          largeMs: medianMs(() => void quadraticReferenceScan(largeCap))
        }),
        (t) => t.largeMs / Math.max(t.smallMs, 0.001) > MAX_DOUBLING_RATIO
      );
      const ratio = taken.largeMs / Math.max(taken.smallMs, 0.001);
      console.log(
        `[FR-R4-F12 P1] control (quadratic reference, capped at 1/${ORACLE_PREFIX_DIVISOR}): ${smallCap.length} bytes ${taken.smallMs.toFixed(1)} ms, ${largeCap.length} bytes ${taken.largeMs.toFixed(1)} ms, ratio ${ratio.toFixed(2)}`
      );

      expect(ratio, 'the control must be able to fail the ratio check').toBeGreaterThan(MAX_DOUBLING_RATIO);
    },
    TEST_TIMEOUT_MS
  );
});
