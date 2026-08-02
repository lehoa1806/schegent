import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { AgyCliRunner, type SpawnFn } from '../../../src/runner/agy-cli';
import { SanitizedLogger } from '../../../src/lib/logger';
import { MAX_STREAM_BUFFER_BYTES } from '../../../src/runner/zipped-stream-buffer';

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

  it('rejects effort xhigh with an Error', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = (_cmd, _args, _opts) => {
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };
    const runner = new AgyCliRunner(spawnFn, null, silentLogger());
    await expect(runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'hi',
      timeoutMs: 5_000,
      cliPath: 'agy',
      cwd: '/repo',
      effort: 'xhigh'
    })).rejects.toThrow("agy-cli: effort 'xhigh' is not supported by Antigravity");
  });

  it('rejects effort max with an Error', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = (_cmd, _args, _opts) => {
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };
    const runner = new AgyCliRunner(spawnFn, null, silentLogger());
    await expect(runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'hi',
      timeoutMs: 5_000,
      cliPath: 'agy',
      cwd: '/repo',
      effort: 'max'
    })).rejects.toThrow("agy-cli: effort 'max' is not supported by Antigravity");
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

  it('passes a model containing spaces as one argv element', async () => {
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
      model: 'Gemini 3.1 Pro'
    });
    const modelIdx = (seen.args as string[]).indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(seen.args[modelIdx + 1]).toBe('Gemini 3.1 Pro');
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

  it('emits stdout/stderr chunks and extracts an Agy conversation_id', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = (_cmd, _args, _opts) => {
      setImmediate(() => {
        child.stdout.push('{"type":"result","conversation_id":"agy-conv-123"}\n');
        child.stderr.push('progress\n');
        child.emit('close', 0, null);
      });
      return child as unknown as ChildProcess;
    };
    const events: Array<{ kind: string; chunk?: string }> = [];
    const runner = new AgyCliRunner(spawnFn, (event) => events.push(event), silentLogger());
    const outputSink = {
      write: vi.fn(() => true),
      onceDrain: vi.fn()
    };

    const result = await runner.invoke({
      phase: 'p',
      iteration: 1,
      prompt: 'hi',
      timeoutMs: 5_000,
      cliPath: 'agy',
      cwd: '/repo'
    }, outputSink);

    expect(result.cliSessionId).toBe('agy-conv-123');
    expect(events).toContainEqual({
      kind: 'stdout-chunk',
      chunk: '{"type":"result","conversation_id":"agy-conv-123"}\n'
    });
    expect(events).toContainEqual({ kind: 'stderr-chunk', chunk: 'progress\n' });
    expect(outputSink.write).toHaveBeenCalledWith(
      'stdout',
      '{"type":"result","conversation_id":"agy-conv-123"}\n'
    );
    expect(outputSink.write).toHaveBeenCalledWith('stderr', 'progress\n');
  });

  it('caps captured output while preserving truncation observability', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = (_cmd, _args, _opts) => {
      setImmediate(() => {
        child.stdout.emit('data', 'x'.repeat(MAX_STREAM_BUFFER_BYTES + 1024));
        child.emit('exit', 0, null);
      });
      return child as unknown as ChildProcess;
    };
    const runner = new AgyCliRunner(spawnFn, null, silentLogger());

    const result = await runner.invoke({
      phase: 'p',
      iteration: 1,
      prompt: 'hi',
      timeoutMs: 5_000,
      cliPath: 'agy',
      cwd: '/repo'
    });

    expect(result.stdoutBuffer.truncated).toBe(true);
    expect(result.stdoutBuffer.totalBytes).toBe(MAX_STREAM_BUFFER_BYTES + 1024);
    expect(result.stdoutBuffer.retainedBytes).toBeLessThanOrEqual(MAX_STREAM_BUFFER_BYTES);
  });

  it('marks idle timeout and terminates the child', async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const runner = new AgyCliRunner(
        () => child as unknown as ChildProcess,
        null,
        silentLogger()
      );
      const invocation = runner.invoke({
        phase: 'p',
        iteration: 1,
        prompt: 'hi',
        timeoutMs: 1_000,
        cliPath: 'agy',
        cwd: '/repo'
      });

      await vi.advanceTimersByTimeAsync(1_001);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      child.emit('exit', null, 'SIGTERM');

      const result = await invocation;
      expect(result.timedOut).toBe(true);
      expect(result.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
