import { describe, expect, it } from 'vitest';

import { parseDocumentBytes } from '../../src/services/process-yaml/yaml-parser';

/**
 * FR-R4-F07 (feature 254, S-T1, contract S3, research R2; FR-001, FR-008, SC-001) — the process-YAML
 * scanner does work in proportion to the line it reads.
 *
 * The scanner's two trims were backtracking regular expressions: `/ +$/` on a plain scalar and
 * `/ +#.*$/` then `/ +$/` on a block-literal header. A document of one line holding twenty thousand
 * spaces held the host for about 650 ms, and the cost quadrupled with every doubling. The 1 MiB size
 * cap bounds the file and not the line, so one hostile line could cost minutes.
 *
 * The gate is a ratio and not a time. Each doubling of the hostile run (5k, 10k, 20k spaces) may cost
 * at most 3.0 times the one before it: linear work doubles, quadratic work quadruples, and the ratio
 * cancels the speed of the machine running it. The oracle is the pair of regexes the scanner used to
 * have, kept verbatim below; the same harness must show THEIR ratio above 3.0, which proves the gate
 * can tell quadratic from linear on the machine running it. Without that control a gate that measured
 * nothing would pass.
 *
 * The 20k median is logged, not asserted: SC-001 targets under 50 ms, and an absolute time is a
 * property of the machine. `tests/perf/budgets.json` indexes this file.
 *
 * Wall-clock assertions run under `vitest.perf.config.ts` (single-threaded) and never in `test:host`
 * (FR-R3-042). The index is `tests/perf/budgets.json`.
 */

/** The ratio a doubling may reach before the work is called super-linear. */
const MAX_DOUBLING_RATIO = 3.0;
/** Samples per size; the assertion is their median. */
const SAMPLES = 7;
/** A sample batch must take at least this long at the smallest size, so timer resolution cannot rule. */
const MIN_BATCH_MS = 2;
/** A failed ratio is taken again, once: preemption and garbage collection only add time. */
const MAX_TAKES = 2;
/** The ceiling on a calibrated batch, so a very fast scan cannot make a sample run for seconds. */
const MAX_BATCH = 20_000;

const GATED_SIZES = [5_000, 10_000, 20_000] as const;
const ORACLE_SIZES = [2_500, 5_000, 10_000] as const;

/** One hostile document shape: the document text for a run of `n` spaces. */
interface Shape {
  readonly name: string;
  readonly document: (spaces: string) => string;
}

/** Research R2's six shapes, accepted and refused. */
const SHAPES: readonly Shape[] = [
  { name: '1 key: a<spaces>b', document: (s) => `key: a${s}b\n` },
  { name: '2 key: a<spaces>', document: (s) => `key: a${s}\n` },
  { name: '3 key: a<spaces> #c', document: (s) => `key: a${s} #c\n` },
  { name: '4 key: |-<spaces>x', document: (s) => `key: |-${s}x\n` },
  { name: '5 key: |-<spaces> #c', document: (s) => `key: |-${s} #c\n` },
  { name: '6 - a<spaces>b', document: (s) => `- a${s}b\n` }
];

const ENCODER = new TextEncoder();

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

/** Time one call of `run`, in milliseconds. */
function timeOnce(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

/** How many calls make the smallest size take at least MIN_BATCH_MS. */
function calibrate(run: () => void): number {
  run();
  const single = Math.max(timeOnce(run), 0.0005);
  return Math.min(MAX_BATCH, Math.max(1, Math.ceil(MIN_BATCH_MS / single)));
}

/** The median time of SAMPLES batches of `batch` calls. */
function medianBatchMs(run: () => void, batch: number): number {
  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    samples.push(
      timeOnce(() => {
        for (let call = 0; call < batch; call++) run();
      })
    );
  }
  return median(samples);
}

interface Take {
  /** How many calls one sample timed. */
  readonly batch: number;
  /** The median batch time at each size, in the order of `sizes`. */
  readonly medians: readonly number[];
  /** `medians[i + 1] / medians[i]`: the cost of each doubling. */
  readonly ratios: readonly number[];
}

/** One measurement: a batch size taken at the smallest size, then a median per size. */
function measure(runnerFor: (spaces: number) => () => void, sizes: readonly number[]): Take {
  const batch = calibrate(runnerFor(sizes[0] as number));
  const medians = sizes.map((size) => medianBatchMs(runnerFor(size), batch));
  const ratios = medians.slice(1).map((value, i) => value / (medians[i] as number));
  return { batch, medians, ratios };
}

/**
 * Measure, and measure once more if `passes` rejects the first take. The better take is kept: a
 * preempted sample can only make a ratio look worse for linear work, and cannot make quadratic
 * work look linear.
 */
function measureWithRetake(
  runnerFor: (spaces: number) => () => void,
  sizes: readonly number[],
  passes: (ratios: readonly number[]) => boolean
): Take {
  let last = measure(runnerFor, sizes);
  for (let take = 1; take < MAX_TAKES && !passes(last.ratios); take++) {
    last = measure(runnerFor, sizes);
  }
  return last;
}

function scannerRunnerFor(shape: Shape): (spaces: number) => () => void {
  return (spaces) => {
    const bytes = ENCODER.encode(shape.document(' '.repeat(spaces)));
    return () => {
      parseDocumentBytes(bytes);
    };
  };
}

/** The two trims the scanner used to run, verbatim (`yaml-scanner.ts` at c744874f, `:343`, `:462`). */
const ORACLE_SHAPES: ReadonlyArray<{ readonly name: string; readonly run: (spaces: string) => () => void }> = [
  {
    name: '1 plain trim: /\\ +$/ on a<spaces>b',
    run: (s) => {
      const value = `a${s}b`;
      return () => {
        value.replace(/ +$/, '');
      };
    }
  },
  {
    name: '4 header pair on |-<spaces>x',
    run: (s) => {
      const value = `|-${s}x`;
      return () => {
        value.replace(/ +#.*$/, '').replace(/ +$/, '');
      };
    }
  }
];

describe('FR-R4-F07 S-T1 — the process-YAML scanner is linear on a hostile line', () => {
  // A scan of 20k spaces on quadratic code takes about a second, so the body of each case is long.
  const TIMEOUT_MS = 180_000;

  it.each(SHAPES)(
    'shape $name: each doubling costs at most 3.0 times the one before',
    (shape) => {
      const take = measureWithRetake(scannerRunnerFor(shape), GATED_SIZES, (ratios) =>
        ratios.every((ratio) => ratio <= MAX_DOUBLING_RATIO)
      );
      console.info(
        `[S-T1] shape ${shape.name}: median per scan at 5k/10k/20k spaces = ` +
          `${take.medians.map((value) => (value / take.batch).toFixed(4)).join(' / ')} ms ` +
          `(batch ${take.batch}); ratios ${take.ratios.map((ratio) => ratio.toFixed(2)).join(', ')}`
      );
      for (const ratio of take.ratios) {
        expect(ratio).toBeLessThanOrEqual(MAX_DOUBLING_RATIO);
      }
    },
    TIMEOUT_MS
  );

  it.each(ORACLE_SHAPES)(
    'oracle control, the old regexes, shape $name: a doubling costs MORE than 3.0 times',
    (oracle) => {
      const runnerFor = (spaces: number): (() => void) => oracle.run(' '.repeat(spaces));
      const take = measureWithRetake(runnerFor, ORACLE_SIZES, (ratios) =>
        ratios.every((ratio) => ratio > MAX_DOUBLING_RATIO)
      );
      console.info(
        `[S-T1 oracle] ${oracle.name}: median per run at 2.5k/5k/10k spaces = ` +
          `${take.medians.map((value) => (value / take.batch).toFixed(3)).join(' / ')} ms; ` +
          `ratios ${take.ratios.map((ratio) => ratio.toFixed(2)).join(', ')}`
      );
      for (const ratio of take.ratios) {
        expect(ratio).toBeGreaterThan(MAX_DOUBLING_RATIO);
      }
    },
    TIMEOUT_MS
  );
});
