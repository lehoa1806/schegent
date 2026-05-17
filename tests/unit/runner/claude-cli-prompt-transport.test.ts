// Feature 013 Wave 8 (US8 / T113): prompt-transport detection tests.
//
// Asserts that when `claude --help` advertises a safer transport, the
// runner uses it (no prompt body in argv); when it does not, the
// runner falls back to the legacy `-p <prompt>` argv form.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import type { ChildProcess, SpawnOptions } from 'child_process';
import * as fs from 'fs/promises';
import {
  ClaudeCliRunner,
  type SpawnFn,
  type TransportFallbackReason,
  detectPromptTransport,
  _resetPromptTransportCacheForTests
} from '../../../src/runner/claude-cli';
import { SanitizedLogger } from '../../../src/lib/logger';

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  killed: boolean;
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({ read() { /* no-op */ } });
  child.stderr = new Readable({ read() { /* no-op */ } });
  const writes: string[] = [];
  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      writes.push(chunk.toString());
      cb();
    },
    final(cb) { cb(); }
  });
  (child.stdin as Writable & { _written: string[] })._written = writes;
  child.killed = false;
  child.kill = vi.fn((_sig?: NodeJS.Signals | number) => {
    child.killed = true;
    return true;
  });
  return child;
}

beforeEach(() => {
  _resetPromptTransportCacheForTests();
});

describe('detectPromptTransport (T110)', () => {
  it('returns prompt-file when --help advertises --prompt-file', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = (_command, args) => {
      setImmediate(() => {
        expect(args).toEqual(['--help']);
        child.stdout.emit('data', 'Usage:\n  --prompt-file <file>   Read prompt from a file\n');
        child.emit('exit', 0, null);
      });
      return child as unknown as ChildProcess;
    };
    const transport = await detectPromptTransport('claude', spawnFn);
    expect(transport).toBe('prompt-file');
  });

  it('returns stdin when --help advertises --prompt-stdin', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      setImmediate(() => {
        child.stdout.emit('data', 'Usage:\n  --prompt-stdin   Read prompt from stdin\n');
        child.emit('exit', 0, null);
      });
      return child as unknown as ChildProcess;
    };
    const transport = await detectPromptTransport('claude', spawnFn);
    expect(transport).toBe('stdin');
  });

  it('returns p-flag when --help shows no transport markers', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      setImmediate(() => {
        child.stdout.emit('data', 'Usage:\n  -p <prompt>   Prompt text\n');
        child.emit('exit', 0, null);
      });
      return child as unknown as ChildProcess;
    };
    const transport = await detectPromptTransport('claude', spawnFn);
    expect(transport).toBe('p-flag');
  });

  it('returns p-flag when the help spawn errors', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      setImmediate(() => child.emit('error', new Error('ENOENT')));
      return child as unknown as ChildProcess;
    };
    const transport = await detectPromptTransport('claude', spawnFn);
    expect(transport).toBe('p-flag');
  });

  it('caches the detected transport per cliPath', async () => {
    const child = makeFakeChild();
    let probeCalls = 0;
    const spawnFn: SpawnFn = () => {
      probeCalls++;
      setImmediate(() => {
        child.stdout.emit('data', '--prompt-file\n');
        child.emit('exit', 0, null);
      });
      return child as unknown as ChildProcess;
    };
    await detectPromptTransport('claude', spawnFn);
    await detectPromptTransport('claude', spawnFn);
    expect(probeCalls).toBe(1);
  });
});

describe('ClaudeCliRunner with probeTransport (T111)', () => {
  it('uses --prompt-file when the probe detects it', async () => {
    let probeCalled = false;
    let invokeArgs: ReadonlyArray<string> = [];
    let invokeStdio: SpawnOptions['stdio'] | undefined;
    const probeChild = makeFakeChild();
    const invokeChild = makeFakeChild();
    const spawnFn: SpawnFn = (_command, args, options) => {
      if (!probeCalled) {
        probeCalled = true;
        setImmediate(() => {
          probeChild.stdout.emit('data', '--prompt-file <file>\n');
          probeChild.emit('exit', 0, null);
        });
        return probeChild as unknown as ChildProcess;
      }
      invokeArgs = args;
      invokeStdio = options.stdio;
      setImmediate(() => invokeChild.emit('exit', 0, null));
      return invokeChild as unknown as ChildProcess;
    };

    const runner = new ClaudeCliRunner(spawnFn, null, { probeTransport: true });
    await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'secret prompt body',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo'
    });

    expect(invokeArgs).toContain('--prompt-file');
    expect(invokeArgs).not.toContain('-p');
    expect(invokeArgs).not.toContain('secret prompt body');
    const pathIdx = invokeArgs.indexOf('--prompt-file') + 1;
    expect(invokeArgs[pathIdx]).toMatch(/schegent-prompt-.*\.txt$/);
    expect(invokeStdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('writes prompt to a 0600-perm temp file and removes it after exit', async () => {
    let probeCalled = false;
    let capturedTempPath = '';
    const probeChild = makeFakeChild();
    const invokeChild = makeFakeChild();
    const spawnFn: SpawnFn = (_command, args) => {
      if (!probeCalled) {
        probeCalled = true;
        setImmediate(() => {
          probeChild.stdout.emit('data', '--prompt-file\n');
          probeChild.emit('exit', 0, null);
        });
        return probeChild as unknown as ChildProcess;
      }
      const idx = args.indexOf('--prompt-file');
      capturedTempPath = args[idx + 1];
      setImmediate(async () => {
        const contents = await fs.readFile(capturedTempPath, 'utf8');
        expect(contents).toBe('hello world');
        invokeChild.emit('exit', 0, null);
      });
      return invokeChild as unknown as ChildProcess;
    };

    const runner = new ClaudeCliRunner(spawnFn, null, { probeTransport: true });
    await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'hello world',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo'
    });

    // After invoke resolves, the temp file should be unlinked.
    await expect(fs.stat(capturedTempPath)).rejects.toThrow();
  });

  it('uses --prompt-stdin transport and pipes prompt over stdin', async () => {
    let probeCalled = false;
    let invokeArgs: ReadonlyArray<string> = [];
    let invokeStdio: SpawnOptions['stdio'] | undefined;
    const probeChild = makeFakeChild();
    const invokeChild = makeFakeChild();
    const spawnFn: SpawnFn = (_command, args, options) => {
      if (!probeCalled) {
        probeCalled = true;
        setImmediate(() => {
          probeChild.stdout.emit('data', '--prompt-stdin\n');
          probeChild.emit('exit', 0, null);
        });
        return probeChild as unknown as ChildProcess;
      }
      invokeArgs = args;
      invokeStdio = options.stdio;
      setImmediate(() => invokeChild.emit('exit', 0, null));
      return invokeChild as unknown as ChildProcess;
    };

    const runner = new ClaudeCliRunner(spawnFn, null, { probeTransport: true });
    await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'pipe me',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo'
    });

    expect(invokeArgs).toContain('--prompt-stdin');
    expect(invokeArgs).not.toContain('-p');
    expect(invokeArgs).not.toContain('pipe me');
    expect(invokeStdio).toEqual(['pipe', 'pipe', 'pipe']);
    const writes = (invokeChild.stdin as Writable & { _written?: string[] })._written;
    expect(writes).toEqual(['pipe me']);
  });

  it('falls back to -p when the probe finds no markers', async () => {
    let probeCalled = false;
    let invokeArgs: ReadonlyArray<string> = [];
    const probeChild = makeFakeChild();
    const invokeChild = makeFakeChild();
    const spawnFn: SpawnFn = (_command, args) => {
      if (!probeCalled) {
        probeCalled = true;
        setImmediate(() => {
          probeChild.stdout.emit('data', 'Usage info, no prompt-file or stdin markers\n');
          probeChild.emit('exit', 0, null);
        });
        return probeChild as unknown as ChildProcess;
      }
      invokeArgs = args;
      setImmediate(() => invokeChild.emit('exit', 0, null));
      return invokeChild as unknown as ChildProcess;
    };

    const runner = new ClaudeCliRunner(spawnFn, null, { probeTransport: true });
    await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'legacy',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo'
    });

    expect(invokeArgs.slice(0, 3)).toEqual(['--dangerously-skip-permissions', '-p', 'legacy']);
  });

  it('shell: false is preserved on every transport (T112)', async () => {
    let probeCalled = false;
    let invokeOpts: SpawnOptions | undefined;
    const probeChild = makeFakeChild();
    const invokeChild = makeFakeChild();
    const spawnFn: SpawnFn = (_command, _args, options) => {
      if (!probeCalled) {
        probeCalled = true;
        setImmediate(() => {
          probeChild.stdout.emit('data', '--prompt-file\n');
          probeChild.emit('exit', 0, null);
        });
        return probeChild as unknown as ChildProcess;
      }
      invokeOpts = options;
      setImmediate(() => invokeChild.emit('exit', 0, null));
      return invokeChild as unknown as ChildProcess;
    };

    const runner = new ClaudeCliRunner(spawnFn, null, { probeTransport: true });
    await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'p',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo'
    });

    expect(invokeOpts?.shell).toBe(false);
  });
});

describe('ClaudeCliRunner backward compatibility (default probeTransport=false)', () => {
  it('does not probe and uses -p when constructed without probeTransport option', async () => {
    let spawnCalls = 0;
    const child = makeFakeChild();
    const seen: { args: ReadonlyArray<string> } = { args: [] };
    const spawnFn: SpawnFn = (_command, args) => {
      spawnCalls++;
      seen.args = args;
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };

    const runner = new ClaudeCliRunner(spawnFn);
    await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'legacy',
      timeoutMs: 5_000,
      cliPath: 'claude',
      cwd: '/repo'
    });

    expect(spawnCalls).toBe(1);
    expect(seen.args.slice(0, 3)).toEqual(['--dangerously-skip-permissions', '-p', 'legacy']);
  });
});

// Feature 041 — observable transport-probe fallback. The runner emits
// exactly one `warn` per `cliPath` when `detectPromptTransport()`
// resolves to `'p-flag'` via either:
//   - probe-error: spawn errored OR probe timed out (Option α — throws)
//   - missing-markers: clean probe exit, neither marker found
// The legacy `-p <prompt>` path remains functional; the warn is
// observability-only.
describe('transport fallback observability (041)', () => {
  const WARN_MESSAGE_PREFIX =
    'claude-cli: prompt-transport fell back to argv -p; upgrading claude is recommended';

  interface WarnCall {
    message: string;
    context?: Record<string, unknown>;
  }

  function makeWarnSpy() {
    const calls: WarnCall[] = [];
    const logger = new SanitizedLogger();
    const spy = vi.fn((message: string, context?: Record<string, unknown>) => {
      calls.push({ message, context });
    });
    logger.warn = spy as unknown as SanitizedLogger['warn'];
    return { logger, calls, spy };
  }

  // T005 — warns exactly once when --help is missing both markers.
  it('warns exactly once when --help is missing both markers', async () => {
    const { logger, calls, spy } = makeWarnSpy();
    let probeCalled = false;
    const probeChild = makeFakeChild();
    const invokeChild = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      if (!probeCalled) {
        probeCalled = true;
        setImmediate(() => {
          probeChild.stdout.emit('data', 'Usage info, no markers here\n');
          probeChild.emit('exit', 0, null);
        });
        return probeChild as unknown as ChildProcess;
      }
      setImmediate(() => invokeChild.emit('exit', 0, null));
      return invokeChild as unknown as ChildProcess;
    };

    const runner = new ClaudeCliRunner(spawnFn, null, { probeTransport: true }, logger);
    await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'irrelevant',
      timeoutMs: 5_000,
      cliPath: 'claude-legacy',
      cwd: '/repo'
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(calls[0].message).toBe(WARN_MESSAGE_PREFIX);
    expect(calls[0].context).toEqual({
      cliPath: 'claude-legacy',
      reason: 'missing-markers' satisfies TransportFallbackReason
    });
  });

  // T006 — does not re-warn on a second invoke with the same cliPath.
  it('does not re-warn on a second invoke with the same cliPath', async () => {
    const { logger, spy } = makeWarnSpy();
    let invokeIdx = 0;
    const probeChild = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      if (invokeIdx === 0) {
        invokeIdx++;
        setImmediate(() => {
          probeChild.stdout.emit('data', 'No markers\n');
          probeChild.emit('exit', 0, null);
        });
        return probeChild as unknown as ChildProcess;
      }
      const c = makeFakeChild();
      setImmediate(() => c.emit('exit', 0, null));
      return c as unknown as ChildProcess;
    };

    const runner = new ClaudeCliRunner(spawnFn, null, { probeTransport: true }, logger);
    const opts = {
      phase: 'speckit-specify' as const,
      iteration: 1,
      prompt: 'p',
      timeoutMs: 5_000,
      cliPath: 'claude-legacy',
      cwd: '/repo'
    };
    await runner.invoke(opts);
    await runner.invoke(opts);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  // T007 — warns with reason 'probe-error' when the probe spawn errors.
  it("warns with reason 'probe-error' when the probe spawn errors", async () => {
    const { logger, calls, spy } = makeWarnSpy();
    let probeCalled = false;
    const probeChild = makeFakeChild();
    const invokeChild = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      if (!probeCalled) {
        probeCalled = true;
        setImmediate(() => probeChild.emit('error', new Error('ENOENT')));
        return probeChild as unknown as ChildProcess;
      }
      setImmediate(() => invokeChild.emit('exit', 0, null));
      return invokeChild as unknown as ChildProcess;
    };

    const runner = new ClaudeCliRunner(spawnFn, null, { probeTransport: true }, logger);
    await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'p',
      timeoutMs: 5_000,
      cliPath: 'claude-missing',
      cwd: '/repo'
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(calls[0].context).toEqual({
      cliPath: 'claude-missing',
      reason: 'probe-error' satisfies TransportFallbackReason
    });
  });

  // T008 — warns with reason 'probe-error' when the probe times out.
  // Implementation chose Option α: runHelpProbe throws on timeout, the
  // catch block in detectPromptTransport routes to 'probe-error'.
  it("warns with reason 'probe-error' when the probe times out", async () => {
    vi.useFakeTimers();
    const { logger, calls, spy } = makeWarnSpy();
    let probeCalled = false;
    const probeChild = makeFakeChild();
    const invokeChild = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      if (!probeCalled) {
        probeCalled = true;
        // Probe never emits exit / error — only exits when killed.
        // makeFakeChild's kill() flips child.killed but does not emit
        // exit. We simulate the kill flow: when kill is called, emit
        // exit synchronously so the await Promise resolves and the
        // timeout-throw path runs.
        const origKill = probeChild.kill;
        probeChild.kill = vi.fn((sig?: NodeJS.Signals | number) => {
          const r = origKill.call(probeChild, sig);
          setImmediate(() => probeChild.emit('exit', null, 'SIGTERM'));
          return r;
        });
        return probeChild as unknown as ChildProcess;
      }
      setImmediate(() => invokeChild.emit('exit', 0, null));
      return invokeChild as unknown as ChildProcess;
    };

    const runner = new ClaudeCliRunner(spawnFn, null, { probeTransport: true }, logger);
    const invokePromise = runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'p',
      timeoutMs: 60_000,
      cliPath: 'claude-frozen',
      cwd: '/repo'
    });

    // Advance past PROBE_TIMEOUT_MS (5_000) to fire the timeout.
    await vi.advanceTimersByTimeAsync(6_000);
    // Let the second spawn (invoke) finish.
    await vi.advanceTimersByTimeAsync(10);
    vi.useRealTimers();
    await invokePromise;

    expect(spy).toHaveBeenCalledTimes(1);
    expect(calls[0].context).toEqual({
      cliPath: 'claude-frozen',
      reason: 'probe-error' satisfies TransportFallbackReason
    });
  });

  // T009 — warns once per cliPath across two runner instances with the
  // same logger (cliPath-keyed module-level Set, not instance-keyed).
  it('warns once per cliPath across two runner instances with the same logger', async () => {
    const { logger, spy } = makeWarnSpy();
    let spawnIdx = 0;
    const spawnFn: SpawnFn = () => {
      const c = makeFakeChild();
      if (spawnIdx % 2 === 0) {
        // probe
        setImmediate(() => {
          c.stdout.emit('data', 'no markers\n');
          c.emit('exit', 0, null);
        });
      } else {
        setImmediate(() => c.emit('exit', 0, null));
      }
      spawnIdx++;
      return c as unknown as ChildProcess;
    };

    const opts = {
      phase: 'speckit-specify' as const,
      iteration: 1,
      prompt: 'p',
      timeoutMs: 5_000,
      cliPath: 'claude-shared',
      cwd: '/repo'
    };
    const runnerA = new ClaudeCliRunner(spawnFn, null, { probeTransport: true }, logger);
    const runnerB = new ClaudeCliRunner(spawnFn, null, { probeTransport: true }, logger);
    await runnerA.invoke(opts);
    await runnerB.invoke(opts);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  // T010 — swallows logger throws (runner.invoke resolves normally).
  it('swallows logger throws', async () => {
    const logger = new SanitizedLogger();
    logger.warn = vi.fn(() => {
      throw new Error('logger blew up');
    }) as unknown as SanitizedLogger['warn'];

    let probeCalled = false;
    const probeChild = makeFakeChild();
    const invokeChild = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      if (!probeCalled) {
        probeCalled = true;
        setImmediate(() => {
          probeChild.stdout.emit('data', 'no markers\n');
          probeChild.emit('exit', 0, null);
        });
        return probeChild as unknown as ChildProcess;
      }
      setImmediate(() => invokeChild.emit('exit', 0, null));
      return invokeChild as unknown as ChildProcess;
    };

    const runner = new ClaudeCliRunner(spawnFn, null, { probeTransport: true }, logger);
    await expect(
      runner.invoke({
        phase: 'speckit-specify',
        iteration: 1,
        prompt: 'p',
        timeoutMs: 5_000,
        cliPath: 'claude-throwy',
        cwd: '/repo'
      })
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  // T011 — does not warn when probeTransport is false (operator opt-out,
  // not a detection-driven fallback).
  it('does not warn when probeTransport is false', async () => {
    const { logger, spy } = makeWarnSpy();
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      setImmediate(() => child.emit('exit', 0, null));
      return child as unknown as ChildProcess;
    };

    const runner = new ClaudeCliRunner(spawnFn, null, {}, logger);
    await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'p',
      timeoutMs: 5_000,
      cliPath: 'claude-optout',
      cwd: '/repo'
    });

    expect(spy).not.toHaveBeenCalled();
  });

  // T019 — does not warn when --help advertises --prompt-file.
  it('does not warn when --help advertises --prompt-file', async () => {
    const { logger, spy } = makeWarnSpy();
    let probeCalled = false;
    const probeChild = makeFakeChild();
    const invokeChild = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      if (!probeCalled) {
        probeCalled = true;
        setImmediate(() => {
          probeChild.stdout.emit('data', 'Usage:\n  --prompt-file <file>\n');
          probeChild.emit('exit', 0, null);
        });
        return probeChild as unknown as ChildProcess;
      }
      setImmediate(() => invokeChild.emit('exit', 0, null));
      return invokeChild as unknown as ChildProcess;
    };

    const opts = {
      phase: 'speckit-specify' as const,
      iteration: 1,
      prompt: 'p',
      timeoutMs: 5_000,
      cliPath: 'claude-current-file',
      cwd: '/repo'
    };
    const runner = new ClaudeCliRunner(spawnFn, null, { probeTransport: true }, logger);
    await runner.invoke(opts);
    await runner.invoke(opts);

    expect(spy).not.toHaveBeenCalled();
  });

  // T020 — does not warn when --help advertises --prompt-stdin.
  it('does not warn when --help advertises --prompt-stdin', async () => {
    const { logger, spy } = makeWarnSpy();
    let probeCalled = false;
    const probeChild = makeFakeChild();
    const invokeChild = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      if (!probeCalled) {
        probeCalled = true;
        setImmediate(() => {
          probeChild.stdout.emit('data', 'Usage:\n  --prompt-stdin\n');
          probeChild.emit('exit', 0, null);
        });
        return probeChild as unknown as ChildProcess;
      }
      setImmediate(() => invokeChild.emit('exit', 0, null));
      return invokeChild as unknown as ChildProcess;
    };

    const runner = new ClaudeCliRunner(spawnFn, null, { probeTransport: true }, logger);
    await runner.invoke({
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'p',
      timeoutMs: 5_000,
      cliPath: 'claude-current-stdin',
      cwd: '/repo'
    });

    expect(spy).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
