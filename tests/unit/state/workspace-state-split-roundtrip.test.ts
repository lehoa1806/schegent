/**
 * FR-R7-07 (SC-004, FR-004, FR-005) — Pre-split persisted-state fixture byte-for-byte
 * roundtrip compatibility and single facade-owned serialization chain verification.
 */

import { describe, expect, it } from 'vitest';
import {
  KEYS,
  SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
  WorkspaceStateStore,
  type Memento
} from '../../../src/state/workspace-state';
import type { WorkflowRun } from '../../../src/state/workflow-run';

function createMemoryMemento(initial: Record<string, unknown> = {}): Memento & {
  snapshot(): Record<string, unknown>;
} {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    get<T>(key: string): T | undefined {
      return data.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) data.delete(key);
      else data.set(key, value);
    },
    snapshot(): Record<string, unknown> {
      return Object.fromEntries(data.entries());
    }
  };
}

const SECOND_QUEUE_ID = '11111111-2222-4333-8444-555555555555';

function buildPreSplitPersistedFixture(): Record<string, unknown> {
  return {
    [KEYS.schemaVersion]: SCHEMA_VERSION,
    [KEYS.schemaVersionNumeric]: STATE_SCHEMA_VERSION,
    [KEYS.queueRegistry]: {
      entries: [
        {
          id: 'default',
          name: 'Default queue',
          position: 0,
          schedule: null,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000
        },
        {
          id: SECOND_QUEUE_ID,
          name: 'Secondary queue',
          position: 1,
          schedule: null,
          createdAt: 1_700_000_001_000,
          updatedAt: 1_700_000_001_000
        }
      ],
      updatedAt: 1_700_000_001_000
    },
    [KEYS.queueDefaultId]: 'default',
    [KEYS.queueGlobalConcurrencyCap]: 2,
    [KEYS.concurrencyNotice]: 'dismissed',
    [KEYS.queue]: {
      default: {
        requests: [
          {
            id: 'task-pre-1',
            description: 'Pre-split fixture task',
            enqueuedAt: 1_700_000_010_000,
            createdAt: 1_700_000_010_000,
            startedAt: null,
            updatedAt: 1_700_000_010_000,
            completedAt: null,
            status: 'pending',
            queueId: 'default',
            position: 0,
            pauseCause: null,
            runId: null,
            retryCount: 0,
            lastError: null,
            pausedReason: null
          }
        ],
        inFlightId: null,
        pausedReason: null,
        updatedAt: 1_700_000_010_000,
        queueLifecycle: 'idle-pending',
        pauseSource: null,
        scheduledStartAt: null,
        scheduledStartSource: 'operator-chooser'
      },
      [SECOND_QUEUE_ID]: {
        requests: [],
        inFlightId: null,
        pausedReason: 'Operator paused',
        updatedAt: 1_700_000_020_000,
        queueLifecycle: 'operator-paused',
        pauseSource: 'operator',
        scheduledStartAt: null,
        scheduledStartSource: null
      }
    },
    [KEYS.run]: {
      default: {
        id: 'run-pre-1',
        featureId: 'task-pre-1',
        queueId: 'default',
        description: 'Pre-split fixture task',
        status: 'paused',
        currentPhase: 'plan',
        currentIteration: 1,
        startedAt: 1_700_000_011_000,
        lastTransitionAt: 1_700_000_012_000,
        delayedRetryCount: 0,
        pendingRetryAt: null,
        pendingRetryCause: null,
        manualPauseAt: 1_700_000_012_000,
        manualPauseCause: 'operator-paused',
        creditPause: null,
        phaseBreakpoints: [],
        phaseOverrides: [],
        resumeTargetPhaseId: null,
        phaseResults: [],
        pipeline: {
          id: 'wf-pre-1',
          name: 'Pre-split workflow',
          version: 1,
          phases: [
            {
              id: 'plan',
              name: 'Plan',
              command: '/plan',
              maxIterations: 1,
              runner: 'claude',
              sideEffects: 'workspace',
              evidencePolicy: 'required',
              hostVerification: 'exit-code',
              hostVerificationDeclaredAt: 'phase-definition'
            }
          ]
        }
      }
    },
    [KEYS.history]: {
      default: [
        {
          runId: 'run-hist-1',
          taskId: 'task-hist-1',
          queueId: 'default',
          terminalStatus: 'completed',
          completedAt: '2026-11-12T10:00:00.000Z'
        }
      ]
    },
    [KEYS.watchdog]: {
      paused: false,
      pausedSince: null,
      nextPollAt: null,
      pollIntervalMs: 1_800_000,
      lastStatusOk: null,
      lastPollOutcome: null,
      cause: null
    },
    [KEYS.confirmSuppression]: {
      version: 1,
      suppressedActionKeys: ['clear-queue']
    },
    [KEYS.gitPlanGrants]: {
      'fp-pre-1': {
        fingerprint: 'fp-pre-1',
        pipelineId: 'wf-pre-1',
        grantedAt: 1_700_000_030_000,
        phaseIds: ['implement']
      }
    },
    [KEYS.operatorPseudonym]: {
      version: 1,
      pseudonym: 'operator-pre-split'
    }
  };
}

function makeMinimalRun(id: string, queueId: string, featureId: string): WorkflowRun {
  return {
    id,
    featureId,
    queueId,
    description: `Run ${id}`,
    status: 'paused',
    currentPhase: 'plan',
    currentIteration: 1,
    startedAt: 1_700_000_100_000,
    lastTransitionAt: 1_700_000_100_000,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    manualPauseAt: 1_700_000_100_000,
    manualPauseCause: 'operator-paused',
    creditPause: null,
    phaseBreakpoints: [],
    phaseOverrides: [],
    resumeTargetPhaseId: null,
    phaseResults: []
  } as unknown as WorkflowRun;
}

describe('FR-R7-07 — split WorkspaceStateStore persisted-state compatibility & serialization', () => {
  it('SC-004: loads a pre-split persisted-state fixture byte-for-byte with zero unintended mutations', async () => {
    const fixture = buildPreSplitPersistedFixture();
    const beforeBytes = JSON.stringify(fixture);
    const memento = createMemoryMemento(structuredClone(fixture));
    const store = new WorkspaceStateStore(memento);

    const init = await store.initialize();
    expect(init).toEqual({
      migrated: false,
      v6MigrationEvents: [],
      v7MigrationEvents: [],
      v10MigrationEvents: [],
      v11MigrationEvents: [],
      v12MigrationEvents: [],
      v13MigrationEvents: [],
      v14MigrationEvents: [],
      orphanedRunEvents: [],
      runRepairEvents: []
    });

    // Every persisted key stays byte-for-byte identical after initialize() with zero extra keys written.
    expect(JSON.stringify(memento.snapshot())).toBe(beforeBytes);

    // Every key family reads back the exact pre-split state through the facade.
    expect(store.getQueueRegistry().entries.map((e) => e.id)).toEqual(['default', SECOND_QUEUE_ID]);
    expect(store.getDefaultQueueId()).toBe('default');
    expect(store.getGlobalConcurrencyCap()).toBe(2);
    expect(store.getConcurrencyNotice()).toBe('dismissed');
    expect(store.getQueue('default').requests.map((r) => r.id)).toEqual(['task-pre-1']);
    expect(store.getQueue(SECOND_QUEUE_ID).queueLifecycle).toBe('operator-paused');
    expect(store.getRun('default')?.id).toBe('run-pre-1');
    expect(store.getHistory()).toHaveLength(1);
    expect(store.getWatchdog().pollIntervalMs).toBe(1_800_000);
    expect(store.getConfirmSuppression().suppressedActionKeys).toEqual(['clear-queue']);
    expect(store.hasGitPlanGrant('fp-pre-1')).toBe(true);
    expect(store.readOperatorPseudonym()).toEqual({ version: 1, pseudonym: 'operator-pre-split' });
  });

  it('FR-005: serializes concurrent multi-queue Run writes on one facade-owned chain with no lost entries', async () => {
    const backing = new Map<string, unknown>(Object.entries(buildPreSplitPersistedFixture()));
    backing.delete(KEYS.run);

    // Async memento with artificial yield to expose any unserialized read-modify-write race.
    const asyncMemento: Memento = {
      get<T>(key: string): T | undefined {
        return backing.get(key) as T | undefined;
      },
      async update(key: string, value: unknown): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (value === undefined) backing.delete(key);
        else backing.set(key, value);
      }
    };

    const store = new WorkspaceStateStore(asyncMemento);
    await Promise.all([
      store.setRun(
        'default',
        makeMinimalRun('run-a', 'default', 'task-a'),
        store.runCommitClaim('default')
      ),
      store.setRun(
        SECOND_QUEUE_ID,
        makeMinimalRun('run-b', SECOND_QUEUE_ID, 'task-b'),
        store.runCommitClaim(SECOND_QUEUE_ID)
      )
    ]);

    const runs = store.getRunMap();
    expect(Object.keys(runs).sort()).toEqual([SECOND_QUEUE_ID, 'default']);
    expect(store.getRun('default')?.id).toBe('run-a');
    expect(store.getRun(SECOND_QUEUE_ID)?.id).toBe('run-b');
  });
});
