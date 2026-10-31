import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MonitorSidecarEvent } from '../../src/contracts/backend-runner';
import { closeStage2Resources } from '../../src/activation/stage2-teardown';
import { createHostTeardown } from '../../src/controller/host-teardown-recorder';
import { BackendRunnerRegistry } from '../../src/runner/backend-runner-registry';
import { TEARDOWN_BOUND_MS } from '../../src/runner/process-tree';

// The variants differ in what builds the runner: the first uses the real factory (a real
// `CodexCliRunner` over a real `ProcessLifecycleRunner` spawning a real script), the second a
// runner over an injected spawn function whose child never exits. The mock delegates unless a
// case asks for the injected one.
const injected = vi.hoisted(() => ({
  spawnFn: undefined as undefined | ((...args: unknown[]) => unknown)
}));
vi.mock('../../src/runner/backend-runner-factory', async () => {
  const actual = await vi.importActual<typeof import('../../src/runner/backend-runner-factory')>(
    '../../src/runner/backend-runner-factory'
  );
  const { CodexCliRunner } = await vi.importActual<typeof import('../../src/runner/codex-cli')>(
    '../../src/runner/codex-cli'
  );
  return {
    ...actual,
    createBackendRunner: (
      kind: Parameters<typeof actual.createBackendRunner>[0],
      options: Parameters<typeof actual.createBackendRunner>[1]
    ) =>
      injected.spawnFn === undefined
        ? actual.createBackendRunner(kind, options)
        : new CodexCliRunner(injected.spawnFn as never, options.monitorHook ?? null)
  };
});

/**
 * FR-R4-F06 (FR-021, SC-006; T23; contract S, S5 and S6) -- ownership is released only after the
 * teardown outcome is known and recorded, and the order is observable.
 *
 * THE DEFECT. `cancelAll()` was a disposable that ran after the synchronous disposals and fired
 * every ladder without waiting. The stage-2 `dispose` went straight on to release the execution
 * leases and then window primacy, so another window could take ownership while this window's
 * backend was still being killed. The order is now: admission closed, SIGTERM, SIGKILL, the
 * report settled, then the leases, then primacy.
 *
 * REAL PROCESSES (standing rule 11). The first case runs a real script that ignores SIGTERM,
 * under a real `ProcessLifecycleRunner` inside a real registry, through the real
 * `closeStage2Resources`. Every pid is recorded and killed in `finally`. The second case never
 * lets its (injected) child exit, with a short injected bound, and shows the release does not wait
 * for it: the report holds `bound-elapsed`, its evidence row lands first, and the releases follow
 * within the bound plus 100 ms. `process.kill` is stubbed there so no real group is signalled.
 *
 * The control is M13: a teardown thunk that does not await `closeAndTearDown` turns the first
 * case red.
 */
const MARKER = 'schegent-teardown-order';
const RUN_ID = 'run-teardown-order';
const CASE_TIMEOUT_MS = 8_000;
const INJECTED_BOUND_MS = 300;
const LADDER_SETTLE_MS = 2_800;
const RELEASE_MARGIN_MS = 100;

const SIX_STEPS = [
  'admission-closed',
  'sigterm',
  'sigkill',
  'report-settled',
  'leases-released',
  'primacy-released'
] as const;

const recordedPids: number[] = [];
let scratch: string | undefined;

afterEach(async () => {
  injected.spawnFn = undefined;
  for (const pid of recordedPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  vi.restoreAllMocks();
  if (scratch !== undefined) {
    await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});

function strayCount(): number {
  try {
    const out = execFileSync('pgrep', ['-f', `[s]${MARKER.slice(1)}`], { encoding: 'utf8' });
    return out.split('\n').filter((line) => line.trim().length > 0).length;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return 0;
    throw error;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The wiring's own teardown (`createHostTeardown`, the function `backend-execution-wiring.ts`
 * calls), with a marker between "the registry's report settled" and "the evidence recorded".
 */
function teardownThunk(
  registry: BackendRunnerRegistry,
  order: string[],
  rows: unknown[]
): () => Promise<void> {
  return createHostTeardown(
    {
      closeAndTearDown: async () => {
        const report = await registry.closeAndTearDown();
        order.push('report-settled');
        return report;
      }
    },
    {
      treeRecorder: { settled: async () => undefined },
      append: async (entry) => {
        order.push('evidence-appended');
        rows.push(entry);
        return undefined;
      },
      logger: { warn: () => undefined }
    }
  );
}

function stageDeps(order: string[], teardown: () => Promise<void>) {
  return {
    sync: [{ dispose: () => void order.push('sync-disposed') }],
    disposables: [],
    transport: {
      flushAndDispose: async () => {
        order.push('transport-flushed');
      }
    },
    teardown
  };
}

/** The two releases `dispose` performs after `closeStage2Resources`, as recording fakes. */
async function releaseOwnership(order: string[]): Promise<void> {
  await Promise.resolve();
  order.push('leases-released');
  await Promise.resolve();
  order.push('primacy-released');
}

describe.skipIf(process.platform === 'win32')('shutdown waits for the teardown before it releases ownership (T23)', () => {
  it(
    'records admission closed, SIGTERM, SIGKILL, the settled report, the leases and then primacy',
    async () => {
      scratch = await mkdtemp(join(tmpdir(), `${MARKER}-`));
      const script = join(scratch, 'codex');
      // A script that ignores SIGTERM, so only the SIGKILL rung ends it.
      // It says it is ready only once the handler is installed: a SIGTERM that lands during Node's
      // start-up would kill it, and the case would then measure a child that never resisted.
      const ready = join(scratch, 'ready');
      await writeFile(
        script,
        `#!${process.execPath}\n` +
          `process.on('SIGTERM', () => {});\n` +
          `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');\n` +
          'setInterval(() => {}, 1000);\n'
      );
      await chmod(script, 0o755);

      const order: string[] = [];
      const rows: unknown[] = [];
      let childPid: number | undefined;
      const monitorHook = (event: MonitorSidecarEvent): void => {
        if (event.kind === 'started' && event.pid !== null) {
          childPid = event.pid;
          recordedPids.push(event.pid);
        }
      };
      const realKill = process.kill.bind(process);
      const sent = new Set<string>();
      vi.spyOn(process, 'kill').mockImplementation(((target: number, signal?: string | number) => {
        if (childPid !== undefined && Math.abs(target) === childPid && typeof signal === 'string') {
          const step = signal === 'SIGTERM' ? 'sigterm' : signal === 'SIGKILL' ? 'sigkill' : undefined;
          if (step !== undefined && !sent.has(step)) {
            sent.add(step);
            order.push(step);
          }
        }
        return realKill(target, signal as NodeJS.Signals);
      }) as unknown as typeof process.kill);

      const registry = new BackendRunnerRegistry(
        { uncontainedGranted: () => new Set(), monitorHook },
        'codex'
      );
      const runner = registry.getOrCreate('codex');
      const close = runner.close.bind(runner);
      runner.close = () => {
        order.push('admission-closed');
        close();
      };
      const invocation = runner.invoke({
        runId: RUN_ID,
        phase: 'speckit-implement',
        iteration: 1,
        prompt: 'work',
        timeoutMs: 60_000,
        cliPath: script,
        cwd: scratch
      });
      for (let waited = 0; waited < 3_000 && !existsSync(ready); waited += 25) await sleep(25);
      expect(existsSync(ready), 'the fixture child must have installed its SIGTERM handler').toBe(true);
      expect(childPid, 'the fixture child must have started').toBeDefined();
      expect(strayCount(), 'control: the tagged child is alive before the teardown').toBeGreaterThan(0);

      await closeStage2Resources(stageDeps(order, teardownThunk(registry, order, rows)));
      await releaseOwnership(order);

      // Printed for the quickstart's section 3 record: the order observed on this host. No value of any kind.
      console.log(`T23 order observed: ${order.join(' > ')}`);
      expect(order.filter((step) => (SIX_STEPS as readonly string[]).includes(step))).toEqual([
        ...SIX_STEPS
      ]);
      // The transport flush sits between the settled report and the lease release (S5).
      expect(order.indexOf('transport-flushed')).toBeGreaterThan(order.indexOf('report-settled'));
      expect(order.indexOf('transport-flushed')).toBeLessThan(order.indexOf('leases-released'));
      expect(order.indexOf('sync-disposed')).toBeLessThan(order.indexOf('report-settled'));
      // A ladder that finished writes no shutdown evidence.
      expect(rows).toEqual([]);
      expect(strayCount()).toBe(0);
      await invocation;
    },
    CASE_TIMEOUT_MS
  );

  it(
    'releases within the bound plus 100 ms for a child that never exits, with the evidence row first',
    async () => {
      const order: string[] = [];
      const rows: Array<{ eventType: string; runId: string; payload: Record<string, unknown> }> = [];
      vi.spyOn(process, 'kill').mockImplementation(((_target: number, signal?: string | number) => {
        if (signal === 0) return true; // the group never goes away
        return true;
      }) as unknown as typeof process.kill);

      const child = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        stderr: Readable;
        stdin: Writable;
        pid: number;
        killed: boolean;
        exitCode: number | null;
        signalCode: string | null;
        kill: () => boolean;
      };
      child.stdout = new Readable({ read() {} });
      child.stderr = new Readable({ read() {} });
      child.stdin = new Writable({ write: (_c, _e, cb) => cb() });
      child.pid = 424_242;
      child.killed = false;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => true; // the injected kill: it never ends the child
      injected.spawnFn = () => child as unknown as ChildProcess;

      const registry = new BackendRunnerRegistry(
        { uncontainedGranted: () => new Set() },
        'codex',
        INJECTED_BOUND_MS
      );
      const runner = registry.getOrCreate('codex');
      const invocation = runner.invoke({
        runId: RUN_ID,
        phase: 'speckit-implement',
        iteration: 1,
        prompt: 'work',
        timeoutMs: 60_000,
        cliPath: 'codex',
        cwd: tmpdir()
      });
      await sleep(25);
      expect(runner.hasActiveProcess).toBe(true);

      const thunk = teardownThunk(registry, order, rows);
      const startedAt = performance.now();
      await closeStage2Resources(stageDeps(order, thunk));
      await releaseOwnership(order);
      const releasedAfterMs = performance.now() - startedAt;

      console.log(
        `T23 never-exiting variant: released ${Math.round(releasedAfterMs)} ms after the call ` +
          `(injected bound ${INJECTED_BOUND_MS} ms, margin ${RELEASE_MARGIN_MS} ms)`
      );
      expect(releasedAfterMs).toBeLessThan(INJECTED_BOUND_MS + RELEASE_MARGIN_MS);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        eventType: 'host-teardown-unconfirmed',
        runId: RUN_ID,
        payload: { runner: 'codex-cli', pid: 424_242, result: 'bound-elapsed', boundMs: INJECTED_BOUND_MS }
      });
      expect(order.indexOf('evidence-appended')).toBeLessThan(order.indexOf('leases-released'));
      expect(order.indexOf('leases-released')).toBeLessThan(order.indexOf('primacy-released'));

      // Let the ladder run out against the stubbed kill, then end the child so nothing is left
      // pending when the stub comes off.
      await sleep(LADDER_SETTLE_MS);
      child.signalCode = 'SIGKILL';
      child.emit('exit', null, 'SIGKILL');
      child.emit('close', null, 'SIGKILL');
      await invocation;
    },
    CASE_TIMEOUT_MS
  );

  it('uses the shipped bound unless a test injects another', () => {
    const registry = new BackendRunnerRegistry({ uncontainedGranted: () => new Set() }, 'codex');
    return registry.closeAndTearDown().then((report) => {
      expect(report.boundMs).toBe(TEARDOWN_BOUND_MS);
    });
  });
});
