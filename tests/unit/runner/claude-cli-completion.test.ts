// Feature 030 BUG-002 — ClaudeCliRunner terminal-result grace-terminate.
//
// When the invocation's terminal stream-json line (`{"type":"result"}`) arrives,
// the runner stops waiting out the long idle timeout: it grace-terminates the
// process after a short settle window if it has not exited, returning
// `completedAwaitingExit: true` (NOT `timedOut`, NOT `killed`). A process that
// exits promptly after its result is a normal completion. A process with no
// output at all still trips the idle timeout (`timedOut: true`) — the stall
// backstop is preserved.
//
// Feature 107 (FR-023) rewrote this header. It described arming as "when
// `completionMarker` is set and appears in stdout", the substring mechanism
// `e2bf9ad` had already replaced, and the file's own first test disproved it:
// output containing the close marker *inside an assistant message* does not
// arm — only the separate `result` line does. The 14 `completionMarker`
// arguments the tests passed went to a field with no reader and are gone.
//
// The distinction is the whole point of the boundary. A substring is forgeable
// by anything the model prints; a `result` envelope is emitted by the CLI
// harness around the model's content, so content cannot forge it. That is why
// this feature removed the field instead of region-qualifying it.

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
    // A real ChildProcess always emits 'close' after 'exit'. Emitting only
    // 'exit' encoded the removed `waitForStdioClose=false` semantics, under
    // which the runner stopped listening at exit; it now waits for close.
    if (emitExitOnKill) {
      child.emit('exit', null, 'SIGTERM');
      child.emit('close', null, 'SIGTERM');
    }
    return true;
  });
  return child;
}

const COMPLETE_OUTPUT = `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"[SCHEGENT_STATUS: DONE]\\n${AUDIT_LOG_CLOSE_MARKER}"}]}}\n`;

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
  it('grace-terminates after a real result emitted within the first five seconds', async () => {
    const child = makeFakeChild(true);
    const spawnFn: SpawnFn = () => {
      setTimeout(
        () => child.stdout.emit(
          'data',
          COMPLETE_OUTPUT + '\n{"type":"result","subtype":"success"}\n'
        ),
        10
      );
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    const p = runner.invoke({
      ...baseReq,
      timeoutMs: 90 * 60_000
    });

    await vi.advanceTimersByTimeAsync(10);
    // T070 raised COMPLETION_SETTLE_MS from 5s to 15s; the grace-terminate
    // this test pins now lands 10s later. Assertions unchanged.
    await vi.advanceTimersByTimeAsync(15_000);

    const raw = await p;
    expect(raw.completedAwaitingExit).toBe(true);
    expect(raw.timedOut).toBe(false);
    expect(raw.killed).toBe(false);
  });

  it('ignores a replayed terminal result until a resumed turn emits fresh evidence', async () => {
    const child = makeFakeChild(true);
    const spawnFn: SpawnFn = () => {
      setTimeout(
        () => child.stdout.emit('data', '{"type":"result","subtype":"success"}\n'),
        10
      );
      setTimeout(
        () => child.stdout.emit(
          'data',
          COMPLETE_OUTPUT + '\n{"type":"result","subtype":"success"}\n'
        ),
        70_000
      );
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    const p = runner.invoke({
      ...baseReq,
      timeoutMs: 90 * 60_000,
      sessionReuse: true,
      resumeSessionId: 'owned-session'
    });

    // T072 — rescaled past FR-026's 60s replay window and 15s settle window.
    // The shape is unchanged from the 5s era: cross the suppression window
    // with only the replayed result seen (no kill), then deliver the turn's
    // real result, then let the settle window expire.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9_000);
    await vi.advanceTimersByTimeAsync(15_000);

    const raw = await p;
    expect(raw.completedAwaitingExit).toBe(true);
    expect(raw.timedOut).toBe(false);
  });

  it('does not treat replay events before an old result as a fresh resumed turn', async () => {
    const child = makeFakeChild(true);
    const spawnFn: SpawnFn = () => {
      // BUG-004 (T077) — fixture corrected, assertions untouched. This test
      // was authored with `init` ahead of the replayed result, which asserts
      // that a replaying CLI emits history on the *far* side of the envelope.
      // FR-029 records the opposite as its premise, and T075 settled it: on
      // CLI 2.1.233 `init` is the first line of every invocation with zero
      // lines before it, so a resumed `init` followed by a result is a live
      // turn, not a replay — the exact shape BUG-004 reported as a 90-minute
      // stall. The two readings cannot both hold, so the replayed result moves
      // to the near side of the boundary where FR-029 puts it. What this test
      // pins is unchanged: replay events preceding an old result are not a
      // fresh resumed turn.
      setTimeout(
        () => child.stdout.emit(
          'data',
          COMPLETE_OUTPUT +
            '{"type":"result","subtype":"success"}\n' +
            '{"type":"system","subtype":"init"}\n'
        ),
        10
      );
      setTimeout(
        () => child.stdout.emit(
          'data',
          COMPLETE_OUTPUT + '{"type":"result","subtype":"success"}\n'
        ),
        70_000
      );
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    const p = runner.invoke({
      ...baseReq,
      timeoutMs: 90 * 60_000,
      sessionReuse: true,
      resumeSessionId: 'owned-session'
    });

    // T072 — rescaled past FR-026's 60s replay window and 15s settle window.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9_000);
    await vi.advanceTimersByTimeAsync(15_000);

    const raw = await p;
    expect(raw.completedAwaitingExit).toBe(true);
    expect(raw.timedOut).toBe(false);
  });

  it('grace-terminates a process that emits the completion marker but does not exit', async () => {
    const child = makeFakeChild(true);
    const spawnFn: SpawnFn = () => {
      // Emit a complete result (with the audit-log close marker) once the
      // runner's stdout listener is attached, then never emit 'exit'.
      setTimeout(() => child.stdout.emit('data', COMPLETE_OUTPUT + '\n{"type":"result"}\n'), 6000);
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    const p = runner.invoke({
      ...baseReq,
      timeoutMs: 90 * 60_000 // long idle window — must NOT be what fires
    });
    await vi.advanceTimersByTimeAsync(6000); // pass the history-replay window and deliver stdout
    await vi.advanceTimersByTimeAsync(30_000); // past the short settle window
    const raw = await p;
    expect(raw.completedAwaitingExit).toBe(true);
    expect(raw.timedOut).toBe(false);
    expect(raw.killed).toBe(false);
    expect(child.kill).toHaveBeenCalled();
    const stdout = Array.from(raw.stdoutBuffer.decompressStream()).join("");
    expect(stdout).toContain(AUDIT_LOG_CLOSE_MARKER);
  });

  it('treats a process that exits promptly after the marker as a normal completion', async () => {
    const child = makeFakeChild(false);
    const spawnFn: SpawnFn = () => {
      setTimeout(() => {
        child.stdout.emit('data', COMPLETE_OUTPUT + '\n{"type":"result"}\n');
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      }, 6000);
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    const p = runner.invoke({
      ...baseReq,
      timeoutMs: 90 * 60_000
    });
    await vi.advanceTimersByTimeAsync(6000);
    const raw = await p;
    expect(raw.exitCode).toBe(0);
    expect(raw.completedAwaitingExit).toBeFalsy();
    expect(raw.timedOut).toBe(false);
  });

  // Feature 030 BUG-003 (T068, T069) — the inverse of BUG-002. BUG-002 was a
  // finished run Schegent failed to see as finished; BUG-003 is a *live* run
  // Schegent wrongly sees as finished and kills. Both turn on the same
  // `sawCompletionMarker` mechanism, so the fix for the first opened the
  // failure mode of the second. These two tests pin FR-026's replay-suppression
  // and disarm clauses; SC-012 is the pair of them.

  it('does not arm the completion marker from a replayed result after a long history replay', async () => {
    // A resumed invocation with a very large history replays the whole prior
    // conversation before emitting anything for the new prompt. The replayed
    // terminal result lands at t=30s — past the old 5s suppression window,
    // inside FR-026's 60s bound — and the new turn's first token only arrives
    // 12s later, which is longer than the settle window. Against the old
    // constants the marker armed at 30s and SIGTERM landed at 35s, mid-stream.
    const child = makeFakeChild(true);
    const spawnFn: SpawnFn = () => {
      setTimeout(
        () => child.stdout.emit('data', '{"type":"result","subtype":"success"}\n'),
        30_000
      );
      setTimeout(
        () => child.stdout.emit('data', '{"type":"assistant","subtype":"message"}\n'),
        42_000
      );
      setTimeout(
        () => child.stdout.emit(
          'data',
          COMPLETE_OUTPUT + '{"type":"result","subtype":"success"}\n'
        ),
        70_000
      );
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    const p = runner.invoke({
      ...baseReq,
      timeoutMs: 90 * 60_000,
      sessionReuse: true,
      resumeSessionId: 'owned-session'
    });

    // Deliver the replayed result, then cross the whole 12s gap before the new
    // turn's first token. Nothing may be killed in here: the process has
    // produced no output of its own yet, so it is working, not lingering.
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(child.kill).not.toHaveBeenCalled();

    // The real terminal result of the current turn arrives later and is the
    // one that legitimately arms the marker.
    await vi.advanceTimersByTimeAsync(28_000);
    await vi.advanceTimersByTimeAsync(15_000);

    const raw = await p;
    expect(raw.completedAwaitingExit).toBe(true);
    expect(raw.timedOut).toBe(false);
  });

  it('restores the full idle window when a stream-json event follows an armed marker', async () => {
    // FR-026 disarm clause, pinned independently of the replay path. This is
    // what bounds the exposure to a single inter-event gap rather than the
    // whole turn: once the current turn emits anything, an armed-in-error
    // marker is corrected rather than left to expire against live work.
    const child = makeFakeChild(true);
    const spawnFn: SpawnFn = () => {
      setTimeout(
        () => child.stdout.emit('data', '{"type":"result","subtype":"success"}\n'),
        1_000
      );
      setTimeout(
        () => child.stdout.emit('data', '{"type":"assistant","subtype":"message"}\n'),
        2_000
      );
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    const p = runner.invoke({
      ...baseReq,
      timeoutMs: 90 * 60_000
    });

    await vi.advanceTimersByTimeAsync(2_000);
    // Well past the settle window. The disarm must have restored `timeoutMs`,
    // so no grace-terminate may fire here.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(child.kill).not.toHaveBeenCalled();

    // Let the long idle window run out so the promise settles.
    await vi.advanceTimersByTimeAsync(90 * 60_000);
    const raw = await p;
    expect(raw.timedOut).toBe(true);
  });

  // Feature 030 BUG-004 (T076, T077) — the consequence of BUG-003's patch. The
  // replay suppression FR-026 added is purely wall-clock, so it cannot tell a
  // replayed terminal result from a live one and discards both: a resumed
  // invocation that genuinely finishes inside the window never arms the marker,
  // and a CLI that then lingers is held for the full 90-minute idle window.
  // That is BUG-002's stall, reintroduced on the resumed path. FR-029 replaces
  // the wall-clock decision with the `system`/`init` boundary; SC-015 is the
  // first test below.

  it('grace-terminates a resumed invocation whose own result arrives inside the replay window', async () => {
    // SC-015. The result at 4s follows this invocation's own `init`, so it
    // belongs to the current turn however early it lands. Against the
    // wall-clock guard the marker never armed and no kill occurred for 90
    // minutes; the only difference from the control below is the resume
    // fields, which must not change completion semantics.
    const child = makeFakeChild(true);
    const spawnFn: SpawnFn = () => {
      setTimeout(() => child.stdout.emit('data', '{"type":"system","subtype":"init"}\n'), 10);
      setTimeout(
        () => child.stdout.emit(
          'data',
          COMPLETE_OUTPUT + '{"type":"result","subtype":"success"}\n'
        ),
        4_000
      );
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    const p = runner.invoke({
      ...baseReq,
      timeoutMs: 90 * 60_000,
      sessionReuse: true,
      resumeSessionId: 'owned-session'
    });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);

    const raw = await p;
    expect(child.kill).toHaveBeenCalled();
    expect(raw.completedAwaitingExit).toBe(true);
    expect(raw.timedOut).toBe(false);
    expect(raw.killed).toBe(false);
  });

  it('grace-terminates a fresh invocation on the same timeline (resume-field control)', async () => {
    const child = makeFakeChild(true);
    const spawnFn: SpawnFn = () => {
      setTimeout(() => child.stdout.emit('data', '{"type":"system","subtype":"init"}\n'), 10);
      setTimeout(
        () => child.stdout.emit(
          'data',
          COMPLETE_OUTPUT + '{"type":"result","subtype":"success"}\n'
        ),
        4_000
      );
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    const p = runner.invoke({
      ...baseReq,
      timeoutMs: 90 * 60_000
    });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);

    const raw = await p;
    expect(child.kill).toHaveBeenCalled();
    expect(raw.completedAwaitingExit).toBe(true);
    expect(raw.timedOut).toBe(false);
  });

  it('does not arm the marker from a terminal result that precedes the init envelope', async () => {
    // T077 — the suppressing half of the boundary, stated positively. T068's
    // fixture emits no `init` at all, so under a structural rule it would pass
    // for the wrong reason: the marker fails to arm because no boundary was
    // ever crossed. Here the boundary IS crossed, after the replayed result,
    // which is the shape FR-029's premise attributes to a replaying CLI.
    const child = makeFakeChild(true);
    const spawnFn: SpawnFn = () => {
      setTimeout(
        () => child.stdout.emit('data', '{"type":"result","subtype":"success"}\n'),
        1_000
      );
      setTimeout(() => child.stdout.emit('data', '{"type":"system","subtype":"init"}\n'), 20_000);
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    const p = runner.invoke({
      ...baseReq,
      timeoutMs: 90 * 60_000,
      sessionReuse: true,
      resumeSessionId: 'owned-session'
    });

    // Well past the settle window with only the pre-init result seen. A marker
    // armed here would have grace-terminated a process that has not started
    // the current turn.
    await vi.advanceTimersByTimeAsync(16_000);
    expect(child.kill).not.toHaveBeenCalled();

    // The boundary arrives, nothing follows it, and the stall backstop — not
    // the settle window — is what ends the invocation.
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.advanceTimersByTimeAsync(90 * 60_000);
    const raw = await p;
    expect(raw.timedOut).toBe(true);
    expect(raw.completedAwaitingExit).toBeFalsy();
  });

  it('arms the marker from a terminal result that follows the init envelope', async () => {
    // T077 — the arming half. Same invocation shape as the test above with the
    // result moved to the far side of the boundary, so the boundary is what
    // decides and the pair is non-vacuous.
    const child = makeFakeChild(true);
    const spawnFn: SpawnFn = () => {
      setTimeout(() => child.stdout.emit('data', '{"type":"system","subtype":"init"}\n'), 1_000);
      setTimeout(
        () => child.stdout.emit('data', '{"type":"result","subtype":"success"}\n'),
        2_000
      );
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    const p = runner.invoke({
      ...baseReq,
      timeoutMs: 90 * 60_000,
      sessionReuse: true,
      resumeSessionId: 'owned-session'
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(15_000);
    const raw = await p;
    expect(child.kill).toHaveBeenCalled();
    expect(raw.completedAwaitingExit).toBe(true);
    expect(raw.timedOut).toBe(false);
  });

  it('suppresses at most one terminal result per resumed invocation (fallback bound)', async () => {
    // FR-029's fallback bound, pinned on its own. T075 established that no
    // reachable CLI configuration replays, so the boundary alone always arms
    // and this path is unreachable in production — which is exactly why it
    // needs its own test rather than relying on incidental coverage. Neither
    // T068's nor T072's fixture exercises it: both deliver their second result
    // past the 60s window, where the window expiry arms them regardless.
    const child = makeFakeChild(true);
    const spawnFn: SpawnFn = () => {
      setTimeout(
        () => child.stdout.emit('data', '{"type":"result","subtype":"success"}\n'),
        1_000
      );
      setTimeout(
        () => child.stdout.emit(
          'data',
          COMPLETE_OUTPUT + '{"type":"result","subtype":"success"}\n'
        ),
        2_000
      );
      return child as unknown as ChildProcess;
    };
    const runner = new ClaudeCliRunner(spawnFn);
    const p = runner.invoke({
      ...baseReq,
      timeoutMs: 90 * 60_000,
      sessionReuse: true,
      resumeSessionId: 'owned-session'
    });

    // Both results land inside the 60s window and no `init` ever arrives, so
    // only the bound can arm the second one.
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(15_000);
    const raw = await p;
    expect(child.kill).toHaveBeenCalled();
    expect(raw.completedAwaitingExit).toBe(true);
    expect(raw.timedOut).toBe(false);
  });

  it('still trips the idle timeout when no output and no marker arrive (stall backstop)', async () => {
    const child = makeFakeChild(true);
    const spawnFn: SpawnFn = () => child as unknown as ChildProcess; // never emits data or exit
    const runner = new ClaudeCliRunner(spawnFn);
    const p = runner.invoke({
      ...baseReq,
      timeoutMs: 60_000
    });
    await vi.advanceTimersByTimeAsync(60_000 + 10);
    const raw = await p;
    expect(raw.timedOut).toBe(true);
    expect(raw.completedAwaitingExit).toBeFalsy();
  });
});
