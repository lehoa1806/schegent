import { describe, it, expect } from 'vitest';
import {
  DEFAULT_QUEUE_ID,
  MAX_QUEUES,
  QueueRegistryViolation,
  makeDefaultRegistry,
  validateQueueRegistry,
  type QueueRegistry,
  type QueueRegistryEntry,
  type QueueSchedule
} from '../../../src/queue/queue-registry';

const NOW = 1_700_000_000_000;
const UUID_A = '11111111-2222-4333-8444-555555555555';

function defaultEntry(overrides: Partial<QueueRegistryEntry> = {}): QueueRegistryEntry {
  return {
    id: DEFAULT_QUEUE_ID,
    name: 'Default queue',
    position: 0,
    state: 'active',
    pauseSource: null,
    schedule: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function registryOf(entries: QueueRegistryEntry[]): QueueRegistry {
  return { entries, updatedAt: NOW };
}

describe('queue-registry — feature 030 single-queue v6 invariants', () => {
  it('MAX_QUEUES is 1', () => {
    expect(MAX_QUEUES).toBe(1);
  });

  it('accepts the canonical single-entry shape (fresh default registry)', () => {
    expect(() => validateQueueRegistry(makeDefaultRegistry(NOW))).not.toThrow();
  });

  it('accepts a manually-paused single entry with pauseSource: operator', () => {
    const registry = registryOf([
      defaultEntry({ state: 'manually-paused', pauseSource: 'operator' })
    ]);
    expect(() => validateQueueRegistry(registry)).not.toThrow();
  });

  it('rejects multi-entry input with expected-single-entry', () => {
    const registry = registryOf([
      defaultEntry(),
      defaultEntry({ id: UUID_A, name: 'Other', position: 1 })
    ]);
    let caught: unknown = null;
    try {
      validateQueueRegistry(registry);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QueueRegistryViolation);
    expect((caught as QueueRegistryViolation).code).toBe('expected-single-entry');
  });

  it('rejects non-default id on the single entry', () => {
    const registry = registryOf([defaultEntry({ id: UUID_A, name: 'Stranger' })]);
    let caught: unknown = null;
    try {
      validateQueueRegistry(registry);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QueueRegistryViolation);
    // The non-default id fails the missing-default check first.
    expect((caught as QueueRegistryViolation).code).toMatch(
      /invalid-registry-state|invalid-queue-id/
    );
  });

  it('rejects non-zero position on the single entry', () => {
    const registry = registryOf([defaultEntry({ position: 1 })]);
    let caught: unknown = null;
    try {
      validateQueueRegistry(registry);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QueueRegistryViolation);
    // Position 1 is rejected by the contiguous-from-0 invariant.
    expect((caught as QueueRegistryViolation).code).toBe('invalid-registry-state');
  });

  it('rejects non-null schedule on the single entry with schedule-not-supported', () => {
    const schedule: QueueSchedule = {
      kind: 'relative',
      expression: 'in 5m',
      targetAt: new Date(NOW + 5 * 60_000).toISOString(),
      setAt: new Date(NOW).toISOString(),
      recurrence: 'one-shot'
    };
    const registry = registryOf([defaultEntry({ schedule })]);
    let caught: unknown = null;
    try {
      validateQueueRegistry(registry);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QueueRegistryViolation);
    expect((caught as QueueRegistryViolation).code).toBe('schedule-not-supported');
  });

  it('preserves the existing pause-source invariant (manually-paused requires pauseSource)', () => {
    const registry = registryOf([
      defaultEntry({ state: 'manually-paused', pauseSource: null })
    ]);
    expect(() => validateQueueRegistry(registry)).toThrowError(/invalid pauseSource/);
  });

  it('preserves the existing pause-source invariant (active forbids non-null pauseSource)', () => {
    const registry = registryOf([
      defaultEntry({ state: 'active', pauseSource: 'operator' as never })
    ]);
    expect(() => validateQueueRegistry(registry)).toThrowError(/non-null pauseSource/);
  });
});
