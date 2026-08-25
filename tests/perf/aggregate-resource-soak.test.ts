import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
 * `00_escalated_residuals_decision.md` §4 is explicit: "any future mechanism work
 * should be argued from measured resident heap". So this measures, and it
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
