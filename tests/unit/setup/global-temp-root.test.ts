import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import {
  formatSweepReport,
  isReused,
  liveness,
  parseStartTimes,
  readStartTimes,
  removeRunRoot,
  REUSE_MARGIN_MS,
  setup,
  sweepScratchRoots,
  teardown,
  type Kill,
  type StartTimeReader
} from '../../global-temp-root';
import { removeTempRoot } from '../../temp-root-cleanup';

/**
 * FR-R3-181 (US3, T1818 – T1821) — the scratch sweep in the vitest global setup, and the
 * teardown beside it.
 *
 * The sweep deletes directories recursively, so most of this file is about what it must NOT
 * delete: a root whose process is alive — including one owned by another user, which `kill`
 * reports as EPERM — this run's own root, and any name the setup did not write. Each removal
 * case sits beside a survival case that differs from it in one fact.
 *
 * `kill` and the start-time reader are injected. EPERM cannot be produced on a single-user
 * machine, and a real pid reuse needs the kernel to wrap its pid space; those are exactly the
 * cases a sweep gets wrong. The defaults are then exercised against the real kernel and the
 * real `ps`, so an injected seam cannot quietly stand in for something the defaults do not do.
 */

/** A root's last write, well in the past: the 2026-09-02 mtime of the reused root found on 2026-10-01. */
const STALE = new Date('2026-09-02T05:29:02Z');
const STALE_MS = STALE.getTime();

/** Stands in for this run's pid in the sweep cases; no fixture uses it unless the case is about it. */
const OWN_PID = 4242;

/** The largest pid `process.kill` accepts, and so the largest the sweep reads from a name. */
const MAX_PID = 2 ** 31 - 1;

/** The report line's whole shape (contracts/scratch-sweep-report.md). */
const REPORT_SHAPE = /^scratch sweep: found=\d+ removed=\d+ skipped=\d+$/;

/** `lstart` is whole seconds and Node's uptime starts a little after exec; both are far inside this. */
const PS_START_TOLERANCE_MS = 5_000;

/** A Date set through `utimes` comes back through `stat` as a float, and can land a fraction early. */
const TIMESTAMP_ROUNDING_MS = 1;

function codedError(code: string): Error {
  return Object.assign(new Error(`synthetic ${code}`), { code });
}

function killThrowing(code: string): Kill {
  return () => {
    throw codedError(code);
  };
}

/** Every pid is held. */
const ALIVE: Kill = () => true;
/** No pid is held. */
const DEAD: Kill = killThrowing('ESRCH');

/** The listed pids are free; every other one is held. */
function killWhereDead(...dead: readonly number[]): Kill {
  return (pid) => {
    if (dead.includes(pid)) throw codedError('ESRCH');
    return true;
  };
}

/** A reader that knows these start times and no others. */
function knownStartTimes(times: Readonly<Record<number, number>>): StartTimeReader {
  const known = new Map(Object.entries(times).map(([pid, at]) => [Number(pid), at]));
  return (pids) => Promise.resolve(new Map(pids.flatMap((pid) => (known.has(pid) ? [[pid, known.get(pid)!]] : []))));
}

/** The pid of a process that has exited and been reaped, so nothing holds it. */
async function reapedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  if (child.pid === undefined) throw new Error('the child process was never spawned');
  return child.pid;
}

let scratch: string;
let parent: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'global-temp-root-'));
  parent = path.join(scratch, '.tmp');
  await fs.mkdir(parent);
});

afterEach(async () => {
  await removeTempRoot(scratch);
});

/** A run-root-shaped directory with a file in it, last written at `writtenAt`. */
async function root(name: string, writtenAt: Date = STALE): Promise<string> {
  const dir = path.join(parent, name);
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'transcript.jsonl'), '{}\n');
  await fs.utimes(dir, writtenAt, writtenAt);
  return dir;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

describe('liveness — only ESRCH proves a pid free (T1818, FR-024)', () => {
  it('a pid whose probe does not throw is alive', () => {
    expect(liveness(101, ALIVE)).toBe('alive');
  });

  it('ESRCH is dead', () => {
    expect(liveness(101, DEAD)).toBe('dead');
  });

  it('EPERM is alive: the process exists, and belongs to another user', () => {
    expect(liveness(101, killThrowing('EPERM'))).toBe('alive');
  });

  it.each(['EINVAL', 'EIO', 'ERR_INVALID_ARG_TYPE'])('an unrecognised %s is alive — fail closed', (code) => {
    expect(liveness(101, killThrowing(code))).toBe('alive');
  });

  it('a throw with no code is alive, and so is a throw that is not an Error at all', () => {
    expect(
      liveness(101, () => {
        throw new Error('no code');
      })
    ).toBe('alive');
    // JavaScript permits throwing anything; a bare string that happens to read ESRCH is not one.
    expect(
      liveness(101, () => {
        throw 'ESRCH';
      })
    ).toBe('alive');
  });

  it('probes with signal 0, which delivers nothing', () => {
    const kill = vi.fn<Kill>(() => true);
    liveness(101, kill);
    expect(kill).toHaveBeenCalledWith(101, 0);
  });

  it('the default probe asks the real kernel: this process is alive, a reaped child is dead', async () => {
    expect(liveness(process.pid)).toBe('alive');
    expect(liveness(await reapedPid())).toBe('dead');
  });
});

describe('pid reuse — a holder that started after the last write is not the creator (T1818a, FR-023)', () => {
  it('the holder must start more than the margin after the last write', () => {
    expect(isReused(STALE_MS - 1, STALE_MS)).toBe(false);
    expect(isReused(STALE_MS, STALE_MS)).toBe(false);
    expect(isReused(STALE_MS + REUSE_MARGIN_MS, STALE_MS)).toBe(false);
    expect(isReused(STALE_MS + REUSE_MARGIN_MS + 1, STALE_MS)).toBe(true);
  });

  it('removes a held root whose holder postdates it, and keeps one whose holder could be its creator', async () => {
    const reused = await root('vitest-101');
    const creator = await root('vitest-102');
    const unread = await root('vitest-103');
    const warn = vi.fn();

    const counts = await sweepScratchRoots(parent, {
      ownPid: OWN_PID,
      kill: ALIVE,
      readStartTimes: knownStartTimes({ 101: STALE_MS + REUSE_MARGIN_MS + 1_000, 102: STALE_MS - 1_000 }),
      warn
    });

    expect(await exists(reused)).toBe(false);
    expect(await exists(creator)).toBe(true);
    expect(await exists(unread)).toBe(true);
    expect(counts).toEqual({ found: 3, removed: 1, skipped: 2 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads the start time of every held pid in one call, and of no free one', async () => {
    await root('vitest-201');
    await root('vitest-202');
    await root('vitest-203');
    const reader = vi.fn<StartTimeReader>(() => Promise.resolve(new Map()));

    await sweepScratchRoots(parent, { ownPid: OWN_PID, kill: killWhereDead(201), readStartTimes: reader, warn: vi.fn() });

    expect(reader).toHaveBeenCalledTimes(1);
    expect([...(reader.mock.calls[0]?.[0] ?? [])].sort((a, b) => a - b)).toEqual([202, 203]);
  });

  it('asks for no start time at all when no pid is held', async () => {
    await root('vitest-211');
    const reader = vi.fn<StartTimeReader>(() => Promise.resolve(new Map()));

    const counts = await sweepScratchRoots(parent, { ownPid: OWN_PID, kill: DEAD, readStartTimes: reader, warn: vi.fn() });

    expect(reader).not.toHaveBeenCalled();
    expect(counts).toEqual({ found: 1, removed: 1, skipped: 0 });
  });

  const failClosed: ReadonlyArray<readonly [string, StartTimeReader]> = [
    ['unavailable', () => Promise.resolve(new Map())],
    ['failing', () => Promise.reject(new Error('ps: command not found'))],
    // A localized month: what `ps` prints when the C locale did not take.
    ['unparseable', (pids) => readStartTimes(pids, () => Promise.resolve('  301 mer. sept.  2 05:29:02 2026\n'))]
  ];

  it.each(failClosed)('an %s start time keeps the root — the sweep degrades to kill alone, not to a deletion', async (_case, reader) => {
    const held = await root('vitest-301');

    const counts = await sweepScratchRoots(parent, { ownPid: OWN_PID, kill: ALIVE, readStartTimes: reader, warn: vi.fn() });

    expect(await exists(held)).toBe(true);
    expect(counts).toEqual({ found: 1, removed: 0, skipped: 1 });
  });

  it('reads liveness again at removal: a pid taken between the batch and its turn keeps the root', async () => {
    const taken = await root('vitest-311');
    let probes = 0;
    // Free when the batch is built, held by the time the sweep reaches the root.
    const kill: Kill = () => {
      probes += 1;
      if (probes === 1) throw codedError('ESRCH');
      return true;
    };

    const counts = await sweepScratchRoots(parent, { ownPid: OWN_PID, kill, readStartTimes: knownStartTimes({}), warn: vi.fn() });

    expect(await exists(taken)).toBe(true);
    expect(counts).toEqual({ found: 1, removed: 0, skipped: 1 });
  });
});

describe('the sweep removes only what it proved orphaned (T1819, FR-024, SC-006)', () => {
  it('removes a root whose pid nothing holds, through the remover it was given', async () => {
    const orphan = await root('vitest-101');
    const remove = vi.fn(removeTempRoot);

    const counts = await sweepScratchRoots(parent, { ownPid: OWN_PID, kill: DEAD, remove, warn: vi.fn() });

    expect(remove).toHaveBeenCalledWith(orphan);
    expect(await exists(orphan)).toBe(false);
    expect(counts).toEqual({ found: 1, removed: 1, skipped: 0 });
  });

  it("never examines this run's own root, though the same facts remove a stranger's", async () => {
    const own = await root(`vitest-${OWN_PID}`);
    const stranger = await root('vitest-5151');
    const kill = vi.fn<Kill>(() => true);
    // Every holder started now, long after either root's last write.
    const reader = vi.fn<StartTimeReader>((pids) => Promise.resolve(new Map(pids.map((pid) => [pid, Date.now()]))));

    const counts = await sweepScratchRoots(parent, { ownPid: OWN_PID, kill, readStartTimes: reader, warn: vi.fn() });

    expect(await exists(own)).toBe(true);
    expect(await exists(stranger)).toBe(false);
    expect(kill).not.toHaveBeenCalledWith(OWN_PID, 0);
    expect(reader).toHaveBeenCalledWith([5151]);
    expect(counts).toEqual({ found: 2, removed: 1, skipped: 1 });
  });

  it('ignores every name the setup did not write, however dead the number in it', async () => {
    const strangers = ['vitest-abc', 'other-1', 'vitest-0123', 'vitest-12-x', 'vitest-0', `vitest-${MAX_PID + 1}`];
    for (const name of strangers) await root(name);
    await fs.writeFile(path.join(parent, 'vitest-77'), 'a file, not a root');
    const elsewhere = path.join(scratch, 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.symlink(elsewhere, path.join(parent, 'vitest-78'));
    // The control: the largest pid the sweep reads, and the same kill, is removed.
    const boundary = await root(`vitest-${MAX_PID}`);
    const kill = vi.fn<Kill>(DEAD);

    const counts = await sweepScratchRoots(parent, { ownPid: OWN_PID, kill, warn: vi.fn() });

    for (const name of [...strangers, 'vitest-77', 'vitest-78']) {
      expect(await exists(path.join(parent, name)), name).toBe(true);
    }
    expect(await exists(elsewhere)).toBe(true);
    expect(await exists(boundary)).toBe(false);
    expect(new Set(kill.mock.calls.map(([pid]) => pid))).toEqual(new Set([MAX_PID]));
    expect(counts).toEqual({ found: 9, removed: 1, skipped: 8 });
  });
});

describe('the report — one line, every run (T1820, FR-025, SC-008)', () => {
  it('has one fixed shape, zeros included', () => {
    expect(formatSweepReport({ found: 0, removed: 0, skipped: 0 })).toBe('scratch sweep: found=0 removed=0 skipped=0');
    expect(formatSweepReport({ found: 151, removed: 150, skipped: 1 })).toMatch(REPORT_SHAPE);
  });

  it('a missing scratch directory is a clean tree: zeros, and no warning', async () => {
    const warn = vi.fn();
    await expect(sweepScratchRoots(path.join(scratch, 'absent'), { warn })).resolves.toEqual({
      found: 0,
      removed: 0,
      skipped: 0
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('so is an empty one', async () => {
    await expect(sweepScratchRoots(parent, { ownPid: OWN_PID, warn: vi.fn() })).resolves.toEqual({
      found: 0,
      removed: 0,
      skipped: 0
    });
  });

  it('a scratch path that cannot be listed is named on stderr, and the run goes on', async () => {
    const notADirectory = path.join(scratch, 'not-a-directory');
    await fs.writeFile(notADirectory, '');
    const warn = vi.fn();

    await expect(sweepScratchRoots(notADirectory, { warn })).resolves.toEqual({ found: 0, removed: 0, skipped: 0 });

    expect(warn).toHaveBeenCalledExactlyOnceWith('scratch sweep: not-a-directory could not be listed (ENOTDIR)');
  });

  it('found = removed + skipped across every way a root can go', async () => {
    await root('vitest-301'); // free: removed
    await root('vitest-302'); // held by a stranger: removed
    await root('vitest-303'); // held by what could be its creator: skipped
    await root(`vitest-${OWN_PID}`); // this run's own: skipped
    await root('not-a-root'); // a name the setup never wrote: skipped
    const stuck = await root('vitest-306'); // free, but its removal fails: skipped, and said so
    const warn = vi.fn();
    const remove = (dir: string): Promise<void> =>
      dir === stuck ? Promise.reject(codedError('EBUSY')) : removeTempRoot(dir);

    const counts = await sweepScratchRoots(parent, {
      ownPid: OWN_PID,
      kill: killWhereDead(301, 306),
      readStartTimes: knownStartTimes({ 302: STALE_MS + REUSE_MARGIN_MS + 1_000, 303: STALE_MS - 1_000 }),
      remove,
      warn
    });

    expect(counts).toEqual({ found: 6, removed: 2, skipped: 4 });
    expect(counts.found).toBe(counts.removed + counts.skipped);
    expect(await exists(stuck)).toBe(true);
    expect(warn).toHaveBeenCalledExactlyOnceWith('scratch sweep: vitest-306 was not removed (EBUSY); counted as skipped');
  });
});

describe('setup sweeps before it creates its own root (FR-023, FR-025)', () => {
  const ENV_KEYS = ['TMPDIR', 'TMP', 'TEMP', 'GIT_CEILING_DIRECTORIES'] as const;
  let savedEnv: ReadonlyMap<string, string | undefined>;
  let log: MockInstance<typeof console.log>;

  beforeEach(() => {
    savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await teardown();
    log.mockRestore();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('prints exactly one line, all zeros on a clean tree — so the sweep ran before this root existed', async () => {
    await setup({ config: { root: scratch } });

    expect(log.mock.calls).toEqual([['scratch sweep: found=0 removed=0 skipped=0']]);
    const own = path.join(parent, `vitest-${process.pid}`);
    expect(process.env.TMPDIR).toBe(own);

    await teardown();
    expect(await exists(own)).toBe(false);
  });

  it("adopts a root left under this run's pid and moves its last write to now", async () => {
    const own = await root(`vitest-${process.pid}`);
    const before = Date.now();

    await setup({ config: { root: scratch } });

    expect(log.mock.calls).toEqual([['scratch sweep: found=1 removed=0 skipped=1']]);
    // Left at STALE, a concurrent run's sweep would read this process's start against it and
    // take a live root for a reused one.
    expect((await fs.stat(own)).mtimeMs).toBeGreaterThanOrEqual(before - TIMESTAMP_ROUNDING_MS);
  });
});

describe('teardown reports a failed removal and does not throw (T1821, FR-020, FR-021)', () => {
  it('names the root and the code on stderr, and resolves', async () => {
    const own = await root('vitest-4243');
    const remove = vi.fn(() => Promise.reject(codedError('EBUSY')));
    const warn = vi.fn();

    await expect(removeRunRoot(own, { remove, warn })).resolves.toBeUndefined();

    expect(remove).toHaveBeenCalledWith(own);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "scratch teardown: vitest-4243 was not removed (EBUSY); left for the next run's sweep"
    );
  });

  it('says nothing when the removal succeeds', async () => {
    const own = await root('vitest-4244');
    const warn = vi.fn();

    await removeRunRoot(own, { warn });

    expect(await exists(own)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

// The user-immutable flag is how a single-user macOS test holds a directory busy: unlinking a
// flagged file fails with EPERM, one of the codes Node's recursive rm retries. Elsewhere there
// is no unprivileged equivalent, and without a hold every removal here is instant — the retry
// cases would pass with no retry at all.
describe.skipIf(process.platform !== 'darwin')('a transient failure is retried, not reported (FR-022)', () => {
  /** Long enough that the first attempt certainly fails; far inside removeTempRoot's retries. */
  const HOLD_MS = 60;

  /** Every hold taken, so the hook lets go of one its test never released. */
  const releases: Array<() => void> = [];

  /**
   * A root whose transcript cannot be unlinked until `release` is called.
   *
   * The flag is cleared by a separate process that waits for its stdin to close, not by this
   * worker. Stdin closes on `release()`, and just as surely when the worker dies mid-hold. Left
   * to the worker, a crash would strand an immutable file four levels below a swept root, and
   * since Node retries each level of a tree on its own, every later run's sweep would spend
   * about twelve hours on that one file before giving up (see removeTempRoot).
   */
  async function heldRoot(name: string): Promise<{ readonly dir: string; readonly release: () => void }> {
    const dir = await root(name);
    const file = path.join(dir, 'transcript.jsonl');
    execFileSync('chflags', ['uchg', file]);
    // Detached: an interrupt reaches the run's process group, and the releaser has to survive
    // it to see stdin close.
    const releaser = spawn('/bin/sh', ['-c', 'read -r _; exec chflags nouchg "$0"', file], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore']
    });
    const release = (): void => {
      releaser.stdin.end();
    };
    releases.push(release);
    return { dir, release };
  }

  afterEach(() => {
    for (const release of releases.splice(0)) release();
    // The releaser clears its flag a moment later; the scratch removal after this cannot wait.
    execFileSync('chflags', ['-R', 'nouchg', scratch]);
  });

  it('the hold is real: a removal that does not retry fails on it', async () => {
    const { dir } = await heldRoot('vitest-401');
    await expect(fs.rm(dir, { recursive: true, force: true })).rejects.toMatchObject({ code: 'EPERM' });
  });

  it('teardown outlasts the hold and removes the root without a warning', async () => {
    const { dir, release } = await heldRoot('vitest-402');
    const warn = vi.fn();
    setTimeout(release, HOLD_MS);
    await removeRunRoot(dir, { warn });

    expect(await exists(dir)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('so does the sweep', async () => {
    const { dir, release } = await heldRoot('vitest-403');
    const warn = vi.fn();
    setTimeout(release, HOLD_MS);
    await expect(sweepScratchRoots(parent, { ownPid: OWN_PID, kill: DEAD, warn })).resolves.toEqual({
      found: 1,
      removed: 1,
      skipped: 0
    });

    expect(await exists(dir)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('start times come from one ps call, in UTC and the C locale (T1818a)', () => {
  it('asks ps once, for every pid', async () => {
    const run = vi.fn((_args: readonly string[]) => Promise.resolve('   11 Wed Sep  2 05:29:02 2026\n'));

    const times = await readStartTimes([11, 22], run);

    expect(run).toHaveBeenCalledExactlyOnceWith(['-o', 'pid=,lstart=', '-p', '11,22']);
    expect(times).toEqual(new Map([[11, Date.UTC(2026, 8, 2, 5, 29, 2)]]));
  });

  it('spawns nothing for no pids', async () => {
    const run = vi.fn((_args: readonly string[]) => Promise.resolve(''));
    await expect(readStartTimes([], run)).resolves.toEqual(new Map());
    expect(run).not.toHaveBeenCalled();
  });

  it('reads ps lines as printed, padded day and trailing spaces included', () => {
    // Lines as this machine's ps printed them on 2026-10-01.
    const stdout = '    1 Wed Sep  9 11:12:09 2026    \n62527 Thu Oct  1 14:20:16 2026\n';
    expect(parseStartTimes(stdout)).toEqual(
      new Map([
        [1, Date.UTC(2026, 8, 9, 11, 12, 9)],
        [62527, Date.UTC(2026, 9, 1, 14, 20, 16)]
      ])
    );
  });

  it('drops every line it cannot read rather than guessing', () => {
    const stdout = [
      '',
      'garbage',
      '   33',
      '   44 mer. sept.  2 05:29:02 2026',
      '   55 Wed Sep  2 05:29:02',
      '   66 Wed Sep  2 5:29:02 2026',
      'ps: process id too large: 100000'
    ].join('\n');
    expect(parseStartTimes(stdout)).toEqual(new Map());
  });

  it.skipIf(process.platform === 'win32')('the real ps puts this process where Node says it started', async () => {
    const times = await readStartTimes([process.pid]);
    const startedAt = times.get(process.pid);

    expect(startedAt).toBeDefined();
    expect(Math.abs(startedAt! - (Date.now() - process.uptime() * 1_000))).toBeLessThan(PS_START_TOLERANCE_MS);
  });

  it.skipIf(process.platform === 'win32')('a ps that finds nothing yields no start time, not an error', async () => {
    await expect(readStartTimes([await reapedPid()])).resolves.toEqual(new Map());
  });
});
