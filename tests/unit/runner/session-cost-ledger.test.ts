// FR-R3-198 (FR-011, T1882) — `total_cost_usd` is the CLI session's running
// total, and it carries across `--resume` (research R9). So the claude runner
// remembers the figure it last recorded for each session, and reports it as
// the baseline of that session's next invocation; the usage extractor
// subtracts it (contract K1 to K3).
//
// The runner cases drive `ClaudeCliRunner` through `claude-cli-completion.test.ts`'s
// fake-child setup, copied below, one runner across several invocations.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import type { ChildProcess } from 'child_process';
import { ClaudeCliRunner, type SpawnFn } from '../../../src/runner/claude-cli';
import type {
  InvocationRequest,
  RawInvocationOutput
} from '../../../src/runner/invocation-result';
import {
  MAX_TRACKED_SESSIONS,
  SessionCostLedger
} from '../../../src/runner/session-cost-ledger';

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
    if (emitExitOnKill) {
      child.emit('exit', null, 'SIGTERM');
      child.emit('close', null, 'SIGTERM');
    }
    return true;
  });
  return child;
}

const baseReq = {
  phase: 'speckit-implement' as const,
  iteration: 1,
  prompt: 'do work',
  cliPath: 'claude',
  cwd: '/repo'
};

const SESSION = 'session-a';
/** A later phase continuing `SESSION`, as cross-phase session reuse does. */
const RESUMED = { sessionReuse: true, resumeSessionId: SESSION } as const;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** One turn of `sessionId`, whose `result` reports a running total of `costUsd`. */
function turn(sessionId: string | null, costUsd: number | null): string {
  const id = sessionId === null ? '' : `,"session_id":"${sessionId}"`;
  const cost = costUsd === null ? '' : `,"total_cost_usd":${costUsd}`;
  return (
    `{"type":"system","subtype":"init"${id}}\n` +
    `{"type":"result","subtype":"success","num_turns":1${id}${cost}}\n`
  );
}

/** Spawns one child per invocation; each writes its output 10 ms in and exits 0. */
function spawnEach(outputs: ReadonlyArray<string>): SpawnFn {
  let calls = 0;
  return () => {
    const output = outputs[calls] ?? '';
    calls += 1;
    const child = makeFakeChild(false);
    setTimeout(() => {
      child.stdout.emit('data', output);
      child.exitCode = 0;
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    }, 10);
    return child as unknown as ChildProcess;
  };
}

async function invokeOnce(
  runner: ClaudeCliRunner,
  overrides: Partial<InvocationRequest>
): Promise<RawInvocationOutput> {
  const pending = runner.invoke({ ...baseReq, timeoutMs: 90 * 60_000, ...overrides });
  await vi.advanceTimersByTimeAsync(10);
  return pending;
}

describe('SessionCostLedger (K1)', () => {
  it('has no figure for a session it has not recorded', () => {
    expect(new SessionCostLedger().get(SESSION)).toBeUndefined();
  });

  it('returns the figure last recorded for a session', () => {
    const ledger = new SessionCostLedger();
    ledger.record(SESSION, 1.0);
    ledger.record(SESSION, 1.6);
    expect(ledger.get(SESSION)).toBe(1.6);
  });

  it('evicts the oldest session when a 65th is recorded', () => {
    expect(MAX_TRACKED_SESSIONS).toBe(64);
    const ledger = new SessionCostLedger();
    for (let i = 0; i < 65; i += 1) ledger.record(`session-${i}`, i);
    expect(ledger.get('session-0')).toBeUndefined();
    expect(ledger.get('session-1')).toBe(1);
    expect(ledger.get('session-64')).toBe(64);
  });

  it('refreshes a session it reads, so the next eviction takes another', () => {
    const ledger = new SessionCostLedger();
    for (let i = 0; i < 64; i += 1) ledger.record(`session-${i}`, i);
    expect(ledger.get('session-0')).toBe(0);
    ledger.record('session-64', 64);
    expect(ledger.get('session-0')).toBe(0);
    expect(ledger.get('session-1')).toBeUndefined();
  });

  it('records a figure only into an empty slot (recordIfAbsent)', () => {
    const ledger = new SessionCostLedger();
    ledger.recordIfAbsent(SESSION, 1.0);
    expect(ledger.get(SESSION)).toBe(1.0);
    ledger.recordIfAbsent(SESSION, 2.0);
    expect(ledger.get(SESSION)).toBe(1.0);
  });
});

describe('ClaudeCliRunner session cost baseline (K2)', () => {
  it('R1: reports the cost it last recorded for the session as the next baseline', async () => {
    const runner = new ClaudeCliRunner(spawnEach([turn(SESSION, 1.0), turn(SESSION, 1.6)]));
    const first = await invokeOnce(runner, {});
    const second = await invokeOnce(runner, RESUMED);
    expect(first.sessionCostBaselineUsd).toBeUndefined();
    expect(second.sessionCostBaselineUsd).toBe(1.0);
  });

  it('R2: a helper invocation between two phases leaves the baseline as it was', async () => {
    // Compaction spend is real spend that no `phase-end` records, so it lands
    // in the next phase's figure (K5).
    const runner = new ClaudeCliRunner(
      spawnEach([turn(SESSION, 1.0), turn(SESSION, 1.3), turn(SESSION, 1.6)])
    );
    await invokeOnce(runner, {});
    await invokeOnce(runner, { ...RESUMED, helperInvocation: true });
    const next = await invokeOnce(runner, RESUMED);
    expect(next.sessionCostBaselineUsd).toBe(1.0);
  });

  it('R3: an invocation with no session id or no cost records nothing', async () => {
    const runner = new ClaudeCliRunner(
      spawnEach([turn(SESSION, 1.0), turn(null, 1.3), turn(SESSION, null), turn(SESSION, 1.6)])
    );
    await invokeOnce(runner, {});
    const noSession = await invokeOnce(runner, {});
    const noCost = await invokeOnce(runner, RESUMED);
    const next = await invokeOnce(runner, RESUMED);
    expect(noSession.sessionCostBaselineUsd).toBeUndefined();
    expect(noCost.sessionCostBaselineUsd).toBe(1.0);
    expect(next.sessionCostBaselineUsd).toBe(1.0);
  });

  // FR-R3-209 — after a restart the ledger is empty, and the Run's persisted figure fills it.
  it('R4: a resume after a restart takes the request figure as its baseline', async () => {
    const runner = new ClaudeCliRunner(spawnEach([turn(SESSION, 1.6)]));
    const resumed = await invokeOnce(runner, { ...RESUMED, resumeSessionCostUsd: 1.0 });
    expect(resumed.sessionCostBaselineUsd).toBe(1.0);
  });

  it('R5: a figure for another session than the one reported is not used', async () => {
    const runner = new ClaudeCliRunner(spawnEach([turn(SESSION, 1.6)]));
    const resumed = await invokeOnce(runner, {
      ...RESUMED,
      resumeSessionId: 'session-b',
      resumeSessionCostUsd: 1.0
    });
    expect(resumed.sessionCostBaselineUsd).toBeUndefined();
  });

  it('R6: the ledger figure wins over the request figure', async () => {
    const runner = new ClaudeCliRunner(spawnEach([turn(SESSION, 1.3), turn(SESSION, 1.6)]));
    await invokeOnce(runner, {});
    const resumed = await invokeOnce(runner, { ...RESUMED, resumeSessionCostUsd: 1.0 });
    expect(resumed.sessionCostBaselineUsd).toBe(1.3);
  });

  it('R7: the result reports the ledger figure once the invocation is recorded', async () => {
    const runner = new ClaudeCliRunner(
      spawnEach([turn(SESSION, 1.0), turn(SESSION, 1.3), turn(SESSION, null), turn('session-new', null)])
    );
    const recorded = await invokeOnce(runner, {});
    const helper = await invokeOnce(runner, { ...RESUMED, helperInvocation: true });
    const noCost = await invokeOnce(runner, RESUMED);
    const fresh = await invokeOnce(runner, {});
    expect(recorded.cliSessionCostUsd).toBe(1.0);
    expect(helper.cliSessionCostUsd).toBe(1.0);
    expect(noCost.cliSessionCostUsd).toBe(1.0);
    expect(fresh.cliSessionCostUsd).toBeUndefined();
  });

  it('R8: a helper that carried no figure leaves the phase to take the figure and its cost', async () => {
    const runner = new ClaudeCliRunner(spawnEach([turn(SESSION, 1.3), turn(SESSION, 1.6)]));
    await invokeOnce(runner, { ...RESUMED, helperInvocation: true });
    const phase = await invokeOnce(runner, { ...RESUMED, resumeSessionCostUsd: 1.0 });
    expect(phase.sessionCostBaselineUsd).toBe(1.0);
  });
});
