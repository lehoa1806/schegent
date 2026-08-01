import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import type { ChildProcess } from 'child_process';
import { ClaudeCliRunner, type SpawnFn, type MonitorSidecarEvent } from '../../../src/runner/claude-cli';

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  killed: boolean;
  pid: number;
  kill: (signal: NodeJS.Signals | number) => boolean;
}

function makeFakeChild(pid = 4242): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({ read() { /* no-op */ } });
  child.stderr = new Readable({ read() { /* no-op */ } });
  child.killed = false;
  child.pid = pid;
  child.kill = vi.fn((_sig?: NodeJS.Signals | number) => {
    child.killed = true;
    return true;
  });
  return child;
}

describe('runner monitor sidecar hook', () => {
  it('emits started exactly once with pid at spawn', async () => {
    const child = makeFakeChild(7777);
    const events: MonitorSidecarEvent[] = [];
    const spawnFn: SpawnFn = () => {
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn, (e) => events.push(e));
    await runner.invoke({
      phase: 'speckit-specify', iteration: 1, prompt: 'p', timeoutMs: 5_000, cliPath: 'claude', cwd: '/repo'
    });
    const startedEvents = events.filter((e) => e.kind === 'started');
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0]).toMatchObject({ kind: 'started', pid: 7777 });
  });

  it('emits stdout-chunk and stderr-chunk for every chunk in arrival order', async () => {
    const child = makeFakeChild();
    const events: MonitorSidecarEvent[] = [];
    const spawnFn: SpawnFn = () => {
      setImmediate(() => {
        child.stdout.emit('data', 'a\n');
        child.stderr.emit('data', 'err1\n');
        child.stdout.emit('data', 'b\n');
        child.emit('exit', 0, null);
      });
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn, (e) => events.push(e));
    await runner.invoke({
      phase: 'speckit-specify', iteration: 1, prompt: 'p', timeoutMs: 5_000, cliPath: 'claude', cwd: '/repo'
    });
    const chunkEvents = events.filter((e) => e.kind === 'stdout-chunk' || e.kind === 'stderr-chunk');
    expect(chunkEvents.map((e) => e.kind)).toEqual(['stdout-chunk', 'stderr-chunk', 'stdout-chunk']);
    expect((chunkEvents[0] as { kind: 'stdout-chunk'; chunk: string }).chunk).toBe('a\n');
    expect((chunkEvents[1] as { kind: 'stderr-chunk'; chunk: string }).chunk).toBe('err1\n');
    expect((chunkEvents[2] as { kind: 'stdout-chunk'; chunk: string }).chunk).toBe('b\n');
  });

  it('emits exited exactly once at exit', async () => {
    const child = makeFakeChild();
    const events: MonitorSidecarEvent[] = [];
    const spawnFn: SpawnFn = () => {
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn, (e) => events.push(e));
    await runner.invoke({
      phase: 'speckit-specify', iteration: 1, prompt: 'p', timeoutMs: 5_000, cliPath: 'claude', cwd: '/repo'
    });
    const exitedEvents = events.filter((e) => e.kind === 'exited');
    expect(exitedEvents).toHaveLength(1);
    expect((exitedEvents[0] as { kind: 'exited'; exitCode: number | null }).exitCode).toBe(0);
  });

  it('hook does not change RawInvocationOutput shape', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      setImmediate(() => {
        child.stdout.emit('data', 'hi\n');
        child.emit('exit', 0, null);
      });
      return child as unknown as ChildProcess;
    };
    const noHook = new ClaudeCliRunner(spawnFn);
    const child2 = makeFakeChild();
    const spawnFn2: SpawnFn = () => {
      setImmediate(() => {
        child2.stdout.emit('data', 'hi\n');
        child2.emit('exit', 0, null);
      });
      return child2 as unknown as ChildProcess;
    };
    const withHook = new ClaudeCliRunner(spawnFn2, () => { /* noop */ });
    const a = await noHook.invoke({
      phase: 'speckit-specify', iteration: 1, prompt: 'p', timeoutMs: 5_000, cliPath: 'claude', cwd: '/repo'
    });
    const b = await withHook.invoke({
      phase: 'speckit-specify', iteration: 1, prompt: 'p', timeoutMs: 5_000, cliPath: 'claude', cwd: '/repo'
    });
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(Array.from(a.stdoutBuffer.decompressStream()).join('')).toBe(Array.from(b.stdoutBuffer.decompressStream()).join(''));
    expect(a.exitCode).toBe(b.exitCode);
    expect(a.killed).toBe(b.killed);
    expect(a.timedOut).toBe(b.timedOut);
  });

  it('hook errors do NOT propagate to runner', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      setImmediate(() => {
        child.stdout.emit('data', 'hi\n');
        child.emit('exit', 0, null);
      });
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn, () => {
      throw new Error('hook boom');
    });
    const result = await runner.invoke({
      phase: 'speckit-specify', iteration: 1, prompt: 'p', timeoutMs: 5_000, cliPath: 'claude', cwd: '/repo'
    });
    expect(result.exitCode).toBe(0);
  });
});
