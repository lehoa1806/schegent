import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SpawnIdentity } from '../../../src/contracts/spawn-identity';
import { checkLiveness, createLivenessProbe } from '../../../src/services/process-liveness';

/**
 * FR-R4-F06 (FR-016, SC-005; T16; contract P, P5 and P6) -- a dead leader with a live group
 * is `orphaned-group`, and a dead group is `dead`.
 *
 * THE DEFECT. `checkLiveness` asked only whether the LEADER's pid was still held. A leader
 * that exits while a helper in its group keeps running read as `dead`, and `dead` permits a
 * resume, so the resumed Run started beside a helper still writing to the workspace. The
 * verdict must follow the group, because the group is what the previous Run owned.
 *
 * The fixture is real: a detached `sh` leader starts a sleeping helper in its group and
 * exits. The leader is waited on until Node has reaped it, because an unreaped zombie still
 * answers signal 0 and would read as a leader that is alive. The helper is killed by its
 * recorded pid in `afterEach`. Control: M11 maps "leader absent, group answers" to `dead`,
 * and the first case then fails with the helper alive.
 *
 * POSIX only: Windows records no process group, and its verdict is `unanswerable` (P4).
 */
const MARKER = 'schegent-orphan-helper';
const TEST_TIMEOUT_MS = 6_000;
const READY_TIMEOUT_MS = 3_000;
const GONE_TIMEOUT_MS = 3_000;
const posixOnly = process.platform === 'win32' ? describe.skip : describe;

const spawned: number[] = [];
let scratch: string | undefined;

afterEach(async () => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  if (scratch !== undefined) {
    await fs.rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });
}

async function waitUntilGone(pid: number): Promise<void> {
  const deadline = Date.now() + GONE_TIMEOUT_MS;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    if (Date.now() > deadline) throw new Error(`pid ${pid} did not go away`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A detached leader that starts a sleeping helper in its group and exits. */
async function startOrphan(): Promise<{ identity: SpawnIdentity; helperPid: number }> {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-orphan-'));
  const helperPath = path.join(scratch, 'helper.js');
  await fs.writeFile(
    helperPath,
    "process.stdout.write('helper-ready\\n'); setInterval(() => {}, 1000);"
  );
  const startedAtMs = Date.now();
  const leader = spawn(
    '/bin/sh',
    ['-c', `"$0" "$1" ${MARKER} & echo $!; exit 0`, process.execPath, helperPath],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  if (leader.pid === undefined) throw new Error('the fixture leader did not start');
  spawned.push(leader.pid);

  const helperPid = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the helper was not ready')), READY_TIMEOUT_MS);
    let seen = '';
    leader.stdout.setEncoding('utf8');
    leader.stdout.on('data', (chunk: string) => {
      seen += chunk;
      const lines = seen.split('\n');
      if (/^\d+$/.test(lines[0] ?? '') && lines.includes('helper-ready')) {
        clearTimeout(timer);
        resolve(Number(lines[0]));
      }
    });
  });
  spawned.push(helperPid);
  await exited(leader);
  return { identity: { pid: leader.pid, pgid: leader.pid, startedAtMs }, helperPid };
}

posixOnly('liveness follows the group, not only the leader (T16)', () => {
  it(
    'gives orphaned-group while the helper lives, and dead once it is killed',
    async () => {
      const { identity, helperPid } = await startOrphan();
      const probe = createLivenessProbe();

      // Control for the fixture itself: the leader is gone, the group is not.
      expect(probe.exists(identity.pid)).toBe(false);
      expect(probe.groupExists(identity.pgid)).toBe(true);

      expect(await checkLiveness(identity, probe)).toBe('orphaned-group');

      process.kill(helperPid, 'SIGKILL');
      await waitUntilGone(helperPid);

      expect(probe.groupExists(identity.pgid)).toBe(false);
      expect(await checkLiveness(identity, probe)).toBe('dead');
    },
    TEST_TIMEOUT_MS
  );
});
