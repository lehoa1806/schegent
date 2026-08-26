import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ZippedStreamBuffer, MAX_STREAM_BUFFER_BYTES } from '../../src/runner/zipped-stream-buffer';

/**
 * FR-R3-081 (T1079, T1086) — measure the aggregate, then bound it.
 *
 * THE ORDER IS THE DELIVERABLE. `F-10` / `REL-05` proposed an aggregate budget
 * from arithmetic: 64 MiB per stream × 2 streams × a cap of 20 is 2.56 GiB. The
 * verification audit corrected that in place under `R-06`, and the correction is
 * the reason this file exists rather than an admission-control mechanism —
 * `MAX_STREAM_BUFFER_BYTES` is an **accepted-input** bound, not resident heap.
 * The head half of each stream is retained gzip-compressed at roughly 0.66× the
 * cap, and text compresses far below that, so the real figure is a measurement
 * and not a multiplication.
 *
 * The escalated-residuals decision record (`00_INDEX.md` §7) item 4 is
 * explicit: "any future mechanism work should be argued from measured resident
 * heap". So this measures, and it
 * asserts a bound DERIVED FROM THE MEASUREMENT rather than from the arithmetic.
 * A soak whose threshold can be traced back to `MAX_STREAM_BUFFER_BYTES` would
 * be the uncorrected framing wearing a test's clothes.
 *
 * WHAT IS MEASURED
 *
 *   - Resident heap after filling `2 × cap` stream buffers, on ordinary text
 *     output and on the pathological no-newline case (one line, forever, which
 *     defeats any line-oriented bound).
 *   - Open file descriptors across the same load, on the platforms that can be
 *     asked (`/dev/fd`); skipped with a note where they cannot.
 *
 * The figures this run produces are recorded in
 * `repo/docs/operations/concurrent-run-resource-measurement.md` with the method
 * and the tree they were taken on. This file is what keeps them from going
 * stale: a measurement nothing repeats is a measurement that drifts.
 */
const CAP = 20;
const STREAMS_PER_RUN = 2;
const CHUNK = 64 * 1024;

/**
 * The measured ceiling, plus headroom.
 *
 * Measured 2026-08-25 (see the operations record): filling 40 buffers to their
 * accepted-input cap left resident heap at **75.0 MiB** for ordinary text — about
 * 1/34 of the 2.50 GiB the accepted-input arithmetic gives for the same load —
 * and below the noise floor for the no-newline case, because a long run of one
 * character compresses to almost nothing.
 *
 * 400 MiB is that figure with roughly 5× headroom, which is what GC timing
 * inside the measurement window costs: the no-newline run measured a NEGATIVE
 * delta because a collection landed inside it. A regression guard, not a target.
 *
 * If a future change makes this fail, the answer is to re-measure and re-argue,
 * not to raise the number.
 */
const MEASURED_HEAP_CEILING_BYTES = 400 * 1024 * 1024;

/**
 * FR-R3-114 row 2 — the ceiling for the incompressible case, measured separately.
 *
 * MEASURED 2026-08-27 on darwin/arm64 (macOS 26.6.2, Node 24.19.0): **41.9 MiB** and **23.8 MiB**
 * on two consecutive runs — against 2.50 GiB of accepted-input arithmetic, and BELOW the 75.0 MiB
 * the compressible text case measured on 2026-08-25. Both figures are recorded rather than the
 * better one: a 1.8x spread between consecutive runs is GC timing inside the measurement window,
 * and a single number would imply a precision this method does not have.
 *
 * THE RESULT IS THE OPPOSITE OF WHAT ROW 2 PREDICTED, and that is the finding. The residual
 * assumed the 75 MiB figure was gzip hiding the real cost, so incompressible input would approach
 * the 2.50 GiB arithmetic. It does not, because `MAX_STREAM_BUFFER_BYTES` bounds what the buffer
 * ACCEPTS, and the compressed representation is what it retains: incompressible bytes hit the
 * accepted-input bound sooner, so fewer of them are held. Compression makes a buffer hold MORE
 * input, not less memory. The pathological case is bounded by construction, and the residual's
 * exposure — "≈2.5 GiB accepted-input arithmetic, invisible to the soak's guard" — is not real.
 *
 * 250 MiB is ~6x the measurement: this is a regression guard on a case whose measured cost is
 * small, and the headroom absorbs GC timing inside the window (the no-newline run once measured a
 * NEGATIVE delta for that reason).
 */
const INCOMPRESSIBLE_HEAP_CEILING_BYTES = 250 * 1024 * 1024;

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aggregate-soak-'));
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

function residentHeapBytes(): number {
  global.gc?.();
  return process.memoryUsage().heapUsed;
}

async function openDescriptorCount(): Promise<number | null> {
  // `/dev/fd` on macOS and Linux; nothing equivalent to ask on Windows, so the
  // measurement reports that it could not be taken rather than reporting zero.
  try {
    return (await fs.readdir('/dev/fd')).length;
  } catch {
    return null;
  }
}

/** Ordinary phase output: newline-terminated, compressible, realistic width. */
function textChunk(index: number): string {
  return `${new Array(512).fill(`line ${index} of ordinary phase output`).join('\n')}\n`;
}

/** The pathological case: no newline, ever. A line-oriented bound cannot help. */
function noNewlineChunk(): string {
  return 'x'.repeat(CHUNK);
}

/**
 * FR-R3-114 row 2 — the case that defeats the compression the other two rely on.
 *
 * WHY THE EXISTING CASES DO NOT COVER THIS. Both fixtures above compress: ordinary phase output
 * is repetitive text, and `'x'.repeat(65536)` compresses to almost nothing — which is why the
 * no-newline case measured a heap delta below the noise floor and was recorded as a pass. The
 * accepted-input arithmetic at cap 20 is ~2.50 GiB, and the measured 75 MiB was a statement about
 * gzip, not about the bound. So the one shape that makes the buffer pay full price — incompressible
 * bytes — was the one never driven.
 *
 * CRYPTO-RANDOM, not `Math.random()`: a PRNG's output is incompressible enough, but this test is
 * about a WORST CASE and `crypto.randomBytes` is the only source here that cannot be argued with.
 * Base64 rather than raw bytes because `ZippedStreamBuffer.append` takes a string, and base64 of
 * random bytes is still incompressible (its 6-bit alphabet costs 33% size, which this accounts for
 * by measuring what is actually appended).
 *
 * Deterministic across runs is NOT wanted here and would be a mistake: the point is that no
 * arrangement of these bytes compresses, and a fixed seed would invite someone to conclude the
 * measurement holds only for that seed.
 */
function incompressibleChunk(): string {
  return randomBytes(CHUNK).toString('base64');
}

async function fillBuffers(make: (i: number) => string): Promise<number> {
  const buffers: ZippedStreamBuffer[] = [];
  for (let i = 0; i < CAP * STREAMS_PER_RUN; i += 1) {
    const buffer = new ZippedStreamBuffer();
    let written = 0;
    let chunk = 0;
    while (written < MAX_STREAM_BUFFER_BYTES) {
      const text = make(chunk);
      buffer.append(text);
      written += Buffer.byteLength(text, 'utf8');
      chunk += 1;
    }
    buffers.push(buffer);
  }
  const heap = residentHeapBytes();
  // Keep the buffers alive across the measurement; the whole question is what
  // they cost while they are held.
  expect(buffers).toHaveLength(CAP * STREAMS_PER_RUN);
  return heap;
}

describe('FR-R3-081 — aggregate heap and descriptors at the maximum cap', () => {
  it('holds resident heap under the MEASURED ceiling on ordinary text output', async () => {
    const before = residentHeapBytes();
    const after = await fillBuffers(textChunk);
    const used = after - before;

    // Reported, not just asserted: the number is the deliverable, and a soak
    // that only says "under the bound" cannot be re-argued from.
    console.log(
      `[aggregate-soak] text: ${CAP * STREAMS_PER_RUN} buffers, resident heap delta ` +
        `${(used / (1024 * 1024)).toFixed(1)} MiB ` +
        `(accepted-input arithmetic would be ${((MAX_STREAM_BUFFER_BYTES * CAP * STREAMS_PER_RUN) / (1024 * 1024 * 1024)).toFixed(2)} GiB)`
    );
    expect(used).toBeLessThan(MEASURED_HEAP_CEILING_BYTES);
  }, 300_000);

  it('holds resident heap under the same ceiling on the no-newline case', async () => {
    const before = residentHeapBytes();
    const after = await fillBuffers(() => noNewlineChunk());
    const used = after - before;
    console.log(
      `[aggregate-soak] no-newline: resident heap delta ${(used / (1024 * 1024)).toFixed(1)} MiB`
    );
    expect(used).toBeLessThan(MEASURED_HEAP_CEILING_BYTES);
  }, 300_000);

  it('holds resident heap under a MEASURED ceiling on INCOMPRESSIBLE output (FR-R3-114 row 2)', async () => {
    // The gap row 2 names. This is the only case in the file whose heap cost is the buffer's real
    // cost rather than gzip's opinion of it, so it gets its own measured ceiling — the shared
    // 400 MiB was set against compressible fixtures and would be a fiction here.
    const before = residentHeapBytes();
    const after = await fillBuffers(() => incompressibleChunk());
    const used = after - before;
    const arithmetic = MAX_STREAM_BUFFER_BYTES * CAP * STREAMS_PER_RUN;
    console.log(
      `[aggregate-soak] incompressible: ${CAP * STREAMS_PER_RUN} buffers, resident heap delta ` +
        `${(used / (1024 * 1024)).toFixed(1)} MiB (accepted-input arithmetic would be ` +
        `${(arithmetic / (1024 * 1024 * 1024)).toFixed(2)} GiB)`
    );
    expect(
      used,
      `incompressible heap delta ${(used / (1024 * 1024)).toFixed(1)} MiB exceeded the measured ` +
        `ceiling ${(INCOMPRESSIBLE_HEAP_CEILING_BYTES / (1024 * 1024)).toFixed(0)} MiB. Re-measure ` +
        'and re-argue; do not raise the number.'
    ).toBeLessThan(INCOMPRESSIBLE_HEAP_CEILING_BYTES);
    // Non-vacuity: the load must actually have cost something, or a buffer that silently dropped
    // its input would pass this by using no memory at all.
    expect(used, 'incompressible input must cost real heap').toBeGreaterThan(8 * 1024 * 1024);
  }, 300_000);

  it('does not leak file descriptors across the load', async () => {
    const before = await openDescriptorCount();
    if (before === null) {
        console.log('[aggregate-soak] descriptors: not measurable on this platform');
      return;
    }
    await fillBuffers(textChunk);
    const after = await openDescriptorCount();
    console.log(`[aggregate-soak] descriptors: ${before} -> ${after}`);
    // The buffers hold no descriptors at all; this guards a future change that
    // gives them one per stream, which at cap 20 is where an FD budget starts to
    // matter.
    expect((after ?? 0) - before).toBeLessThan(CAP * STREAMS_PER_RUN);
  }, 300_000);
});
