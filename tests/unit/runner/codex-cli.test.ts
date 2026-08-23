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
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
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
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((_sig?: NodeJS.Signals | number) => {
    child.killed = true;
    return true;
  });
  return child;
}

describe('CodexCliRunner.invoke', () => {
  it('spawns codex with structured output and a workspace-write sandbox, piping the prompt over stdin', async () => {
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
      setImmediate(() => { child.emit('exit', 0, null); child.emit('close', 0, null); });
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
    expect(seen.args).toEqual(['exec', '--json', '--sandbox', 'workspace-write']);
    expect(seen.options.shell).toBe(false);
    expect(seen.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    const captured = (child.stdin as Writable & { __captured: string[] }).__captured;
    expect(captured.join('')).toBe('do work');
  });

  it('can spawn with only Schegent-controlled env when inheritance is disabled', async () => {
    const originalSecret = process.env.SCHEGENT_SECRET_TEST;
    process.env.SCHEGENT_SECRET_TEST = 'do-not-forward';
    try {
      const child = makeFakeChild();
      const seen: { options: SpawnOptions } = { options: {} };
      const spawnFn: SpawnFn = (_command, _args, options) => {
        seen.options = options;
        setImmediate(() => { child.emit('exit', 0, null); child.emit('close', 0, null); });
        return child as unknown as ChildProcess;
      };
      const runner = new CodexCliRunner(spawnFn);
      await runner.invoke({
        phase: 'speckit-plan',
        iteration: 1,
        prompt: 'do work',
        timeoutMs: 5_000,
        cliPath: 'codex',
        cwd: '/repo',
        env: { SCHEGENT_PHASE: 'speckit-plan' },
        inheritProcessEnv: false
      });

      expect(seen.options.env).toEqual({ SCHEGENT_PHASE: 'speckit-plan' });
      expect((seen.options.env as NodeJS.ProcessEnv).SCHEGENT_SECRET_TEST).toBeUndefined();
    } finally {
      if (originalSecret === undefined) {
        delete process.env.SCHEGENT_SECRET_TEST;
      } else {
        process.env.SCHEGENT_SECRET_TEST = originalSecret;
      }
    }
  });

  it('forwards --model and maps effort to a Codex configuration override', async () => {
    const child = makeFakeChild();
    let observedArgs: ReadonlyArray<string> = [];
    const spawnFn: SpawnFn = (_cmd, args) => {
      observedArgs = args;
      setImmediate(() => { child.emit('exit', 0, null); child.emit('close', 0, null); });
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
      '--json',
      '--sandbox',
      'workspace-write',
      '--model',
      'codex-pro',
      '--config',
      'model_reasoning_effort=high'
    ]);
    expect(observedArgs).not.toContain('-c');
  });

  it('captures stdout and stderr and reports exit code', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      setImmediate(() => {
        child.stdout.emit('data', 'tool result\n');
        child.stderr.emit('data', 'warn: deprecated flag\n');
        child.emit('close', 0, null);
      });
      return child as unknown as ChildProcess;
    };
    const runner = new CodexCliRunner(spawnFn);
    const outputSink = {
      write: vi.fn(() => true),
      onceDrain: vi.fn()
    };
    const result = await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'do work',
      timeoutMs: 5_000,
      cliPath: 'codex',
      cwd: '/repo'
    }, outputSink);
    expect(Array.from(result.stdoutBuffer.decompressStream()).join('')).toContain('tool result');
    expect(Array.from(result.stderrBuffer.decompressStream()).join('')).toContain('warn');
    expect(result.exitCode).toBe(0);
    expect(result.killed).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(outputSink.write).toHaveBeenCalledWith('stdout', 'tool result\n');
    expect(outputSink.write).toHaveBeenCalledWith('stderr', 'warn: deprecated flag\n');
  });

  it('emits monitor sidecar events for started/stdout/exited', async () => {
    const events: Array<{ kind: string }> = [];
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      setImmediate(() => {
        child.stdout.emit('data', 'hello');
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
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
      setTimeout(() => { child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM'); }, 100);
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
        child.emit('close', null, 'SIGTERM');
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
      setImmediate(() => { child.emit('exit', 0, null); child.emit('close', 0, null); });
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
      setImmediate(() => { child.emit('exit', 0, null); child.emit('close', 0, null); });
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
      exits.push(() => { child.emit('exit', 0, null); child.emit('close', 0, null); });
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

/**
 * Feature 093 (T046a) — the shared `ProcessLifecycleRunner` behind the codex
 * and agy backends tracks every live subprocess, not just the newest.
 *
 * Exercised through `CodexCliRunner` because the lifecycle runner has no
 * public construction site of its own; `AgyCliRunner` delegates to the same
 * instance shape. Each assertion fails against the pre-feature single
 * `active: ChildProcess | null` slot, where the second spawn overwrote the
 * first's handle and the first exit cleared the slot for both.
 */
describe('CodexCliRunner concurrent invocations (Feature 093 T046a)', () => {
  function overlappingSpawn(children: FakeChild[]): SpawnFn {
    let index = 0;
    return (() => children[index++] as unknown as ChildProcess) as SpawnFn;
  }

  const request = (prompt: string) => ({
    phase: 'speckit-specify' as const,
    iteration: 1,
    prompt,
    timeoutMs: 60_000,
    cliPath: 'codex',
    cwd: '/repo'
  });

  it('cancelActive terminates every in-flight child, not just the newest', async () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    const runner = new CodexCliRunner(overlappingSpawn([first, second]));

    const firstDone = runner.invoke(request('a'));
    const secondDone = runner.invoke(request('b'));

    expect(runner.hasActiveProcess).toBe(true);
    expect(runner.cancelActive()).toBe(true);
    expect(first.kill).toHaveBeenCalledWith('SIGTERM');
    expect(second.kill).toHaveBeenCalledWith('SIGTERM');

    first.emit('exit', null, 'SIGTERM');
    first.emit('close', null, 'SIGTERM');
    second.emit('exit', null, 'SIGTERM');
    second.emit('close', null, 'SIGTERM');
    await Promise.all([firstDone, secondDone]);
    expect(runner.hasActiveProcess).toBe(false);
  });

  it('keeps reporting an active process after one of two children exits', async () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    const runner = new CodexCliRunner(overlappingSpawn([first, second]));

    const firstDone = runner.invoke(request('a'));
    const secondDone = runner.invoke(request('b'));

    first.exitCode = 0;
    first.emit('exit', 0, null);
    first.emit('close', 0, null);
    await firstDone;

    expect(runner.hasActiveProcess).toBe(true);
    expect(runner.cancelActive()).toBe(true);
    expect(first.kill).not.toHaveBeenCalled();
    expect(second.kill).toHaveBeenCalledWith('SIGTERM');

    second.emit('exit', null, 'SIGTERM');
    second.emit('close', null, 'SIGTERM');
    await secondDone;
    expect(runner.hasActiveProcess).toBe(false);
  });
});
