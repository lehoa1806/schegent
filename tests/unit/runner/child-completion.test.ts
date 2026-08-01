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
