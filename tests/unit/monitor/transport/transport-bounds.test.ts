// Feature 251 (FR-R4-F04, contract T4, SC-003, FR-005, FR-006, FR-007) — every transport file is
// bounded by record age, by size, and by a workspace total.
//
// What it pins: appends every minute for longer than the age bound leave no record older than the
// bound in the live Run file; the per-file bound holds after many appends; one record longer than the
// bound becomes data-model §2's placeholder and none of its content reaches the disk; Run files and
// legacy generations over the workspace total lose the inactive file with the oldest newest-record
// time first, and an active Run's file is never removed; a legacy generation whose newest record is
// past the bound is removed whole by `runPass` and one inside it is not rewritten; compaction sets
// the file's mtime to its newest record's time (R6); and `usage()` reports the cached measure.
//
// Why: the filing's finding (D-31) is that no age bound existed, so expired records remained for as
// long as the file lived. Wall time is faked (`toFake: ['Date']`) and a one-day bound keeps the
// stretch short; every "removed" claim is paired with a control that must hit.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { CLI_TRANSPORT_FILE_NAME } from '../../../../src/monitor/cli-transport-sink';
import {
  TRANSPORT_FILE_MAX_BYTES,
  TRANSPORT_WORKSPACE_MAX_BYTES
} from '../../../../src/monitor/transport/transport-policy';
import { createTransportHarness, runFilePath, type TransportHarness } from './transport-harness';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const MIB = 1024 * 1024;
const START = Date.parse('2026-03-01T00:00:00.000Z');
const NO_ACTIVE: ReadonlySet<string> = new Set();

let harness: TransportHarness;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  harness = await createTransportHarness({ setting: 'on', ageDays: 1 });
});

afterEach(async () => {
  vi.useRealTimers();
  await harness.dispose();
});

const lineAt = (iso: string, runId: string, content: string): string =>
  `${iso}\t${runId}\tspeckit-implement\tstdout\t${content}\n`;

/** A file of valid records whose newest is `newestMs`, padded to about `bytes`. */
async function writeRecords(file: string, runId: string, newestMs: number, bytes: number): Promise<void> {
  const padding = 'p'.repeat(1000);
  const count = Math.max(1, Math.floor(bytes / (padding.length + 80)));
  const rows: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = newestMs - (count - 1 - index) * 1000;
    rows.push(lineAt(new Date(at).toISOString(), runId, `${padding} ${index}`));
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, rows.join(''), { mode: 0o600 });
}

const exists = async (file: string): Promise<boolean> =>
  fs.stat(file).then(
    () => true,
    () => false
  );

describe('record age (SC-003, FR-005)', () => {
  it('leaves no record older than the bound in the live Run file after appends past the bound', async () => {
    const appends = Math.floor((1.5 * DAY_MS) / MINUTE_MS);
    for (let index = 0; index < appends; index += 1) {
      vi.setSystemTime(START + index * MINUTE_MS);
      harness.record('run-a', `SYNTHETIC-MARKER-251-age ${index}`);
      // Flushed per append: the router reads the clock when it processes a record, not when the sink
      // accepts it, so a loop that queues them all would have it judge every record at the last time.
      await harness.flush();
    }
    const now = START + (appends - 1) * MINUTE_MS;

    const records = (await fs.readFile(harness.runFile('run-a'), 'utf8')).trimEnd().split('\n');
    const times = records.map((line) => Date.parse(line.split('\t')[0]!));
    expect(Math.min(...times)).toBeGreaterThanOrEqual(now - DAY_MS);
    // The controls: the newest record is kept and the first one is gone, so this is compaction and
    // not a file that simply never held much.
    expect(records[records.length - 1]!.includes(`age ${appends - 1}`)).toBe(true);
    expect(records.some((line) => line.includes('age 0\t') || line.endsWith('age 0'))).toBe(false);
    expect(records.length).toBeGreaterThan(1000);
  });

  it('sets the mtime of a compacted file to its newest record, not to the time of the rewrite (R6)', async () => {
    const file = harness.runFile('run-old');
    const newest = START - 60 * MINUTE_MS;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      [START - 2 * DAY_MS, START - 3 * 60 * MINUTE_MS, newest]
        .map((at, index) => lineAt(new Date(at).toISOString(), 'run-old', `old ${index}`))
        .join(''),
      { mode: 0o600 }
    );

    await harness.router.runPass(NO_ACTIVE);

    const kept = (await fs.readFile(file, 'utf8')).trimEnd().split('\n');
    // The control: the expired record went and the two inside the bound stayed.
    expect(kept.map((line) => line.split('\t')[4])).toEqual(['old 1', 'old 2']);
    expect(Math.abs((await fs.stat(file)).mtimeMs - newest)).toBeLessThan(2);
  });
});

describe('the per-file bound (FR-005)', () => {
  it('holds after many appends and keeps the newest records', async () => {
    const chunk = 'x'.repeat(64 * 1024);
    const total = 100;
    for (let index = 0; index < total; index += 1) {
      vi.setSystemTime(START + index * 1000);
      harness.record('run-a', `${chunk} n=${index}`);
      await harness.flush();
    }

    const file = harness.runFile('run-a');
    expect((await fs.stat(file)).size).toBeLessThanOrEqual(TRANSPORT_FILE_MAX_BYTES);
    const content = await fs.readFile(file, 'utf8');
    expect(content.includes(` n=${total - 1}\n`)).toBe(true);
    expect(content.includes(` n=0\n`)).toBe(false);
  });
});

describe('an oversize record (FR-006)', () => {
  it('becomes the placeholder and no byte of its content reaches the disk', async () => {
    const content = 'SYNTHETIC-MARKER-251-big '.repeat(Math.ceil((TRANSPORT_FILE_MAX_BYTES + 1024) / 25));
    harness.record('run-a', content);
    await harness.flush();

    const formatted = `${new Date(START).toISOString()}\trun-a\tspeckit-implement\tstdout\t${content}\n`;
    const expected =
      `${new Date(START).toISOString()}\trun-a\tspeckit-implement\tstdout\t` +
      `[transport record omitted: run=run-a phase=speckit-implement stream=stdout bytes=${Buffer.byteLength(formatted)}]\n`;
    const written = await fs.readFile(harness.runFile('run-a'), 'utf8');
    expect(written).toBe(expected);
    expect(written.includes('SYNTHETIC-MARKER-251-big')).toBe(false);
  });
});

describe('the workspace total (FR-006)', () => {
  it('removes the inactive file with the oldest newest-record time first, legacy generations included', async () => {
    harness.setting = 'on';
    const legacy = path.join(harness.workspaceRoot, '.schegent', `${CLI_TRANSPORT_FILE_NAME}.1`);
    await writeRecords(legacy, 'legacy', START - 5 * 60_000, 4 * MIB);
    for (let run = 1; run <= 5; run += 1) {
      await writeRecords(runFilePath(harness.workspaceRoot, `run-${run}`), `run-${run}`, START - (5 - run) * 60_000, 4 * MIB);
    }
    // run-1 is the oldest Run file and is active, so it is the file the total must not remove.
    const active = new Set(['run-1']);
    harness.statuses.set('run-1', 'running');

    await harness.router.finalizeRun('run-5', 'completed', active);

    expect(await exists(legacy), 'the oldest candidate is the legacy generation').toBe(false);
    expect(await exists(harness.runFile('run-1')), 'an active Run is never removed').toBe(true);
    for (const run of ['run-2', 'run-3', 'run-4', 'run-5']) {
      expect(await exists(harness.runFile(run)), `${run} stays: the total is met`).toBe(true);
    }
  });

  it('never removes an active Run, even when it is the only candidate over the total', async () => {
    harness.setting = 'on';
    await writeRecords(harness.runFile('run-active'), 'run-active', START, 4 * MIB);
    for (let run = 1; run <= 5; run += 1) {
      await writeRecords(harness.runFile(`run-${run}`), `run-${run}`, START + run * 60_000, 4 * MIB);
    }
    const active = new Set(['run-active']);
    harness.statuses.set('run-active', 'running');

    await harness.router.finalizeRun('run-5', 'completed', active);

    expect(await exists(harness.runFile('run-active'))).toBe(true);
    // Control: the total was enforced (24 MiB of files over a 20 MiB bound), by removing something.
    const survivors = await Promise.all(
      ['run-1', 'run-2', 'run-3', 'run-4', 'run-5'].map((run) => exists(harness.runFile(run)))
    );
    expect(survivors.filter(Boolean).length).toBeLessThan(5);
    expect(TRANSPORT_WORKSPACE_MAX_BYTES).toBe(20 * MIB);
  });
});

describe('legacy generations expire whole (FR-007)', () => {
  it('removes one whose newest record is past the bound, and leaves one inside it untouched', async () => {
    const directory = path.join(harness.workspaceRoot, '.schegent');
    const expired = path.join(directory, `${CLI_TRANSPORT_FILE_NAME}.2`);
    const inside = path.join(directory, `${CLI_TRANSPORT_FILE_NAME}.1`);
    await writeRecords(expired, 'legacy', START - 3 * DAY_MS, 64 * 1024);
    await writeRecords(inside, 'legacy', START - 60_000, 64 * 1024);
    const insideBefore = await fs.readFile(inside);

    await harness.router.runPass(NO_ACTIVE);

    expect(await exists(expired)).toBe(false);
    // Not rewritten: its oldest records are outside the bound, and a legacy generation is never
    // compacted (data-model §3, "Never").
    expect((await fs.readFile(inside)).equals(insideBefore)).toBe(true);
  });
});

describe('usage (data-model §4)', () => {
  it('reports the retained bytes, Run count, legacy bytes and the date the latest record ages out', async () => {
    const legacy = path.join(harness.workspaceRoot, '.schegent', `${CLI_TRANSPORT_FILE_NAME}.1`);
    await writeRecords(legacy, 'legacy', START - 2 * 60_000, 100 * 1024);
    harness.record('run-a', 'SYNTHETIC-MARKER-251-usage a');
    vi.setSystemTime(START + 60_000);
    harness.record('run-b', 'SYNTHETIC-MARKER-251-usage b');
    await harness.flush();
    expect(harness.router.usage(), 'nothing is measured before the first Run end or pass').toBeNull();

    await harness.router.finalizeRun('run-b', 'completed', NO_ACTIVE);

    const usage = harness.router.usage();
    const runBytes =
      (await fs.stat(harness.runFile('run-a'))).size + (await fs.stat(harness.runFile('run-b'))).size;
    const legacyBytes = (await fs.stat(legacy)).size;
    expect(usage).toEqual({
      version: 1,
      retainedBytes: runBytes + legacyBytes,
      runCount: 2,
      legacyBytes,
      agesOutBy: new Date(START + 60_000 + DAY_MS).toISOString(),
      measuredAt: new Date(START + 60_000).toISOString()
    });
  });
});
