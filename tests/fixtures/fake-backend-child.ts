import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { vi } from 'vitest';

/**
 * FR-R4-F06 (FR-025 to FR-027; contract F, module table; T104) -- one scripted backend child for the
 * per-protocol lifecycle suites.
 *
 * WHAT IT IS. A `ChildProcess` double whose life is a script: chunks on stdout and stderr at stated
 * times, an optional exit and close, an optional failing stdin, and a `kill` that records what it
 * was sent and, if the script says the child dies on that signal, ends it. It starts NO process,
 * opens no pipe to the OS and reads no clock: every offset is milliseconds from `start()`, driven
 * by `vi.useFakeTimers()` (F7). A suite that uses it never sleeps.
 *
 * WHY ONE FIXTURE FOR THREE ADAPTERS. The three adapters differ in the protocol that ends an
 * invocation, not in what a child can do. Claude parses a terminal `result` line; Codex and Agy
 * complete on exit plus stdio close. One scripted child lets each suite express "the child printed
 * its terminal row and lingered" or "the last line has no newline" in the same words, and the case
 * table of contract F reads straight off the scripts.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never signals a real process group. A suite that runs the
 * termination ladder against it must also call `stubGroupSignals()`, because the ladder addresses
 * the child's group with `process.kill(-pid, ...)` and a fake pid is some real machine's pid. The
 * real-process boundary is covered elsewhere, with real children and bounded waits (F9).
 *
 * No value of any kind is generated here beyond the script's own text.
 */

/** One piece of output, `at` milliseconds after `start()`. */
export interface ScriptedChunk {
  readonly at: number;
  readonly chunk: string;
}

export interface FakeChildScript {
  readonly pid?: number;
  readonly stdout?: readonly ScriptedChunk[];
  readonly stderr?: readonly ScriptedChunk[];
  /** Milliseconds after `start()` that the child exits on its own. Absent: it lives until killed. */
  readonly exitAt?: number;
  readonly exitCode?: number;
  /** Milliseconds between `exit` and `close`. Default 0. */
  readonly closeAfterExitMs?: number;
  /**
   * When true, `exit` fires at `exitAt` and `close`/`end` never fire on their own, modeling a
   * descendant holding the inherited stdio pipes open until `waitForChildCompletion`'s close grace
   * expires and destroys the local streams.
   */
  readonly holdStdioOpenAfterExit?: boolean;
  /**
   * Simulates a failed spawn (`ENOENT`): `pid` is `undefined`, stdin writes fail with `EPIPE`, and
   * the child emits a process-level `'error'` event on start.
   */
  readonly spawnError?: { readonly code: string };
  /**
   * The signal that ends the child. Default `SIGTERM`, as most CLIs behave. `SIGKILL` makes a child
   * that ignores SIGTERM, so only the ladder's second rung reaps it. `'never'` makes one nothing
   * ends, for the cases about a bound.
   */
  readonly diesOn?: 'SIGTERM' | 'SIGKILL' | 'never';
  /** The prompt write fails with this errno, as it does when the child has closed its stdin. */
  readonly stdinFailure?: { readonly code: 'EPIPE' | 'ECONNRESET' };
}

export interface FakeBackendChild extends EventEmitter {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly stdin: Writable;
  pid: number;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
  /** Every signal `kill` was sent, in order. */
  readonly signalsReceived: string[];
  /** Every chunk written to stdin that was accepted. */
  readonly stdinWrites: string[];
  /** Begin the script. A spawn function calls it, so every offset is from the spawn. */
  start(): void;
}

const DEFAULT_PID = 424_242;

export function createFakeBackendChild(script: FakeChildScript = {}): FakeBackendChild {
  const child = new EventEmitter() as FakeBackendChild;
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdinWrites: string[] = [];
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      const failureCode = script.stdinFailure?.code ?? (script.spawnError ? 'EPIPE' : undefined);
      if (failureCode !== undefined) {
        callback(Object.assign(new Error(failureCode), { code: failureCode }));
        return;
      }
      stdinWrites.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      callback();
    }
  });

  const signalsReceived: string[] = [];
  let finished = false;
  let closed = false;

  const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (finished) return;
    finished = true;
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
    if (script.holdStdioOpenAfterExit === true && signal === null) return;
    setTimeout(() => {
      closed = true;
      stdout.emit('end');
      stderr.emit('end');
      child.emit('close', code, signal);
    }, script.closeAfterExitMs ?? 0);
  };

  Object.assign(child, {
    stdout,
    stderr,
    stdin,
    pid: script.spawnError !== undefined ? (undefined as unknown as number) : (script.pid ?? DEFAULT_PID),
    killed: false,
    exitCode: null,
    signalCode: null,
    signalsReceived,
    stdinWrites,
    kill: vi.fn((signal?: NodeJS.Signals | number) => {
      const name = typeof signal === 'string' ? signal : 'SIGTERM';
      signalsReceived.push(name);
      child.killed = true;
      const diesOn = script.diesOn ?? 'SIGTERM';
      // SIGKILL ends every child except one that "never" dies; SIGTERM only the ones that die on it.
      const ends =
        diesOn === 'never' ? false : name === 'SIGKILL' || (name === 'SIGTERM' && diesOn === 'SIGTERM');
      if (ends) setTimeout(() => finish(null, name as NodeJS.Signals), 0);
      return true;
    }),
    start: () => {
      if (script.spawnError !== undefined) {
        setTimeout(() => {
          closed = true;
          child.emit(
            'error',
            Object.assign(new Error(script.spawnError!.code), { code: script.spawnError!.code })
          );
        }, 0);
        return;
      }
      for (const step of script.stdout ?? []) {
        setTimeout(() => {
          if (!closed && !child.killed && !stdout.destroyed) stdout.emit('data', step.chunk);
        }, step.at);
      }
      for (const step of script.stderr ?? []) {
        setTimeout(() => {
          if (!closed && !child.killed && !stderr.destroyed) stderr.emit('data', step.chunk);
        }, step.at);
      }
      if (script.exitAt !== undefined) {
        setTimeout(() => finish(script.exitCode ?? 0, null), script.exitAt);
      }
    }
  });
  return child;
}

/** A spawn function that starts the child's script and hands the child back. */
export function scriptedSpawn(child: FakeBackendChild): () => ChildProcess {
  return () => {
    child.start();
    return child as unknown as ChildProcess;
  };
}

/**
 * Stand in for the group signals and group probes the termination ladder sends. The leader's pid is
 * always free and the group never answers, so a ladder run against a double settles as the fixture
 * says, and no signal reaches a real process group. Restore with `vi.restoreAllMocks()`.
 */
export function stubGroupSignals(): void {
  vi.spyOn(process, 'kill').mockImplementation(((_target: number, signal?: string | number) => {
    if (signal !== 0) return true;
    throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
  }) as unknown as typeof process.kill);
}

/** The text a runner captured on one stream, whole. */
export function capturedText(buffer: { decompressStream(): IterableIterator<string> }): string {
  return Array.from(buffer.decompressStream()).join('');
}
