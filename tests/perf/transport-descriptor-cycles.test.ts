// FR-R3-137 (T1532a, T1532b, FR-015) — the transport sink's descriptor count across
// repeated build/teardown and Run-start/Run-end cycles.
//
// FR-R4-F04 — the descriptors moved. The sink writes no file; the router it hands lines to holds one
// append descriptor per file it is writing (a Run file under `on`), and the sink's
// `openDescriptorCount` reports the router's. What the original cycles measured as "repoint" and
// "rotation" (one shared destination, moved and rolled over) does not exist any more: the equivalents
// are a Run starting (a handle opens), a Run ending (`finalizeRun` releases it) and a compaction (the
// handle is dropped before the rename). The claim is unchanged: the count returns to baseline every
// cycle and stays flat across a sustained fixture.
//
// WHY PERF AND NOT HOST (plan D12). This is a bound over REPETITION: the claim is
// that the count returns to baseline every cycle and stays flat across a sustained
// fixture, and demonstrating that costs hundreds of real opens. FR-R3-042 excluded
// `tests/perf/**` from the default include for exactly this kind of assertion, and
// putting a repetition budget inside `test:host` would land it in the suite
// FR-R3-033 made hermetic.
//
// NOT COVERED BY THE WARNING DETECTOR, deliberately. `vitest.perf.config.ts`
// declares no `setupFiles` and this item does not add one — that config's contents
// are FR-R3-042's decision. It costs nothing here: `openDescriptorCount` returning
// to zero is a strictly stronger claim than the absence of a `DEP0137` warning,
// which only appears once the collector gets around to it.
//
// WHAT IS ASSERTED AND WHAT IS ONLY OBSERVED (C3). The sink's own handle count is
// asserted, on every platform. The process count from `/dev/fd` is CORROBORATION
// and never an assertion, because it includes descriptors this feature does not
// own — vitest's own pipes and modules move it. §2 of
// `docs/operations/transport-descriptor-measurement.md` carries the figures.
//
// EVERY REAL OPEN. No port is injected anywhere in this file, which matters more than it looks: a
// sink built over a double never opens a descriptor at all, and a stress test over a double would
// measure nothing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { CliTransportSink, createCliTransportSink } from '../../src/monitor/cli-transport-sink';
import { createTransportRouter, type TransportRouter } from '../../src/monitor/transport/transport-router';
import { SanitizedLogger } from '../../src/lib/logger';

/**
 * Cycles per exercise. 200 is chosen to be well past any plausible cache or
 * bookkeeping period and still finish in seconds — the value of this file is that
 * somebody re-runs it, and the count is stated in the record so a later reader
 * knows what the flatness claim was measured over.
 */
const CYCLES = 200;

let workspaceRoot: string;

/**
 * Open descriptors for the whole process, where the platform can be asked.
 * `null` where it cannot — the same shape as
 * `large-workspace-resource-sweep.test.ts`, whose §5 sibling record measures the
 * process-wide number under load rather than one sink's handles.
 */
async function processDescriptorCount(): Promise<number | null> {
  for (const dir of ['/dev/fd', '/proc/self/fd']) {
    try {
      return (await fs.readdir(dir)).length;
    } catch {
      continue;
    }
  }
  return null;
}

/** The real sink over the real router, writing a Run file per Run under `on`. */
function sinkFor(): { sink: CliTransportSink; router: TransportRouter } {
  const logger = { warn: (): void => undefined };
  const router = createTransportRouter({
    workspaceRoot: () => workspaceRoot,
    readSetting: () => 'on',
    readRawTranscriptMode: () => 'errors-only',
    readMaxAgeDays: () => 30,
    tempRoot: `${workspaceRoot}-os-temp`,
    runStatus: () => undefined,
    logger
  });
  const realLogger = new SanitizedLogger([]);
  const sink = createCliTransportSink(router, { sanitize: (line) => realLogger.sanitize(line), warn: logger.warn });
  return { sink, router };
}

/**
 * Record one line and wait for it to land. `record()` is fire-and-forget by
 * design, so without the flush the handle may not be open yet and the assertion
 * would be reading a sink that has not started work.
 */
async function recordOne(sink: CliTransportSink, n: number): Promise<void> {
  sink.record({ runId: `run-${n}`, phase: 'build', stream: 'stdout', line: `line ${n}` });
  await sink.flushPendingWrites();
}

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-transport-fd-'));
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe('FR-R3-137 — descriptor cycles (T1532a, FR-015)', () => {
  it('returns to baseline after every build/teardown cycle', async () => {
    const peaks: number[] = [];
    const residues: number[] = [];

    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      const { sink } = sinkFor();

      // BEFORE: a sink that has recorded nothing holds nothing. The handle is
      // opened by the first write, not by construction.
      expect(sink.openDescriptorCount).toBe(0);

      await recordOne(sink, cycle);
      // DURING: one destination, one handle. Two would mean the append path had
      // stopped reusing what it holds.
      peaks.push(sink.openDescriptorCount);

      await sink.flushAndDispose();
      // AFTER: this is the item. Before FR-R3-137 the only thing that closed one
      // of these was the collector, so this number was 1 forever and the cycle
      // leaked a descriptor per Stage-2 build.
      residues.push(sink.openDescriptorCount);
    }

    expect(peaks.every((n) => n === 1), `peaks: ${[...new Set(peaks)].join(',')}`).toBe(true);
    expect(residues.filter((n) => n !== 0)).toHaveLength(0);

    // Emitted in the house form so the dated record quotes this run rather than a
    // number somebody remembered. See `aggregate-resource-soak.test.ts`.
    console.log(
      `[FR-R3-137] build/teardown: ${CYCLES} cycles, during=${[...new Set(peaks)].join(',')}, after=${[...new Set(residues)].join(',')}`
    );
  });

  it('holds one handle per active Run, none after its end, and none after disposal', async () => {
    const { sink, router } = sinkFor();
    const afterStart: number[] = [];
    const afterEnd: number[] = [];
    const afterNext: number[] = [];

    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      // A Run starts: its first record opens its Run file's handle, and one Run is active at a time
      // here, so one handle is held — two would be the leak the release at a Run's end exists to stop.
      await recordOne(sink, cycle);
      afterStart.push(sink.openDescriptorCount);

      // The Run ends: `finalizeRun` releases its descriptors, so the count after a Run's end is zero
      // by construction, and this file asserts that rather than the 1 a reader might expect.
      await router.finalizeRun(`run-${cycle}`, 'completed', new Set());
      afterEnd.push(sink.openDescriptorCount);

      // And the next Run takes exactly one handle again. This is the reading that would climb if an
      // end ever leaked the handle it released.
      await recordOne(sink, cycle + CYCLES);
      afterNext.push(sink.openDescriptorCount);
      await router.finalizeRun(`run-${cycle + CYCLES}`, 'completed', new Set());

      // The retention sweep's part, done by hand. Under `on` every Run's file is kept and each Run's end
      // lists them all from the disk (a listing trusts no cache), so 400 kept files would measure that
      // listing growing with them (80 cycles took 3.7 s, 40 took 0.9 s) rather than the handle count.
      await fs.rm(path.join(workspaceRoot, '.schegent', 'sessions'), { recursive: true, force: true });
    }

    // Flat, not merely bounded: `<= 1` would also pass on a sink that had stopped
    // writing altogether, which is the failure mode a descriptor test is closest to.
    const distinct = (counts: number[]): string => [...new Set(counts)].join(',');
    expect(afterStart.every((n) => n === 1), `start: ${distinct(afterStart)}`).toBe(true);
    expect(afterEnd.every((n) => n === 0), `end: ${distinct(afterEnd)}`).toBe(true);
    expect(afterNext.every((n) => n === 1), `next: ${distinct(afterNext)}`).toBe(true);

    await sink.flushAndDispose();
    expect(sink.openDescriptorCount).toBe(0);
    console.log(
      `[FR-R3-137] run start/end: ${CYCLES} cycles, ` +
        `start=${distinct(afterStart)}, end=${distinct(afterEnd)}, next=${distinct(afterNext)}, disposed=0`
    );
  });

  it('stays flat across a sustained fixture rather than growing with it', async () => {
    const { sink } = sinkFor();
    let peak = 0;

    for (let n = 0; n < CYCLES * 10; n += 1) {
      sink.record({ runId: `run-${n % 16}`, phase: 'build', stream: 'stdout', line: `line ${n}` });
      if (n % 100 === 0) {
        await sink.flushPendingWrites();
        peak = Math.max(peak, sink.openDescriptorCount);
      }
    }
    await sink.flushPendingWrites();
    peak = Math.max(peak, sink.openDescriptorCount);

    // 2,000 records across 16 run ids, all active. The count tracks ACTIVE RUNS, one handle each, and
    // there are sixteen; a count that tracked records is the growth this asserts against.
    expect(peak).toBe(16);

    await sink.flushAndDispose();
    expect(sink.openDescriptorCount).toBe(0);
    console.log(
      `[FR-R3-137] sustained: ${CYCLES * 10} records over 16 run ids, peak=${peak}, disposed=0`
    );
  });
});

describe('FR-R3-137 — process-level corroboration (T1532b, C3)', () => {
  // Skipped on win32, which has no `/dev/fd` or `/proc/self/fd` to read. Harmless:
  // the ASSERTION above (`openDescriptorCount`) runs on every platform, so win32
  // loses corroboration, not coverage — which is why no platform-record row is
  // owed here. `tests/lint/platform-branch-has-record-row.test.ts` scans `src/`,
  // and `platform-observation-record.md` tabulates acceptance halves with
  // fixtures and observation classes; a skipped corroboration is neither.
  it.skipIf(process.platform === 'win32')(
    'shows no process-wide descriptor growth across the cycles',
    async () => {
      const before = await processDescriptorCount();
      expect(before, 'the platform filter should have skipped this').not.toBeNull();

      for (let cycle = 0; cycle < CYCLES; cycle += 1) {
        const { sink } = sinkFor();
        await recordOne(sink, cycle);
        await sink.flushAndDispose();
      }

      const after = await processDescriptorCount();
      const delta = (after ?? 0) - (before ?? 0);

      // OBSERVED, NOT ASSERTED — beyond a ceiling loose enough that only a real
      // per-cycle leak reaches it. 200 cycles leaking one descriptor each moves
      // this by 200; the module loading, temp-directory churn and vitest's own
      // pipes move it by a handful in either direction, and pinning that number
      // would make this test an instrument aimed at the runner.
      expect(delta, `process descriptor delta over ${CYCLES} cycles: ${delta}`).toBeLessThan(
        CYCLES / 4
      );
      console.log(
        `[FR-R3-137] process descriptors (${process.platform}): ${before} -> ${after}, ` +
          `delta=${delta} over ${CYCLES} build/teardown cycles`
      );
    }
  );
});
