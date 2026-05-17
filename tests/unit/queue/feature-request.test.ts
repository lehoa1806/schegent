import { describe, it, expect } from 'vitest';
import {
  MAX_DESCRIPTION_LENGTH,
  ensureExtendedFeatureRequest,
  validateDescription,
  type FeatureRequest
} from '../../../src/queue/feature-request';

describe('validateDescription', () => {
  it('returns the trimmed description for valid input', () => {
    expect(validateDescription('  hello  ')).toBe('hello');
  });

  it('throws on empty / whitespace-only input', () => {
    expect(() => validateDescription('   ')).toThrow(/non-empty/);
  });

  it('throws when over the cap', () => {
    expect(() => validateDescription('x'.repeat(MAX_DESCRIPTION_LENGTH + 1))).toThrow(/exceeds/);
  });
});

describe('ensureExtendedFeatureRequest backfills missing fields', () => {
  it('fills the new 004 fields with defaults when absent', () => {
    const legacy = {
      id: 'r-1',
      description: 'do thing',
      enqueuedAt: 1_700_000_000_000,
      status: 'pending' as const,
      position: 0,
      runId: null
    };
    const upgraded: FeatureRequest = ensureExtendedFeatureRequest(legacy);
    expect(upgraded.retryCount).toBe(0);
    expect(upgraded.lastError).toBeNull();
    expect(upgraded.pausedReason).toBeNull();
    expect(upgraded.startedAt).toBeNull();
    expect(upgraded.completedAt).toBeNull();
    expect(upgraded.createdAt).toBe(1_700_000_000_000);
    expect(upgraded.updatedAt).toBe(1_700_000_000_000);
  });

  it('preserves explicit values when supplied', () => {
    const upgraded = ensureExtendedFeatureRequest({
      id: 'r-2',
      description: 'do thing',
      enqueuedAt: 1_000,
      status: 'failed',
      position: 1,
      runId: 'r-1',
      retryCount: 3,
      lastError: 'boom',
      pausedReason: null,
      startedAt: 1_500,
      updatedAt: 2_000,
      completedAt: 2_500,
      createdAt: 800
    });
    expect(upgraded.retryCount).toBe(3);
    expect(upgraded.lastError).toBe('boom');
    expect(upgraded.startedAt).toBe(1_500);
    expect(upgraded.updatedAt).toBe(2_000);
    expect(upgraded.completedAt).toBe(2_500);
    expect(upgraded.createdAt).toBe(800);
  });
});

describe('FeatureRequest status taxonomy', () => {
  it('uses canonical in-flight status (not running)', () => {
    const upgraded: FeatureRequest = ensureExtendedFeatureRequest({
      id: 'r-3',
      description: 'do thing',
      enqueuedAt: 1_000,
      status: 'in-flight',
      position: 0,
      runId: 'run-1'
    });
    expect(upgraded.status).toBe('in-flight');
  });
});
