import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { ClaudeCliRunner, type SpawnFn } from '../../../src/runner/claude-cli';

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  killed: boolean;
  exitCode: number | null;
  signalCode: string | null;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({ read() { /* no-op */ } });
  child.stderr = new Readable({ read() { /* no-op */ } });
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((_sig?: NodeJS.Signals | number) => {
    child.killed = true;
    return true;
  });
  return child;
}

describe('ClaudeCliRunner.invoke', () => {
  it('passes the prompt over stdin natively under -p', async () => {
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
    const runner = new ClaudeCliRunner(spawnFn);
    await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'do work',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo'
    });
    expect(seen.command).toBe('claude');
    expect(seen.args).toEqual(['--dangerously-skip-permissions', '-p', '--output-format', 'stream-json', '--verbose']);
    expect(seen.options.shell).toBe(false);
    expect(child.stdin.write).toHaveBeenCalledWith('do work');
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it('can spawn with only Schegent-controlled env when inheritance is disabled', async () => {
    const originalSecret = process.env.SCHEGENT_SECRET_TEST;
    process.env.SCHEGENT_SECRET_TEST = 'do-not-forward';
    try {
      const child = makeFakeChild();
      const seen: { options: SpawnOptions } = { options: {} };
      const spawnFn: SpawnFn = (_command, _args, options) => {
        seen.options = options;
        setImmediate(() => child.emit('exit', 0, null));
        return child as unknown as ChildProcess;
      };
      const runner = new ClaudeCliRunner(spawnFn);
      await runner.invoke({
        phase: 'speckit-plan',
        iteration: 1,
        prompt: 'do work',
        timeoutMs: 5_000,
        cliPath: 'claude',
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

  it('captures stdout and stderr and resolves exit code', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      setImmediate(() => {
        child.stdout.emit('data', '[SCHEGENT_STATUS: CLEAR]\n');
        child.stderr.emit('data', 'warn: nothing important\n');
        child.emit('exit', 0, null);
      });
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    const result = await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'do work',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo'
    });
    const stdout = Array.from(result.stdoutBuffer.decompressStream()).join("");
    expect(stdout).toContain('[SCHEGENT_STATUS: CLEAR]');
    const stderr = Array.from(result.stderrBuffer.decompressStream()).join("");
    expect(stderr).toContain('warn');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.killed).toBe(false);
  });

  it('marks timedOut and kills the child after timeoutMs', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => child as unknown as ChildProcess;

    const runner = new ClaudeCliRunner(spawnFn);
    const promise = runner.invoke({
      phase: 'speckit-plan',
      iteration: 1,
      prompt: 'p',
      timeoutMs: 1_000,
      cliPath: 'claude',
      cwd: '/repo'
    });

    await vi.advanceTimersByTimeAsync(1_001);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit', null, 'SIGTERM');

    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.killed).toBe(true);
    vi.useRealTimers();
  });

  it('aborts when cancellation signal fires', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => child as unknown as ChildProcess;
    const runner = new ClaudeCliRunner(spawnFn);

    const listeners: Array<() => void> = [];
    const signal = {
      aborted: false,
      addEventListener: (_e: 'abort', cb: () => void) => listeners.push(cb)
    };

    const promise = runner.invoke({
      phase: 'speckit-plan',
      iteration: 1,
      prompt: 'p',
      timeoutMs: 60_000,
      cliPath: 'claude',
      cwd: '/repo',
      cancellationSignal: signal
    });

    listeners.forEach((cb) => cb());
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit', null, 'SIGTERM');

    const result = await promise;
    expect(result.killed).toBe(true);
  });

  // The controller shares one AbortController.signal across every phase
  // within a `driveRun`. Without removing the per-invocation `'abort'`
  // listener at exit, the listener set grows by one per phase and each
  // closure pins the (already-exited) subprocess for the rest of the run.
  it('detaches the abort listener once the child exits', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);

    const added: Array<() => void> = [];
    const removed: Array<() => void> = [];
    const signal = {
      aborted: false,
      addEventListener: (_e: 'abort', cb: () => void) => added.push(cb),
      removeEventListener: (_e: 'abort', cb: () => void) => removed.push(cb)
    };

    await runner.invoke({
      phase: 'speckit-plan',
      iteration: 1,
      prompt: 'p',
      timeoutMs: 60_000,
      cliPath: 'claude',
      cwd: '/repo',
      cancellationSignal: signal
    });

    expect(added).toHaveLength(1);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toBe(added[0]);
  });

  it('cancelActive kills the in-flight child and returns true', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => child as unknown as ChildProcess;
    const runner = new ClaudeCliRunner(spawnFn);

    const promise = runner.invoke({
      phase: 'speckit-plan',
      iteration: 1,
      prompt: 'p',
      timeoutMs: 60_000,
      cliPath: 'claude',
      cwd: '/repo'
    });

    expect(runner.hasActiveProcess).toBe(true);
    expect(runner.cancelActive()).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    child.emit('exit', null, 'SIGTERM');
    await promise;
    expect(runner.hasActiveProcess).toBe(false);
  });

  it('cancelActive returns false when no process is active', () => {
    const runner = new ClaudeCliRunner((() => makeFakeChild()) as unknown as SpawnFn);
    expect(runner.cancelActive()).toBe(false);
  });

  it('appends --model and --effort after the existing -p block when set (T031, US2)', async () => {
    const child = makeFakeChild();
    const seen: { args: ReadonlyArray<string> } = { args: [] };
    const spawnFn: SpawnFn = (_command, args) => {
      seen.args = args;
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    await runner.invoke({
      phase: 'security-audit',
      iteration: 1,
      prompt: 'do work',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo',
      model: 'claude-opus-4-7',
      effort: 'high'
    });
    expect(seen.args.slice(0, 2)).toEqual(['--dangerously-skip-permissions', '-p']);
    expect(seen.args).toContain('--model');
    expect(seen.args).toContain('claude-opus-4-7');
    expect(seen.args).toContain('--effort');
    expect(seen.args).toContain('high');
    expect(seen.args.indexOf('--model')).toBeGreaterThan(seen.args.indexOf('-p'));
    expect(seen.args.indexOf('--effort')).toBeGreaterThan(seen.args.indexOf('-p'));
  });

  it('omits --model and --effort when not set (T028, US1)', async () => {
    const child = makeFakeChild();
    const seen: { args: ReadonlyArray<string> } = { args: [] };
    const spawnFn: SpawnFn = (_command, args) => {
      seen.args = args;
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'p',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo'
    });
    expect(seen.args).toEqual(['--dangerously-skip-permissions', '-p', '--output-format', 'stream-json', '--verbose']);
    expect(seen.args).not.toContain('--model');
    expect(seen.args).not.toContain('--effort');
  });

  it('captures non-zero exit codes', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      setImmediate(() => child.emit('exit', 1, null));
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    const result = await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'p',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo'
    });
    expect(result.exitCode).toBe(1);
  });

  it('appends --debug-file, --output-format stream-json, --verbose when verboseDiagnostics is set (010, T035, US3/FR-018)', async () => {
    const child = makeFakeChild();
    const seen: { args: ReadonlyArray<string> } = { args: [] };
    const spawnFn: SpawnFn = (_command, args) => {
      seen.args = args;
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'p',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo',
      verboseDiagnostics: {
        directory: '/repo/.schegent/sessions/run-x/diagnostics/spec-kit/specify/iter-1',
        debugFile: '/repo/.schegent/sessions/run-x/diagnostics/spec-kit/specify/iter-1/debug.json',
        streamFile: '/repo/.schegent/sessions/run-x/diagnostics/spec-kit/specify/iter-1/stream.jsonl',
        verboseLogFile: '/repo/.schegent/sessions/run-x/diagnostics/spec-kit/specify/iter-1/verbose.log'
      }
    });
    // Existing -p block stays first.
    expect(seen.args.slice(0, 2)).toEqual(['--dangerously-skip-permissions', '-p']);
    // --output-format stream-json is always present (session ID capture).
    // The verbose diagnostics add --debug-file and --verbose on top.
    const debugIdx = seen.args.indexOf('--debug-file');
    const verboseIdx = seen.args.indexOf('--verbose');
    expect(debugIdx).toBeGreaterThan(seen.args.indexOf('-p'));
    expect(debugIdx).toBeGreaterThan(verboseIdx);
    // --debug-file carries the canonical path.
    expect(seen.args[debugIdx + 1]).toBe(
      '/repo/.schegent/sessions/run-x/diagnostics/spec-kit/specify/iter-1/debug.json'
    );
    // --output-format stream-json paired (always present, before diagnostics).
    expect(seen.args).toContain('--output-format');
    expect(seen.args[seen.args.indexOf('--output-format') + 1]).toBe('stream-json');
    // Each flag appears exactly once.
    expect(seen.args.filter((a) => a === '--debug-file')).toHaveLength(1);
    expect(seen.args.filter((a) => a === '--output-format')).toHaveLength(1);
    expect(seen.args.filter((a) => a === '--verbose')).toHaveLength(1);
  });

  it('omits diagnostic flags when verboseDiagnostics is absent, but keeps --verbose for stream-json (010, T035, US3/FR-024)', async () => {
    const child = makeFakeChild();
    const seen: { args: ReadonlyArray<string> } = { args: [] };
    const spawnFn: SpawnFn = (_command, args) => {
      seen.args = args;
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'p',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo'
    });
    expect(seen.args).not.toContain('--debug-file');
    // --output-format stream-json is always present (session ID capture).
    expect(seen.args).toContain('--output-format');
    expect(seen.args).toContain('stream-json');
    expect(seen.args).toContain('--verbose');
  });
});
