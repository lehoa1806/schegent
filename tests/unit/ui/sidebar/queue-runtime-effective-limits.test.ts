// FR-R4-F02 (spec 240, US8; contract E3 G8, G9; SC-010) — the `effectiveLimits` projection of an
// in-flight Run, read through the real composition path (`StateProjector` -> `snapshot-composer.ts`
// -> `composeQueueRuntimes`).
//
// The claim is equality with what the runner received: the projector is handed the same resolved
// settings object the runner is built from, and the shown limits must equal it, layer by layer. A
// Run that is not in flight has no projection at all, and a host that supplies no source publishes
// none rather than inventing defaults.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AuditLogWriter } from '../../../../src/audit/audit-log-writer';
import { snapshotPhaseDef, snapshotPipelineContract } from '../../../../src/config/pipeline-snapshot';
import { DEFAULT_QUEUE_ID } from '../../../../src/contracts/queue-identity';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { resolveEffectiveLimits, type EffectiveLimitsInput } from '../../../../src/services/effective-limits';
import { unfencedCommit } from '../../../../src/state/ownership-claim';
import { WorkspaceStateStore, type Memento } from '../../../../src/state/workspace-state';
import { StateProjector, type StateProjectorDeps } from '../../../../src/ui/sidebar/state-projector';
import type { PhaseDef, PipelineDef } from '../../../../src/config/pipeline-config';
import { creditPausedRunFixture } from '../../watchdog/credit-paused-run';
import { runOf } from './queue-runtime-read.helpers';

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

let store: WorkspaceStateStore;
let audit: AuditLogWriter;
let tmpRoot: string;

beforeEach(async () => {
  store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-effective-limits-'));
  audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** The settings the runner was built with, each from a different layer. */
const RUNNER_SETTINGS: EffectiveLimitsInput['settings'] = {
  iterationCap: { value: 4, origin: 'workspace-folder' },
  idleTimeoutSeconds: { value: 600, origin: 'workspace' },
  maxDurationSeconds: { value: 7200, origin: 'user' }
};

const LIVE: EffectiveLimitsInput['live'] = {
  forceContinueOnCap: { value: true, origin: 'workspace' },
  maxUnchangedComparisons: { value: 2, origin: 'workspace' },
  limitUsd: { value: 3, origin: 'user' },
  limitTokens: { value: null, origin: 'default' }
};

async function seedRunInFlight(phase: Partial<PhaseDef> = {}): Promise<void> {
  const phaseDef: PhaseDef = { id: 'implement', name: 'Implement', version: 1, instruction: 'Do it.', ...phase };
  const flow: PipelineDef = { id: 'flow', name: 'Flow', phases: ['implement'] };
  const run = creditPausedRunFixture(
    { pausedAt: 1, windowStartedAt: 2, stoppedAt: null },
    {
      creditPause: null,
      status: 'running',
      currentPhase: 'implement',
      defaultRunnerKind: 'claude',
      pipeline: snapshotPipelineContract(flow, [snapshotPhaseDef(phaseDef, 'claude')])
    }
  );
  await store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));
}

function snapshotWith(deps: Partial<StateProjectorDeps> = {}) {
  const projector = new StateProjector({ store, audit, ownerId: 'this-window', debounceMs: 100, ...deps });
  projector.start();
  const snapshot = projector.getCurrentSnapshot();
  projector.dispose();
  return snapshot;
}

const getEffectiveLimits: NonNullable<StateProjectorDeps['getEffectiveLimits']> = (run) =>
  resolveEffectiveLimits({
    settings: RUNNER_SETTINGS,
    live: LIVE,
    run,
    spendTrust: () => 'enforced'
  });

describe('effectiveLimits on the in-flight Run (E3 G8, G9)', () => {
  it('equals what the runner received, layer by layer', async () => {
    await seedRunInFlight();

    const limits = runOf(snapshotWith({ getEffectiveLimits }))?.effectiveLimits;

    expect(limits?.iterationCap).toEqual(RUNNER_SETTINGS.iterationCap);
    expect(limits?.idleTimeoutSeconds).toEqual(RUNNER_SETTINGS.idleTimeoutSeconds);
    expect(limits?.maxDurationSeconds).toEqual(RUNNER_SETTINGS.maxDurationSeconds);
    expect(limits?.onRetryCap).toEqual({ value: 'continue', origin: 'workspace' });
    expect(limits?.spend).toEqual({
      kind: 'bounded',
      denomination: 'usd',
      limit: { value: 3, origin: 'user' },
      trust: 'enforced'
    });
  });

  it('shows the Phase\'s own frozen values with origin `phase`, not the settings', async () => {
    await seedRunInFlight({ timeoutSeconds: 90, onRetryCap: 'fail', spendBoundUsd: 1 });

    const limits = runOf(snapshotWith({ getEffectiveLimits }))?.effectiveLimits;

    expect(limits?.idleTimeoutSeconds).toEqual({ value: 90, origin: 'phase' });
    expect(limits?.onRetryCap).toEqual({ value: 'fail', origin: 'phase' });
    expect(limits?.spend).toMatchObject({ kind: 'bounded', limit: { value: 1, origin: 'phase' } });
  });

  it('is null for a queue that holds no Run', () => {
    expect(runOf(snapshotWith({ getEffectiveLimits }))).toBeNull();
  });

  it('is null when the host supplies no source, rather than invented defaults', async () => {
    await seedRunInFlight();

    expect(runOf(snapshotWith())?.effectiveLimits).toBeNull();
  });

  it('is recomputed on every snapshot: a setting changed between two snapshots is what the second shows', async () => {
    await seedRunInFlight();
    let cap = 5;
    const live = (): EffectiveLimitsInput['live'] => ({
      ...LIVE,
      forceContinueOnCap: { value: cap > 5, origin: 'user' }
    });
    const reading: NonNullable<StateProjectorDeps['getEffectiveLimits']> = (run) =>
      resolveEffectiveLimits({ settings: RUNNER_SETTINGS, live: live(), run, spendTrust: () => 'enforced' });

    expect(runOf(snapshotWith({ getEffectiveLimits: reading }))?.effectiveLimits?.onRetryCap.value).toBe('fail');
    cap = 6;
    expect(runOf(snapshotWith({ getEffectiveLimits: reading }))?.effectiveLimits?.onRetryCap.value).toBe('continue');
  });

  it('carries only numbers and closed enums: no string a setting supplied', async () => {
    await seedRunInFlight();

    const json = JSON.stringify(runOf(snapshotWith({ getEffectiveLimits }))?.effectiveLimits);
    const strings = [...json.matchAll(/"([^"]*)"/g)].map((match) => match[1] as string);
    const vocabulary = new Set([
      'iterationCap', 'idleTimeoutSeconds', 'maxDurationSeconds', 'retryCap', 'onRetryCap', 'spend',
      // FR-R4-F17 — the unchanged-metrics bound's member, its state key and the four closed states.
      'unchangedComparisons', 'state', 'active', 'disabled', 'inert-cap-outcome', 'inert-no-retry-condition',
      'value', 'origin', 'kind', 'denomination', 'limit', 'trust',
      'default', 'user', 'workspace', 'workspace-folder', 'phase',
      'fail', 'continue', 'continue-degraded', 'none', 'bounded', 'usd', 'tokens', 'enforced', 'not-trustworthy'
    ]);
    expect(strings.filter((text) => !vocabulary.has(text))).toEqual([]);
  });
});
