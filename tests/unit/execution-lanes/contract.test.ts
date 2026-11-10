import { describe, expect, it } from 'vitest';

import {
  INTEGRATION_STATES,
  JOURNAL_OUTCOMES,
  LANE_CAP_DEFAULT,
  LANE_CAP_MAX,
  LANE_DISCLOSURE,
  LANE_OBSERVATIONS,
  LANE_PAGE_LIMIT_MAX,
  LANE_REFUSAL_REASONS,
  LANE_STATES,
  LIVE_LANE_STATES,
  PROVISIONING_DEADLINE_DEFAULT_MS,
  PROVISIONING_DEADLINE_MAX_MS,
  PROVISIONING_DEADLINE_MIN_MS,
  PROVISIONING_REFUSAL_REASONS,
  RECEIPT_OUTCOMES,
  VERIFICATION_LIMITS,
  laneOk,
  laneRefused
} from '../../../src/contracts/execution-lanes';

describe('execution-lanes contract (FR-R6-F10)', () => {
  it('fixes the disclosure text (FR-007)', () => {
    expect(LANE_DISCLOSURE).toBe(
      'A lane is a separate Git working tree. It is a working-tree boundary, not a permission boundary: ' +
        "the repository's hooks, configuration, credentials and object store are shared with it, and a " +
        "process in a lane can reach anything the operator's checkout can. Lane operations may run the " +
        "repository's hooks, and a fast-forward landing in a checked-out branch may run `post-merge`."
    );
  });

  it('lists eight lane states and eight integration states', () => {
    expect(LANE_STATES).toHaveLength(8);
    expect(INTEGRATION_STATES).toHaveLength(8);
    expect(new Set(LANE_STATES).size).toBe(8);
    expect(new Set(INTEGRATION_STATES).size).toBe(8);
  });

  it('counts only preparing, active and paused as live', () => {
    expect([...LIVE_LANE_STATES]).toEqual(['preparing', 'active', 'paused']);
    for (const state of LIVE_LANE_STATES) expect(LANE_STATES).toContain(state);
  });

  it('starts the refusal list with the eight provisioning reasons, no duplicates', () => {
    expect(PROVISIONING_REFUSAL_REASONS).toHaveLength(8);
    expect(LANE_REFUSAL_REASONS.slice(0, 8)).toEqual([...PROVISIONING_REFUSAL_REASONS]);
    expect(LANE_REFUSAL_REASONS).toHaveLength(29);
    expect(new Set(LANE_REFUSAL_REASONS).size).toBe(LANE_REFUSAL_REASONS.length);
  });

  it('keeps observations disjoint from refusal reasons', () => {
    const reasons = new Set<string>(LANE_REFUSAL_REASONS);
    for (const observation of LANE_OBSERVATIONS) expect(reasons.has(observation)).toBe(false);
  });

  it('adds only canceled to the receipt outcomes for the journal', () => {
    expect([...JOURNAL_OUTCOMES]).toEqual([...RECEIPT_OUTCOMES, 'canceled']);
  });

  it('fixes the bounds', () => {
    expect(LANE_PAGE_LIMIT_MAX).toBe(200);
    expect(LANE_CAP_DEFAULT).toBe(1);
    expect(LANE_CAP_MAX).toBe(20);
    expect(PROVISIONING_DEADLINE_DEFAULT_MS).toBe(120_000);
    expect(PROVISIONING_DEADLINE_MIN_MS).toBe(1_000);
    expect(PROVISIONING_DEADLINE_MAX_MS).toBe(600_000);
    expect(VERIFICATION_LIMITS).toEqual({
      maxChecks: 8,
      maxArgs: 32,
      maxArgChars: 512,
      minTimeoutMs: 1_000,
      maxTimeoutMs: 600_000,
      maxProfileJsonBytes: 8_192
    });
  });

  it('freezes every exported list', () => {
    for (const list of [LANE_STATES, INTEGRATION_STATES, LANE_REFUSAL_REASONS, LANE_OBSERVATIONS, VERIFICATION_LIMITS]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });

  it('builds results with and without commits', () => {
    expect(laneOk(3)).toEqual({ ok: true, value: 3 });
    expect(laneRefused('lane-busy')).toEqual({ ok: false, refusal: { reason: 'lane-busy' } });
    const commits = { expected: 'a'.repeat(40), candidate: 'b'.repeat(40) };
    expect(laneRefused('target-advanced', commits)).toEqual({
      ok: false,
      refusal: { reason: 'target-advanced', commits }
    });
  });
});
