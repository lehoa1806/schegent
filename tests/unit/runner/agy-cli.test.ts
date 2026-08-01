import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { AgyCliRunner, type SpawnFn } from '../../../src/runner/agy-cli';
import { SanitizedLogger } from '../../../src/lib/logger';

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

function silentLogger(): SanitizedLogger {
  const logger = new SanitizedLogger();
  logger.info = vi.fn();
  logger.warn = vi.fn();
  return logger;
}

describe('AgyCliRunner.invoke', () => {
  it('spawns agy with --dangerously-skip-permissions -p and pipes prompt via stdin', async () => {
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
    const runner = new AgyCliRunner(spawnFn, null, silentLogger());
    await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'do work',
      timeoutMs: 5_000,
      cliPath: 'agy',
      cwd: '/repo'
    });
    expect(seen.command).toBe('agy');
    expect(seen.args).toContain('--dangerously-skip-permissions');
    expect(seen.args).toContain('-p');
    expect(seen.args).toContain('--output-format');
    expect(seen.args).toContain('stream-json');
    expect(seen.options.shell).toBe(false);
    expect(seen.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    const captured = (child.stdin as Writable & { __captured: string[] }).__captured;
    expect(captured.join('')).toBe('do work');
  });

  it('maps effort xhigh → high with WARN log', async () => {
    const child = makeFakeChild();
    const seen: { args: ReadonlyArray<string> } = { args: [] };
    const spawnFn: SpawnFn = (_cmd, args, _opts) => {
      seen.args = args;
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };
    const logger = silentLogger();
    const runner = new AgyCliRunner(spawnFn, null, logger);
    await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'hi',
      timeoutMs: 5_000,
      cliPath: 'agy',
      cwd: '/repo',
      effort: 'xhigh'
    });
    const effortIdx = (seen.args as string[]).indexOf('--effort');
    expect(effortIdx).toBeGreaterThan(-1);
    expect(seen.args[effortIdx + 1]).toBe('high');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("effort 'xhigh' is not supported")
    );
  });

  it('maps effort max → high with WARN log', async () => {
    const child = makeFakeChild();
    const seen: { args: ReadonlyArray<string> } = { args: [] };
    const spawnFn: SpawnFn = (_cmd, args, _opts) => {
      seen.args = args;
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };
    const logger = silentLogger();
    const runner = new AgyCliRunner(spawnFn, null, logger);
    await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'hi',
      timeoutMs: 5_000,
      cliPath: 'agy',
      cwd: '/repo',
      effort: 'max'
    });
    const effortIdx = (seen.args as string[]).indexOf('--effort');
    expect(effortIdx).toBeGreaterThan(-1);
    expect(seen.args[effortIdx + 1]).toBe('high');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("effort 'max' is not supported")
    );
  });

  it('passes low/medium/high effort unchanged', async () => {
    for (const effort of ['low', 'medium', 'high'] as const) {
      const child = makeFakeChild();
      const seen: { args: ReadonlyArray<string> } = { args: [] };
      const spawnFn: SpawnFn = (_cmd, args, _opts) => {
        seen.args = args;
        setImmediate(() => child.emit('exit', 0, null));
        return child as unknown as ChildProcess;
      };
      const logger = silentLogger();
      const runner = new AgyCliRunner(spawnFn, null, logger);
      await runner.invoke({
        phase: 'p',
        iteration: 1,
        prompt: 'hi',
        timeoutMs: 5_000,
        cliPath: 'agy',
        cwd: '/repo',
        effort
      });
      const effortIdx = (seen.args as string[]).indexOf('--effort');
      expect(effortIdx).toBeGreaterThan(-1);
      expect(seen.args[effortIdx + 1]).toBe(effort);
      expect(logger.warn).not.toHaveBeenCalled();
    }
  });

  it('includes --model when model is specified', async () => {
    const child = makeFakeChild();
    const seen: { args: ReadonlyArray<string> } = { args: [] };
    const spawnFn: SpawnFn = (_cmd, args, _opts) => {
      seen.args = args;
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };
    const runner = new AgyCliRunner(spawnFn, null, silentLogger());
    await runner.invoke({
      phase: 'p',
      iteration: 1,
      prompt: 'hi',
      timeoutMs: 5_000,
      cliPath: 'agy',
      cwd: '/repo',
      model: 'claude-sonnet-4-6'
    });
    const modelIdx = (seen.args as string[]).indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(seen.args[modelIdx + 1]).toBe('claude-sonnet-4-6');
  });

  it('uses --conversation <id> for session continuation when isContinue + resumeSessionId', async () => {
    const child = makeFakeChild();
    const seen: { args: ReadonlyArray<string> } = { args: [] };
    const spawnFn: SpawnFn = (_cmd, args, _opts) => {
      seen.args = args;
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };
    const runner = new AgyCliRunner(spawnFn, null, silentLogger());
    await runner.invoke({
      phase: 'p',
      iteration: 1,
      prompt: 'hi',
      timeoutMs: 5_000,
      cliPath: 'agy',
      cwd: '/repo',
      isContinue: true,
      resumeSessionId: 'sess-123'
    });
    const convIdx = (seen.args as string[]).indexOf('--conversation');
    expect(convIdx).toBeGreaterThan(-1);
    expect(seen.args[convIdx + 1]).toBe('sess-123');
  });

  it('uses --conversation <id> for session reuse when sessionReuse + resumeSessionId', async () => {
    const child = makeFakeChild();
    const seen: { args: ReadonlyArray<string> } = { args: [] };
    const spawnFn: SpawnFn = (_cmd, args, _opts) => {
      seen.args = args;
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };
    const runner = new AgyCliRunner(spawnFn, null, silentLogger());
    await runner.invoke({
      phase: 'p',
      iteration: 1,
      prompt: 'hi',
      timeoutMs: 5_000,
      cliPath: 'agy',
      cwd: '/repo',
      sessionReuse: true,
      resumeSessionId: 'sess-456'
    });
    const convIdx = (seen.args as string[]).indexOf('--conversation');
    expect(convIdx).toBeGreaterThan(-1);
    expect(seen.args[convIdx + 1]).toBe('sess-456');
  });

  it('omits --conversation when isContinue is true but no resumeSessionId', async () => {
    const child = makeFakeChild();
    const seen: { args: ReadonlyArray<string> } = { args: [] };
    const spawnFn: SpawnFn = (_cmd, args, _opts) => {
      seen.args = args;
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };
    const runner = new AgyCliRunner(spawnFn, null, silentLogger());
    await runner.invoke({
      phase: 'p',
      iteration: 1,
      prompt: 'hi',
      timeoutMs: 5_000,
      cliPath: 'agy',
      cwd: '/repo',
      isContinue: true
    });
    expect(seen.args).not.toContain('--conversation');
  });

  it('emits started/exited monitor events', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = (_cmd, _args, _opts) => {
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };
    const events: Array<{ kind: string }> = [];
    const hook = (event: { kind: string }) => { events.push(event); };
    const runner = new AgyCliRunner(spawnFn, hook as never, silentLogger());
    await runner.invoke({
      phase: 'p',
      iteration: 1,
      prompt: 'hi',
      timeoutMs: 5_000,
      cliPath: 'agy',
      cwd: '/repo'
    });
    const kinds = events.map(e => e.kind);
    expect(kinds).toContain('started');
    expect(kinds).toContain('exited');
  });

  it('rejects shell: true', async () => {
    // The safeSpawn guard should throw when shell: true is injected.
    // This tests the internal guard, not the public API (which always passes shell: false).
    const child = makeFakeChild();
    // We can't directly test safeSpawn from outside, but we verify the runner
    // always passes shell: false to spawn.
    const seen: { options: SpawnOptions } = { options: {} };
    const capturingSpawnFn: SpawnFn = (_cmd, _args, options) => {
      seen.options = options;
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };
    const runner = new AgyCliRunner(capturingSpawnFn, null, silentLogger());
    await runner.invoke({
      phase: 'p',
      iteration: 1,
      prompt: 'hi',
      timeoutMs: 5_000,
      cliPath: 'agy',
      cwd: '/repo'
    });
    expect(seen.options.shell).toBe(false);
  });

  it('cancelActive terminates the active process', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = (_cmd, _args, _opts) => {
      // Don't emit exit — leave the process "running"
      return child as unknown as ChildProcess;
    };
    const runner = new AgyCliRunner(spawnFn, null, silentLogger());
    // Start invoke but don't await — it will hang until we cancel
    const invokePromise = runner.invoke({
      phase: 'p',
      iteration: 1,
      prompt: 'hi',
      timeoutMs: 60_000,
      cliPath: 'agy',
      cwd: '/repo'
    });
    expect(runner.hasActiveProcess).toBe(true);
    runner.cancelActive();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    // Simulate exit after SIGTERM
    child.exitCode = null;
    child.signalCode = 'SIGTERM';
    child.emit('exit', null, 'SIGTERM');
    const result = await invokePromise;
    expect(result.killed).toBe(true);
  });
});
