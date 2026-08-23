/**
 * Feature 107 (T612, SC-006) — what may arm a grace-terminate.
 *
 * The runner can SIGTERM a live CLI process. Until `e2bf9ad` the trigger was a
 * substring scan over accumulated stdout for the audit-log close marker, so a
 * model that quoted a prior phase's block mid-turn could arm a kill against
 * itself. `e2bf9ad` replaced it with a check on the stream-json `{"type":
 * "result"}` envelope — a line the CLI harness emits around the model's
 * content, which content therefore cannot forge.
 *
 * That fix shipped with no test, and its own field, contract entry, comments,
 * and 14 test arguments went on describing the substring mechanism as live —
 * which is how FR-R3-023 came to propose region-qualifying a coupling that no
 * longer existed. These tests pin the boundary so it cannot be quietly undone,
 * and are paired with `tests/lint/no-content-driven-process-control.test.ts`,
 * which forbids the mechanism rather than the identifier.
 */
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

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({ read() { /* no-op */ } });
  child.stderr = new Readable({ read() { /* no-op */ } });
  child.stdin = null;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => {
    child.killed = true;
    child.emit('exit', null, 'SIGTERM');
    child.emit('close', null, 'SIGTERM');
    return true;
  });
  return child;
}

/** An assistant message whose *content* carries the close marker. */
function messageCarrying(text: string): string {
  return `${JSON.stringify({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  })}\n`;
}

const baseReq = {
  phase: 'speckit-implement' as const,
  iteration: 1,
  prompt: 'do work',
  cliPath: 'claude',
  cwd: '/repo'
};

const IDLE_TIMEOUT_MS = 90 * 60_000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('a close marker in content does not arm a grace-terminate (SC-006)', () => {
  const contentCases: Array<[string, string]> = [
    ['bare in an assistant message', AUDIT_LOG_CLOSE_MARKER],
    [
      'inside a quoted prior-phase block',
      `The previous phase printed:\\n${AUDIT_LOG_CLOSE_MARKER}\\nI am still working.`
    ],
    ['inside a code fence', `\`\`\`\\n${AUDIT_LOG_CLOSE_MARKER}\\n\`\`\``],
    [
      'alongside a termination token',
      `[SCHEGENT_STATUS: DONE]\\n${AUDIT_LOG_CLOSE_MARKER}`
    ]
  ];

  for (const [label, text] of contentCases) {
    it(`keeps streaming when the marker appears ${label}`, async () => {
      const child = makeFakeChild();
      const spawnFn: SpawnFn = () => {
        setTimeout(() => child.stdout.emit('data', messageCarrying(text)), 10);
        return child as unknown as ChildProcess;
      };
      const runner = new ClaudeCliRunner(spawnFn);
      const p = runner.invoke({ ...baseReq, timeoutMs: IDLE_TIMEOUT_MS });

      await vi.advanceTimersByTimeAsync(10);
      // Well past the settle window a substring reader would have started.
      await vi.advanceTimersByTimeAsync(60_000);

      expect(child.kill).not.toHaveBeenCalled();

      // Let the process finish on its own so the promise resolves.
      child.exitCode = 0;
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
      const raw = await p;
      expect(raw.completedAwaitingExit).toBeFalsy();
      expect(raw.killed).toBe(false);
    });
  }
});

describe('a terminal result envelope does arm a grace-terminate (SC-006)', () => {
  it('grace-terminates a process that emits its result and does not exit', async () => {
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      setTimeout(
        () => child.stdout.emit('data', '{"type":"result","subtype":"success"}\n'),
        10
      );
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    const p = runner.invoke({ ...baseReq, timeoutMs: IDLE_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(15_000);

    const raw = await p;
    expect(child.kill).toHaveBeenCalled();
    expect(raw.completedAwaitingExit).toBe(true);
    expect(raw.timedOut).toBe(false);
    expect(raw.killed).toBe(false);
  });

  it('arms on the envelope even when no close marker was ever emitted', async () => {
    // The converse of the cases above: the envelope is sufficient on its own,
    // so the two signals are genuinely independent.
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      setTimeout(() => {
        child.stdout.emit('data', messageCarrying('no audit block here'));
        child.stdout.emit('data', '{"type":"result","subtype":"success"}\n');
      }, 10);
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    const p = runner.invoke({ ...baseReq, timeoutMs: IDLE_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(15_000);

    expect((await p).completedAwaitingExit).toBe(true);
  });

  it('disarms when a later stream event shows the turn continued', async () => {
    // A result line followed by more stream-json events means the run was not
    // finished after all; the settle window must not fire on stale evidence.
    const child = makeFakeChild();
    const spawnFn: SpawnFn = () => {
      setTimeout(() => child.stdout.emit('data', '{"type":"result","subtype":"success"}\n'), 10);
      setTimeout(() => child.stdout.emit('data', messageCarrying('still going')), 20);
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    const p = runner.invoke({ ...baseReq, timeoutMs: IDLE_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(child.kill).not.toHaveBeenCalled();

    child.exitCode = 0;
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await p;
  });
});
