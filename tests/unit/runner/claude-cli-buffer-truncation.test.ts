import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import type { ChildProcess } from 'child_process';
import { ClaudeCliRunner, type SpawnFn } from '../../../src/runner/claude-cli';

const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  killed: boolean;
  kill(signal: NodeJS.Signals | number): boolean;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({
    read() {
      /* no-op */
    }
  });
  child.stderr = new Readable({
    read() {
      /* no-op */
    }
  });
  child.killed = false;
  child.kill = vi.fn((_sig?: NodeJS.Signals | number) => {
    child.killed = true;
    return true;
  });
  return child;
}

describe('ClaudeCliRunner.invoke — buffer truncation flags (Feature 042)', () => {
  it('sets stdoutTruncated=true when stdout exceeds MAX_BUFFER_BYTES', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      setImmediate(() => {
        // Emit (MAX_BUFFER_BYTES + 1) bytes on stdout. Use a single
        // large ASCII chunk; the byte counter is updated via
        // Buffer.byteLength so the size and the string length match.
        child.stdout.emit('data', 'a'.repeat(MAX_BUFFER_BYTES + 1));
        child.emit('exit', 0, null);
      });
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

    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
  });

  it('sets stdoutTruncated=false when stdout fits inside cap', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      setImmediate(() => {
        child.stdout.emit('data', 'small chunk\n');
        child.emit('exit', 0, null);
      });
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

    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
  });

  it('sets stderrTruncated=true when stderr exceeds MAX_BUFFER_BYTES', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      setImmediate(() => {
        child.stderr.emit('data', 'b'.repeat(MAX_BUFFER_BYTES + 1));
        child.emit('exit', 1, null);
      });
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

    expect(result.stderrTruncated).toBe(true);
    expect(result.stdoutTruncated).toBe(false);
  });

  it('preserves captured prefix up to the cap; discarded bytes do not appear in stdout', async () => {
    const child = makeFakeChild();
    const prefix = 'kept-prefix-';
    const padding = 'a'.repeat(MAX_BUFFER_BYTES - prefix.length); // exactly fills cap
    const overflow = 'OVERFLOW-DROPPED';
    const spawnFn: SpawnFn = () => {
      setImmediate(() => {
        child.stdout.emit('data', prefix + padding);
        child.stdout.emit('data', overflow);
        child.emit('exit', 0, null);
      });
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

    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.startsWith(prefix)).toBe(true);
    expect(result.stdout.includes(overflow)).toBe(false);
  });

  it('returns both truncation flags on the timeout path', async () => {
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
    child.emit('exit', null, 'SIGTERM');

    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
    vi.useRealTimers();
  });
});
