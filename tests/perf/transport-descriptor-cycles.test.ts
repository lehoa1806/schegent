// FR-R3-137 (T1532a, T1532b, FR-015) — the transport sink's descriptor count across
// repeated build/teardown and repoint/rotation cycles.
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
// EVERY REAL OPEN. No `appendFile` port is injected anywhere in this file, which
// matters more than it looks: `writeAbsorbing` short-circuits past
// `appendHandleFor` when a port is present, so a sink built with an injected
// append never opens a descriptor at all. Three of the four suites that construct
// sinks emitted zero descriptor warnings for precisely that reason, and a stress
// test with an injected port would measure nothing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CLI_TRANSPORT_DIRECTORY,
  CLI_TRANSPORT_FILE_NAME,
  CliTransportSink,
  type CliTransportSettings
} from '../../src/monitor/cli-transport-sink';

/**
 * Cycles per exercise. 200 is chosen to be well past any plausible cache or
 * bookkeeping period and still finish in seconds — the value of this file is that
 * somebody re-runs it, and the count is stated in the record so a later reader
 * knows what the flatness claim was measured over.
 */
const CYCLES = 200;

/** Destinations the repoint exercise rotates between. */
const DESTINATIONS = 8;

/**
 * A byte bound below the size of one record, so rotation fires on every cycle
 * regardless of what is already on disk.
 *
 * Measured the other way first and it is worth recording: at 256 bytes the
 * rotation only fired every fourth cycle, because the bound is
 * `bytesOnDisk + record > maxBytes` and a freshly repointed destination starts at
 * zero. A stress test whose exercise fires intermittently reports the fixture, not
 * the code. 1 byte takes the degenerate-but-correct branch the sink documents at
 * its rotation check — "a single record larger than the whole budget still
 * rotates" — which is deterministic.
 */
const ROTATION_MAX_BYTES = 1;

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

/** A settings accessor whose destination and byte bound the test can move. */
function mutableSettings(initial: CliTransportSettings): {
  accessor: { read: () => CliTransportSettings | null };
  repoint: (to: string) => void;
  setMaxBytes: (bytes: number) => void;
} {
  let current = initial;
  return {
    accessor: { read: (): CliTransportSettings | null => current },
    repoint: (to: string): void => {
      current = { ...current, path: to };
    },
    setMaxBytes: (bytes: number): void => {
      current = { ...current, maxBytes: bytes };
    }
  };
}

function defaultSettings(root: string, maxBytes = 5 * 1024 * 1024): CliTransportSettings {
  return {
    root,
    path: path.join(root, CLI_TRANSPORT_DIRECTORY, CLI_TRANSPORT_FILE_NAME),
    maxBytes,
    maxGenerations: 3
  };
}

function sinkFor(accessor: { read: () => CliTransportSettings | null }): CliTransportSink {
  return new CliTransportSink({
    settings: accessor,
    sanitize: (line: string) => line,
    logger: { warn: (): void => undefined }
  });
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
      const settings = mutableSettings(defaultSettings(workspaceRoot));
      const sink = sinkFor(settings.accessor);

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

  it('holds one handle across repoint and rotation cycles, and none after disposal', async () => {
    const settings = mutableSettings(defaultSettings(workspaceRoot));
    const sink = sinkFor(settings.accessor);
    const afterRepoint: number[] = [];
    const afterRotation: number[] = [];
    const afterReopen: number[] = [];

    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      // Repoint: a fresh destination every cycle, cycling through a small set so
      // the exercise also revisits paths a stale handle could still be held for.
      // One destination is current at a time, so one handle is held at a time —
      // two would be the leak `appendHandleFor` was given its stale-key sweep for.
      settings.repoint(
        path.join(workspaceRoot, CLI_TRANSPORT_DIRECTORY, `dest-${cycle % DESTINATIONS}.log`)
      );
      await recordOne(sink, cycle);
      afterRepoint.push(sink.openDescriptorCount);

      // Rotation: a byte bound this record exceeds renames the destination. The
      // handle goes BEFORE the rename — held across it, the descriptor follows the
      // inode into the rotated generation and appends there forever — and the
      // rotated record is then written by path rather than through a handle. So
      // the count after a rotating record is zero by construction, and this file
      // asserts that rather than the 1 a reader might expect.
      settings.setMaxBytes(ROTATION_MAX_BYTES);
      await recordOne(sink, cycle);
      afterRotation.push(sink.openDescriptorCount);

      // And the reopen: the next ordinary record takes exactly one handle again.
      // This is the reading that would climb if a rotation ever leaked the handle
      // it dropped, because the sweep only closes keys other than the current one.
      settings.setMaxBytes(5 * 1024 * 1024);
      await recordOne(sink, cycle);
      afterReopen.push(sink.openDescriptorCount);
    }

    // Flat, not merely bounded: `<= 1` would also pass on a sink that had stopped
    // writing altogether, which is the failure mode a descriptor test is closest to.
    const distinct = (counts: number[]): string => [...new Set(counts)].join(',');
    expect(afterRepoint.every((n) => n === 1), `repoint: ${distinct(afterRepoint)}`).toBe(true);
    expect(afterRotation.every((n) => n === 0), `rotation: ${distinct(afterRotation)}`).toBe(true);
    expect(afterReopen.every((n) => n === 1), `reopen: ${distinct(afterReopen)}`).toBe(true);

    await sink.flushAndDispose();
    expect(sink.openDescriptorCount).toBe(0);
    console.log(
      `[FR-R3-137] repoint/rotation: ${CYCLES} cycles over ${DESTINATIONS} destinations, ` +
        `repoint=${distinct(afterRepoint)}, rotation=${distinct(afterRotation)}, reopen=${distinct(afterReopen)}, disposed=0`
    );
  });

  it('stays flat across a sustained fixture rather than growing with it', async () => {
    const settings = mutableSettings(defaultSettings(workspaceRoot));
    const sink = sinkFor(settings.accessor);
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

    // 2,000 records across 16 run ids and one destination. The count tracks
    // DESTINATIONS, and there is one; a count that tracked runs or records is the
    // growth this asserts against.
    expect(peak).toBe(1);

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
        const settings = mutableSettings(defaultSettings(workspaceRoot));
        const sink = sinkFor(settings.accessor);
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
