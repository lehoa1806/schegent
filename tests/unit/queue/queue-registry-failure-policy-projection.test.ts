// Feature 195 (T039, FR-014, FR-018, research D1) — the registry's effective
// failure-policy projection, built the same way `state`/`pauseSource` are:
// `projectQueueRegistry` derives it from `QueueState.failurePolicy` and the
// workspace default, and it is never a second stored copy.

import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { describe, it, expect } from 'vitest';
import { makeDefaultRegistry, projectQueueRegistry } from '../../../src/queue/queue-registry';
import type { QueueFailurePolicy } from '../../../src/contracts/queue-failure-policy';

const NOW = 1_700_000_000_000;

function projectWith(
  stored: QueueFailurePolicy | undefined,
  workspaceDefault: QueueFailurePolicy
) {
  const registry = makeDefaultRegistry(NOW);
  const failurePolicyByQueueId = new Map<string, QueueFailurePolicy | undefined>([
    [DEFAULT_QUEUE_ID, stored]
  ]);
  return projectQueueRegistry(registry, new Map(), failurePolicyByQueueId, workspaceDefault)
    .entries[0]!;
}

describe('queue-registry effective failure-policy projection', () => {
  it('an un-opinionated queue (no stored value) reads the workspace default as its effective policy', () => {
    const entry = projectWith(undefined, 'continue');
    expect(entry.failurePolicy).toBe('continue');
    expect(entry.failurePolicyOverride).toBeNull();
  });

  it('an overridden queue keeps its own answer regardless of the workspace default', () => {
    const entry = projectWith('continue', 'halt-on-failure');
    expect(entry.failurePolicy).toBe('continue');
    expect(entry.failurePolicyOverride).toBe('continue');
  });

  it('a queue returned to "follow the default" (stored removed) tracks the default again', () => {
    const followingDefault = projectWith(undefined, 'halt-on-failure');
    expect(followingDefault.failurePolicy).toBe('halt-on-failure');
    expect(followingDefault.failurePolicyOverride).toBeNull();
  });

  it('omitting the new parameters entirely projects every entry onto the literal package default', () => {
    const registry = makeDefaultRegistry(NOW);
    const entry = projectQueueRegistry(registry, new Map()).entries[0]!;
    expect(entry.failurePolicy).toBe('halt-on-failure');
    expect(entry.failurePolicyOverride).toBeNull();
  });
});
