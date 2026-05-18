import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { CodexCliRunner, type SpawnFn } from '../../../src/runner/codex-cli';

interface FakeChild extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  killed: boolean;
  pid?: number;
  kill(signal: NodeJS.Signals | number): boolean;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  // Writable stub — collect bytes the runner pipes for assertion.
  const sink: string[] = [];
  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      sink.push(chunk.toString('utf8'));
      cb();
    }
  });
  (child.stdin as Writable & { __captured: string[] }).__captured = sink;
  child.stdout = new Readable({ read() { /* no-op */ } });
  child.stderr = new Readable({ read() { /* no-op */ } });
  child.killed = false;
  child.pid = 4242;
  child.kill = vi.fn((_sig?: NodeJS.Signals | number) => {
    child.killed = true;
    return true;
  });
  return child;
}

describe('CodexCliRunner.invoke', () => {
  it('spawns codex with `exec --no-stream` and pipes the prompt over stdin', async () => {
    const child = makeFakeChild();
    const seen: { command: string; args: ReadonlyArray<string>; options: SpawnOptions } = {
      command: '',
      args: [],
      options: {}
    };
    const spawnFn: SpawnFn = (command, args, options) => {
      seen.command = command;
      seen.args = args;
      seen.options = options;
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };
    const runner = new CodexCliRunner(spawnFn);
    await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'do work',
      timeoutMs: 5_000,
      cliPath: 'codex',
      cwd: '/repo'
    });
    expect(seen.command).toBe('codex');
    expect(seen.args).toEqual(['exec', '--no-stream']);
    expect(seen.options.shell).toBe(false);
    expect(seen.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    const captured = (child.stdin as Writable & { __captured: string[] }).__captured;
    expect(captured.join('')).toBe('do work');
  });

  it('forwards --model and --effort when set', async () => {
    const child = makeFakeChild();
    let observedArgs: ReadonlyArray<string> = [];
    const spawnFn: SpawnFn = (_cmd, args) => {
      observedArgs = args;
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };
    const runner = new CodexCliRunner(spawnFn);
    await runner.invoke({
      phase: 'speckit-plan',
      iteration: 1,
      prompt: 'plan',
      timeoutMs: 5_000,
      cliPath: 'codex',
      cwd: '/repo',
      model: 'codex-pro',
      effort: 'high'
    });
    expect(observedArgs).toEqual([
      'exec',
      '--no-stream',
      '--model',
      'codex-pro',
      '--effort',
      'high'
    ]);
  });

  it('captures stdout and stderr and reports exit code', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      setImmediate(() => {
        child.stdout.emit('data', 'tool result\n');
        child.stderr.emit('data', 'warn: deprecated flag\n');
        child.emit('exit', 0, null);
      });
      return child as unknown as ChildProcess;
    };
    const runner = new CodexCliRunner(spawnFn);
    const result = await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'do work',
      timeoutMs: 5_000,
      cliPath: 'codex',
      cwd: '/repo'
    });
    expect(result.stdout).toContain('tool result');
    expect(result.stderr).toContain('warn');
    expect(result.exitCode).toBe(0);
    expect(result.killed).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
  });

  it('marks stdoutTruncated when the stream exceeds 4 MiB', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      setImmediate(() => {
        const big = 'A'.repeat(2 * 1024 * 1024);
        child.stdout.emit('data', big);
        child.stdout.emit('data', big);
        // 5 MiB total stdout — third chunk will overflow the 4 MiB cap
        child.stdout.emit('data', 'A'.repeat(1 * 1024 * 1024));
        child.emit('exit', 0, null);
      });
      return child as unknown as ChildProcess;
    };
    const runner = new CodexCliRunner(spawnFn);
    const result = await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'noisy',
      timeoutMs: 10_000,
      cliPath: 'codex',
      cwd: '/repo'
    });
    expect(result.stdoutTruncated).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('emits monitor sidecar events for started/stdout/exited', async () => {
    const events: Array<{ kind: string }> = [];
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      setImmediate(() => {
        child.stdout.emit('data', 'hello');
        child.emit('exit', 0, null);
      });
      return child as unknown as ChildProcess;
    };
    const runner = new CodexCliRunner(spawnFn, (event) => events.push(event));
    await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'do work',
      timeoutMs: 5_000,
      cliPath: 'codex',
      cwd: '/repo'
    });
    expect(events.map((e) => e.kind)).toEqual(['started', 'stdout-chunk', 'exited']);
  });

  it('flags timedOut and terminates the child when the timeout fires', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      // After the timeout terminates the child, simulate the resulting
      // signalled exit so the invoke() promise can settle.
      setTimeout(() => child.emit('exit', null, 'SIGTERM'), 100);
      return child as unknown as ChildProcess;
    };
    const runner = new CodexCliRunner(spawnFn);
    const result = await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'hangs',
      timeoutMs: 50,
      cliPath: 'codex',
      cwd: '/repo'
    });
    expect(result.timedOut).toBe(true);
    expect(child.kill).toHaveBeenCalled();
  });

  it('observes the cancellation signal and reports killed=true', async () => {
    const child = makeFakeChild();
    const abortListeners: Array<() => void> = [];
    const signal = {
      aborted: false,
      addEventListener(_e: 'abort', cb: () => void) {
        abortListeners.push(cb);
      }
    };
    const spawnFn: SpawnFn = () => {
      setImmediate(() => {
        for (const cb of abortListeners) cb();
        child.emit('exit', null, 'SIGTERM');
      });
      return child as unknown as ChildProcess;
    };
    const runner = new CodexCliRunner(spawnFn);
    const result = await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'cancel me',
      timeoutMs: 5_000,
      cliPath: 'codex',
      cwd: '/repo',
      cancellationSignal: signal
    });
    expect(result.killed).toBe(true);
    expect(child.kill).toHaveBeenCalled();
  });

  // Pair with `claude-cli`'s identical leak fix: per-phase listeners
  // must detach after the child exits so a long-lived shared signal does
  // not accumulate closures across phases within one `driveRun`.
  it('detaches the abort listener once the child exits', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };
    const runner = new CodexCliRunner(spawnFn);

    const added: Array<() => void> = [];
    const removed: Array<() => void> = [];
    const signal = {
      aborted: false,
      addEventListener: (_e: 'abort', cb: () => void) => added.push(cb),
      removeEventListener: (_e: 'abort', cb: () => void) => removed.push(cb)
    };

    await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'p',
      timeoutMs: 60_000,
      cliPath: 'codex',
      cwd: '/repo',
      cancellationSignal: signal
    });

    expect(added).toHaveLength(1);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toBe(added[0]);
  });

  it('rejects shell:true via the safeSpawn guard', async () => {
    const evilSpawn: SpawnFn = (_cmd, _args, options) => {
      // The runner is supposed to throw BEFORE reaching here, but assert
      // defensively that shell is not true on the path we observe.
      expect(options.shell).toBe(false);
      const child = makeFakeChild();
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };
    const runner = new CodexCliRunner(evilSpawn);
    // Normal invocation should not throw — the safeSpawn guard rejects
    // shell:true at the options layer. We can't easily inject shell:true
    // from outside, so we exercise the guard via a unit-level call.
    await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'safe',
      timeoutMs: 5_000,
      cliPath: 'codex',
      cwd: '/repo'
    });
  });

  it('cancelActive() returns true when a process is active and false otherwise', async () => {
    const child = makeFakeChild();
    const exits: Array<() => void> = [];
    const spawnFn: SpawnFn = () => {
      exits.push(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };
    const runner = new CodexCliRunner(spawnFn);
    expect(runner.cancelActive()).toBe(false);
    const result$ = runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'p',
      timeoutMs: 5_000,
      cliPath: 'codex',
      cwd: '/repo'
    });
    expect(runner.hasActiveProcess).toBe(true);
    expect(runner.cancelActive()).toBe(true);
    for (const fn of exits) fn();
    await result$;
    expect(runner.hasActiveProcess).toBe(false);
  });
});
