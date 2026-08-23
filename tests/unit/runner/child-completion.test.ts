import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
  STDIO_CLOSE_GRACE_MS,
  waitForChildCompletion
} from '../../../src/runner/child-completion';

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({ read() { /* no-op */ } });
  child.stderr = new Readable({ read() { /* no-op */ } });
  return child;
}

describe('waitForChildCompletion', () => {
  it('waits for close so buffered pipe data can drain after exit', async () => {
    const child = makeChild();
    const completion = waitForChildCompletion(
      child as unknown as ChildProcess,
      true
    );

    child.emit('exit', 0, null);
    let resolved = false;
    void completion.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);

    child.emit('close', 0, null);
    await expect(completion).resolves.toEqual({
      exitCode: 0,
      signal: null,
      stdioCloseTimedOut: false
    });
  });

  it('reports a process-level error so a broken stdin pipe is not read as a delivery failure', async () => {
    // FR-R3-047 — a spawn that never produced a process (ENOENT on a mistyped
    // CLI path) also breaks the stdin pipe, so the prompt write fails EPIPE with
    // nothing on the far end. Without this flag the runners classify that as a
    // prompt-delivery failure, which outranks every other arm of the phase-runner
    // chain and reports a cause that is not the cause.
    const child = makeChild();
    const completion = waitForChildCompletion(child as unknown as ChildProcess, true);

    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));

    await expect(completion).resolves.toEqual({
      exitCode: null,
      signal: null,
      stdioCloseTimedOut: false,
      processError: true
    });
  });

  it('does not call a LIVE child a process error when its kill fails', async () => {
    // `terminate()` kills on every idle expiry and every cancellation, and a
    // failing `kill()` (EPERM) makes Node emit `'error'` on a child that is
    // still running. `processError` is consumed as "there was no child" and
    // suppresses the prompt-delivery condition, so flagging this case would
    // silently discard a real EPIPE truncation on a live backend. A pid is the
    // exact discriminator: it exists only once the spawn succeeded.
    const child = makeChild();
    (child as unknown as { pid: number }).pid = 4242;
    const completion = waitForChildCompletion(child as unknown as ChildProcess, true);

    child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));

    await expect(completion).resolves.toEqual({
      exitCode: null,
      signal: null,
      stdioCloseTimedOut: false
    });
  });

  it('keeps the exit code it already observed when an error arrives after exit', async () => {
    // Inside the stdio-close grace the exit code is already known. Replacing it
    // with `null` would make the payload projection and the runners' `killed`
    // checks read a non-zero exit as "terminated by signal".
    const child = makeChild();
    (child as unknown as { pid: number }).pid = 4243;
    const completion = waitForChildCompletion(child as unknown as ChildProcess, true);

    child.emit('exit', 1, null);
    child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));

    await expect(completion).resolves.toEqual({
      exitCode: 1,
      signal: null,
      stdioCloseTimedOut: false
    });
  });

  it('bounds the close wait when a descendant retains inherited stdio', async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild();
      const stdoutDestroy = vi.spyOn(child.stdout, 'destroy');
      const stderrDestroy = vi.spyOn(child.stderr, 'destroy');
      const completion = waitForChildCompletion(
        child as unknown as ChildProcess,
        true
      );

      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(STDIO_CLOSE_GRACE_MS);

      await expect(completion).resolves.toEqual({
        exitCode: 0,
        signal: null,
        stdioCloseTimedOut: true
      });
      expect(stdoutDestroy).toHaveBeenCalledOnce();
      expect(stderrDestroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
