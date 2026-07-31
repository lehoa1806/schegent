import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import type { ChildProcess, SpawnOptions } from 'child_process';
import {
  ClaudeCliRunner,
  type SpawnFn
} from '../../src/runner/claude-cli';

/**
 * Feature 032 — argv composition contract tests.
 */

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  killed: boolean;
  kill(signal: NodeJS.Signals | number): boolean;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({ read() { /* no-op */ } });
  child.stderr = new Readable({ read() { /* no-op */ } });
  child.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  child.killed = false;
  child.kill = vi.fn((_sig?: NodeJS.Signals | number) => {
    child.killed = true;
    return true;
  });
  return child;
}

interface SpawnCapture {
  command: string;
  args: ReadonlyArray<string>;
  options: SpawnOptions;
}

function captureSpawn(child: FakeChild, capture: SpawnCapture): SpawnFn {
  return (command, args, options) => {
    capture.command = command;
    capture.args = args;
    capture.options = options;
    setImmediate(() => child.emit('exit', 0, null));
    return child as unknown as ChildProcess;
  };
}

describe('continue-flag argv composition: natively via stdin', () => {
  it('argv is exactly [--dangerously-skip-permissions, -c, -p, --output-format, stream-json, --verbose] when isContinue is true', async () => {
    const child = makeFakeChild();
    const seen: SpawnCapture = { command: '', args: [], options: {} };
    const runner = new ClaudeCliRunner(captureSpawn(child, seen));
    await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'do work',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo',
      isContinue: true
    });
    expect(seen.args).toEqual([
      '--dangerously-skip-permissions',
      '-c',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose'
    ]);
  });

  it('argv has NO -c when isContinue is false', async () => {
    const child = makeFakeChild();
    const seen: SpawnCapture = { command: '', args: [], options: {} };
    const runner = new ClaudeCliRunner(captureSpawn(child, seen));
    await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'do work',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo',
      isContinue: false
    });
    expect(seen.args).toEqual([
      '--dangerously-skip-permissions',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose'
    ]);
    expect(seen.args).not.toContain('-c');
  });

  it('argv has NO -c when isContinue is omitted (backwards-compat)', async () => {
    const child = makeFakeChild();
    const seen: SpawnCapture = { command: '', args: [], options: {} };
    const runner = new ClaudeCliRunner(captureSpawn(child, seen));
    await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'do work',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo'
    });
    expect(seen.args).toEqual([
      '--dangerously-skip-permissions',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose'
    ]);
    expect(seen.args).not.toContain('-c');
  });
});

describe('continue-flag argv composition: restart-equivalent (isContinue=false)', () => {
  it('restart-equivalent argv has NO -c', async () => {
    const child = makeFakeChild();
    const seen: SpawnCapture = { command: '', args: [], options: {} };
    const runner = new ClaudeCliRunner(captureSpawn(child, seen));
    await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'restart-prompt',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo',
      isContinue: false
    });
    expect(seen.args).not.toContain('-c');
    expect(seen.args).not.toContain('--continue');
    expect(seen.args[0]).toBe('--dangerously-skip-permissions');
    expect(seen.args[1]).toBe('-p');
  });
});

describe('continue-flag argv composition: resumeSessionId', () => {
  it('argv uses --resume <id> when isContinue is true AND resumeSessionId is set', async () => {
    const child = makeFakeChild();
    const seen: SpawnCapture = { command: '', args: [], options: {} };
    const runner = new ClaudeCliRunner(captureSpawn(child, seen));
    await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'retry prompt',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo',
      isContinue: true,
      resumeSessionId: 'sess-abc-123'
    });
    expect(seen.args).toEqual([
      '--dangerously-skip-permissions',
      '--resume',
      'sess-abc-123',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose'
    ]);
    expect(seen.args).not.toContain('-c');
  });

  it('argv falls back to -c when isContinue is true but resumeSessionId is undefined', async () => {
    const child = makeFakeChild();
    const seen: SpawnCapture = { command: '', args: [], options: {} };
    const runner = new ClaudeCliRunner(captureSpawn(child, seen));
    await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'retry prompt',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo',
      isContinue: true
    });
    expect(seen.args).toEqual([
      '--dangerously-skip-permissions',
      '-c',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose'
    ]);
    expect(seen.args).not.toContain('--resume');
  });

  it('argv has NO --resume or -c when isContinue is false even with resumeSessionId', async () => {
    const child = makeFakeChild();
    const seen: SpawnCapture = { command: '', args: [], options: {} };
    const runner = new ClaudeCliRunner(captureSpawn(child, seen));
    await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'fresh prompt',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo',
      isContinue: false,
      resumeSessionId: 'sess-should-not-appear'
    });
    expect(seen.args).toEqual([
      '--dangerously-skip-permissions',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose'
    ]);
    expect(seen.args).not.toContain('-c');
    expect(seen.args).not.toContain('--resume');
  });
});
