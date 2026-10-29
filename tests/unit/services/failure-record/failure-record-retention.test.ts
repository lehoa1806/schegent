/**
 * FR-R4-F15 (feature 243) — contract K1: the record pass the session sweep runs.
 *
 * `specs/243-retained-failure-diagnostics/contracts/retention-and-removal.md` K6.1 to K6.6. Everything
 * runs on a real temporary directory as the workspace root; a record's age and order come from its
 * NAME, so the files hold a stub body, and a case that reads one fails (K1.7). The two seams a real
 * directory cannot supply, a listing that races a removal and a removal that fails, are the pass's
 * own `readdir` and `rm` and nothing else.
 */
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAILURE_RECORD_RETAINED_MAX, recordFileName } from '../../../../src/contracts/failure-record';
import { sweepFailureRecords } from '../../../../src/services/failure-record/failure-record-retention';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-10-28T14:30:05.123Z');
const MAX_AGE_MS = 30 * DAY_MS;
const RECORDS = path.join('.schegent', 'failure-records');
const IS_WINDOWS = process.platform === 'win32';

let root: string;
let outside: string;
let warn: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'failure-record-retention-'));
  outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'failure-record-retention-outside-'));
  warn = vi.fn();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });
});

const dir = (): string => path.join(root, RECORDS);

/** A record name for an instant, a suffix and a Run. The body is never read. */
function nameFor(failedAtMs: number, suffix = '0a1b2c3d', runId = 'run-1'): string {
  const name = recordFileName({ failedAt: new Date(failedAtMs).toISOString(), suffix, runId, taskId: 'task-1' });
  if (name === null) throw new Error('fixture name does not build');
  return name;
}

async function plant(name: string, body = '{}'): Promise<void> {
  await fsp.mkdir(dir(), { recursive: true });
  await fsp.writeFile(path.join(dir(), name), body);
}

async function remaining(): Promise<string[]> {
  return (await fsp.readdir(dir()).catch(() => [] as string[])).sort();
}

const sweep = (maxAgeMs = MAX_AGE_MS, extra: Partial<Parameters<typeof sweepFailureRecords>[0]> = {}) =>
  sweepFailureRecords({ workspaceRoot: root, logger: { warn }, ...extra }, maxAgeMs, NOW);

describe('age (K6.1, K1.3)', () => {
  it('removes the records older than the age and keeps the ones within it', async () => {
    const old = [31, 40, 90].map((days, index) => nameFor(NOW.getTime() - days * DAY_MS, `0000000${index}`));
    const young = [1, 29].map((days, index) => nameFor(NOW.getTime() - days * DAY_MS, `1111111${index}`));
    for (const name of [...old, ...young]) await plant(name);

    expect(await sweep()).toEqual({ removed: 3, failures: 0 });
    expect(await remaining()).toEqual([...young].sort());
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps a record exactly as old as the age, and removes one a millisecond older', async () => {
    const exactly = nameFor(NOW.getTime() - MAX_AGE_MS, '00000001');
    const older = nameFor(NOW.getTime() - MAX_AGE_MS - 1, '00000002');
    await plant(exactly);
    await plant(older);
    expect(await sweep()).toEqual({ removed: 1, failures: 0 });
    expect(await remaining()).toEqual([exactly]);
  });

  it('keeps a record whose stamp is in the future: its age is negative', async () => {
    const future = nameFor(NOW.getTime() + DAY_MS, '00000001');
    await plant(future);
    expect(await sweep(1)).toEqual({ removed: 0, failures: 0 });
    expect(await remaining()).toEqual([future]);
  });

  it('reads the age from the name, never from the file: an old file with a fresh name is kept', async () => {
    const fresh = nameFor(NOW.getTime() - DAY_MS, '00000001');
    await plant(fresh);
    const longAgo = new Date(NOW.getTime() - 365 * DAY_MS);
    await fsp.utimes(path.join(dir(), fresh), longAgo, longAgo);
    expect(await sweep()).toEqual({ removed: 0, failures: 0 });
    expect(await remaining()).toEqual([fresh]);
  });
});

describe('count (K6.2, K6.4, K1.4)', () => {
  it('removes the oldest of 201 records within the age, so 200 remain', async () => {
    const names: string[] = [];
    for (let index = 0; index < FAILURE_RECORD_RETAINED_MAX + 1; index += 1) {
      names.push(nameFor(NOW.getTime() - (index + 1) * 60_000, '0a1b2c3d'));
    }
    for (const name of names) await plant(name);

    expect(await sweep()).toEqual({ removed: 1, failures: 0 });
    const left = await remaining();
    expect(left).toHaveLength(FAILURE_RECORD_RETAINED_MAX);
    // `names` runs newest to oldest, so the one that went is the last.
    expect(left).not.toContain(names[names.length - 1]);
    expect(left).toContain(names[0]);
  });

  it('orders equal stamps by suffix, removing the lesser suffix first', async () => {
    const stamp = NOW.getTime() - DAY_MS;
    const names: string[] = [];
    for (let index = 0; index < FAILURE_RECORD_RETAINED_MAX + 1; index += 1) {
      names.push(nameFor(stamp, index.toString(16).padStart(8, '0')));
    }
    for (const name of names) await plant(name);
    await sweep();
    expect(await remaining()).not.toContain(names[0]);
    expect(await remaining()).toHaveLength(FAILURE_RECORD_RETAINED_MAX);
  });

  it('keeps a future-stamped record by age and still counts it toward the 200', async () => {
    const future = nameFor(NOW.getTime() + DAY_MS, 'ffffffff');
    const within: string[] = [];
    for (let index = 0; index < FAILURE_RECORD_RETAINED_MAX; index += 1) {
      within.push(nameFor(NOW.getTime() - (index + 1) * 60_000, '0a1b2c3d'));
    }
    await plant(future);
    for (const name of within) await plant(name);

    // A one-day age: the future record is kept by age (its age is negative), and with 200 others it is
    // one of 201, so the oldest of the 200 goes.
    expect(await sweep(DAY_MS)).toEqual({ removed: 1, failures: 0 });
    const left = await remaining();
    expect(left).toHaveLength(FAILURE_RECORD_RETAINED_MAX);
    expect(left).toContain(future);
    expect(left).not.toContain(within[within.length - 1]);
  });

  it('applies the age first, so the count is of what survived it', async () => {
    const survivors: string[] = [];
    for (let index = 0; index < FAILURE_RECORD_RETAINED_MAX; index += 1) {
      survivors.push(nameFor(NOW.getTime() - (index + 1) * 60_000, '0a1b2c3d'));
    }
    const expired = nameFor(NOW.getTime() - 2 * MAX_AGE_MS, '00000001');
    for (const name of [...survivors, expired]) await plant(name);
    expect(await sweep()).toEqual({ removed: 1, failures: 0 });
    expect(await remaining()).toHaveLength(FAILURE_RECORD_RETAINED_MAX);
    expect(await remaining()).not.toContain(expired);
  });
});

describe('a record already gone counts as removed (K6.3, K1.5)', () => {
  it('counts a candidate deleted between the listing and the removal as removed, with no warning', async () => {
    const gone = nameFor(NOW.getTime() - 40 * DAY_MS, '00000001');
    await plant(gone);
    const result = await sweep(MAX_AGE_MS, {
      fs: {
        readdir: async (directory) => {
          const entries = await fsp.readdir(directory, { withFileTypes: true });
          await fsp.rm(path.join(directory, gone));
          return entries;
        }
      }
    });
    expect(result).toEqual({ removed: 1, failures: 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('counts an ENOENT from the removal itself as removed, with no warning', async () => {
    const gone = nameFor(NOW.getTime() - 40 * DAY_MS, '00000001');
    await plant(gone);
    const result = await sweep(MAX_AGE_MS, {
      fs: {
        rm: async () => {
          throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        }
      }
    });
    expect(result).toEqual({ removed: 1, failures: 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once by code, keeps the candidate and carries on when a removal fails', async () => {
    const stuck = nameFor(NOW.getTime() - 50 * DAY_MS, '00000001');
    const other = nameFor(NOW.getTime() - 40 * DAY_MS, '00000002');
    await plant(stuck);
    await plant(other);
    const result = await sweep(MAX_AGE_MS, {
      fs: {
        rm: async (target) => {
          if (target.includes('00000001')) throw Object.assign(new Error(`busy: ${target}`), { code: 'EBUSY' });
          await fsp.rm(target, { force: true });
        }
      }
    });
    expect(result).toEqual({ removed: 1, failures: 1 });
    expect(await remaining()).toEqual([stuck]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('failure-record-retention: remove failed', { errorCode: 'EBUSY' });
  });
});

describe('what it leaves alone (K6.5, K1.2)', () => {
  it('touches no symlink, directory, foreign file, spool entry or lock, however old their names read', async () => {
    const ancient = NOW.getTime() - 365 * DAY_MS;
    const real = nameFor(ancient, '00000001');
    const linkName = nameFor(ancient, '00000002');
    const dirName = nameFor(ancient, '00000003');
    await plant(real);
    await plant('notes.txt');
    await plant('.pending');
    await plant(`${nameFor(ancient, '00000004')}.lock`);
    await plant('x.json');
    await fsp.mkdir(path.join(dir(), dirName));
    await fsp.writeFile(path.join(dir(), dirName, 'inner.json'), 'inner');
    if (!IS_WINDOWS) {
      const target = path.join(outside, 'target.json');
      await fsp.writeFile(target, 'outside');
      await fsp.symlink(target, path.join(dir(), linkName));
    }

    expect(await sweep()).toEqual({ removed: 1, failures: 0 });
    const left = await remaining();
    expect(left).not.toContain(real);
    for (const kept of ['notes.txt', '.pending', 'x.json', dirName, `${nameFor(ancient, '00000004')}.lock`]) {
      expect(left, kept).toContain(kept);
    }
    expect(await fsp.readFile(path.join(dir(), dirName, 'inner.json'), 'utf8')).toBe('inner');
    if (!IS_WINDOWS) {
      expect(left).toContain(linkName);
      expect(await fsp.readFile(path.join(outside, 'target.json'), 'utf8')).toBe('outside');
    }
  });

  it('does nothing, and says nothing, when the directory does not exist', async () => {
    expect(await sweep()).toEqual({ removed: 0, failures: 0 });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('a directory that is not the workspace\'s own (K6.6, K1.1)', () => {
  it.skipIf(IS_WINDOWS)('warns once and removes nothing when the directory is a symlink out of the workspace', async () => {
    const victim = path.join(outside, nameFor(NOW.getTime() - 365 * DAY_MS, '00000001'));
    await fsp.writeFile(victim, 'must survive');
    await fsp.mkdir(path.join(root, '.schegent'), { recursive: true });
    await fsp.symlink(outside, dir());

    expect(await sweep()).toEqual({ removed: 0, failures: 1 });
    expect(await fsp.readFile(victim, 'utf8')).toBe('must survive');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe('failure-record-retention: root refused');
    expect(Object.keys(warn.mock.calls[0]?.[1] as object).sort()).toEqual(['errno', 'reason']);
  });
});

describe('what a warning may say, and what the pass may read (K1.6, K1.7)', () => {
  it('names no path, file name, Run id or content in any warning', async () => {
    const stuck = nameFor(NOW.getTime() - 50 * DAY_MS, '00000001', 'run-secret-9');
    await plant(stuck, 'SECRET-BODY-TEXT');
    await sweep(MAX_AGE_MS, {
      fs: {
        rm: async (target) => {
          throw Object.assign(new Error(`EBUSY: ${target}`), { code: 'EBUSY' });
        }
      }
    });
    const logged = JSON.stringify(warn.mock.calls);
    for (const fragment of [root, stuck, 'run-secret-9', 'task-1', 'SECRET-BODY-TEXT', '.schegent']) {
      expect(logged, fragment).not.toContain(fragment);
    }
  });

  it('reads no record body: neither readFile nor open is called, and an unreadable file is still swept', async () => {
    const names = [41, 5].map((days, index) => nameFor(NOW.getTime() - days * DAY_MS, `0000000${index}`));
    for (const name of names) await plant(name, 'not json at all, and never read');
    const readFile = vi.spyOn(fsp, 'readFile');
    const open = vi.spyOn(fsp, 'open');

    expect(await sweep()).toEqual({ removed: 1, failures: 0 });
    expect(readFile).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(await remaining()).toEqual([names[1]]);
  });
});
