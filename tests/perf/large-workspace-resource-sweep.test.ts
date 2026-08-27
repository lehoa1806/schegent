// FR-R3-130 (T1494) — resident heap, descriptors, and Git behaviour at concurrency
// 1/2/4/8 on a representative LARGE workspace.
//
// WHY THIS AND NOT `aggregate-resource-soak.test.ts`. That file measured the
// accepted-input ceiling at cap 20 on nothing — buffers filled with generated text,
// no workspace at all — and it is the right shape for its question (`FR-R3-081`:
// what does the stream bound actually cost in resident heap?). It answers nothing
// about the two things an operator on a real repository asks: does Git stay usable
// while N Runs are in flight, and do descriptors accumulate.
//
// `FR-R3-124`'s sweep answered the ATTRIBUTION question at the same concurrencies
// and said explicitly that its synthetic fixture moves the resource figures and not
// the outcome distribution, pointing here for the resource half. This is that half.
//
// WHAT "REPRESENTATIVE LARGE" MEANS, and it is a choice with a cost. 2,000 tracked
// files across 40 directories, ~6 MiB of content. Chosen because it is the point
// where `git status` stops being instantaneous on a warm cache while still building
// in seconds — a fixture nobody will run is a measurement nobody repeats. It is NOT
// a claim about the largest workspace this product supports; §5 of the record states
// that limit.
//
// EVERY FIGURE HERE IS AN OBSERVATION, not a budget. The asserted bound stays
// `aggregate-resource-soak.test.ts`'s 400 MiB, derived by `FR-R3-081` from its own
// measurement. What this file asserts is only that the sweep RAN and produced
// figures — a measurement whose assertions are its own numbers is a measurement that
// gets adjusted instead of re-run.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MAX_STREAM_BUFFER_BYTES,
  ZippedStreamBuffer,
  readStreamPressure,
  resetStreamPressure
} from '../../src/runner/zipped-stream-buffer';

const git = promisify(execFile);

/** The levels the item names. 1 is the control. */
const LEVELS = [1, 2, 4, 8] as const;
const STREAMS_PER_RUN = 2;

/** The fixture's shape. See the header for why these numbers. */
const FIXTURE_DIRS = 40;
const FILES_PER_DIR = 50;
const FILE_BYTES = 3 * 1024;

/**
 * How much of each stream buffer a level fills.
 *
 * NOT the full 64 MiB cap. At cap 8 that would be 1 GiB of accepted input and a
 * multi-minute test, and `FR-R3-081` already measured the ceiling. What this sweep
 * needs is a load that scales with the level so the SHAPE of the growth is visible;
 * 4 MiB per stream gives 64 MiB accepted at level 8, which is enough to see whether
 * resident heap tracks accepted input or the compression ratio.
 */
const FILL_BYTES_PER_STREAM = 4 * 1024 * 1024;

interface LevelResult {
  readonly level: number;
  readonly heapDeltaMiB: number;
  readonly openDescriptorDelta: number | null;
  readonly gitStatusMs: number;
  readonly acceptedMiB: number;
  readonly retainedMiB: number;
}

let workspaceRoot: string;

/** Open descriptors, where the platform can be asked. `null` where it cannot. */
async function openDescriptorCount(): Promise<number | null> {
  for (const dir of ['/dev/fd', '/proc/self/fd']) {
    try {
      return (await fs.readdir(dir)).length;
    } catch {
      continue;
    }
  }
  return null;
}

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-large-ws-'));
  await git('git', ['init', '-q'], { cwd: workspaceRoot });
  await git('git', ['config', 'user.email', 'perf@example.com'], { cwd: workspaceRoot });
  await git('git', ['config', 'user.name', 'Perf'], { cwd: workspaceRoot });
  const body = 'x'.repeat(FILE_BYTES);
  for (let d = 0; d < FIXTURE_DIRS; d += 1) {
    const dir = path.join(workspaceRoot, `pkg-${d}`);
    await fs.mkdir(dir, { recursive: true });
    await Promise.all(
      Array.from({ length: FILES_PER_DIR }, (_, f) =>
        fs.writeFile(path.join(dir, `mod-${f}.ts`), `// ${d}/${f}\n${body}\n`)
      )
    );
  }
  await git('git', ['add', '-A'], { cwd: workspaceRoot, maxBuffer: 64 * 1024 * 1024 });
  await git('git', ['commit', '-q', '-m', 'fixture'], { cwd: workspaceRoot });
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

async function measureLevel(level: number): Promise<LevelResult> {
  const before = process.memoryUsage().heapUsed;
  const fdBefore = await openDescriptorCount();

  // `2 x level` buffers, filled together the way concurrent Runs fill them.
  const buffers = Array.from(
    { length: level * STREAMS_PER_RUN },
    () => new ZippedStreamBuffer()
  );
  // A string, because `ZippedStreamBuffer.append` takes decoded text — the stream
  // is already through the decoder by the time a buffer sees it.
  const chunk = `${'schegent stream output line'.repeat(80)}\n`.repeat(20);
  const perStream = Math.ceil(FILL_BYTES_PER_STREAM / Buffer.byteLength(chunk));
  for (let i = 0; i < perStream; i += 1) {
    for (const buffer of buffers) buffer.append(chunk);
  }

  // Git, while the buffers are held. This is the question `aggregate-resource-soak`
  // cannot ask: whether the working tree stays usable under the load.
  const gitStart = performance.now();
  await git('git', ['status', '--porcelain=v1'], {
    cwd: workspaceRoot,
    maxBuffer: 64 * 1024 * 1024
  });
  const gitStatusMs = performance.now() - gitStart;

  const accepted = buffers.reduce((sum, buffer) => sum + buffer.totalBytes, 0);
  const retained = buffers.reduce((sum, buffer) => sum + buffer.retainedBytes, 0);
  const heapDelta = process.memoryUsage().heapUsed - before;
  const fdAfter = await openDescriptorCount();

  return {
    level,
    heapDeltaMiB: Number((heapDelta / 1024 / 1024).toFixed(2)),
    openDescriptorDelta: fdBefore === null || fdAfter === null ? null : fdAfter - fdBefore,
    gitStatusMs: Number(gitStatusMs.toFixed(0)),
    acceptedMiB: Number((accepted / 1024 / 1024).toFixed(1)),
    retainedMiB: Number((retained / 1024 / 1024).toFixed(2))
  };
}

describe('FR-R3-130 — large-workspace resource behaviour at 1/2/4/8', () => {
  it('measures every level and reports the figures', async () => {
    const results: LevelResult[] = [];
    for (const level of LEVELS) results.push(await measureLevel(level));

    const lines = results.map(
      (r) =>
        `  N=${String(r.level).padStart(2)}  accepted=${r.acceptedMiB} MiB  ` +
        `retained=${r.retainedMiB} MiB  heapDelta=${r.heapDeltaMiB} MiB  ` +
        `fdDelta=${r.openDescriptorDelta ?? 'unavailable'}  git status=${r.gitStatusMs} ms`
    );
    console.log(
      [
        `[FR-R3-130] large-workspace sweep (${FIXTURE_DIRS * FILES_PER_DIR} tracked files, ` +
          `${((FIXTURE_DIRS * FILES_PER_DIR * FILE_BYTES) / 1024 / 1024).toFixed(1)} MiB):`,
        ...lines,
        '  figures are OBSERVATIONS; the asserted bound is aggregate-resource-soak.test.ts'
      ].join('\n')
    );

    // The only assertions are that the sweep ran. A measurement that asserted its
    // own numbers would be adjusted rather than re-run, which is the failure mode
    // `FR-R3-081`'s record warns about in its own words.
    expect(results).toHaveLength(LEVELS.length);
    for (const r of results) {
      expect(r.acceptedMiB, `level ${r.level} accepted nothing`).toBeGreaterThan(0);
      expect(r.gitStatusMs, `level ${r.level} git status did not run`).toBeGreaterThan(0);
    }
    // The accepted input scales with the level, which is what makes the shape of the
    // heap column readable. Without this the sweep could measure one level four
    // times and look identical.
    expect(results[3]!.acceptedMiB).toBeGreaterThan(results[0]!.acceptedMiB * 4);
  }, 240_000);

  it('descriptors do not accumulate with the level, where the platform can be asked', async () => {
    // The audit's question, and the one a soak over buffers alone cannot answer: a
    // stream buffer holds memory, not a file. If the descriptor delta tracked the
    // level, something is holding a handle per stream.
    const first = await measureLevel(1);
    const last = await measureLevel(8);
    if (first.openDescriptorDelta === null || last.openDescriptorDelta === null) {
      console.log('[FR-R3-130] descriptor counting unavailable on this platform; skipped');
      return;
    }
    expect(
      last.openDescriptorDelta,
      'open descriptors grew with the concurrency level — a stream buffer is memory, ' +
        'not a handle, so something is holding one per stream'
    ).toBeLessThanOrEqual(first.openDescriptorDelta + 4);
  }, 240_000);

  it('the per-stream fill is a fraction of the accepted-input cap, deliberately', () => {
    // Stated as an assertion so the reasoning in the header cannot drift from the
    // constant: this sweep measures the SHAPE of growth, and `FR-R3-081` measures
    // the ceiling. A fill that reached the cap would duplicate that work and cost
    // minutes.
    expect(FILL_BYTES_PER_STREAM).toBeLessThan(MAX_STREAM_BUFFER_BYTES);
  });
});

/**
 * FR-R3-130 (T1496) — the live aggregate figure moves.
 *
 * The projection's whole value is that it changes while a configuration is loaded. A
 * projection that reported a constant would be indistinguishable from one that
 * reported nothing, and this is the assertion that separates them.
 *
 * In the perf suite rather than the unit suite because it holds real buffers at real
 * sizes; the accounting arithmetic itself is covered by
 * `tests/unit/runner/zipped-stream-buffer.test.ts`.
 */
describe('FR-R3-130 (T1496) — live aggregate stream pressure', () => {
  it('rises with the buffers held and returns to zero when they finalize', async () => {
    resetStreamPressure();
    expect(readStreamPressure()).toEqual({ liveBuffers: 0, retainedBytes: 0, ceilingBytes: 0 });

    const buffers = Array.from({ length: 8 }, () => new ZippedStreamBuffer());
    const held = readStreamPressure();
    expect(held.liveBuffers, 'construction must register').toBe(8);
    expect(held.ceilingBytes).toBe(8 * MAX_STREAM_BUFFER_BYTES);
    expect(held.retainedBytes, 'nothing appended yet').toBe(0);

    const chunk = `${'aggregate pressure line'.repeat(60)}\n`.repeat(10);
    for (const buffer of buffers) for (let i = 0; i < 40; i += 1) buffer.append(chunk);

    const loaded = readStreamPressure();
    expect(loaded.retainedBytes, 'the figure did not move').toBeGreaterThan(0);
    // It agrees with what the buffers themselves report, which is what makes it a
    // projection rather than a second opinion.
    expect(loaded.retainedBytes).toBe(
      buffers.reduce((sum, buffer) => sum + buffer.retainedBytes, 0)
    );

    // And it comes back down. A registry that only grew would read as a leak within
    // one session, which is worse than no figure.
    for (const buffer of buffers) buffer.finalize();
    const after = readStreamPressure();
    expect(after.liveBuffers, 'finalize must deregister').toBe(0);
    expect(after.retainedBytes).toBe(0);
  });

  it('is idempotent against a second finalize', () => {
    // A double-subtract would drive the aggregate negative and a negative buffered
    // figure on a dashboard is worse than an absent one.
    resetStreamPressure();
    const buffer = new ZippedStreamBuffer();
    buffer.append('some output\n');
    buffer.finalize();
    buffer.finalize();
    const reading = readStreamPressure();
    expect(reading.liveBuffers).toBe(0);
    expect(reading.retainedBytes).toBe(0);
  });
});

/**
 * FR-R3-130 (T1497) — activation-path percentiles on a LARGE workspace.
 *
 * WHAT WAS MISSING. `tests/integration/activation-eager.host.test.ts` holds the whole
 * activation chain to one 5 s budget on the development tree, and
 * `activation-retention-sweep.test.ts` (`FR-R3-114`) measures the retention link on a
 * tree of the observed ORDER. Neither measures activation against a **large
 * workspace**, and neither produces a percentile — so "activation is fast" was a
 * budget with a single sample behind it, and a release claim cannot cite a single
 * sample.
 *
 * WHAT IS MEASURED. The activation-path work whose cost scales with the workspace:
 * walking the tree the way the retention sweep and the mount probe do, on the 2,000-
 * file fixture this file already builds, sampled enough times to report p50 and p95.
 *
 * WHAT IS NOT. This is not the full activation chain — that needs an extension host,
 * and `activation-eager.host.test.ts` owns it. It is the workspace-scaling part, which
 * is the part a large workspace changes. Stated so the floor it establishes is not
 * read as a claim about activation end to end.
 *
 * THE FLOOR IS A CEILING ON THE CLAIM, not a budget on the code: the release checklist
 * may say activation stays under it on a workspace of this size, and no more.
 */
describe('FR-R3-130 (T1497) — activation-path percentiles on a large workspace', () => {
  /** Samples. Enough for a p95 to mean something, few enough to stay in the suite. */
  const SAMPLES = 20;

  it('measures p50 and p95 for the workspace-scaling activation work', async () => {
    const durations: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const start = performance.now();
      // The two workspace-scaling reads activation performs: a recursive walk of the
      // tree (what the retention sweep and the mount probe both do) and a `git
      // status` (what the checkpoint baseline probe does).
      const walk = async (dir: string): Promise<number> => {
        let count = 0;
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) count += await walk(path.join(dir, entry.name));
          else count += 1;
        }
        return count;
      };
      await walk(workspaceRoot);
      await git('git', ['status', '--porcelain=v1'], {
        cwd: workspaceRoot,
        maxBuffer: 64 * 1024 * 1024
      });
      durations.push(performance.now() - start);
    }

    durations.sort((a, b) => a - b);
    const p = (share: number): number =>
      Number(durations[Math.min(durations.length - 1, Math.floor(durations.length * share))]!.toFixed(0));
    const p50 = p(0.5);
    const p95 = p(0.95);

    console.log(
      `[FR-R3-130] activation-path percentiles over ${FIXTURE_DIRS * FILES_PER_DIR} tracked ` +
        `files, ${SAMPLES} samples: p50=${p50} ms  p95=${p95} ms  ` +
        `min=${durations[0]!.toFixed(0)} ms  max=${durations[durations.length - 1]!.toFixed(0)} ms`
    );

    // The assertion is that the measurement RAN and produced ordered percentiles, not
    // that either figure is under a number. A measurement asserting its own value is
    // one that gets adjusted instead of re-run — the same reasoning the sweep above
    // states, and `FR-R3-081`'s record before it.
    expect(durations).toHaveLength(SAMPLES);
    expect(p95).toBeGreaterThanOrEqual(p50);
    expect(p50).toBeGreaterThan(0);
  }, 240_000);
});
