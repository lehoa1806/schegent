/**
 * FR-R6-F06 (T005, research R2) — the additive F02 extension: distinct cache counters and
 * their relation to input tokens.
 */
import { describe, expect, it } from 'vitest';
import {
  SHARED_STORAGE_CONTRACT_VERSION,
  acceptUsageObservation,
  createObservationLedgerState,
  type UsageObservationInput
} from '../../../src/contracts';

function observation(overrides: Record<string, unknown> = {}): UsageObservationInput {
  return {
    schemaVersion: SHARED_STORAGE_CONTRACT_VERSION,
    workspaceId: 'ws-1',
    queueId: 'queue-main',
    rootExecutionId: 'run-1',
    attemptId: 'att-1',
    producerNamespace: 'claude-cli',
    producerObservationId: 'obs-1',
    source: 'cli-stream',
    observationTimeUtc: '2026-11-09T09:00:00Z',
    counterScope: 'attempt-incremental',
    inputTokens: 100n,
    outputTokens: 20n,
    quality: { provenance: 'observed', completeness: 'known' },
    ...overrides
  } as UsageObservationInput;
}

describe('F02 cache counter extension (T005)', () => {
  it('accepts both cache counters and a relation, keeping them exact', () => {
    const res = acceptUsageObservation(
      createObservationLedgerState(),
      observation({
        cacheReadTokens: 400n,
        cacheCreationTokens: '50',
        cacheRelation: 'disjoint'
      })
    );
    expect(res.status).toBe('accepted');
    if (res.status !== 'accepted') return;
    expect(res.value.cacheReadTokens).toBe(400n);
    expect(res.value.cacheCreationTokens).toBe(50n);
    expect(res.value.cacheRelation).toBe('disjoint');
  });

  it('leaves the cache fields null when they are absent', () => {
    const res = acceptUsageObservation(createObservationLedgerState(), observation());
    expect(res.status).toBe('accepted');
    if (res.status !== 'accepted') return;
    expect(res.value.cacheReadTokens).toBeNull();
    expect(res.value.cacheCreationTokens).toBeNull();
    expect(res.value.cacheRelation).toBe('unknown');
  });

  it.each([
    ['cacheReadTokens', -1],
    ['cacheReadTokens', 1.5],
    ['cacheCreationTokens', 'abc'],
    ['cacheCreationTokens', -5n]
  ])('refuses %s = %s', (field, value) => {
    const res = acceptUsageObservation(
      createObservationLedgerState(),
      observation({ [field]: value })
    );
    expect(res.status).toBe('refused');
    if (res.status !== 'refused') return;
    expect(res.error.field).toBe(field);
  });

  it('refuses an unknown cacheRelation', () => {
    const res = acceptUsageObservation(
      createObservationLedgerState(),
      observation({ cacheRelation: 'overlapping' })
    );
    expect(res.status).toBe('refused');
    if (res.status !== 'refused') return;
    expect(res.error.field).toBe('cacheRelation');
  });

  it('still refuses any other unknown key', () => {
    const res = acceptUsageObservation(
      createObservationLedgerState(),
      observation({ cacheWriteTokens: 1 })
    );
    expect(res.status).toBe('refused');
  });
});
