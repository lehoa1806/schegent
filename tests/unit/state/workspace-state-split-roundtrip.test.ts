/**
 * FR-R7-07 (SC-004, FR-004, FR-005) & FR-R7-11 (Task 14, FR-014) — Independent pre-split
 * persisted-state fixture byte-for-byte roundtrip compatibility and single facade-owned
 * serialization chain verification.
 *
 * The pre-split fixture at `tests/fixtures/state/pre-split-workspace-state-feee811a.json`
 * is pinned using literal pre-split key strings verified against baseline commit `feee811a`
 * (pre-FR-R7-07) — never constructed from live `KEYS`, `SCHEMA_VERSION`, or
 * `STATE_SCHEMA_VERSION` imports.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SanitizedLogger } from '../../../src/lib/logger';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import type { WorkflowRun } from '../../../src/state/workflow-run';

const PRE_SPLIT_FIXTURE_PATH = resolve(
  __dirname,
  '..',
  '..',
  'fixtures',
  'state',
  'pre-split-workspace-state-feee811a.json'
);

const SECOND_QUEUE_ID = '11111111-2222-4333-8444-555555555555';
const AGENT_CONFIG_FINGERPRINT =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const EXPECTED_PRE_SPLIT_LITERAL_KEYS: readonly string[] = Object.freeze([
  'schegent.schemaVersion',
  'schegent.schemaVersionNumeric',
  'schegent.queues.registry',
  'schegent.queue.defaultQueueId',
  'schegent.queue.globalConcurrencyCap',
  'schegent.ui.concurrencyNotice',
  'schegent.queue',
  'schegent.run',
  'schegent.history',
  'schegent.watchdog',
  'schegent.ui.confirmSuppression',
  'schegent.consent.gitPlanGrants.v1',
  'schegent.consent.agentConfigGrants.v1',
  'schegent.connectedRuns',
  'schegent.terminalTransitionIntent',
  'schegent.executionLeases',
  'schegent.lock',
  'schegent.controlLedger',
  'schegent.operatorPseudonym'
]);

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function loadPinnedPreSplitFixture(): {
  readonly rawText: string;
  readonly parsed: Record<string, unknown>;
  readonly compactBytes: string;
  readonly compactSha256: string;
} {
  const rawText = readFileSync(PRE_SPLIT_FIXTURE_PATH, 'utf8');
  const parsed = JSON.parse(rawText) as Record<string, unknown>;
  const compactBytes = JSON.stringify(parsed);
  return {
    rawText,
    parsed,
    compactBytes,
    compactSha256: sha256Hex(compactBytes)
  };
}

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

function makeMinimalRun(id: string, featureId: string): WorkflowRun {
  return {
    id,
    featureId,
    featureDir: `specs/test-${id}`,
    status: 'paused',
    currentPhase: 'plan',
    currentIteration: 1,
    startedAt: 1_700_000_100_000,
    lastTransitionAt: 1_700_000_100_000,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    manualPauseAt: 1_700_000_100_000,
    manualPauseCause: 'operator-paused',
    creditPause: null,
    phaseBreakpoints: [],
    phaseOverrides: [],
    resumeTargetPhaseId: null
  };
}

describe('FR-R7-07 / FR-R7-11 — split WorkspaceStateStore persisted-state compatibility & serialization', () => {
  it('SC-004 / FR-014: loads pinned pre-split fixture bytes from commit feee811a with zero mutations and full family read parity', async () => {
    const pinned = loadPinnedPreSplitFixture();
    expect(Object.keys(pinned.parsed)).toEqual(EXPECTED_PRE_SPLIT_LITERAL_KEYS);

    const logLines: string[] = [];
    const logger = new SanitizedLogger([{ appendLine: (line) => logLines.push(line) }]);
    const memento = createMemoryMemento(structuredClone(pinned.parsed));
    const store = new WorkspaceStateStore(memento, logger);

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

    // Every persisted key stays byte-for-byte & SHA-256 identical after initialize() with zero extra keys written.
    const afterBytes = JSON.stringify(memento.snapshot());
    expect(afterBytes).toBe(pinned.compactBytes);
    expect(sha256Hex(afterBytes)).toBe(pinned.compactSha256);

    // Queue registry, defaults, concurrency, and per-queue state family
    expect(store.getQueueRegistry().entries.map((e) => e.id)).toEqual(['default', SECOND_QUEUE_ID]);
    expect(store.getDefaultQueueId()).toBe('default');
    expect(store.getGlobalConcurrencyCap()).toBe(2);
    expect(store.getConcurrencyNotice()).toBe('dismissed');
    expect(store.getQueue('default').requests.map((r) => r.id)).toEqual(['task-pre-1']);
    expect(store.getQueue('default').queueLifecycle).toBe('idle-pending');
    expect(store.getQueue(SECOND_QUEUE_ID).queueLifecycle).toBe('operator-paused');
    expect(store.getQueue(SECOND_QUEUE_ID).pauseSource).toBe('operator');

    // Runs, quarantine, and terminal transition intents family
    const run = store.getRun('default');
    expect(run?.id).toBe('run-pre-1');
    expect(run?.featureId).toBe('task-pre-1');
    expect(run?.status).toBe('paused');
    expect(run?.manualPauseCause).toBe('operator-paused');
    expect(run?.pipeline?.id).toBe('wf-pre-1');
    expect(store.drainRunQuarantineEvents()).toEqual([]);

    const terminalIntents = store.getTerminalTransitionIntents();
    expect(Object.keys(terminalIntents)).toEqual(['run-term-1']);
    expect(terminalIntents['run-term-1']!.run.id).toBe('run-term-1');
    expect(terminalIntents['run-term-1']!.run.status).toBe('completed');
    expect(terminalIntents['run-term-1']!.description).toBe(
      'Pre-split terminal transition intent'
    );

    // History family
    expect(store.getHistory()).toHaveLength(1);
    expect(Object.keys(store.getHistoryMap())).toEqual(['default']);

    // Locks, execution leases, watchdog, and operator pseudonym family
    expect(store.getWatchdog()).toEqual({
      paused: false,
      pausedSince: null,
      nextPollAt: null,
      pollIntervalMs: 1_800_000,
      lastStatusOk: null,
      lastPollOutcome: null,
      cause: null
    });
    expect(store.getLock()).toEqual({
      ownerId: 'window-pre-1',
      acquiredAt: 1_700_000_000_000,
      heartbeatAt: 1_700_000_010_000
    });
    expect(store.getExecutionLeases()).toEqual({
      default: {
        queueId: 'default',
        ownerId: 'window-pre-1',
        acquiredAt: 1_700_000_005_000,
        heartbeatAt: 1_700_000_010_000
      }
    });
    expect(store.readOperatorPseudonym()).toEqual({
      version: 1,
      pseudonym: 'operator-pre-split'
    });

    // Grants & confirmation suppression family
    expect(store.getConfirmSuppression()).toEqual({
      version: 1,
      suppressedActionKeys: ['clear-queue']
    });
    expect(store.hasGitPlanGrant('fp-pre-1')).toBe(true);
    expect(store.getGitPlanGrants()['fp-pre-1']!.pipelineId).toBe('wf-pre-1');
    expect(store.hasAgentConfigGrant(AGENT_CONFIG_FINGERPRINT, 'claude')).toBe(true);
    expect(store.getAgentConfigGrants()[AGENT_CONFIG_FINGERPRINT]!.files).toEqual([
      {
        name: 'CLAUDE.md',
        size: 128,
        digest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      }
    ]);

    // Connected workflow runs & control ledger family
    expect(Object.keys(store.getConnectedRuns())).toEqual(['crun-pre-1']);
    const connectedRun = store.getConnectedRun('crun-pre-1');
    expect(connectedRun?.workflowId).toBe('wf-connected-pre-1');
    expect(connectedRun?.queueId).toBe('default');
    expect(connectedRun?.revision).toBe(2);
    expect(connectedRun?.controlState).toEqual({
      version: 1,
      ledgerRunId: 'ledger-pre-1'
    });
    expect(store.getRawControlLedger()).toEqual({
      version: 1,
      revision: 1,
      nextWaitSequence: 1,
      roots: {},
      quotaObservations: {},
      checks: {},
      waiters: [],
      permits: {}
    });

    // Zero warnings or dropped records across initialization and every family read
    expect(logLines).toEqual([]);
  });

  it('FR-005: serializes concurrent multi-queue Run writes on one facade-owned chain with no lost entries', async () => {
    const pinned = loadPinnedPreSplitFixture();
    const backing = new Map<string, unknown>(Object.entries(structuredClone(pinned.parsed)));
    backing.delete('schegent.run');

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
        makeMinimalRun('run-a', 'task-a'),
        store.runCommitClaim('default')
      ),
      store.setRun(
        SECOND_QUEUE_ID,
        makeMinimalRun('run-b', 'task-b'),
        store.runCommitClaim(SECOND_QUEUE_ID)
      )
    ]);

    const runs = store.getRunMap();
    expect(Object.keys(runs).sort()).toEqual([SECOND_QUEUE_ID, 'default']);
    expect(store.getRun('default')?.id).toBe('run-a');
    expect(store.getRun(SECOND_QUEUE_ID)?.id).toBe('run-b');
  });
});
