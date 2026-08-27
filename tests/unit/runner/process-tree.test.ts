import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  processTreeSpawnOptions,
  signalProcessTree,
  processTreeIsGone
} from '../../../src/runner/process-tree';

/**
 * FR-R3-054 (H-05) — the escalation ladder signalled the direct child only.
 *
 * A CLI tool that forks a helper survives cancel, timeout, aggressive pause and
 * deactivation, and keeps mutating the workspace after Schegent has recorded a
 * terminal state -- racing rollback, retry, recovery and the next phase.
 *
 * The oracle is a sentinel file a GRANDCHILD appends to on a timer. If it keeps
 * growing after the direct child is signalled, the descendant is alive. Nothing
 * about that is inferred: the bytes are on disk or they are not.
 */
const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('signalling the process tree (H-05)', () => {
  let dir: string;
  let sentinel: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-tree-'));
    sentinel = path.join(dir, 'sentinel');
    await fs.writeFile(sentinel, '');
  });

  /** Grandchild pids this file created, killed in `afterEach` whatever the test did. */
  let grandchildren: number[];

  beforeEach(() => {
    grandchildren = [];
  });

  afterEach(async () => {
    // FR-R3-114 follow-up — the leak this file used to be.
    //
    // The first case DELIBERATELY creates a surviving grandchild, and its cleanup was
    // `process.kill(-child.pid)` on a child spawned WITHOUT `detached`. Such a child has no
    // process group of its own, so the negative pid names a group that does not exist; the
    // `catch` swallowed the `ESRCH` and the comment said so out loud. The cleanup could not
    // work by construction, and every run of this file leaked one `sh` loop appending to a
    // file forty times a second, forever. Two were found alive on the development machine on
    // 2026-08-27, aged 8h22m and 3h24m — burning CPU and I/O under every test run since.
    //
    // That is very likely a real contributor to the "load sensitivity" this repository keeps
    // documenting and attributing to the machine: a day of development leaves a handful of
    // these, and the timeouts they cause look exactly like a busy laptop.
    //
    // Killed by PID, which works whether or not the child was detached.
    for (const pid of grandchildren) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone — the ordinary case when the test's own signalling worked.
      }
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  /**
   * A child that forks a grandchild appending to the sentinel every 25ms.
   *
   * The grandchild ECHOES ITS PID as the first line of stdout so the cleanup above can name it,
   * and BOUNDS ITSELF at ~15s so a cleanup that is somehow missed still cannot leak forever.
   * Both, deliberately: the pid is the precise mechanism, and the bound is what makes the
   * failure mode survivable rather than permanent.
   *
   * 15 s is far beyond every assertion window below (the longest is 300 ms after a kill), so a
   * grandchild that stopped because it ran out of iterations rather than because it was
   * signalled cannot make any case pass vacuously.
   */
  const spawnTree = (withGroup: boolean) => {
    const child = spawn(
      '/bin/sh',
      [
        '-c',
        `( i=0; while [ $i -lt 600 ]; do printf 'x' >> "${sentinel}"; sleep 0.025; i=$((i+1)); done ) & ` +
          `echo $!; sleep 60`
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], shell: false, ...(withGroup ? processTreeSpawnOptions() : {}) }
    );
    // `stdout` is non-null because this spawn asks for a pipe; the first line is the echoed pid.
    child.stdout.on('data', (chunk: Buffer) => {
      const pid = Number.parseInt(chunk.toString('utf8').trim(), 10);
      if (Number.isInteger(pid) && pid > 0) grandchildren.push(pid);
    });
    return child;
  };

  const size = async (): Promise<number> => (await fs.stat(sentinel)).size;
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  posixOnly('killing only the direct child leaves the grandchild running', async () => {
    // The defect, demonstrated. This is what the ladder did before this change.
    const child = spawnTree(false);
    await settle(200);
    child.kill('SIGKILL');
    await settle(150);
    const afterKill = await size();
    await settle(250);
    expect(await size()).toBeGreaterThan(afterKill);
    // The survivor this test deliberately created is killed by `afterEach`, by PID. It used to
    // be attempted here with `process.kill(-child.pid)` on a child that has no group of its
    // own — a call that could never succeed, on a survivor that then ran forever.
  }, 20_000);

  posixOnly('signalling the group stops the grandchild too', async () => {
    const child = spawnTree(true);
    await settle(200);
    expect(await size()).toBeGreaterThan(0);

    await signalProcessTree(child, 'SIGKILL');
    await settle(200);
    const afterKill = await size();
    await settle(300);
    expect(await size()).toBe(afterKill);
  }, 20_000);

  posixOnly('reports the tree gone only once it really is', async () => {
    const child = spawnTree(true);
    await settle(150);
    expect(processTreeIsGone(child)).toBe(false);
    await signalProcessTree(child, 'SIGKILL');
    await settle(250);
    expect(processTreeIsGone(child)).toBe(true);
  }, 20_000);

  it('asks for its own group only where that means something', () => {
    const options = processTreeSpawnOptions();
    expect(options.detached).toBe(process.platform !== 'win32');
  });
});
