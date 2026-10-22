import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { removeTempRoot } from './temp-root-cleanup';

/**
 * Vitest `globalSetup` that gives a test run its own temp root instead of the
 * shared system one.
 *
 * The suite creates scratch directories through `os.tmpdir()` from 124 distinct
 * `mkdtemp` prefixes across 102 files. On a developer machine those land beside
 * every other tool's leftovers in `$TMPDIR`, and a saturated `$TMPDIR` degrades
 * directory operations enough to blow the 5 s test timeout: measured on
 * 2026-08-18, `concurrency-cap.test.ts` took 16.5 s and failed 3 of 5 against a
 * directory holding ~964,000 entries, and 2.1 s with all 5 passing against a
 * clean one — same code, no edits. The failures look like flakes in whichever
 * suites happen to be filesystem-heavy, which is why they were misread as such
 * for a while.
 *
 * `os.tmpdir()` is the single funnel every one of those prefixes passes through,
 * so pointing it at a per-run directory fixes all of them without touching a
 * test. Mocking the filesystem was the alternative and is the wrong trade here:
 * a large share of these tests exist to assert real syscall semantics —
 * `flag: 'wx'` (O_EXCL) exclusivity and rename atomicity in
 * `src/state/ownership-fs.ts`, archive-by-rename in the audit writer, and real
 * `git diff --binary` bytes in the checkpoint attribution tests — and a
 * JavaScript model of the filesystem cannot exhibit the divergences those tests
 * are looking for.
 */

/**
 * THE SWEEP (FR-R3-181). A run killed before its teardown leaves its root
 * behind, and nothing ever removed one: on 2026-09-17 `.tmp/` held 151 of them,
 * 1.9 GB. So setup first removes every root whose creator is provably gone, and
 * prints one line saying what it found — every run, zeros included, because a
 * line that appears only when there is something to say cannot be told apart
 * from a sweep that never ran.
 *
 * "Provably gone" is narrow, because a wrong guess deletes a live run's scratch
 * tree out from under it:
 *
 * - `kill(pid, 0)` failing with ESRCH is the only proof that nothing holds the
 *   pid. EPERM means a process exists and belongs to another user; any other
 *   outcome is not understood. Both count as alive.
 * - A held pid may have been reused. The holder is the creator only if it
 *   started before the root was last written, so a holder that started more than
 *   `REUSE_MARGIN_MS` after that write is a stranger, and the root is orphaned.
 *   With no start time, the root is kept.
 * - This run's own root, and any name this setup would not have written, are
 *   never examined at all.
 * - Liveness is read again for each root just before it is removed. Removing a
 *   backlog takes seconds, and a pid freed when the sweep began can be taken by
 *   the time it reaches that root.
 *
 * LIMITS. Liveness is read in this process's pid namespace. A container sharing
 *   this tree from another namespace reads as orphaned, and loses its root. And
 *   a new run that takes a pid in the moment its stale root is being removed
 *   loses the root it adopted; its setup or first scratch write then fails
 *   loudly, rather than writing into a tree that is gone.
 *
 *   A stale root holding something no retry can remove — an immutable file, say —
 *   stalls setup on every run, not once. Removal goes through `removeTempRoot`,
 *   whose retries compound with depth: 33 s for such a file directly inside the
 *   root, eleven times that for each level further down. Only then is the root
 *   counted as skipped and named on stderr, and the next run waits again.
 */

/** Directory holding every run's root; also the git discovery ceiling. */
const TEMP_ROOT_DIR = '.tmp';

/**
 * A root this setup writes. A leading zero is excluded because no pid prints
 * one, and `vitest-0` above all: `kill(0, 0)` probes this process's own group,
 * and so would read a root nothing holds as alive.
 */
const RUN_ROOT_NAME = /^vitest-([1-9]\d*)$/;

/**
 * The largest pid `process.kill` accepts. A larger number in a name cannot be a
 * pid, and passing it on would make `kill` throw and `ps` reject the whole batch.
 */
const MAX_PID = 2 ** 31 - 1;

/** `ps` answers in milliseconds; past this it is wedged, and every live root is kept. */
const PS_TIMEOUT_MS = 5_000;

/**
 * How much later than a root's last write its pid's holder must have started to
 * be judged a stranger.
 *
 * A creator starts before it writes, so on a steady clock any later-starting
 * holder is a stranger, and no margin is needed. The margin is for clocks that
 * step. macOS records a process's start in wall-clock time, so a clock stepped
 * back between a run's start and its write puts the write before the start; on
 * Linux `ps` derives the start from boot time and the current clock, so a
 * forward step taken after the start moves the start later. Either way, the
 * creator would read as a stranger. The cost is that a root whose pid is reused
 * within ten minutes of its last write waits for that holder to exit.
 */
export const REUSE_MARGIN_MS = 10 * 60_000;

/** One `ps -o pid=,lstart=` line in the C locale. `lstart` is whole seconds. */
const LSTART_LINE =
  /^\s*(\d+) +(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})\s*$/;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An error code worth printing; anything else is reported as unknown. */
const ERRNO_CODE = /^[A-Z][A-Z0-9_]{0,31}$/;

/** `process.kill`'s probe form. Signal 0 delivers nothing; it only asks. */
export type Kill = (pid: number, signal: 0) => unknown;

/** Start time, in epoch milliseconds, of each listed pid that could be read. */
export type StartTimeReader = (pids: readonly number[]) => Promise<ReadonlyMap<number, number>>;

export type Liveness = 'alive' | 'dead';

/** What one sweep saw. `found` counts every entry; `found = removed + skipped`. */
export interface SweepCounts {
  readonly found: number;
  readonly removed: number;
  readonly skipped: number;
}

/** The sweep's contact with the outside world, injectable so the cases that matter can be built. */
export interface SweepDeps {
  readonly ownPid: number;
  readonly kill: Kill;
  readonly readStartTimes: StartTimeReader;
  readonly remove: (dir: string) => Promise<void>;
  readonly warn: (message: string) => void;
}

interface RunRoot {
  readonly dir: string;
  readonly pid: number;
}

/** Only the fields this module reads, so it does not pin a vitest type. */
interface GlobalSetupContextLike {
  readonly config: { readonly root: string };
}

const execFileAsync = promisify(execFile);

let runRoot: string | null = null;

export async function setup(ctx: GlobalSetupContextLike): Promise<void> {
  const parent = path.resolve(ctx.config.root, TEMP_ROOT_DIR);

  // Swept before this run's root is created, so a clean tree reports zeros
  // instead of counting the root this run is about to make.
  console.log(formatSweepReport(await sweepScratchRoots(parent)));

  // Keyed by pid so a concurrent `test:e2e` or `test:evals` run cannot remove
  // this run's root out from under it in its own teardown.
  runRoot = path.join(parent, `vitest-${process.pid}`);
  await fs.mkdir(runRoot, { recursive: true });
  // A root left under this pid by an earlier run is adopted as it stands, last
  // written before this process started. A concurrent run's sweep would then
  // read this process as a holder that postdates the root, and remove it.
  const now = new Date();
  await fs.utimes(runRoot, now, now);

  // `os.tmpdir()` reads TMPDIR on POSIX and TEMP/TMP on Windows; set all three
  // so the root holds on either platform.
  process.env.TMPDIR = runRoot;
  process.env.TMP = runRoot;
  process.env.TEMP = runRoot;

  // The root sits inside the repository's working tree, so a `git` command run
  // with its cwd in a scratch directory would otherwise discover *this*
  // repository by walking up. That is not a cosmetic difference: the checkpoint
  // service shells out to `git diff --binary HEAD`, and
  // `run-checkpoint-service.test.ts` deliberately builds a directory that is
  // *not* a repository to assert the capture failure — without a ceiling that
  // test would instead diff the developer's own uncommitted work and capture it
  // into a test artifact. The ceiling stops the upward search at the parent, so
  // scratch directories read as "not a git repository" exactly as they do under
  // the system temp dir.
  process.env.GIT_CEILING_DIRECTORIES = parent;

  // `git commit` starts a detached `git maintenance run --auto`. Measured on git
  // 2.54, its default geometric repack runs once two loose objects sit in
  // `.git/objects/17/`, the one directory git samples to estimate the count, and it
  // deletes the loose `.git/objects/xx` directories while a test walks or removes
  // the fixture: ENOENT or ENOTEMPTY. Whether a commit does that turns on its
  // hashes, so the failure looks random. Set here, no fixture has to remember it.
  appendGitConfig('maintenance.auto', 'false');
}

export async function teardown(): Promise<void> {
  if (runRoot === null) return;
  // A failure is reported, never thrown: a teardown that throws would fail an
  // otherwise green run, and once this process exits the next run's sweep
  // removes what was left.
  await removeRunRoot(runRoot);
  runRoot = null;
}

const DEFAULT_DEPS: SweepDeps = {
  ownPid: process.pid,
  kill: (pid, signal) => process.kill(pid, signal),
  readStartTimes,
  remove: removeTempRoot,
  warn: (message) => console.warn(message)
};

/** Removes every run root under `parent` whose creator is provably gone. Never throws. */
export async function sweepScratchRoots(parent: string, overrides: Partial<SweepDeps> = {}): Promise<SweepCounts> {
  const deps: SweepDeps = { ...DEFAULT_DEPS, ...overrides };
  const entries = await listEntries(parent, deps.warn);
  const roots = entries.flatMap((entry): RunRoot[] => {
    const pid = runRootPid(entry);
    return pid === null || pid === deps.ownPid ? [] : [{ dir: path.join(parent, entry.name), pid }];
  });
  const startTimes = await startTimesOfHeld(roots, deps);

  let removed = 0;
  for (const root of roots) {
    if (!(await isOrphaned(root, startTimes, deps))) continue;
    const failure = await removalFailure(root.dir, deps.remove);
    if (failure === null) {
      removed += 1;
    } else {
      deps.warn(`scratch sweep: ${path.basename(root.dir)} was not removed (${failure}); counted as skipped`);
    }
  }
  return { found: entries.length, removed, skipped: entries.length - removed };
}

export function formatSweepReport(counts: SweepCounts): string {
  return `scratch sweep: found=${counts.found} removed=${counts.removed} skipped=${counts.skipped}`;
}

/** Removes this run's root; a failure is named on stderr and left for the next run's sweep. */
export async function removeRunRoot(
  root: string,
  overrides: Partial<Pick<SweepDeps, 'remove' | 'warn'>> = {}
): Promise<void> {
  const { remove, warn } = { ...DEFAULT_DEPS, ...overrides };
  const failure = await removalFailure(root, remove);
  if (failure === null) return;
  warn(`scratch teardown: ${path.basename(root)} was not removed (${failure}); left for the next run's sweep`);
}

/** Only ESRCH proves a pid free. EPERM is a process another user owns; anything else is not understood. */
export function liveness(pid: number, kill: Kill = DEFAULT_DEPS.kill): Liveness {
  try {
    kill(pid, 0);
    return 'alive';
  } catch (error) {
    return errnoCode(error) === 'ESRCH' ? 'dead' : 'alive';
  }
}

/** A holder that started more than the margin after the root's last write is not its creator. */
export function isReused(startedAt: number, writtenAt: number): boolean {
  return startedAt > writtenAt + REUSE_MARGIN_MS;
}

/** Start times from one `ps` call. A pid `ps` does not list, or prints unreadably, has none. */
export async function readStartTimes(
  pids: readonly number[],
  run: (args: readonly string[]) => Promise<string> = runPs
): Promise<ReadonlyMap<number, number>> {
  if (pids.length === 0) return new Map();
  return parseStartTimes(await run(['-o', 'pid=,lstart=', '-p', pids.join(',')]));
}

/** Reads `lstart` as UTC, which is what `runPs` asks `ps` to print it in. Unreadable lines are dropped. */
export function parseStartTimes(stdout: string): ReadonlyMap<number, number> {
  const times = new Map<number, number>();
  for (const line of stdout.split('\n')) {
    const match = LSTART_LINE.exec(line);
    if (match === null) continue;
    const [, pid, month, day, hours, minutes, seconds, year] = match;
    const monthIndex = MONTHS.findIndex((name) => name === month);
    if (monthIndex === -1) continue;
    times.set(
      Number(pid),
      Date.UTC(Number(year), monthIndex, Number(day), Number(hours), Number(minutes), Number(seconds))
    );
  }
  return times;
}

async function runPs(args: readonly string[]): Promise<string> {
  try {
    // UTC and the C locale, so the line has one shape and needs no zone to read.
    const { stdout } = await execFileAsync('ps', args, {
      encoding: 'utf8',
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
      timeout: PS_TIMEOUT_MS
    });
    return stdout;
  } catch {
    // Missing, failed, or timed out — and `ps` exits 1 when it lists none of
    // the pids. No start time is read, so every held root is kept.
    return '';
  }
}

async function listEntries(parent: string, warn: (message: string) => void): Promise<readonly Dirent[]> {
  try {
    return await fs.readdir(parent, { withFileTypes: true });
  } catch (error) {
    const code = errnoCode(error);
    // No scratch directory yet is a clean tree, not a failure.
    if (code !== 'ENOENT') warn(`scratch sweep: ${path.basename(parent)} could not be listed (${code})`);
    return [];
  }
}

/** The pid in a run root's name, or null for anything this setup would not have written. */
function runRootPid(entry: Dirent): number | null {
  // A symlink is not followed: the sweep removes only what sits under `.tmp/`.
  if (!entry.isDirectory()) return null;
  const match = RUN_ROOT_NAME.exec(entry.name);
  if (match === null) return null;
  const pid = Number(match[1]);
  return pid <= MAX_PID ? pid : null;
}

async function startTimesOfHeld(roots: readonly RunRoot[], deps: SweepDeps): Promise<ReadonlyMap<number, number>> {
  const held = roots.filter((root) => liveness(root.pid, deps.kill) === 'alive').map((root) => root.pid);
  if (held.length === 0) return new Map();
  try {
    return await deps.readStartTimes(held);
  } catch {
    // No start time is read, so every held root is kept: the sweep falls back
    // to kill alone, never to a deletion.
    return new Map();
  }
}

async function isOrphaned(root: RunRoot, startTimes: ReadonlyMap<number, number>, deps: SweepDeps): Promise<boolean> {
  if (liveness(root.pid, deps.kill) === 'dead') return true;
  const startedAt = startTimes.get(root.pid);
  if (startedAt === undefined) return false;
  const writtenAt = await mtimeOf(root.dir);
  return writtenAt !== null && isReused(startedAt, writtenAt);
}

async function mtimeOf(dir: string): Promise<number | null> {
  try {
    return (await fs.lstat(dir)).mtimeMs;
  } catch {
    // Gone or unreadable: there is no write to compare against, so the root is kept.
    return null;
  }
}

/** The removal's error code, or null when it succeeded. */
async function removalFailure(dir: string, remove: (dir: string) => Promise<void>): Promise<string | null> {
  try {
    await remove(dir);
    return null;
  } catch (error) {
    return errnoCode(error);
  }
}

/**
 * Adds one entry to git's environment config, after any the environment already
 * holds. Git reads `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` for every n
 * below `GIT_CONFIG_COUNT`, and they override every config file.
 */
function appendGitConfig(key: string, value: string): void {
  const index = Number(process.env.GIT_CONFIG_COUNT ?? '0');
  process.env[`GIT_CONFIG_KEY_${index}`] = key;
  process.env[`GIT_CONFIG_VALUE_${index}`] = value;
  process.env.GIT_CONFIG_COUNT = String(index + 1);
}

function errnoCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && ERRNO_CODE.test(code)) return code;
  }
  return 'unknown';
}
