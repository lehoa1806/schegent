import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import type { ChildProcess, SpawnOptions } from 'child_process';
import {
  ClaudeCliRunner,
  type SpawnFn,
  _resetPromptTransportCacheForTests,
  detectPromptTransport
} from '../../src/runner/claude-cli';

/**
 * Feature 032 — argv composition contract tests.
 *
 * Covers tasks T008 (p-flag), T009 (prompt-file), T010 (stdin), and
 * T027 (negative case under restart-equivalent isContinue: false).
 *
 * Contract: when `InvocationRequest.isContinue === true`, the spawned
 * argv MUST be exactly
 *   ['--dangerously-skip-permissions', '-c', <transport-specific>, …]
 * with `-c` positioned immediately after `--dangerously-skip-permissions`
 * and immediately before the transport-specific flag. When `isContinue`
 * is `false`, `undefined`, or omitted, no `-c` element appears.
 */

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable | null;
  killed: boolean;
  kill(signal: NodeJS.Signals | number): boolean;
}

function makeFakeChild(withStdin = false): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({ read() { /* no-op */ } });
  child.stderr = new Readable({ read() { /* no-op */ } });
  child.stdin = withStdin
    ? new Writable({ write(_chunk, _enc, cb) { cb(); } })
    : null;
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

beforeEach(() => {
  _resetPromptTransportCacheForTests();
});

describe('continue-flag argv composition: transport=p-flag', () => {
  it('argv is exactly [--dangerously-skip-permissions, -c, -p, <prompt>] when isContinue is true', async () => {
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
      'do work'
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
      'do work'
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
      'do work'
    ]);
    expect(seen.args).not.toContain('-c');
  });
});

describe('continue-flag argv composition: transport=prompt-file', () => {
  it('argv positions -c between --dangerously-skip-permissions and --prompt-file when isContinue is true', async () => {
    // Probe the help output so the runner selects the prompt-file transport.
    const probeChild = makeFakeChild();
    const invokeChild = makeFakeChild();
    const seen: SpawnCapture = { command: '', args: [], options: {} };
    let isProbe = true;
    const spawnFn: SpawnFn = (command, args, options) => {
      if (isProbe) {
        isProbe = false;
        setImmediate(() => {
          probeChild.stdout.emit('data', '... --prompt-file <path> ...\n');
          probeChild.emit('exit', 0, null);
        });
        return probeChild as unknown as ChildProcess;
      }
      seen.command = command;
      seen.args = args;
      seen.options = options;
      setImmediate(() => invokeChild.emit('exit', 0, null));
      return invokeChild as unknown as ChildProcess;
    };
    const detected = await detectPromptTransport('claude', spawnFn);
    expect(detected).toBe('prompt-file');
    const runner = new ClaudeCliRunner(spawnFn, null, { probeTransport: true });
    await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'continuation prompt',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo',
      isContinue: true
    });
    expect(seen.args[0]).toBe('--dangerously-skip-permissions');
    expect(seen.args[1]).toBe('-c');
    expect(seen.args[2]).toBe('--prompt-file');
    expect(typeof seen.args[3]).toBe('string');
    // The fourth element is the temp-file path. It MUST exist and end
    // with `.txt` per the runner contract.
    expect(seen.args[3]).toMatch(/\.txt$/);
  });

  it('argv has NO -c on prompt-file transport when isContinue is false', async () => {
    const probeChild = makeFakeChild();
    const invokeChild = makeFakeChild();
    const seen: SpawnCapture = { command: '', args: [], options: {} };
    let isProbe = true;
    const spawnFn: SpawnFn = (command, args, options) => {
      if (isProbe) {
        isProbe = false;
        setImmediate(() => {
          probeChild.stdout.emit('data', '... --prompt-file <path> ...\n');
          probeChild.emit('exit', 0, null);
        });
        return probeChild as unknown as ChildProcess;
      }
      seen.command = command;
      seen.args = args;
      seen.options = options;
      setImmediate(() => invokeChild.emit('exit', 0, null));
      return invokeChild as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn, null, { probeTransport: true });
    await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'fresh prompt',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo'
    });
    expect(seen.args[0]).toBe('--dangerously-skip-permissions');
    expect(seen.args[1]).toBe('--prompt-file');
    expect(seen.args).not.toContain('-c');
  });
});

// Feature 032 — T027: restart-equivalent negative case. When an
// upstream controller (e.g. `WorkflowController.restartActivePhase`)
// dispatches with `isContinue: false`, no `-c` element appears in the
// argv across any transport. This is a direct runner-level invariant
// rather than a controller-side test (which lives in
// `tests/unit/controller/workflow-controller-continue-flag.test.ts`).
describe('continue-flag argv composition: restart-equivalent (isContinue=false)', () => {
  it('p-flag restart-equivalent argv has NO -c', async () => {
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

  it('prompt-file restart-equivalent argv has NO -c', async () => {
    const probeChild = makeFakeChild();
    const invokeChild = makeFakeChild();
    const seen: SpawnCapture = { command: '', args: [], options: {} };
    let isProbe = true;
    const spawnFn: SpawnFn = (command, args, options) => {
      if (isProbe) {
        isProbe = false;
        setImmediate(() => {
          probeChild.stdout.emit('data', '... --prompt-file <path> ...\n');
          probeChild.emit('exit', 0, null);
        });
        return probeChild as unknown as ChildProcess;
      }
      seen.command = command;
      seen.args = args;
      seen.options = options;
      setImmediate(() => invokeChild.emit('exit', 0, null));
      return invokeChild as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn, null, { probeTransport: true });
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
    expect(seen.args[1]).toBe('--prompt-file');
  });

  it('stdin restart-equivalent argv has NO -c', async () => {
    const probeChild = makeFakeChild();
    const invokeChild = makeFakeChild(true);
    const seen: SpawnCapture = { command: '', args: [], options: {} };
    let isProbe = true;
    const spawnFn: SpawnFn = (command, args, options) => {
      if (isProbe) {
        isProbe = false;
        setImmediate(() => {
          probeChild.stdout.emit('data', '... --prompt-stdin ...\n');
          probeChild.emit('exit', 0, null);
        });
        return probeChild as unknown as ChildProcess;
      }
      seen.command = command;
      seen.args = args;
      seen.options = options;
      setImmediate(() => invokeChild.emit('exit', 0, null));
      return invokeChild as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn, null, { probeTransport: true });
    await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'restart-prompt',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo',
      isContinue: false
    });
    expect(seen.args).toEqual([
      '--dangerously-skip-permissions',
      '--prompt-stdin'
    ]);
  });
});

describe('continue-flag argv composition: transport=stdin', () => {
  it('argv positions -c between --dangerously-skip-permissions and --prompt-stdin when isContinue is true', async () => {
    const probeChild = makeFakeChild();
    const invokeChild = makeFakeChild(true);
    const seen: SpawnCapture = { command: '', args: [], options: {} };
    let isProbe = true;
    const spawnFn: SpawnFn = (command, args, options) => {
      if (isProbe) {
        isProbe = false;
        setImmediate(() => {
          probeChild.stdout.emit('data', '... --prompt-stdin ...\n');
          probeChild.emit('exit', 0, null);
        });
        return probeChild as unknown as ChildProcess;
      }
      seen.command = command;
      seen.args = args;
      seen.options = options;
      setImmediate(() => invokeChild.emit('exit', 0, null));
      return invokeChild as unknown as ChildProcess;
    };
    const detected = await detectPromptTransport('claude', spawnFn);
    expect(detected).toBe('stdin');
    const runner = new ClaudeCliRunner(spawnFn, null, { probeTransport: true });
    await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'continuation prompt',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo',
      isContinue: true
    });
    expect(seen.args).toEqual([
      '--dangerously-skip-permissions',
      '-c',
      '--prompt-stdin'
    ]);
  });

  it('argv has NO -c on stdin transport when isContinue is false', async () => {
    const probeChild = makeFakeChild();
    const invokeChild = makeFakeChild(true);
    const seen: SpawnCapture = { command: '', args: [], options: {} };
    let isProbe = true;
    const spawnFn: SpawnFn = (command, args, options) => {
      if (isProbe) {
        isProbe = false;
        setImmediate(() => {
          probeChild.stdout.emit('data', '... --prompt-stdin ...\n');
          probeChild.emit('exit', 0, null);
        });
        return probeChild as unknown as ChildProcess;
      }
      seen.command = command;
      seen.args = args;
      seen.options = options;
      setImmediate(() => invokeChild.emit('exit', 0, null));
      return invokeChild as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn, null, { probeTransport: true });
    await runner.invoke({
      phase: 'speckit-implement',
      iteration: 1,
      prompt: 'fresh prompt',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo'
    });
    expect(seen.args).toEqual([
      '--dangerously-skip-permissions',
      '--prompt-stdin'
    ]);
    expect(seen.args).not.toContain('-c');
  });
});
