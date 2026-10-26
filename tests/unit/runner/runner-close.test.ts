import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { BackendRunner, RunnerLabel } from '../../../src/contracts/backend-runner';
import { SanitizedLogger } from '../../../src/lib/logger';
import { AgyCliRunner } from '../../../src/runner/agy-cli';
import { ClaudeCliRunner, type SpawnFn } from '../../../src/runner/claude-cli';
import { CodexCliRunner } from '../../../src/runner/codex-cli';
import type { InvocationRequest } from '../../../src/runner/invocation-result';
import { SpawnRefusedAfterCloseError } from '../../../src/runner/spawn-refused-after-close';

/**
 * The feature-228 security review, S1. Host teardown runs `cancelAll()`, whose
 * SIGTERM ends a child with 143 and `killed` false. A turn that still had
 * background work open then reads as unfinished, and the controller resumed it:
 * a detached `--resume` CLI spawned after the teardown that was meant to stop
 * every CLI. A runner the registry has closed refuses each later spawn instead.
 */

interface FakeChild extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  killed: boolean;
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals | number): boolean;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  child.stdout = new Readable({ read() { /* no-op */ } });
  child.stderr = new Readable({ read() { /* no-op */ } });
  child.killed = false;
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((_sig?: NodeJS.Signals | number) => {
    child.killed = true;
    return true;
  });
  return child;
}

function exitingChild(): ChildProcess {
  const child = makeFakeChild();
  setImmediate(() => { child.emit('exit', 0, null); child.emit('close', 0, null); });
  return child as unknown as ChildProcess;
}

function silentLogger(): SanitizedLogger {
  const logger = new SanitizedLogger();
  logger.info = vi.fn();
  logger.warn = vi.fn();
  return logger;
}

const REQUEST: InvocationRequest = {
  phase: 'speckit-implement',
  iteration: 1,
  prompt: 'p',
  timeoutMs: 5_000,
  cliPath: 'cli',
  cwd: '/repo'
};

const RUNNERS: ReadonlyArray<{
  readonly label: RunnerLabel;
  readonly make: (spawnFn: SpawnFn) => BackendRunner;
}> = [
  { label: 'claude-cli', make: (spawnFn) => new ClaudeCliRunner(spawnFn, null, {}, silentLogger()) },
  { label: 'codex-cli', make: (spawnFn) => new CodexCliRunner(spawnFn, null, silentLogger()) },
  { label: 'agy-cli', make: (spawnFn) => new AgyCliRunner(spawnFn, null, silentLogger()) }
];

describe.each(RUNNERS)('$label close()', ({ label, make }) => {
  it('refuses every invocation after it, and starts no process', async () => {
    const spawnFn = vi.fn<SpawnFn>(() => exitingChild());
    const runner = make(spawnFn);
    runner.close();
    // Teardown can be reached twice, so a second close changes nothing.
    runner.close();

    const refused = runner.invoke(REQUEST);
    await expect(refused).rejects.toBeInstanceOf(SpawnRefusedAfterCloseError);
    await expect(refused).rejects.toMatchObject({ runner: label });
    expect(spawnFn).not.toHaveBeenCalled();
    expect(runner.hasActiveProcess).toBe(false);
  });

  it('leaves a child that is already running to cancelActive()', async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn<SpawnFn>(() => child as unknown as ChildProcess);
    const runner = make(spawnFn);
    const running = runner.invoke(REQUEST);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    runner.close();
    expect(child.kill).not.toHaveBeenCalled();
    expect(runner.hasActiveProcess).toBe(true);

    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await expect(running).resolves.toMatchObject({ exitCode: 0 });
  });
});

describe('ClaudeCliRunner close() while an invocation awaits its diagnostics directory', () => {
  let root = '';

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'schegent-runner-close-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses the spawn that await was leading to', async () => {
    const segments = ['.schegent', 'sessions', 'run-x', 'diagnostics'];
    const directory = join(root, ...segments);
    const spawnFn = vi.fn<SpawnFn>(() => exitingChild());
    const runner = new ClaudeCliRunner(spawnFn, null, {}, silentLogger());

    const pending = runner.invoke({
      ...REQUEST,
      verboseDiagnostics: {
        directory,
        debugFile: join(directory, 'debug.json'),
        streamFile: join(directory, 'stream.jsonl'),
        verboseLogFile: join(directory, 'verbose.log'),
        workspaceRoot: root,
        segments
      }
    });
    // The invocation is now suspended in `prepare()`, past any check made
    // before that await.
    runner.close();

    await expect(pending).rejects.toBeInstanceOf(SpawnRefusedAfterCloseError);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
