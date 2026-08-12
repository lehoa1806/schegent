// Feature 091 (T003, US1) — the bounded existence probe.
//
// FR-006b: a check that has not answered within a bounded interval is recorded
// unresolved, so one unreachable location cannot hold the completion transition
// open. R3 in contracts/run-output-recording.md places that bound *inside the
// probe adapter* rather than in the resolver, which is why this file exists
// separately: the resolver stays a pure function of its injected probe and its
// own tests need no fake timers.
//
// The bound is per check, not shared. A shared deadline would make every check
// after a slow one fail for a reason that is not its own, contradicting R2.
//
// A timed-out probe *rejects*; it does not answer `false`. The two are different
// claims — "I looked and nothing is there" versus "I could not look" — and the
// resolver's per-iteration catch (T010) is what turns the second into an
// unresolved record. Answering `false` here would launder a non-answer into an
// answer one layer too early.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OUTPUT_PROBE_TIMEOUT_MS,
  createBoundedOutputProbe
} from '../../../../src/services/run-output/run-output-probe';

const lstat = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', () => ({
  default: { lstat },
  lstat
}));

describe('createBoundedOutputProbe (FR-006b, R3)', () => {
  beforeEach(() => {
    lstat.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('bounds the wait at two seconds', () => {
    expect(OUTPUT_PROBE_TIMEOUT_MS).toBe(2_000);
  });

  it('answers true when the path is there', async () => {
    lstat.mockResolvedValue({});
    await expect(createBoundedOutputProbe().exists('/workspace/out/report.md')).resolves.toBe(true);
  });

  it('answers false when the path is missing', async () => {
    lstat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(createBoundedOutputProbe().exists('/workspace/out/gone.md')).resolves.toBe(false);
  });

  it('answers false for any filesystem error, because a failed look is not a sighting', async () => {
    lstat.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(createBoundedOutputProbe().exists('/workspace/out/locked.md')).resolves.toBe(
      false
    );
  });

  it('answers false for a filesystem error whose own message reads like a timeout', async () => {
    // The adapter distinguishes its own timeout by type, not by matching the
    // message. A driver or network mount that reports "operation timed out" has
    // still answered the question — the location could not be examined — and an
    // answer of `false` is the right one. Classifying by substring would turn
    // this into a rejection and record it as a non-answer.
    lstat.mockRejectedValue(Object.assign(new Error('ETIMEDOUT: operation timed out'), {
      code: 'ETIMEDOUT'
    }));
    await expect(createBoundedOutputProbe().exists('/workspace/out/mount.md')).resolves.toBe(false);
  });

  it('rejects rather than answering when the call never settles', async () => {
    vi.useFakeTimers();
    lstat.mockReturnValue(new Promise(() => {}));

    const pending = createBoundedOutputProbe().exists('/workspace/out/hung.md');
    const asserted = expect(pending).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(OUTPUT_PROBE_TIMEOUT_MS);
    await asserted;
  });

  it('does not fire the timer for a call that settled, so a fast check is unaffected', async () => {
    vi.useFakeTimers();
    lstat.mockResolvedValue({});

    await expect(createBoundedOutputProbe().exists('/workspace/out/report.md')).resolves.toBe(true);

    // A leaked timer would still be pending here and would reject into nothing.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds each invocation independently, so a slow check spends no other budget', async () => {
    vi.useFakeTimers();
    lstat.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce({});

    const probe = createBoundedOutputProbe();
    const hung = probe.exists('/workspace/out/hung.md');
    const asserted = expect(hung).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(OUTPUT_PROBE_TIMEOUT_MS);
    await asserted;

    // The second check gets a full budget of its own, not what the first left.
    await expect(probe.exists('/workspace/out/report.md')).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
