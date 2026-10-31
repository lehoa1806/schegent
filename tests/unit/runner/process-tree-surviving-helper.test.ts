import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { MonitorSidecarEvent } from '../../../src/contracts/backend-runner';
import { escalateAndReportTree } from '../../../src/runner/process-tree';

/**
 * FR-R4-F06 (FR-015, SC-005; T14; contract P, P1) -- a helper that outlives its leader
 * is escalated, confirmed gone, and reported as exactly what it is.
 *
 * THE DEFECT. The ladder's only SIGKILL was skipped whenever the direct child had been
 * reaped by the time it fired (`if (childIsReaped(child)) return`). A leader that handles
 * SIGTERM and exits therefore left a same-group helper that ignores SIGTERM alive, the
 * SIGKILL never came, and the confirmation probe never ran: the surviving helper was
 * neither killed nor reported. That is the arrangement FR-R3-054 was written for, and the
 * one place it did nothing.
 *
 * THE ORACLE is the operating system, not an inference: the helper's own pid answers
 * `ESRCH`, and `pgrep` finds no process carrying its argv tag. The fixture is a REAL
 * detached leader and a REAL helper that ignores SIGTERM, because the whole claim is
 * about what a signal does to real processes in one group.
 *
 * Safety (standing rule 11): the test spawns only its own children, records each pid,
 * bounds every wait, signals only those recorded pids in `finally`, and looks for strays
 * with `pgrep -f` (pids only, never `-fl`, which would print the environment).
 * POSIX only: there is no process group to survive in on win32.
 */
const MARKER = 'schegent-surviving-helper';
const TEST_TIMEOUT_MS = 6_000;
const HELPER_READY_TIMEOUT_MS = 3_000;
const posixOnly = process.platform === 'win32' ? describe.skip : describe;

const attribution = { runId: 'run-surviving', phase: 'implement', iteration: 1 } as const;

/** Pids this file created, killed by pid in `afterEach` whatever the test did. */
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

/** The helper: ignores SIGTERM, says it is ready, and sleeps until killed. */
const HELPER_SCRIPT = [
  "process.on('SIGTERM', () => {});",
  "process.stdout.write('helper-ready\\n');",
  'setInterval(() => {}, 1000);'
].join('\n');

interface Fixture {
  readonly leader: ChildProcess;
  readonly helperPid: number;
}

/**
 * A detached `sh` leader that starts the helper in its own group and then waits. The
 * leader traps nothing, so SIGTERM ends it; the helper's handler swallows SIGTERM.
 * The leader prints the helper's pid, and the helper prints a readiness line, so the
 * ladder starts only once the helper can actually ignore the signal.
 */
async function startFixture(): Promise<Fixture> {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-surviving-'));
  const helperPath = path.join(scratch, 'helper.js');
  await fs.writeFile(helperPath, HELPER_SCRIPT);
  const leader = spawn(
    '/bin/sh',
    ['-c', `"$0" "$1" ${MARKER} & echo $!; wait`, process.execPath, helperPath],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  if (leader.pid === undefined) throw new Error('the fixture leader did not start');
  spawned.push(leader.pid);

  const helperPid = await new Promise<number>((resolve, reject) => {
    let seen = '';
    let helper: number | undefined;
    const timer = setTimeout(
      () => reject(new Error('the helper was not ready in time')),
      HELPER_READY_TIMEOUT_MS
    );
    leader.stdout.setEncoding('utf8');
    leader.stdout.on('data', (chunk: string) => {
      seen += chunk;
      const lines = seen.split('\n');
      const first = lines[0] ?? '';
      if (helper === undefined && /^\d+$/.test(first)) {
        helper = Number(first);
      }
      if (helper !== undefined && lines.includes('helper-ready')) {
        clearTimeout(timer);
        resolve(helper);
      }
    });
  });
  spawned.push(helperPid);
  return { leader, helperPid };
}

/** `pgrep -f` for the tag, PIDs only. Exit 1 (no match) is the answer under test. */
function strayCount(): number {
  try {
    const out = execFileSync('pgrep', ['-f', `[s]${MARKER.slice(1)}`], { encoding: 'utf8' });
    return out.split('\n').filter((line) => line.trim().length > 0).length;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return 0;
    throw error;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

posixOnly('a helper that outlives its leader is escalated and confirmed gone (T14)', () => {
  it(
    'SIGKILLs the group after the leader exits on SIGTERM, and settles group-gone',
    async () => {
      const { leader, helperPid } = await startFixture();
      // Control: before the ladder runs, the helper really is alive and really is tagged.
      expect(isAlive(helperPid)).toBe(true);
      expect(strayCount()).toBeGreaterThan(0);

      const events: MonitorSidecarEvent[] = [];
      const warnings: string[] = [];
      let reported = false;
      const outcome = await escalateAndReportTree({
        child: leader,
        attribution,
        runner: 'claude-cli',
        warn: (message) => void warnings.push(message),
        emit: (event) => void events.push(event),
        alreadyReported: () => reported,
        markReported: () => {
          reported = true;
        }
      });

      expect(outcome.result).toBe('group-gone');
      expect(outcome.runner).toBe('claude-cli');
      expect(outcome.pid).toBe(leader.pid ?? null);
      expect(outcome.attribution).toEqual(attribution);
      // The oracle: the helper is not alive, and nothing carrying its tag is.
      expect(isAlive(helperPid)).toBe(false);
      expect(strayCount()).toBe(0);
      // A group that was escalated and confirmed gone is not a survivor to report.
      expect(events).toEqual([]);
      expect(warnings).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );
});
