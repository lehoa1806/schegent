// FR-R6-F05 (T039, T040, contract surfaces-and-wiring.md §4) — the headless retention-policy and
// archival functions validate the request shape, then return the service's result unchanged. The
// service, not the caller, decides whether a run's control frames are resolved: with no ledger
// lookup injected every run counts as unresolved, so nothing is archived (fail closed).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETENTION_POLICY,
  type ArchivalQueueInput
} from '../../../src/contracts/artifact-lifecycle/retention-policy-types';
import {
  adoptRetentionPolicy,
  archiveTerminalTasks,
  previewRetentionPolicy,
  previewTaskArchival
} from '../../../src/headless/artifact-lifecycle-api';
import type { ArtifactLifecycleService } from '../../../src/services/artifact-lifecycle/lifecycle-service';
import { FULL, lifecycleFixture, NOW } from './lifecycle-fixture';

const DAY_MS = 24 * 60 * 60 * 1000;

const OLD_QUEUE: readonly ArchivalQueueInput[] = [
  {
    queueId: 'queue-1',
    tasks: [
      {
        taskId: 'task-1',
        status: 'completed',
        runId: 'run-1',
        terminalResolvedAtMs: NOW - 45 * DAY_MS,
        outcome: 'completed',
        summary: { retryCount: 0 },
        retainedReferenceIds: []
      }
    ]
  }
];

function adoptDefault(service: ArtifactLifecycleService): number {
  const preview = previewRetentionPolicy(service, DEFAULT_RETENTION_POLICY);
  if (!preview.ok) throw new Error(preview.refusal.code);
  const adopted = adoptRetentionPolicy(service, {
    previewId: preview.value.previewId,
    confirmation: 'confirmed',
    authority: FULL,
    policy: DEFAULT_RETENTION_POLICY
  });
  if (!adopted.ok) throw new Error(adopted.refusal.code);
  return adopted.value.policyRevision;
}

function archiveOld(service: ArtifactLifecycleService) {
  const preview = previewTaskArchival(service, { queues: OLD_QUEUE });
  if (!preview.ok) throw new Error(preview.refusal.code);
  return archiveTerminalTasks(service, {
    previewId: preview.value.previewId,
    confirmation: 'confirmed',
    authority: FULL,
    queues: OLD_QUEUE
  });
}

describe('headless retention policy', () => {
  it('adopts a previewed, confirmed policy as revision 1', () => {
    expect(adoptDefault(lifecycleFixture().build())).toBe(1);
  });

  it('refuses a policy that is not an object before the service sees it', () => {
    const result = previewRetentionPolicy(lifecycleFixture().build(), 'policy');
    expect(result.ok ? undefined : result.refusal.code).toBe('invalid-input');
  });

  it('refuses a policy with a wrong field through the service check', () => {
    const result = previewRetentionPolicy(lifecycleFixture().build(), { ...DEFAULT_RETENTION_POLICY, schemaVersion: 2 });
    expect(result.ok ? undefined : result.refusal.code).toBe('invalid-input');
  });

  it('refuses an adoption request carrying an unexpected key', () => {
    const result = adoptRetentionPolicy(lifecycleFixture().build(), {
      previewId: 'id-1',
      confirmation: 'confirmed',
      authority: FULL,
      policy: DEFAULT_RETENTION_POLICY,
      force: true
    });
    expect(result.ok ? undefined : result.refusal.code).toBe('invalid-input');
  });
});

describe('headless task archival', () => {
  it('archives an old terminal Task whose run frames the ledger reports resolved', () => {
    const service = lifecycleFixture().build({ runFrameStatuses: () => ['completed'] });
    adoptDefault(service);
    const result = archiveOld(service);
    expect(result.ok ? { archived: result.value.archived, skipped: result.value.skipped } : result.refusal.code).toEqual({
      archived: 1,
      skipped: 0
    });
  });

  it('keeps every Task when no ledger lookup is injected', () => {
    const service = lifecycleFixture().build();
    adoptDefault(service);
    const result = archiveOld(service);
    expect(result.ok ? { archived: result.value.archived, skipped: result.value.skipped } : result.refusal.code).toEqual({
      archived: 0,
      skipped: 1
    });
  });

  it('refuses queues that are not an array of objects', () => {
    const result = previewTaskArchival(lifecycleFixture().build(), { queues: ['queue-1'] });
    expect(result.ok ? undefined : result.refusal.code).toBe('invalid-input');
  });
});
