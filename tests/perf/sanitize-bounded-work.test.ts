import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_LINE_UNITS } from '../../src/lib/line-framer';
import { KeyBlockLineRedactor, REDACTION_SENTINEL, SanitizedLogger, isSecretKeyName } from '../../src/lib/logger';
import { MAX_ARTIFACT_BYTES } from '../../src/services/evidence-export';
import { mulberry32, pick } from '../fixtures/seeded-rng';

/**
 * FR-R4-F10 (contract BD1 to BD6; data-model section 6; clarify Q2; SC-005; FR-027 to FR-030; tasks TA6)
 * -- sanitization does work in proportion to its input, on hostile input, at the two bounds the host
 * actually delivers.
 *
 * WHY IT EXISTS. `sanitize()` runs on every log line, every audit entry and every exported artifact. A
 * redaction expression that backtracks on near-match input lets one hostile line stall the extension host:
 * at plan time the JWT expression took 10.8 s for one 128 Ki line (about 11 minutes extrapolated to the
 * 1 MiB a line sink admits), and the GCP envelope expression 1.85 s at 1 MiB (research R13). Two exports
 * sanitize a whole 16 MiB artifact in one call (R14). So this file declares both bounds, imports them
 * rather than retyping them, and holds every generator to three assertions: a line-sized call under 250 ms,
 * a full-over-half ratio of at most 3.0, and, for three generators, an artifact-sized call under 4,000 ms.
 *
 * THE LADDER (TA6). Run naively, a quadratic expression would hang this test for minutes or hours. Each
 * generator climbs: one probe at 65,536 units, which fails at once when it exceeds the line ceiling; then
 * the half and full line sizes, only after the probe passed; then the artifact size, only after both line
 * assertions passed. A rung that is not reached fails the test and names the rung. It never passes.
 *
 * THE CONTROL (BD4). `QUADRATIC_ORACLE` is the JWT expression as it stood before this feature, kept
 * verbatim. The same measurement over it must report a ratio ABOVE 3.0, or the test fails as vacuous: a
 * check that cannot tell quadratic from linear on this machine proves nothing. Linear work doubles per
 * doubling and quadratic work quadruples, and the ratio cancels the machine's speed.
 *
 * Fixed seeds are printed on every run, so a failure reproduces from its seed alone (BD6). This runs
 * under `vitest.perf.config.ts`, single-threaded, and never in `test:host` (FR-R3-042).
 */
const BOUND = {
  lineBoundUnits: DEFAULT_MAX_LINE_UNITS,
  artifactBoundUnits: MAX_ARTIFACT_BYTES,
  lineCeilingMs: 250,
  artifactCeilingMs: 4_000,
  maxDoublingRatio: 3.0,
  samples: 7,
  maxTakes: 2,
  probeUnits: 65_536,
  oracleSizes: [4_096, 8_192, 16_384] as const,
  machine: 'Apple M1 Pro, 32 GiB, macOS 27.0.1, Node 24.19.0'
} as const;
const TEST_TIMEOUT_MS = 120_000;
/** A single full-size sample this many times the ceiling fails the test without taking medians. */
const SCREEN_MULTIPLE = 4;

/** The JWT expression before this feature (`src/lib/logger.ts` at `a75eb26b`), verbatim. */
const QUADRATIC_ORACLE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

const logger = new SanitizedLogger();

type Generator = (rng: () => number, length: number) => string;

interface Case {
  readonly id: string;
  readonly seed: number;
  readonly generate: Generator;
  /** Whether the artifact rung applies (one sample, for G1 `eyJ`, G2 and G8 only). */
  readonly artifact: boolean;
  /** How the generated text is delivered: one `sanitize` call, or line by line through the key-block redactor. */
  readonly delivery: 'string' | 'lines';
}

/** Join pieces chosen by `rng` until `length` units, then cut to exactly `length`. */
function build(rng: () => number, length: number, pieces: readonly string[]): string {
  const parts: string[] = [];
  let total = 0;
  while (total < length) {
    const piece = pick(rng, pieces);
    parts.push(piece);
    total += piece.length;
  }
  return parts.join('').slice(0, length);
}

/** G1: near-match repetition of one prefix, with seeded short fills, so the expression starts often and rarely finishes. */
function nearMatch(prefix: string, fills: readonly string[]): Generator {
  return (rng, length) => build(rng, length, [prefix, ...fills.map((fill) => `${prefix}${fill}`)]);
}

const TOKEN_FILL = 'ZqK8vR2mN7pL4wT9yB6cD1fH5jX0aS7u';

/**
 * G1 `eyJ`: one unbroken run of token characters made of `eyJ` repeated, with nothing in it that ends the
 * run. This is the shape that made the old JWT expression quadratic: from every `eyJ` it scans to the end
 * of the run looking for a `.`. Pieces that contain a `.` or a space would keep ending the run and hide it.
 */
const unbrokenEyJ: Generator = (rng, length) => build(rng, length, ['eyJ', 'eyJ-', 'eyJ_', 'eyJa']);
const BEGIN = ['-----', 'BEGIN RSA PRIVATE', ' KEY-----'].join('');
const BEGIN_X = '-----BEGIN X-----';
const BEGIN_Y = '-----BEGIN Y-----';
const END = ['-----', 'END RSA PRIVATE', ' KEY-----'].join('');

/**
 * G8: a seeded interleaving of whole chunks (4 Ki to 64 Ki units) of the G1 to G6 generators' output. Whole
 * chunks, and not single fragments, because a fragment such as a space ends every token run and a random
 * mix of fragments is therefore never hostile; a chunk keeps its own run.
 */
function interleave(rng: () => number, length: number): string {
  const sources = BASE_GENERATORS.map((testCase) => testCase.generate);
  const parts: string[] = [];
  let total = 0;
  while (total < length) {
    const chunk = 4_096 * (1 + Math.floor(rng() * 16));
    const part = pick(rng, sources)(rng, chunk);
    parts.push(part);
    total += part.length;
  }
  return parts.join('').slice(0, length);
}

/** G1 to G8 as contract BD2 lists them. */
const CASES: readonly Case[] = [
  { id: 'G1 eyJ', seed: 257_101, artifact: true, delivery: 'string', generate: unbrokenEyJ },
  { id: 'G1 sk-', seed: 257_102, artifact: false, delivery: 'string', generate: nearMatch('sk-', ['', 'ant-', '-', TOKEN_FILL.slice(0, 18)]) },
  { id: 'G1 ghp_ and gho_', seed: 257_103, artifact: false, delivery: 'string', generate: (rng, n) => build(rng, n, ['ghp_', 'gho_', 'ghp_Zq3K8', 'gho_', '_']) },
  { id: 'G1 xoxb-', seed: 257_104, artifact: false, delivery: 'string', generate: nearMatch('xoxb-', ['', '1', '-12', '-1-']) },
  { id: 'G1 AKIA', seed: 257_105, artifact: false, delivery: 'string', generate: nearMatch('AKIA', ['', 'ZQ3K8VR2MN7PL4W', 'ZQ3K8VR2MN7PL4WTX']) },
  { id: 'G1 npm_', seed: 257_106, artifact: false, delivery: 'string', generate: nearMatch('npm_', ['', TOKEN_FILL.slice(0, 20), TOKEN_FILL.slice(0, 35)]) },
  { id: 'G1 Bearer', seed: 257_107, artifact: false, delivery: 'string', generate: nearMatch('Bearer ', ['', '  ', 'abc', '\t']) },
  { id: 'G1 https://u:', seed: 257_108, artifact: false, delivery: 'string', generate: nearMatch('https://u:', ['', ':', '@', 'p@ss', ':@:']) },
  { id: 'G1 password assignment', seed: 257_109, artifact: false, delivery: 'string', generate: nearMatch(`${['pass', 'word'].join('')}=`, ['', ' ', 'abc', '"']) },
  {
    id: 'G2 unterminated GCP envelope',
    seed: 257_102_000,
    artifact: true,
    delivery: 'string',
    generate: (rng, n) => {
      // The first half opens the envelope over and over; the second is ONE opening and a body with no
      // quote in it, which a lazy loop with no bound would hold a backtrack frame per character for.
      const head = build(rng, Math.floor(n / 2), [`"private_key": "${BEGIN_X}a`, `"private_key":"${BEGIN_Y}`, `-----END `]);
      const opening = `"private_key": "${BEGIN_X}`;
      return `${head}${opening}${'a'.repeat(Math.max(0, n - head.length - opening.length))}`;
    }
  },
  { id: 'G3 BEGIN header, with and without END', seed: 257_103_000, artifact: false, delivery: 'string', generate: (rng, n) => build(rng, n, [BEGIN, `${BEGIN}\nbody\n`, `${BEGIN}\nbody\n${END}\n`]) },
  { id: 'G4 URL with many separators', seed: 257_104_000, artifact: false, delivery: 'string', generate: (rng, n) => build(rng, n, ['https://u:', ':', '@', 'p', ':@', '@@']) },
  { id: 'G5 key/value run', seed: 257_105_000, artifact: false, delivery: 'string', generate: (rng, n) => build(rng, n, ['a=b;', '"k": "v",', 'k=v&', 'x: y\n']) },
  { id: 'G6 whitespace and keyword runs', seed: 257_106_000, artifact: false, delivery: 'string', generate: (rng, n) => build(rng, n, [' ', '        ', '\t', 'token        ', 'secret  ', 'password\t\t']) },
  {
    id: 'G7 multiline material through KeyBlockLineRedactor',
    seed: 257_107_000,
    artifact: false,
    delivery: 'lines',
    generate: (rng, n) => build(rng, n, [`${BEGIN}\n`, 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0t\n', `${END}\n`, 'ordinary line\n', `${BEGIN} ${END}\n`])
  },
  {
    id: 'G8 seeded interleaving of G1 to G6',
    seed: 257_108_000,
    artifact: true,
    delivery: 'string',
    generate: (rng, length) => interleave(rng, length)
  }
];

/** The generators G8 interleaves: everything but G7 and G8 themselves. */
const BASE_GENERATORS: readonly Case[] = CASES.filter((testCase) => !testCase.id.startsWith('G7') && !testCase.id.startsWith('G8'));

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

function timeOnce(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

/** One delivery of `text`: a single `sanitize` call, or every line through a fresh key-block redactor. */
function deliver(delivery: Case['delivery'], text: string): () => void {
  if (delivery === 'string') {
    return () => {
      logger.sanitize(text);
    };
  }
  const lines = text.split('\n');
  return () => {
    const redactor = new KeyBlockLineRedactor((input) => logger.sanitize(input));
    for (const line of lines) redactor.sanitizeLine(line);
  };
}

function medianMs(run: () => void): number {
  run();
  return median(Array.from({ length: BOUND.samples }, () => timeOnce(run)));
}

/** Take a measurement, and take it once more if `passes` rejects the first: preemption only adds time. */
function withRetake<T>(measure: () => T, passes: (taken: T) => boolean): T {
  let taken = measure();
  for (let take = 1; take < BOUND.maxTakes && !passes(taken); take += 1) taken = measure();
  return taken;
}

class RungFailure extends Error {}

function failAt(rung: number, name: string, id: string, seed: number, detail: string): never {
  throw new RungFailure(`${id} (seed ${seed}) failed rung ${rung} (${name}): ${detail}`);
}

console.log(`[FR-R4-F10 P1] machine: ${BOUND.machine}; running on Node ${process.version}, ${os.cpus().at(0)?.model ?? 'unknown cpu'}`);
console.log(
  `[FR-R4-F10 P1] bounds: line ${BOUND.lineBoundUnits} units (<${BOUND.lineCeilingMs} ms), artifact ${BOUND.artifactBoundUnits} units (<${BOUND.artifactCeilingMs} ms), ratio <= ${BOUND.maxDoublingRatio}`
);

describe('sanitize() on hostile input stays proportional to its size (SC-005)', () => {
  it('declares the bounds it imports', () => {
    expect(BOUND.lineBoundUnits).toBe(1_048_576);
    expect(BOUND.artifactBoundUnits).toBe(16 * 1024 * 1024);
    expect(CASES.map((testCase) => testCase.seed).every((seed) => Number.isInteger(seed))).toBe(true);
    expect(new Set(CASES.map((testCase) => testCase.seed)).size).toBe(CASES.length);
    expect(CASES.filter((testCase) => testCase.artifact).map((testCase) => testCase.id)).toEqual([
      'G1 eyJ',
      'G2 unterminated GCP envelope',
      'G8 seeded interleaving of G1 to G6'
    ]);
  });

  it.each(CASES.map((testCase) => [testCase.id, testCase] as const))(
    '%s',
    (_id, testCase) => {
      let rungs = 0;
      const rng = () => mulberry32(testCase.seed);

      // Rung 1: one probe at 65,536 units. It fails at once on a quadratic expression.
      const probeText = testCase.generate(rng(), BOUND.probeUnits);
      expect(probeText.length).toBe(BOUND.probeUnits);
      const probeMs = timeOnce(deliver(testCase.delivery, probeText));
      if (probeMs >= BOUND.lineCeilingMs) {
        failAt(1, 'probe at 65,536 units', testCase.id, testCase.seed, `${probeMs.toFixed(1)} ms is not under ${BOUND.lineCeilingMs} ms`);
      }
      rungs += 1;

      // Rung 2: the half and full line sizes, and the ratio between them.
      const half = testCase.generate(rng(), BOUND.lineBoundUnits / 2);
      const full = testCase.generate(rng(), BOUND.lineBoundUnits);
      expect(full.length).toBe(BOUND.lineBoundUnits);
      // A single sample at the full size comes first. A time several times the ceiling is not noise a retake
      // could absorb, and taking the medians of a quadratic expression would run for minutes.
      const screenMs = timeOnce(deliver(testCase.delivery, full));
      if (screenMs >= BOUND.lineCeilingMs * SCREEN_MULTIPLE) {
        failAt(
          2,
          'screen at 1,048,576 units',
          testCase.id,
          testCase.seed,
          `one call took ${screenMs.toFixed(1)} ms, over ${SCREEN_MULTIPLE} times the ${BOUND.lineCeilingMs} ms ceiling`
        );
      }
      const taken = withRetake(
        () => ({ halfMs: medianMs(deliver(testCase.delivery, half)), fullMs: medianMs(deliver(testCase.delivery, full)) }),
        (t) => t.fullMs < BOUND.lineCeilingMs && t.fullMs / Math.max(t.halfMs, 0.001) <= BOUND.maxDoublingRatio
      );
      const ratio = taken.fullMs / Math.max(taken.halfMs, 0.001);
      console.log(
        `[FR-R4-F10 P1] ${testCase.id}: seed ${testCase.seed}, probe ${probeMs.toFixed(1)} ms, half ${taken.halfMs.toFixed(2)} ms, full ${taken.fullMs.toFixed(2)} ms, ratio ${ratio.toFixed(2)}`
      );
      if (taken.fullMs >= BOUND.lineCeilingMs) {
        failAt(2, 'line ceiling at 1,048,576 units', testCase.id, testCase.seed, `${taken.fullMs.toFixed(1)} ms is not under ${BOUND.lineCeilingMs} ms`);
      }
      if (ratio > BOUND.maxDoublingRatio) {
        failAt(2, 'growth ratio', testCase.id, testCase.seed, `${ratio.toFixed(2)} is above ${BOUND.maxDoublingRatio}`);
      }
      rungs += 1;

      // Rung 3: one artifact-sized call, for the three generators the contract names.
      if (testCase.artifact) {
        const artifact = testCase.generate(rng(), BOUND.artifactBoundUnits);
        const artifactMs = timeOnce(deliver(testCase.delivery, artifact));
        console.log(`[FR-R4-F10 P1] ${testCase.id}: seed ${testCase.seed}, artifact ${BOUND.artifactBoundUnits} units ${artifactMs.toFixed(1)} ms`);
        if (artifactMs >= BOUND.artifactCeilingMs) {
          failAt(3, 'artifact ceiling at 16 MiB', testCase.id, testCase.seed, `${artifactMs.toFixed(1)} ms is not under ${BOUND.artifactCeilingMs} ms`);
        }
        rungs += 1;
      }

      // A rung that was skipped is a failure that names itself, never a pass.
      expect(rungs, `${testCase.id}: a rung was not reached`).toBe(testCase.artifact ? 3 : 2);
    },
    TEST_TIMEOUT_MS
  );
});

describe('the control: the check can tell quadratic from linear on this machine (BD4)', () => {
  it('reports a ratio above 3.0 for the JWT expression as it stood before this feature', () => {
    const generate = unbrokenEyJ;
    const sizes = BOUND.oracleSizes;
    const texts = sizes.map((size) => generate(mulberry32(257_101), size));
    const measure = () => {
      const times = texts.map((text) =>
        medianMs(() => {
          text.replace(QUADRATIC_ORACLE, REDACTION_SENTINEL);
        })
      );
      return times.slice(1).map((time, index) => time / Math.max(times.at(index) ?? 0.001, 0.001));
    };
    const ratios = withRetake(measure, (taken) => taken.every((ratio) => ratio > BOUND.maxDoublingRatio));
    console.log(`[FR-R4-F10 P1] oracle ratios at ${sizes.join(', ')}: ${ratios.map((ratio) => ratio.toFixed(2)).join(', ')}`);
    expect(
      ratios.every((ratio) => ratio > BOUND.maxDoublingRatio),
      `the quadratic oracle's ratios ${ratios.join(', ')} are not above ${BOUND.maxDoublingRatio}: the check is vacuous here`
    ).toBe(true);
  }, TEST_TIMEOUT_MS);
});

/**
 * The structured walkers call `isSecretKeyName` on every key that holds a non-empty string, and a tool
 * call's argument keys come from model output, bounded only by the 64 Ki per-field cap of the phase-log
 * projection. A camelCase split that backtracks over an uppercase run took 9 s for an 80 Ki-unit key, so
 * one key at the probe size must stay under the line ceiling, as a whole sanitized record does.
 */
describe('isSecretKeyName on a hostile key stays proportional to its size (SC-005)', () => {
  it.each([
    ['an uppercase run', 'A'.repeat(BOUND.probeUnits)],
    ['an uppercase run ending in a secret word', `${'A'.repeat(BOUND.probeUnits - 5)}Token`],
    ['alternating separators', '_-.'.repeat(BOUND.probeUnits / 4)]
  ])('%s at 65,536 units', (_name, key) => {
    const keyMs = timeOnce(() => {
      isSecretKeyName(key);
    });
    const recordMs = timeOnce(() => {
      logger.sanitizeRecord({ [key]: 'x' });
    });
    console.log(`[FR-R4-F10 P1] isSecretKeyName ${_name}: key ${keyMs.toFixed(2)} ms, record ${recordMs.toFixed(2)} ms`);
    expect(keyMs, `isSecretKeyName took ${keyMs.toFixed(1)} ms`).toBeLessThan(BOUND.lineCeilingMs);
    expect(recordMs, `sanitizeRecord took ${recordMs.toFixed(1)} ms`).toBeLessThan(BOUND.lineCeilingMs);
  }, TEST_TIMEOUT_MS);
});
