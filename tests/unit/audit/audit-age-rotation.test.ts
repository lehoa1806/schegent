// Feature 251 (FR-R4-F04, contract T11, SC-006, FR-016, FR-017) — the live audit log rotates by the age of
// its oldest row, through the real writer, on a fake wall clock.
//
// What it pins: with a one-day bound and appends every five minutes (far below the size threshold) the
// log rotates within one append of its oldest row turning a day old; a writer built at noon, a restart,
// still rotates a day after the oldest row and not a day after the restart; a row dated a year ahead does
// not postpone rotation; a generation whose rows carry no usable timestamp is aged from the sidecar's
// `firstObservedAt`; and a history holding a size rotation, an age rotation and an archive cut verifies
// with the real chain verifier.
//
// Why: the filing's finding (S-21) is that the age was `stat.mtimeMs`, and every append refreshes the
// mtime, so on any workspace that kept appending the log never aged out. Only `Date` is faked (the file
// system's own mtimes stay real), which is what makes the mtime reading fail here: real mtimes never move
// by a day, and the rows' own timestamps, from the faked clock, do.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { verifyAuditChainAt } from '../../../src/audit/audit-chain';
import { generationIdentity } from '../../../src/audit/audit-generation-age';
import { AuditGenerationClock, readAuditGenerationSidecar } from '../../../src/audit/audit-generation-sidecar';
import { SanitizedLogger } from '../../../src/lib/logger';
import { removeTempRoot } from '../../temp-root-cleanup';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const START = Date.parse('2026-04-01T09:00:00.000Z');

let root: string;
let auditDir: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-audit-age-'));
  auditDir = path.join(root, '.schegent');
});

afterEach(async () => {
  vi.useRealTimers();
  await removeTempRoot(root);
});

const writerWith = (overrides: ConstructorParameters<typeof AuditLogWriter>[0] extends infer C ? Partial<C> : never = {}): AuditLogWriter =>
  new AuditLogWriter(
    {
      workspaceRoot: root,
      rotationSizeBytes: 512 * 1024 * 1024,
      rotationMaxAgeMs: DAY_MS,
      retentionMaxArchives: 50,
      retentionMaxArchiveAgeMs: 365 * DAY_MS,
      ...overrides
    },
    new SanitizedLogger([])
  );

async function appendAt(writer: AuditLogWriter, at: number, n: number): Promise<void> {
  vi.setSystemTime(at);
  await writer.append({
    runId: `run-${n}`,
    phase: 'speckit-implement',
    iteration: 1,
    eventType: 'cli-invocation',
    payload: { n },
    outcome: 'info'
  });
}

const archives = async (): Promise<string[]> =>
  (await fs.readdir(auditDir)).filter((name) => /^audit\.log\.\d/.test(name)).sort();

const liveRows = async (): Promise<Array<{ timestamp: string; payload: { n: number } }>> =>
  (await fs.readFile(path.join(auditDir, 'audit.log'), 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { timestamp: string; payload: { n: number } });

describe('age rotation from the oldest row (SC-006, FR-016)', () => {
  it('rotates within one append of the oldest row turning a day old', async () => {
    const writer = writerWith();
    let rotatedAt: number | null = null;
    for (let n = 0; n <= Math.ceil((1.2 * DAY_MS) / FIVE_MINUTES_MS); n += 1) {
      const at = START + n * FIVE_MINUTES_MS;
      await appendAt(writer, at, n);
      if (rotatedAt === null && (await archives()).length > 0) rotatedAt = at;
    }

    expect(rotatedAt, 'the log rotated').not.toBeNull();
    // Within one append of the day: the append at which `now - oldest >= 1 day` rotates before it writes.
    expect(rotatedAt! - START).toBeGreaterThanOrEqual(DAY_MS);
    expect(rotatedAt! - START).toBeLessThan(DAY_MS + FIVE_MINUTES_MS);
    // The new live log starts at the append that rotated.
    expect(Date.parse((await liveRows())[0]!.timestamp)).toBe(rotatedAt);
  });

  it('still rotates a day after the oldest row when a new writer is built at noon (a restart)', async () => {
    const first = writerWith();
    // Rows from 09:00 to 12:00, then the host restarts at noon.
    for (let n = 0; n <= 36; n += 1) await appendAt(first, START + n * FIVE_MINUTES_MS, n);
    const restarted = writerWith();

    // The oldest row is at 09:00; a day later the restarted writer rotates, not a day after its own start.
    await appendAt(restarted, START + DAY_MS - FIVE_MINUTES_MS, 100);
    expect(await archives(), 'one append before a day: not yet').toHaveLength(0);
    await appendAt(restarted, START + DAY_MS, 101);
    expect(await archives(), 'a day after the oldest row: rotated').toHaveLength(1);
  });

  it('does not let a row dated a year ahead postpone rotation', async () => {
    const writer = writerWith();
    await appendAt(writer, START + 365 * DAY_MS, 0);
    // The clock is back to now (it was wrong, or a row was mis-stamped): a day later the log rotates.
    await appendAt(writer, START + 60_000, 1);
    await appendAt(writer, START + DAY_MS - FIVE_MINUTES_MS, 2);
    expect(await archives()).toHaveLength(0);
    await appendAt(writer, START + 60_000 + DAY_MS, 3);
    expect(await archives(), 'aged from when the generation was first seen, not from the future row').toHaveLength(1);
  });

  it('ages a generation of rows with no usable timestamp from the sidecar\'s firstObservedAt', async () => {
    await fs.mkdir(auditDir, { recursive: true });
    const firstLine = '{"id":"legacy-1","note":"a row with no timestamp"}';
    await fs.writeFile(path.join(auditDir, 'audit.log'), `${firstLine}\n`, 'utf8');
    // The generation was first observed 25 hours ago, by an earlier host.
    await fs.writeFile(
      path.join(auditDir, 'audit-generation.json'),
      JSON.stringify({
        version: 1,
        generation: generationIdentity(Buffer.from(firstLine, 'utf8')),
        firstObservedAt: new Date(START - 25 * 60 * 60 * 1000).toISOString()
      }),
      'utf8'
    );

    await appendAt(writerWith(), START, 0);

    expect((await archives()).length, 'rotated at once: 25 hours old by its sidecar').toBeGreaterThanOrEqual(1);
  });

  it('writes the sidecar once per generation, never under an audit.log name, owner-only', async () => {
    const writer = writerWith();
    await appendAt(writer, START, 0);
    await appendAt(writer, START + FIVE_MINUTES_MS, 1);

    const sidecar = path.join(auditDir, 'audit-generation.json');
    const parsed = JSON.parse(await fs.readFile(sidecar, 'utf8')) as { version: number; firstObservedAt: string };
    expect(parsed.version).toBe(1);
    // First observed at the second append: the first one found no generation yet, so there was nothing to
    // observe (and nothing to age) until a row existed.
    expect(Date.parse(parsed.firstObservedAt)).toBeGreaterThanOrEqual(START);
    expect(Date.parse(parsed.firstObservedAt)).toBeLessThanOrEqual(START + FIVE_MINUTES_MS);
    if (process.platform !== 'win32') expect((await fs.stat(sidecar)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(auditDir)).filter((name) => name.startsWith('audit.log') && name.includes('generation'))).toEqual([]);
  });
});

describe('a history with every kind of boundary verifies (FR-017)', () => {
  // Real time passes between appends (the clock is faked, the file system's mtimes are not), because
  // retention prunes archives by mtime and two archives made in the same millisecond have no order.
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

  it('verifies across a size rotation, an age rotation and an archive cut', async () => {
    // One writer that keeps a single archive, so every rotation prunes the one before it and records a cut
    // of exactly one archive. (A prune that removes several archives at once is a separate finding about
    // the chain verifier, noted in measurements.md and not changed here.)
    const writer = writerWith({ rotationSizeBytes: 1200, retentionMaxArchives: 1 });

    // Size rotations: a small threshold rolls the log every few rows.
    for (let n = 0; n < 7; n += 1) {
      await appendAt(writer, START + n * 60_000, n);
      await settle();
    }
    const beforeAge = await archives();
    expect(beforeAge, 'a size rotation left an archive').toHaveLength(1);

    // An age rotation: one row more than a day after the live generation's oldest, far below the size bound.
    await appendAt(writer, START + 7 * 60_000 + DAY_MS + 3_600_000, 7);
    await settle();
    const afterAge = await archives();
    expect(afterAge, 'an age rotation replaced the archive').toHaveLength(1);
    expect(afterAge[0], 'a different archive: the log rotated').not.toBe(beforeAge[0]);

    for (let n = 8; n < 12; n += 1) {
      await appendAt(writer, START + 2 * DAY_MS + n * 60_000, n);
      await settle();
    }

    expect((await fs.readFile(path.join(auditDir, 'audit.log.cuts'), 'utf8')).trim().length, 'cuts were recorded').toBeGreaterThan(0);
    const checked = verifyAuditChainAt(auditDir);
    expect(checked, 'the history can be read').not.toBeNull();
    expect(checked!.verdict.ok, JSON.stringify(checked!.verdict)).toBe(true);
    expect(checked!.verdict.ok && checked!.verdict.cuts, 'the cuts are counted, not merely tolerated').toBeGreaterThan(0);
  });
});

describe('a live log already past its size threshold', () => {
  it('rotates on size without reading the log, or the sidecar, for its age', async () => {
    await appendAt(writerWith(), START, 1);
    // The age read loads the whole live log; past the size threshold rotation is decided already, and a
    // log planted far past it (a cloned `.schegent/`, a sparse file) must not be loaded to decide it again.
    const observe = vi.spyOn(AuditGenerationClock.prototype, 'observe');
    try {
      await appendAt(writerWith({ rotationSizeBytes: 1 }), START + FIVE_MINUTES_MS, 2);
      expect(observe).not.toHaveBeenCalled();
      expect(await archives(), 'the control: the size rotation itself still happened').toHaveLength(1);
    } finally {
      observe.mockRestore();
    }
  });

  it('reads no sidecar larger than one it could have written', async () => {
    const value = { version: 1, generation: 'g', firstObservedAt: new Date(START).toISOString() };
    await fs.mkdir(auditDir, { recursive: true });
    const sidecar = path.join(auditDir, 'audit-generation.json');
    await fs.writeFile(sidecar, JSON.stringify(value));
    expect(await readAuditGenerationSidecar(root), 'the control: a sidecar of its own size is read').toEqual(value);
    await fs.writeFile(sidecar, `${JSON.stringify(value)}${' '.repeat(8192)}`);
    expect(await readAuditGenerationSidecar(root)).toBeNull();
  });
});
