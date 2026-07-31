// Feature 030 BUG-002 — ClaudeCliRunner completion-marker grace-terminate.
//
// When `completionMarker` is set and appears in stdout, the runner stops
// waiting out the long idle timeout: it grace-terminates the process after a
// short settle window if it has not exited, returning `completedAwaitingExit:
// true` (NOT `timedOut`, NOT `killed`). A process that exits promptly after the
// marker is a normal completion. A process with no output and no marker still
// trips the idle timeout (`timedOut: true`) — the stall backstop is preserved.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import type { ChildProcess } from 'child_process';
import { ClaudeCliRunner, type SpawnFn } from '../../../src/runner/claude-cli';
import { AUDIT_LOG_CLOSE_MARKER } from '../../../src/parser/audit-log-parser';

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: NodeJS.WritableStream | null;
  killed: boolean;
  exitCode: number | null;
  signalCode: string | null;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(emitExitOnKill: boolean): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({ read() { /* no-op */ } });
  child.stderr = new Readable({ read() { /* no-op */ } });
  child.stdin = null;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((_sig?: NodeJS.Signals | number) => {
    child.killed = true;
    // Simulate the OS delivering the signal: the process exits with a null
    // exit code and the signal name.
    if (emitExitOnKill) child.emit('exit', null, 'SIGTERM');
    return true;
  });
  return child;
}

const COMPLETE_OUTPUT = `[SCHEGENT_STATUS: DONE]\n${AUDIT_LOG_CLOSE_MARKER}\n`;

const baseReq = {
  phase: 'speckit-implement' as const,
  iteration: 1,
  prompt: 'do work',
  cliPath: 'claude',
  cwd: '/repo'
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ClaudeCliRunner — BUG-002 completion-marker grace-terminate', () => {
  it('grace-terminates a process that emits the completion marker but does not exit', async () => {
    const child = makeFakeChild(true);
    const spawnFn: SpawnFn = () => {
      // Emit a complete result (with the audit-log close marker) once the
      // runner's stdout listener is attached, then never emit 'exit'.
      setTimeout(() => child.stdout.emit('data', COMPLETE_OUTPUT), 0);
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    const p = runner.invoke({
      ...baseReq,
      timeoutMs: 90 * 60_000, // long idle window — must NOT be what fires
      completionMarker: AUDIT_LOG_CLOSE_MARKER
    });
    await vi.advanceTimersByTimeAsync(0); // deliver stdout → detect marker → arm settle timer
    await vi.advanceTimersByTimeAsync(30_000); // past the short settle window
    const raw = await p;
    expect(raw.completedAwaitingExit).toBe(true);
    expect(raw.timedOut).toBe(false);
    expect(raw.killed).toBe(false);
    expect(child.kill).toHaveBeenCalled();
    expect(raw.stdout).toContain(AUDIT_LOG_CLOSE_MARKER);
  });

  it('treats a process that exits promptly after the marker as a normal completion', async () => {
    const child = makeFakeChild(false);
    const spawnFn: SpawnFn = () => {
      setTimeout(() => {
        child.stdout.emit('data', COMPLETE_OUTPUT);
        child.emit('exit', 0, null);
      }, 0);
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    const p = runner.invoke({
      ...baseReq,
      timeoutMs: 90 * 60_000,
      completionMarker: AUDIT_LOG_CLOSE_MARKER
    });
    await vi.advanceTimersByTimeAsync(0);
    const raw = await p;
    expect(raw.exitCode).toBe(0);
    expect(raw.completedAwaitingExit).toBeFalsy();
    expect(raw.timedOut).toBe(false);
  });

  it('still trips the idle timeout when no output and no marker arrive (stall backstop)', async () => {
    const child = makeFakeChild(true);
    const spawnFn: SpawnFn = () => child as unknown as ChildProcess; // never emits data or exit
    const runner = new ClaudeCliRunner(spawnFn);
    const p = runner.invoke({
      ...baseReq,
      timeoutMs: 60_000,
      completionMarker: AUDIT_LOG_CLOSE_MARKER
    });
    await vi.advanceTimersByTimeAsync(60_000 + 10);
    const raw = await p;
    expect(raw.timedOut).toBe(true);
    expect(raw.completedAwaitingExit).toBeFalsy();
  });
});
