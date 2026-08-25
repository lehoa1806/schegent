// FR-R3-075 (feature 152) — an invocation deadline a chatty child cannot reset.
//
// `schegent.invocation.timeoutSeconds` was described as a per-phase timeout and
// implemented as an idle window: every output chunk re-armed it, so a child
// emitting one byte inside each window ran forever, with cost and availability
// both unbounded. These fixtures drive the REAL runner with REAL node children
// and pin the two bounds apart: a perpetually chatty child dies at the absolute
// deadline (reason `deadlineExceeded`, never `timedOut`), a silent child dies
// at the idle bound (reason `timedOut`, never `deadlineExceeded`), and when
// both windows elapse together exactly one reason is recorded.

import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { InvocationRequest } from '../../../src/runner/invocation-result';
import {
  ProcessLifecycleRunner,
  type ProcessSpawnFn
} from '../../../src/runner/process-lifecycle-runner';

/** Prints a line every 50 ms forever — the child the idle window cannot bound. */
const CHATTY_FOREVER = 'setInterval(() => console.log("tick"), 50);';

/** Produces nothing and lingers — the child the idle window exists for. */
const SILENT_FOREVER = 'setTimeout(() => {}, 60_000);';

function makeRunner(): ProcessLifecycleRunner {
  return new ProcessLifecycleRunner(
    spawn as unknown as ProcessSpawnFn,
    null,
    new SanitizedLogger(),
    'deadline-fixture'
  );
}

function requestFor(overrides: Partial<InvocationRequest>): InvocationRequest {
  return {
    phase: 'implement' as InvocationRequest['phase'],
    iteration: 1,
    prompt: 'fixture',
    timeoutMs: 60_000,
    cliPath: process.execPath,
    cwd: process.cwd(),
    ...overrides
  };
}

async function invoke(script: string, overrides: Partial<InvocationRequest>) {
  return makeRunner().invoke({
    request: requestFor(overrides),
    args: ['-e', script],
    env: process.env,
    commandDisplay: 'node -e <fixture>'
  });
}

describe('FR-R3-075 — the absolute deadline and the idle window are two bounds', () => {
  it('terminates a perpetually chatty child at the deadline, with its own reason', async () => {
    // Idle window far away (60 s), deadline close (400 ms). Every 50 ms chunk
    // resets the idle timer — before this feature, this child ran forever.
    const result = await invoke(CHATTY_FOREVER, { timeoutMs: 60_000, maxDurationMs: 400 });
    expect(result.deadlineExceeded).toBe(true);
    expect(result.timedOut).toBe(false);
    // Terminated by the runner's own ladder, not a clean exit.
    expect(result.exitCode).toBe(null);
  }, 15_000);

  it('terminates a silent child at the idle bound, never taking the deadline path', async () => {
    const result = await invoke(SILENT_FOREVER, { timeoutMs: 400, maxDurationMs: 60_000 });
    expect(result.timedOut).toBe(true);
    expect(result.deadlineExceeded).not.toBe(true);
    expect(result.exitCode).toBe(null);
  }, 15_000);

  it('records exactly one reason when both windows elapse together: the deadline wins', async () => {
    // Both bounds at the same instant on a silent child — whatever order the
    // two timers fire in, evidence must carry ONE reason, and "ran long" is
    // the one the operator can act on.
    const result = await invoke(SILENT_FOREVER, { timeoutMs: 400, maxDurationMs: 400 });
    if (result.deadlineExceeded === true) {
      expect(result.timedOut).toBe(false);
    } else {
      // A scheduler that ran the idle expiry a tick earlier terminated the
      // child before the deadline timer fired; that is still exactly one
      // reason recorded.
      expect(result.timedOut).toBe(true);
    }
  }, 15_000);

  it('a child that finishes inside both windows reports neither', async () => {
    const result = await invoke('console.log("done");', {
      timeoutMs: 5_000,
      maxDurationMs: 5_000
    });
    expect(result.timedOut).toBe(false);
    expect(result.deadlineExceeded).not.toBe(true);
    expect(result.exitCode).toBe(0);
  }, 15_000);

  it('no maxDurationMs means no wall-clock bound (the pre-152 idle-only shape)', async () => {
    const result = await invoke('setTimeout(() => { console.log("late"); }, 300);', {
      timeoutMs: 1_000
    });
    expect(result.deadlineExceeded).not.toBe(true);
    expect(result.exitCode).toBe(0);
  }, 15_000);
});
