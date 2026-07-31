import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import type { ChildProcess } from 'child_process';
import {
  ClaudeCliRunner,
  type SpawnFn
} from '../../../src/runner/claude-cli';

/**
 * Feature 032 — T011: defense-in-depth assertions on the argv-append
 * gate condition. The gate MUST be strict `=== true` (not a truthy
 * check) so non-boolean values that happen to coerce to true do NOT
 * trigger the append. The append is idempotent: a single invocation
 * appends `-c` at most once.
 */

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable | null;
  killed: boolean;
  kill(signal: NodeJS.Signals | number): boolean;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({ read() { /* no-op */ } });
  child.stderr = new Readable({ read() { /* no-op */ } });
  child.stdin = null;
  child.killed = false;
  child.kill = vi.fn((_sig?: NodeJS.Signals | number) => {
    child.killed = true;
    return true;
  });
  return child;
}

interface SpawnCapture {
  args: ReadonlyArray<string>;
}

function captureSpawn(child: FakeChild, capture: SpawnCapture): SpawnFn {
  return (_command, args) => {
    capture.args = args;
    setImmediate(() => child.emit('exit', 0, null));
    return child as unknown as ChildProcess;
  };
}



describe('ClaudeCliRunner -c append gate (feature 032)', () => {
  it('appends -c exactly once when isContinue is true', async () => {
    const child = makeFakeChild();
    const seen: SpawnCapture = { args: [] };
    const runner = new ClaudeCliRunner(captureSpawn(child, seen));
    await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'p',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo',
      isContinue: true
    });
    const cCount = seen.args.filter((a) => a === '-c').length;
    expect(cCount).toBe(1);
  });

  it('does NOT append --continue long-form (canonical short form only)', async () => {
    const child = makeFakeChild();
    const seen: SpawnCapture = { args: [] };
    const runner = new ClaudeCliRunner(captureSpawn(child, seen));
    await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'p',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo',
      isContinue: true
    });
    expect(seen.args).not.toContain('--continue');
  });

  it('does NOT append -c when isContinue is undefined', async () => {
    const child = makeFakeChild();
    const seen: SpawnCapture = { args: [] };
    const runner = new ClaudeCliRunner(captureSpawn(child, seen));
    await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'p',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo'
    });
    expect(seen.args).not.toContain('-c');
  });

  it('does NOT append -c when isContinue is false', async () => {
    const child = makeFakeChild();
    const seen: SpawnCapture = { args: [] };
    const runner = new ClaudeCliRunner(captureSpawn(child, seen));
    await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'p',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo',
      isContinue: false
    });
    expect(seen.args).not.toContain('-c');
  });

  it('does NOT append -c when isContinue is a truthy non-boolean (strict === true gate)', async () => {
    const child = makeFakeChild();
    const seen: SpawnCapture = { args: [] };
    const runner = new ClaudeCliRunner(captureSpawn(child, seen));
    await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'p',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo',
      // @ts-expect-error — intentional misuse to verify strict === true gate.
      isContinue: 1
    });
    expect(seen.args).not.toContain('-c');
  });

  it('preserves the --dangerously-skip-permissions + -c prefix shape across transports (p-flag baseline)', async () => {
    const child = makeFakeChild();
    const seen: SpawnCapture = { args: [] };
    const runner = new ClaudeCliRunner(captureSpawn(child, seen));
    await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'p',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo',
      isContinue: true
    });
    // The prefix MUST be these two flags in this order.
    expect(seen.args[0]).toBe('--dangerously-skip-permissions');
    expect(seen.args[1]).toBe('-c');
  });
});

/**
 * Feature 032 — interaction with --model / --effort / verbose-diagnostics
 * flags. The append point for `-c` is BEFORE any of those tail args; the
 * tail args themselves stay unaffected.
 */
describe('ClaudeCliRunner -c interaction with tail args (feature 032)', () => {
  it('preserves --model and --effort positions when isContinue=true', async () => {
    const child = makeFakeChild();
    const seen: SpawnCapture = { args: [] };
    const runner = new ClaudeCliRunner(captureSpawn(child, seen));
    await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'p',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      isContinue: true
    });
    expect(seen.args).toEqual([
      '--dangerously-skip-permissions',
      '-c',
      '-p',
      '--model',
      'claude-sonnet-4-6',
      '--effort',
      'medium',
      '--output-format',
      'stream-json',
      '--verbose'
    ]);
  });
});
