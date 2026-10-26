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
import type { RawInvocationOutput } from '../../../src/runner/invocation-result';
import type { MonitorSidecarEvent } from '../../../src/contracts/backend-runner';
import { AUDIT_LOG_CLOSE_MARKER } from '../../../src/parser/audit-log-parser';
import { SanitizedLogger } from '../../../src/lib/logger';
import { MAX_OPEN_TASKS, MAX_TASK_ID_LENGTH } from '../../../src/runner/background-task-tracker';

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

  // Feature 212 / T027 (FR-005, FR-014) — `sawTerminalResult`, the envelope
  // fact this backend reports out.
  //
  // WHY THIS IS NOT `completedAwaitingExit`
  //
  // The plan named `completedAwaitingExit` as the source fact. It is not one.
  // That flag is the AND of two things — an envelope arrived AND the process was
  // still running when the settle window expired — so on every phase that exits
  // promptly after its result, which is every healthy phase, it is `false`. A
  // host reading it as "no envelope" would stamp `resultEnvelope: 'absent'` on
  // the whole fleet: the same fabricated fact, in the same audit field, that this
  // feature exists to remove. The first test below is that exact case, and it is
  // the one that makes the distinction load-bearing rather than stylistic.
  //
  // It is also a LATCH. `sawCompletionMarker` is cleared by the next event line
  // (`:592`) because the settle window needs "is the envelope still the last
  // thing we saw"; envelope presence needs the opposite rule, so the two are
  // separate variables set at the same point rather than one variable read twice.
  describe('the envelope fact this backend reports out (feature 212)', () => {
    it('reports received on a run that exits promptly after its result', async () => {
      const child = makeFakeChild(true);
      const spawnFn: SpawnFn = () => {
        setTimeout(
          () => child.stdout.emit(
            'data',
            COMPLETE_OUTPUT + '{"type":"result","subtype":"success"}\n'
          ),
          10
        );
        setTimeout(() => {
          child.exitCode = 0;
          child.emit('exit', 0, null);
          child.emit('close', 0, null);
        }, 20);
        return child as unknown as ChildProcess;
      };
      const runner = new ClaudeCliRunner(spawnFn);
      const p = runner.invoke({ ...baseReq, timeoutMs: 90 * 60_000 });
      await vi.advanceTimersByTimeAsync(30);

      const raw = await p;
      expect(raw.sawTerminalResult).toBe(true);
      // The point of the test: the ordinary, healthy, envelope-bearing run is
      // exactly where the rejected source fact reads `false`.
      expect(raw.completedAwaitingExit).toBeFalsy();
      expect(raw.timedOut).toBe(false);
      expect(child.kill).not.toHaveBeenCalled();
    });

    it('reports absent when output arrived but no result envelope ever did', async () => {
      const child = makeFakeChild(true);
      const spawnFn: SpawnFn = () => {
        // Content only — including the audit close marker, which is forgeable by
        // anything the model prints and is NOT an envelope. See the file header.
        setTimeout(() => child.stdout.emit('data', COMPLETE_OUTPUT), 10);
        return child as unknown as ChildProcess;
      };
      const runner = new ClaudeCliRunner(spawnFn);
      const p = runner.invoke({ ...baseReq, timeoutMs: 60_000 });
      await vi.advanceTimersByTimeAsync(60_000 + 20);

      const raw = await p;
      // `false`, not absent: this backend watched, so it is entitled to the claim.
      expect(raw.sawTerminalResult).toBe(false);
      expect(raw.timedOut).toBe(true);
    });

    it('does not count a suppressed history replay as this invocation envelope', async () => {
      // The latch is set in the branch that ACCEPTS the result, not at the
      // detection, so a replayed result the runner deliberately ignores cannot
      // make a resumed invocation claim an envelope it never received.
      const child = makeFakeChild(true);
      const spawnFn: SpawnFn = () => {
        setTimeout(
          () => child.stdout.emit('data', '{"type":"result","subtype":"success"}\n'),
          10
        );
        return child as unknown as ChildProcess;
      };
      const runner = new ClaudeCliRunner(spawnFn);
      const p = runner.invoke({
        ...baseReq,
        timeoutMs: 60_000,
        sessionReuse: true,
        resumeSessionId: 'owned-session'
      });
      await vi.advanceTimersByTimeAsync(60_000 + 20);

      const raw = await p;
      expect(raw.sawTerminalResult).toBe(false);
      expect(raw.timedOut).toBe(true);
    });
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

// FR-R3-198 (T1876) — a result is not the end of the turn while backgrounded
// work is open.
//
// A turn that starts a command in the background writes its `result` while
// the command still runs. In print mode the CLI then waits for it, and on the
// task's `task_notification` wakes a second turn in the same process: `init`,
// the turn's output, a second `result`. The settle window read that wait as a
// process lingering after its work. In T1875's capture the woken turn's `init`
// came 19.1 s after the first result, so the settle, 15 s after it, would have
// cut the turn off first. Here an open backgrounded task holds the settle, the
// hold ends when the last task closes or at the CLI's own 600 s ceiling, and
// the bookkeeping lines the CLI writes about its tasks are not activity.
describe('ClaudeCliRunner — FR-R3-198 background hold (T1876)', () => {
  const DEFAULT_TIMEOUT_MS = 5_400_000;

  const STARTED_T1 =
    '{"type":"system","subtype":"task_started","is_backgrounded":true,"task_id":"t1"}\n';
  const STARTED_T2 =
    '{"type":"system","subtype":"task_started","is_backgrounded":true,"task_id":"t2"}\n';
  const STARTED_T1_FOREGROUND =
    '{"type":"system","subtype":"task_started","is_backgrounded":false,"task_id":"t1"}\n';
  const NOTIFIED_T1 =
    '{"type":"system","subtype":"task_notification","task_id":"t1","status":"completed"}\n';
  const NOTIFIED_T2 =
    '{"type":"system","subtype":"task_notification","task_id":"t2","status":"completed"}\n';
  const NOTIFIED_T9 =
    '{"type":"system","subtype":"task_notification","task_id":"t9","status":"completed"}\n';
  const STOPPED_T1 =
    '{"type":"system","subtype":"task_notification","task_id":"t1","status":"stopped"}\n';
  const UPDATED_T1 = '{"type":"system","subtype":"task_updated","task_id":"t1"}\n';
  const TASKS_CHANGED_EMPTY =
    '{"type":"system","subtype":"background_tasks_changed","tasks":[]}\n';
  const INIT = '{"type":"system","subtype":"init"}\n';
  const RESULT = '{"type":"result","subtype":"success"}\n';
  const FIRST_TURN_TEXT =
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"build started in the background"}]}}\n';
  const WOKEN_TURN_TEXT =
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"the background build finished"}]}}\n';

  /** Spawns `child`, which writes `opening` 10 ms in, once the runner listens. */
  function spawnOpening(child: FakeChild, opening: string): SpawnFn {
    return () => {
      setTimeout(() => child.stdout.emit('data', opening), 10);
      return child as unknown as ChildProcess;
    };
  }

  /** The CLI exiting 0 on its own. */
  function exitCleanly(child: FakeChild): void {
    child.exitCode = 0;
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
  }

  function capturingLogger(): { logger: SanitizedLogger; lines: string[] } {
    const lines: string[] = [];
    const logger = new SanitizedLogger([{ appendLine: (line) => { lines.push(line); } }]);
    return { logger, lines };
  }

  /** The runner's own messages about `about`, without the logger's stamp and level. */
  function messages(lines: ReadonlyArray<string>, about: string): string[] {
    return lines
      .filter((line) => line.includes(about))
      .map((line) => line.slice(line.indexOf('[ClaudeCliRunner]')));
  }

  /**
   * B7's timeline. The first turn backgrounds `t1` and writes its result. 16 s
   * on, `t1`'s notification wakes a second turn, which writes its own result
   * with nothing open, and the CLI exits 0.
   */
  async function runWokenTurn(): Promise<{ child: FakeChild; raw: RawInvocationOutput }> {
    const child = makeFakeChild(true);
    const runner = new ClaudeCliRunner(
      spawnOpening(child, FIRST_TURN_TEXT + STARTED_T1 + RESULT)
    );
    const p = runner.invoke({ ...baseReq, timeoutMs: DEFAULT_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(child.kill).not.toHaveBeenCalled();

    child.stdout.emit('data', NOTIFIED_T1);
    child.stdout.emit('data', INIT + WOKEN_TURN_TEXT + RESULT);
    exitCleanly(child);
    return { child, raw: await p };
  }

  it('holds the settle while a backgrounded task is open past the result (B1)', async () => {
    const child = makeFakeChild(true);
    const runner = new ClaudeCliRunner(spawnOpening(child, STARTED_T1 + RESULT));
    const p = runner.invoke({ ...baseReq, timeoutMs: DEFAULT_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(child.kill).not.toHaveBeenCalled();

    exitCleanly(child);
    const raw = await p;
    expect(raw.exitCode).toBe(0);
  });

  it('settles 15 s after the last open task closes (B2)', async () => {
    const child = makeFakeChild(true);
    const runner = new ClaudeCliRunner(spawnOpening(child, STARTED_T1 + RESULT));
    const p = runner.invoke({ ...baseReq, timeoutMs: DEFAULT_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(child.kill).not.toHaveBeenCalled();

    child.stdout.emit('data', NOTIFIED_T1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(child.kill).toHaveBeenCalled();
    const raw = await p;
    expect(raw.completedAwaitingExit).toBe(true);
    expect(raw.timedOut).not.toBe(true);
  });

  it('settles at 15 s when the task that ran was not backgrounded (B3, guard)', async () => {
    const child = makeFakeChild(true);
    const runner = new ClaudeCliRunner(
      spawnOpening(child, STARTED_T1_FOREGROUND + NOTIFIED_T1 + RESULT)
    );
    const p = runner.invoke({ ...baseReq, timeoutMs: DEFAULT_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(child.kill).toHaveBeenCalled();
    const raw = await p;
    expect(raw.completedAwaitingExit).toBe(true);
    expect(raw.timedOut).toBe(false);
  });

  it('ignores a notification for a task this invocation never started (B4, guard)', async () => {
    // A resumed session can carry the notification of a task an earlier
    // invocation started. `init` comes first, as in the resumed cases above,
    // so the result that follows is this invocation's own and is accepted.
    const child = makeFakeChild(true);
    const runner = new ClaudeCliRunner(spawnOpening(child, INIT + NOTIFIED_T9 + RESULT));
    const p = runner.invoke({
      ...baseReq,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      sessionReuse: true,
      resumeSessionId: 'owned-session'
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(child.kill).toHaveBeenCalled();
    const raw = await p;
    expect(raw.completedAwaitingExit).toBe(true);
    expect(raw.timedOut).toBe(false);
  });

  it('ends the hold at the 600 s ceiling and then settles (B5)', async () => {
    const child = makeFakeChild(true);
    const runner = new ClaudeCliRunner(spawnOpening(child, STARTED_T1 + RESULT));
    const p = runner.invoke({ ...baseReq, timeoutMs: DEFAULT_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(599_999);
    expect(child.kill).not.toHaveBeenCalled();

    // 600 000 ms after the result the ceiling ends the hold, and the settle
    // counts from there.
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalled();
    const raw = await p;
    expect(raw.completedAwaitingExit).toBe(true);
    expect(raw.timedOut).toBe(false);
  });

  it('settles at 15 s after a result with nothing open (B6, guard)', async () => {
    const child = makeFakeChild(true);
    const runner = new ClaudeCliRunner(spawnOpening(child, RESULT));
    const p = runner.invoke({ ...baseReq, timeoutMs: DEFAULT_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(child.kill).toHaveBeenCalled();
    const raw = await p;
    expect(raw.completedAwaitingExit).toBe(true);
    expect(raw.timedOut).toBe(false);
  });

  it('lets the woken turn run to its own result and exit (B7)', async () => {
    const { child, raw } = await runWokenTurn();
    expect(child.kill).not.toHaveBeenCalled();
    expect(raw.exitCode).toBe(0);
    expect(raw.completedAwaitingExit).not.toBe(true);
    const stdout = Array.from(raw.stdoutBuffer.decompressStream()).join('');
    expect(stdout).toContain('build started in the background');
    expect(stdout).toContain('the background build finished');
  });

  it('keeps holding while a second backgrounded task is open (B8)', async () => {
    const child = makeFakeChild(true);
    const runner = new ClaudeCliRunner(spawnOpening(child, STARTED_T1 + STARTED_T2 + RESULT));
    const p = runner.invoke({ ...baseReq, timeoutMs: DEFAULT_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(child.kill).not.toHaveBeenCalled();

    child.stdout.emit('data', NOTIFIED_T1);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(child.kill).not.toHaveBeenCalled();

    // The last task closing is what ends the hold.
    child.stdout.emit('data', NOTIFIED_T2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(child.kill).toHaveBeenCalled();
    const raw = await p;
    expect(raw.completedAwaitingExit).toBe(true);
  });

  it('counts a new ceiling from the woken turn result when it backgrounds again (B9)', async () => {
    const child = makeFakeChild(true);
    const runner = new ClaudeCliRunner(spawnOpening(child, STARTED_T1 + RESULT));
    const p = runner.invoke({ ...baseReq, timeoutMs: DEFAULT_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(child.kill).not.toHaveBeenCalled();

    // The woken turn starts `t2` and writes its result now, at X.
    child.stdout.emit('data', NOTIFIED_T1);
    child.stdout.emit('data', INIT + WOKEN_TURN_TEXT + STARTED_T2 + RESULT);
    // A ceiling counted from the first result would have ended the hold 16 s
    // earlier, and the settle would have terminated the process by now.
    await vi.advanceTimersByTimeAsync(599_999);
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(child.kill).toHaveBeenCalled();
    const raw = await p;
    expect(raw.completedAwaitingExit).toBe(true);
  });

  it('reads the bookkeeping lines around the last close as silence (B10)', async () => {
    const child = makeFakeChild(true);
    const runner = new ClaudeCliRunner(spawnOpening(child, STARTED_T1 + RESULT));
    const p = runner.invoke({ ...baseReq, timeoutMs: DEFAULT_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1_000);
    // The order research R2 measured when a task was stopped, its notification
    // repeated. None of these lines is a new turn.
    for (const line of [STOPPED_T1, UPDATED_T1, TASKS_CHANGED_EMPTY, STOPPED_T1]) {
      child.stdout.emit('data', line);
    }
    await vi.advanceTimersByTimeAsync(15_000);
    expect(child.kill).toHaveBeenCalled();
    const raw = await p;
    expect(raw.completedAwaitingExit).toBe(true);
  });

  it('lets the idle window run during a hold and labels its expiry timedOut (B11)', async () => {
    const child = makeFakeChild(true);
    const runner = new ClaudeCliRunner(spawnOpening(child, STARTED_T1 + RESULT));
    const p = runner.invoke({ ...baseReq, timeoutMs: 60_000 });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(45_000);
    expect(child.kill).toHaveBeenCalled();
    const raw = await p;
    expect(raw.timedOut).toBe(true);
    expect(raw.completedAwaitingExit).toBeFalsy();
  });

  it('leaves the absolute deadline in force during a hold (B12)', async () => {
    const child = makeFakeChild(true);
    const runner = new ClaudeCliRunner(spawnOpening(child, STARTED_T1 + RESULT));
    // `maxDurationMs` is the deadline field FR-R3-075's cases set, in
    // `tests/unit/runner/invocation-deadline.test.ts`.
    const p = runner.invoke({
      ...baseReq,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxDurationMs: 30_000
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(child.kill).not.toHaveBeenCalled();

    // 30 000 ms from spawn.
    await vi.advanceTimersByTimeAsync(14_990);
    expect(child.kill).toHaveBeenCalled();
    const raw = await p;
    expect(raw.deadlineExceeded).toBe(true);
    expect(raw.completedAwaitingExit).toBeFalsy();
    expect(raw.timedOut).toBe(false);
  });

  it('reports whether the last accepted result came with backgrounded work open (B13)', async () => {
    const settled = async (opening: string, settleMs: number): Promise<RawInvocationOutput> => {
      const child = makeFakeChild(true);
      const p = new ClaudeCliRunner(spawnOpening(child, opening)).invoke({
        ...baseReq,
        timeoutMs: DEFAULT_TIMEOUT_MS
      });
      await vi.advanceTimersByTimeAsync(10 + settleMs);
      expect(child.kill).toHaveBeenCalled();
      return p;
    };

    // B5's shape: held to the ceiling, then settled.
    expect((await settled(STARTED_T1 + RESULT, 615_000)).backgroundWorkOpenAtResult).toBe(true);
    // B6's and B3's shapes: nothing open at the result.
    expect((await settled(RESULT, 15_000)).backgroundWorkOpenAtResult).toBe(false);
    const foreground = await settled(STARTED_T1_FOREGROUND + NOTIFIED_T1 + RESULT, 15_000);
    expect(foreground.backgroundWorkOpenAtResult).toBe(false);
    // B7: the first result started a hold, and the last came with nothing open.
    expect((await runWokenTurn()).raw.backgroundWorkOpenAtResult).toBe(false);
  });

  it('logs one began and one ended line per hold, with no task id (B14)', async () => {
    // B2's shape: the task closes 16 s after the result.
    const closed = capturingLogger();
    const closedChild = makeFakeChild(true);
    const closedRun = new ClaudeCliRunner(
      spawnOpening(closedChild, STARTED_T1 + RESULT),
      null,
      {},
      closed.logger
    ).invoke({ ...baseReq, timeoutMs: DEFAULT_TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(closedChild.kill).not.toHaveBeenCalled();
    closedChild.stdout.emit('data', NOTIFIED_T1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(closedChild.kill).toHaveBeenCalled();
    await closedRun;

    expect(messages(closed.lines, 'background hold began')).toEqual([
      '[ClaudeCliRunner] background hold began openTasks=1 untracked=false ceilingMs=600000 resumed=false ' +
        'phase=speckit-implement iteration=1'
    ]);
    expect(messages(closed.lines, 'background hold ended')).toEqual([
      '[ClaudeCliRunner] background hold ended reason=closed heldMs=16000 ' +
        'phase=speckit-implement iteration=1'
    ]);

    // B5's shape: the ceiling ends the hold.
    const ceiling = capturingLogger();
    const ceilingChild = makeFakeChild(true);
    const ceilingRun = new ClaudeCliRunner(
      spawnOpening(ceilingChild, STARTED_T1 + RESULT),
      null,
      {},
      ceiling.logger
    ).invoke({ ...baseReq, timeoutMs: DEFAULT_TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(10 + 615_000);
    expect(ceilingChild.kill).toHaveBeenCalled();
    await ceilingRun;

    expect(messages(ceiling.lines, 'background hold ended')).toEqual([
      '[ClaudeCliRunner] background hold ended reason=ceiling heldMs=600000 ' +
        'phase=speckit-implement iteration=1'
    ]);
    // Contract H10: no task id in anything the runner logged.
    expect([...closed.lines, ...ceiling.lines].filter((line) => line.includes('t1'))).toEqual([]);
  });

  it('clears the ceiling when the CLI exits on its own during a hold (B15)', async () => {
    const { logger, lines } = capturingLogger();
    const child = makeFakeChild(true);
    const runner = new ClaudeCliRunner(
      spawnOpening(child, STARTED_T1 + RESULT),
      null,
      {},
      logger
    );
    const p = runner.invoke({ ...baseReq, timeoutMs: DEFAULT_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1_000);
    exitCleanly(child);
    const raw = await p;
    expect(child.kill).not.toHaveBeenCalled();
    expect(raw.backgroundWorkOpenAtResult).toBe(true);

    // A ceiling left armed would fire in here and log the hold's end.
    const loggedAtExit = lines.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(lines).toHaveLength(loggedAtExit);
  });

  it('begins a new hold, with its own ceiling, on a result accepted during one (B16)', async () => {
    // `t1`'s notification wakes the model while `t2` still runs, so the woken
    // turn's result arrives during the first hold. Its ceiling counts from that
    // result (H6). The hold it replaces ended by neither `closed` nor `ceiling`
    // (H5), so it logs no `ended` line.
    const { logger, lines } = capturingLogger();
    const child = makeFakeChild(true);
    const runner = new ClaudeCliRunner(
      spawnOpening(child, STARTED_T1 + STARTED_T2 + RESULT),
      null,
      {},
      logger
    );
    const p = runner.invoke({ ...baseReq, timeoutMs: DEFAULT_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(16_000);
    child.stdout.emit('data', NOTIFIED_T1);
    child.stdout.emit('data', INIT + WOKEN_TURN_TEXT + RESULT);
    // The first hold's ceiling falls 584 000 ms from here. Left armed, it
    // would end the hold then, and the settle would terminate the process
    // before this check.
    await vi.advanceTimersByTimeAsync(599_999);
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(child.kill).toHaveBeenCalled();
    const raw = await p;
    expect(raw.completedAwaitingExit).toBe(true);
    expect(raw.backgroundWorkOpenAtResult).toBe(true);

    expect(messages(lines, 'background hold began')).toEqual([
      '[ClaudeCliRunner] background hold began openTasks=2 untracked=false ceilingMs=600000 resumed=false ' +
        'phase=speckit-implement iteration=1',
      '[ClaudeCliRunner] background hold began openTasks=1 untracked=false ceilingMs=600000 resumed=false ' +
        'phase=speckit-implement iteration=1'
    ]);
    expect(messages(lines, 'background hold ended')).toEqual([
      '[ClaudeCliRunner] background hold ended reason=ceiling heldMs=600000 ' +
        'phase=speckit-implement iteration=1'
    ]);
  });

  it('keeps the open-work report through the result the CLI writes after SIGTERM (B17)', async () => {
    // B5's shape, with the CLI research R2 measured: on the settle's SIGTERM it
    // stops the open task, writes `init` and a zero-turn `result`, and exits
    // 143. That result is the CLI shutting down, not a turn, so it does not
    // decide again, and the turn that ended with work open is reported so.
    const child = makeFakeChild(false);
    child.kill = vi.fn(() => {
      if (child.killed) return true;
      child.killed = true;
      child.stdout.emit('data', STOPPED_T1 + UPDATED_T1 + TASKS_CHANGED_EMPTY + STOPPED_T1);
      child.stdout.emit('data', INIT + RESULT);
      child.exitCode = 143;
      child.emit('exit', 143, null);
      child.emit('close', 143, null);
      return true;
    });
    const runner = new ClaudeCliRunner(spawnOpening(child, STARTED_T1 + RESULT));
    const p = runner.invoke({ ...baseReq, timeoutMs: DEFAULT_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(10 + 615_000);
    expect(child.kill).toHaveBeenCalled();
    const raw = await p;
    expect(raw.completedAwaitingExit).toBe(true);
    expect(raw.exitCode).toBe(143);
    expect(raw.backgroundWorkOpenAtResult).toBe(true);
  });

  function startedLine(taskId: string): string {
    return `{"type":"system","subtype":"task_started","is_backgrounded":true,"task_id":"${taskId}"}\n`;
  }

  function notifiedLine(taskId: string): string {
    return `{"type":"system","subtype":"task_notification","task_id":"${taskId}","status":"completed"}\n`;
  }

  // FR-R3-206 (T1890): a start dropped at a tracker bound keeps the hold to its ceiling.
  it('holds to the ceiling for a start dropped for an over-long id (B18)', async () => {
    const overLongId = 'q'.repeat(MAX_TASK_ID_LENGTH + 1);
    const { logger, lines } = capturingLogger();
    const child = makeFakeChild(true);
    const runner = new ClaudeCliRunner(
      spawnOpening(child, startedLine(overLongId) + RESULT),
      null,
      {},
      logger
    );
    const p = runner.invoke({ ...baseReq, timeoutMs: DEFAULT_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(child.kill).not.toHaveBeenCalled();

    // The ceiling falls at 600 010 ms and the settle follows it by 15 000 ms, as in B5.
    await vi.advanceTimersByTimeAsync(599_000);
    expect(child.kill).toHaveBeenCalled();
    const raw = await p;
    expect(raw.backgroundWorkOpenAtResult).toBe(true);

    expect(messages(lines, 'background hold ended')).toEqual([
      '[ClaudeCliRunner] background hold ended reason=ceiling heldMs=600000 ' +
        'phase=speckit-implement iteration=1'
    ]);
    expect(messages(lines, 'background hold began')).toEqual([
      '[ClaudeCliRunner] background hold began openTasks=0 untracked=true ceilingMs=600000 ' +
        'resumed=false phase=speckit-implement iteration=1'
    ]);
    // Four characters of the id are enough to find it in a line.
    expect(lines.filter((line) => line.includes('qqqq'))).toEqual([]);
  });

  it('holds to the ceiling when every tracked task closes but one start was dropped (B19)', async () => {
    const ids = Array.from({ length: MAX_OPEN_TASKS + 1 }, (_, index) => `t${index}`);
    const { logger, lines } = capturingLogger();
    const child = makeFakeChild(true);
    const runner = new ClaudeCliRunner(
      spawnOpening(child, ids.map(startedLine).join('') + RESULT),
      null,
      {},
      logger
    );
    const p = runner.invoke({ ...baseReq, timeoutMs: DEFAULT_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(child.kill).not.toHaveBeenCalled();

    // Closing the 256 tracked tasks leaves only the dropped start.
    child.stdout.emit('data', ids.slice(0, MAX_OPEN_TASKS).map(notifiedLine).join(''));
    await vi.advanceTimersByTimeAsync(16_000);
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(583_000);
    expect(child.kill).toHaveBeenCalled();
    const raw = await p;
    expect(raw.backgroundWorkOpenAtResult).toBe(true);

    expect(messages(lines, 'background hold ended')).toEqual([
      '[ClaudeCliRunner] background hold ended reason=ceiling heldMs=600000 ' +
        'phase=speckit-implement iteration=1'
    ]);
    expect(lines.filter((line) => line.includes('reason=closed'))).toEqual([]);
    expect(messages(lines, 'background hold began')).toEqual([
      '[ClaudeCliRunner] background hold began openTasks=256 untracked=true ceilingMs=600000 ' +
        'resumed=false phase=speckit-implement iteration=1'
    ]);
  });

  it('clears the ceiling when the CLI exits on its own during a hold on a dropped start (B20)', async () => {
    const { logger, lines } = capturingLogger();
    const child = makeFakeChild(true);
    const runner = new ClaudeCliRunner(
      spawnOpening(child, startedLine('q'.repeat(MAX_TASK_ID_LENGTH + 1)) + RESULT),
      null,
      {},
      logger
    );
    const p = runner.invoke({ ...baseReq, timeoutMs: DEFAULT_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1_000);
    exitCleanly(child);
    const raw = await p;
    expect(child.kill).not.toHaveBeenCalled();
    expect(raw.backgroundWorkOpenAtResult).toBe(true);

    // A ceiling left armed would fire in here and log the hold's end, as in B15.
    const loggedAtExit = lines.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(lines).toHaveLength(loggedAtExit);
  });

  /** The `invocationId` the runner stamped on its `started` event. */
  function startedInvocationId(events: ReadonlyArray<MonitorSidecarEvent>): string {
    const started = events.find((event) => event.kind === 'started');
    if (started === undefined) throw new Error('the runner reported no started event');
    return started.invocationId;
  }

  // FR-R3-208 (T1893): the runner reports a hold's begin and end to the monitor's hook.
  it('reports a hold when it begins and when its last task closes (B21)', async () => {
    const events: MonitorSidecarEvent[] = [];
    const holds = () => events.filter((event) => event.kind === 'background-hold');
    const child = makeFakeChild(true);
    const runner = new ClaudeCliRunner(
      spawnOpening(child, STARTED_T1 + RESULT),
      (event) => events.push(event)
    );
    const p = runner.invoke({ ...baseReq, runId: 'run-1', timeoutMs: DEFAULT_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(10);
    const invocationId = startedInvocationId(events);
    expect(holds()).toEqual([
      { kind: 'background-hold', runId: 'run-1', invocationId, held: true }
    ]);

    child.stdout.emit('data', NOTIFIED_T1);
    expect(holds()).toHaveLength(2);
    expect(holds()[1]).toEqual({
      kind: 'background-hold',
      runId: 'run-1',
      invocationId,
      held: false
    });

    // The hold event names the invocation its chunk events name.
    expect(events.some((event) => event.kind === 'stdout-chunk')).toBe(true);
    for (const event of events) {
      if (event.kind === 'stdout-chunk') expect(event.invocationId).toBe(invocationId);
    }

    exitCleanly(child);
    await p;
  });

  it('reports the hold ending when the ceiling falls (B22)', async () => {
    const events: MonitorSidecarEvent[] = [];
    const holds = () => events.filter((event) => event.kind === 'background-hold');
    const child = makeFakeChild(true);
    const runner = new ClaudeCliRunner(
      spawnOpening(child, STARTED_T1 + RESULT),
      (event) => events.push(event)
    );
    const p = runner.invoke({ ...baseReq, runId: 'run-1', timeoutMs: DEFAULT_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(10);
    const invocationId = startedInvocationId(events);
    expect(holds()).toEqual([
      { kind: 'background-hold', runId: 'run-1', invocationId, held: true }
    ]);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(holds()).toHaveLength(2);
    expect(holds()[1]).toEqual({
      kind: 'background-hold',
      runId: 'run-1',
      invocationId,
      held: false
    });

    exitCleanly(child);
    await p;
  });

  it('reports a replacing hold as another begin, and the CLI exit as no end (B23)', async () => {
    // B16's timeline: a result accepted during a hold begins a new one (D2), and
    // the CLI's own exit clears the ceiling without ending the hold (D1), so the
    // monitor's exit handling is what clears the flag.
    const events: MonitorSidecarEvent[] = [];
    const holds = () => events.filter((event) => event.kind === 'background-hold');
    const child = makeFakeChild(true);
    const runner = new ClaudeCliRunner(
      spawnOpening(child, STARTED_T1 + STARTED_T2 + RESULT),
      (event) => events.push(event)
    );
    const p = runner.invoke({ ...baseReq, runId: 'run-1', timeoutMs: DEFAULT_TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(16_000);
    child.stdout.emit('data', NOTIFIED_T1);
    child.stdout.emit('data', INIT + WOKEN_TURN_TEXT + RESULT);
    const invocationId = startedInvocationId(events);
    const began = { kind: 'background-hold', runId: 'run-1', invocationId, held: true };
    expect(holds()).toEqual([began, began]);

    // Still two, both begins: the exit sent no `held: false`.
    exitCleanly(child);
    await p;
    expect(holds()).toEqual([began, began]);
  });
});
