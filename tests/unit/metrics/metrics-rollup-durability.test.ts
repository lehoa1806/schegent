import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { MetricsRollupWriter } from '../../../src/metrics/metrics-rollup-writer';
import { readMetricsRollup, metricsRollupPath } from '../../../src/metrics/metrics-rollup-reader';
import { composeCumulativeTotals } from '../../../src/metrics/metrics-rollup';
import { streamRollup } from '../../../src/metrics/metrics-rollup-stream';
import { SanitizedLogger } from '../../../src/lib/logger';

/**
 * FR-R3-082 (T1090, T1092) — the metrics rollup's two durability properties.
 *
 * `REL-06`, in the writer's own words: "The file is never rewritten, never
 * trimmed." That was candour, and it was also the finding. The second half was
 * the per-append timeout: a `Promise.race` against the write, which bounds the
 * WAIT and not the WRITE — the timer fires, the chain advances, and the I/O is
 * still outstanding, free to land after the next append. `M-02`'s shape, fixed
 * for `AuditLogWriter` under FR-R3-050 and not here.
 *
 * NON-VACUITY, measured: restoring `Promise.race([appendFile, setTimeout])` in
 * `write()` lets the wedged append below be overtaken by the next one — the
 * reorder, reproduced, with the second record landing in the file before the
 * first. Reverted, and the file re-run green.
 */
let workspaceRoot: string;
let logger: SanitizedLogger;

/**
 * A writer whose FIRST append stalls until released.
 *
 * A subclass rather than an injected port or a module mock. The module
 * namespace is not spyable under ESM, and an injected write port is what this
 * round has spent several items establishing the cost of — it has to be
 * defaulted, and a default is off in production the moment someone forgets. A
 * subclass has no production surface: nothing constructs one but this file.
 */
function wedgedWriter(delayMs?: number): { writer: MetricsRollupWriter; releaseWedge: () => void } {
  let release: () => void = () => undefined;
  const wedged = new Promise<void>((resolve) => {
    release = resolve;
  });
  let call = 0;
  class WedgedWriter extends MetricsRollupWriter {
    protected override async appendBytes(line: string): Promise<void> {
      call += 1;
      if (call === 1) {
        if (delayMs === undefined) await wedged;
        else await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      await super.appendBytes(line);
    }
  }
  return { writer: new WedgedWriter({ workspaceRoot, logger }), releaseWedge: () => release() };
}

const record = (runId: string, costUsd?: number) => ({
  runId,
  terminalStatus: 'completed' as const,
  startedAt: '2026-08-25T00:00:00.000Z',
  endedAt: '2026-08-25T00:01:00.000Z',
  durationMs: 60_000,
  phasesTotal: 3,
  phasesCompleted: 3,
  phasesSkipped: 0,
  backendInvocations: 2,
  ...(costUsd === undefined ? {} : { costUsd })
});

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metrics-durability-'));
  await fs.mkdir(path.join(workspaceRoot, '.schegent'), { recursive: true });
  logger = new SanitizedLogger();
});

describe('FR-R3-082 — the append chain waits for the write (T1089, T1090)', () => {
  it('does not advance past an outstanding write when the caller times out', async () => {
    const { writer, releaseWedge } = wedgedWriter();

    // Wedge the filesystem for the FIRST append only. The second is free to
    // proceed the instant the chain lets it — and the chain must not.
    const first = writer.append(record('run-wedged'));
    const second = writer.append(record('run-after'));

    // The caller of the wedged append is answered — a wedged disk must not stall
    // the phase waiting on it.
    await expect(first).resolves.toBeTruthy();

    // ...and the second append has NOT landed, because the chain is still
    // holding on the first write. This is the assertion the old shape failed.
    //
    // The settle is load-bearing: without it this reads the file in the same
    // tick the caller was answered, and a released chain would not have written
    // yet either — the assertion would pass for both shapes and prove nothing.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await streamRollup(workspaceRoot, metricsRollupPath(workspaceRoot))).records).toEqual([]);

    releaseWedge();
    await second;

    // Order preserved: the wedged write landed first, as the chain promised.
    const streamed = await streamRollup(workspaceRoot, metricsRollupPath(workspaceRoot));
    expect(streamed.records.map((entry) => entry.runId)).toEqual(['run-wedged', 'run-after']);
  }, 20_000);

  it('answers a slow-but-bounded append as appended, not as a failure', async () => {
    const { writer, releaseWedge } = wedgedWriter(50);
    const outcome = await writer.append(record('run-slow'));
    expect(outcome.outcome).toBe('appended');
    releaseWedge();
  });
});

describe('FR-R3-082 — a trim loses history, never totals (T1091, T1092)', () => {
  /**
   * A writer that keeps only three records, so a discard is observable without
   * writing five thousand of them. The arithmetic under test is what happens to
   * the discarded records' totals; the size of the window is not what makes it
   * true.
   */
  class SmallWindowWriter extends MetricsRollupWriter {
    protected override retainedRecordsAfterTrim(): number {
      return 3;
    }
  }

  async function seed(count: number, costEach: number): Promise<void> {
    const writer = new MetricsRollupWriter({ workspaceRoot, logger });
    for (let i = 0; i < count; i += 1) {
      await writer.append(record(`run-${i}`, costEach));
    }
  }

  it('keeps every cumulative total non-decreasing across a trim', async () => {
    await seed(40, 0.25);
    const before = await readMetricsRollup(workspaceRoot, logger);
    const totalsBefore = composeCumulativeTotals(before.records, [], before.carryForward).totals;

    // Force the trim by writing a header-and-records file over the threshold,
    // rather than by appending 8 MiB of real records: the property under test is
    // the arithmetic across a trim, and the threshold is not what makes it true.
    const padded =
      (await fs.readFile(metricsRollupPath(workspaceRoot), 'utf8')) +
      `${' '.repeat(9 * 1024 * 1024)}\n`;
    await fs.writeFile(metricsRollupPath(workspaceRoot), padded);

    await new SmallWindowWriter({ workspaceRoot, logger }).append(record('run-trigger', 0.25));

    const after = await readMetricsRollup(workspaceRoot, logger);
    const totalsAfter = composeCumulativeTotals(after.records, [], after.carryForward).totals;

    // Every field, not just cost: a trim that preserved the money and lost the
    // phase counts would still be a trim that lost totals.
    for (const key of Object.keys(totalsBefore) as Array<keyof typeof totalsBefore>) {
      if (typeof totalsBefore[key] !== 'number') continue;
      expect({ key, value: totalsAfter[key] as number }).toEqual({
        key,
        value: expect.any(Number)
      });
      expect(totalsAfter[key] as number).toBeGreaterThanOrEqual(totalsBefore[key] as number);
    }
    // And the new run is counted on top, not instead.
    expect(totalsAfter.runs).toBe(totalsBefore.runs + 1);
    // The trim really bit: the file holds fewer records than runs, which is the
    // arrangement the header exists to make readable.
    expect(after.records.length).toBeLessThan(totalsAfter.runs);
    expect(after.carryForward).toBeDefined();
  }, 30_000);

  it('reads a header-less rollup exactly as before', async () => {
    // Every rollup written before this feature has no header, and no schema
    // version moved for it.
    await seed(3, 1);
    const read = await readMetricsRollup(workspaceRoot, logger);
    expect(read.carryForward).toBeUndefined();
    expect(read.records).toHaveLength(3);
    expect(composeCumulativeTotals(read.records, []).totals.runs).toBe(3);
  });

  it('carries the run count forward, so a trimmed rollup does not read as lost history', async () => {
    await seed(5, 2);
    const before = await readMetricsRollup(workspaceRoot, logger);
    const runsBefore = composeCumulativeTotals(before.records, [], before.carryForward).rollupRuns;

    const padded =
      (await fs.readFile(metricsRollupPath(workspaceRoot), 'utf8')) +
      `${' '.repeat(9 * 1024 * 1024)}\n`;
    await fs.writeFile(metricsRollupPath(workspaceRoot), padded);
    await new SmallWindowWriter({ workspaceRoot, logger }).append(record('run-trigger', 2));

    const after = await readMetricsRollup(workspaceRoot, logger);
    const composed = composeCumulativeTotals(after.records, [], after.carryForward);
    expect(composed.rollupRuns).toBe(runsBefore + 1);
  }, 30_000);
});

describe('FR-R3-082 — neither side materializes the whole file (T1093, T1094)', () => {
  it('reads a rollup split across many chunks without losing a straddling line', async () => {
    // A chunk boundary lands mid-record roughly always. A reader that dropped
    // the straddling line would lose one run per chunk, silently.
    const writer = new MetricsRollupWriter({ workspaceRoot, logger });
    for (let i = 0; i < 500; i += 1) await writer.append(record(`run-${i}`, 0.01));

    const streamed = await streamRollup(workspaceRoot, metricsRollupPath(workspaceRoot));
    expect(streamed.records).toHaveLength(500);
    expect(streamed.unreadableRecords).toBe(0);
    expect(streamed.records[0]?.runId).toBe('run-0');
    expect(streamed.records[499]?.runId).toBe('run-499');
  }, 30_000);

  it('counts an unusable line rather than dropping it silently', async () => {
    const writer = new MetricsRollupWriter({ workspaceRoot, logger });
    await writer.append(record('run-good'));
    await fs.appendFile(metricsRollupPath(workspaceRoot), 'not json at all\n');

    const streamed = await streamRollup(workspaceRoot, metricsRollupPath(workspaceRoot));
    expect(streamed.records).toHaveLength(1);
    expect(streamed.unreadableRecords).toBe(1);
  });
});

describe('FR-R3-082 — the rollup path is walked, not composed (T1098)', () => {
  it('refuses an append when `.schegent` becomes a link out of the workspace', async () => {
    // `.schegent/` is a directory a cloned workspace controls. The verdict this
    // replaced refused a link planted AT the rollup and could say nothing about
    // a link at a component above it.
    const outside = path.join(path.dirname(workspaceRoot), 'outside-rollup');
    await fs.mkdir(outside, { recursive: true });
    await fs.rm(path.join(workspaceRoot, '.schegent'), { recursive: true, force: true });
    await fs.symlink(outside, path.join(workspaceRoot, '.schegent'), 'dir');

    const outcome = await new MetricsRollupWriter({ workspaceRoot, logger }).append(
      record('run-swapped', 1)
    );
    expect(outcome.outcome).toBe('failed');
    // Nothing was written through the link.
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('refuses a READ through a swapped component rather than reporting zero history', async () => {
    // An empty rollup means "zero runs", which is a claim about the workspace.
    // A rollup that cannot be proven is not a claim about anything.
    await new MetricsRollupWriter({ workspaceRoot, logger }).append(record('run-1', 1));
    const outside = path.join(path.dirname(workspaceRoot), 'outside-read');
    await fs.mkdir(outside, { recursive: true });
    await fs.rm(path.join(workspaceRoot, '.schegent'), { recursive: true, force: true });
    await fs.symlink(outside, path.join(workspaceRoot, '.schegent'), 'dir');

    const read = await readMetricsRollup(workspaceRoot, logger);
    // Reported as unavailable, which the projection already distinguishes from
    // an empty rollup.
    expect(read.available).toBe(false);
  });
});
