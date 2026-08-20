import { beforeEach, describe, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => new Map<string, boolean>());
vi.mock('../../../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (name: string) => capabilities.get(name) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));
vi.mock('../../../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({ uri: { fsPath: '/tmp/removal' }, name: 'removal', index: 0 })
}));

import { FakeCatalogStore, layerWrites } from '../../../../fixtures/fake-catalog-store';
import { handler } from '../../../../../src/ui/sidebar/commands/cmd-save-phases';
import { CMD_SAVE_PHASES } from '../../../../../src/ui/sidebar/messages';
import type { CommandAckMessage, SavePhasesCommand } from '../../../../../src/ui/sidebar/messages';

const ROW = { id: 'custom-phase', name: 'Custom', version: 1, instruction: 'Run.' };

/** Feature 099 (T496f, FR-044a) — seeding rows does not move a revision. */
const SEEDED_REVISION = new FakeCatalogStore().revisionOf('phase');

function run(options: {
  phases?: readonly unknown[];
  pipelines?: readonly unknown[];
  runtimePipelines?: readonly unknown[];
}) {
  const acks: CommandAckMessage[] = [];
  const store = new FakeCatalogStore({
    phases: options.phases ?? [],
    pipelines: options.pipelines ?? []
  });
  const ctx = {
    deps: {
      executeCommand: vi.fn(), queueRemover: { remove: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), sanitize: String },
      catalogStore: store,
      refreshCatalog: vi.fn(async () => undefined),
      readPhaseConfig: () => ({ rows: store.rowsOf('phase'), revision: store.revisionOf('phase') }),
      readPipelineConfig: () => ({
        rows: store.rowsOf('pipeline'), revision: store.revisionOf('pipeline')
      }),
      getCatalog: () => ({
        phases: [], models: {}, defaultPipelineId: 'default',
        pipelines: options.runtimePipelines ?? options.pipelines ?? []
      })
    },
    correlationId: 'remove',
    postAck: async (ack: CommandAckMessage) => { acks.push(ack); return true; }
  } as unknown as Parameters<typeof handler>[0];
  return { ctx, acks, store, writes: () => layerWrites(store) };
}

function remove(id: string, proposed: readonly unknown[] = []): SavePhasesCommand {
  return {
    type: CMD_SAVE_PHASES,
    correlationId: 'remove',
    payload: {
      expectedRevision: SEEDED_REVISION,
      mutation: { kind: 'remove', phaseId: id }, phases: proposed
    }
  };
}

function reset(): SavePhasesCommand {
  return {
    type: CMD_SAVE_PHASES,
    correlationId: 'reset',
    payload: { expectedRevision: SEEDED_REVISION, mutation: { kind: 'reset' }, phases: [] }
  };
}

beforeEach(() => capabilities.clear());

describe('Feature 098 (T034) — a reset survives a denied override policy', () => {
  // FR-015, SC-016. Feature 059's I-2 invariant is that an operator can always
  // return to defaults from a denied state, and it was expressed two ways: a
  // layer-emptying `reset`, or a payload byte-equal to the built-in rows. With the
  // built-in rows empty those two collapse into one — emptying the layer *is* the
  // byte-equal payload — and the assertion this feature needs is that the surviving
  // half still works. Otherwise an operator whose `phases` capability is denied
  // would have no way out of a layer they can no longer edit.
  //
  // The Pipeline layer's half of FR-015 is already pinned by
  // `cmd-save-pipelines.test.ts` ('accepts a layer-emptying reset even when the
  // pipelines capability is denied'), and the Workflow layer has behaved this way
  // since feature 086 with a layer that was always empty. This is the Phase layer.
  it('accepts a layer-emptying reset with the phases capability denied, and writes an empty layer', async () => {
    capabilities.set('phases', false);
    const { ctx, acks, writes, store } = run({ phases: [ROW] });

    await handler(ctx, reset());

    expect(acks[0].status).toBe('accepted');
    expect(writes()).toEqual([[]]);
    expect(store.rowsOf('phase')).toEqual([]);
  });

  it('still denies a non-empty save with the capability denied, so the reset carve-out is narrow', async () => {
    // The companion assertion: the reset is admitted because it empties the layer,
    // not because the gate stopped running. A `reset` mutation carrying rows is not
    // a reset (`cmd-save-phases.ts` conjoins the kind with an empty payload), so it
    // reaches the gate like any other write.
    capabilities.set('phases', false);
    const { ctx, acks, writes } = run({ phases: [ROW] });

    await handler(ctx, {
      type: CMD_SAVE_PHASES,
      correlationId: 'reset-with-rows',
      payload: {
        expectedRevision: SEEDED_REVISION,
        mutation: { kind: 'reset' }, phases: [{ ...ROW, name: 'Renamed' }]
      }
    } as SavePhasesCommand);

    expect(acks[0].status).toBe('rejected');
    expect(writes()).toEqual([]);
  });
});

describe('safe Phase source removal', () => {
  // Feature 098 (T036, FR-010) — this named a built-in Phase and expected
  // `built-in-immutable`. That reason is keyed on the id being present in the
  // built-in layer, which now holds nothing, so it can no longer be produced. The
  // safety property it stood for survives on its own terms: a removal naming an id
  // no writable layer owns is still rejected and still writes nothing. Only the
  // reason code changes, to the generic mismatch.
  it('rejects removal of an id no layer owns', async () => {
    const { ctx, acks, writes } = run({});
    await handler(ctx, remove('speckit-plan'));
    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'phase-mutation-mismatch' });
    expect(writes()).toEqual([]);
  });

  it('allows removal when no configured Pipeline depends on the id', async () => {
    // Feature 099 (T496f, FR-042) — this read "allows workspace removal when a
    // valid user source remains": the removal was safe because a lower layer still
    // supplied the id. There is one layer now, so the id genuinely goes; what makes
    // the removal safe is that nothing references it. That is the claim left, and
    // it is the baseline the two blocked cases below are measured against.
    const { ctx, acks, writes, store } = run({ phases: [ROW] });
    await handler(ctx, remove(ROW.id));
    expect(acks[0].status).toBe('accepted');
    expect(writes()).toEqual([[]]);
    expect(store.rowsOf('phase')).toEqual([]);
  });

  it('reports dependent pipelines when removal would leave an unresolved id', async () => {
    const pipelines = [
      { id: 'pipeline-z', name: 'Z', phases: [ROW.id] },
      { id: 'pipeline-a', name: 'A', phases: [ROW.id] }
    ];
    const { ctx, acks, writes } = run({ phases: [ROW], pipelines });
    await handler(ctx, remove(ROW.id));
    expect(acks[0]).toMatchObject({
      status: 'rejected', reason: 'phase-removal-blocked',
      result: { dependentPipelineIds: ['pipeline-a', 'pipeline-z'], total: 2 }
    });
    expect(writes()).toEqual([]);
  });

  it('removes one duplicate persisted source row so the remaining row becomes valid', async () => {
    const duplicateRows = [ROW, { ...ROW, version: 2 }];
    const { ctx, acks, writes } = run({ phases: duplicateRows });

    await handler(ctx, remove(ROW.id, [ROW]));

    expect(acks[0].status).toBe('accepted');
    expect(writes()).toEqual([[ROW]]);
  });

  it('counts a Pipeline the catalog holds twice as one dependent, not two', async () => {
    // Feature 099 (T496f, FR-039) — this read "ignores a workspace Pipeline row
    // shadowed by a user Pipeline with the same id". Shadowing is gone, and the
    // "a non-effective row does not block a removal" half is already carried by
    // 'ignores an invalid configured Pipeline row' below. What one id claimed twice
    // means NOW is the de-duplication the dependent scan performs on purpose — its
    // own comment says counting such a row twice "would overstate the dependents a
    // removal is blocked by" — and nothing else pins it. So this is that claim: one
    // id, two rows, one dependent.
    const pipelines = [
      { id: 'shared-pipeline', name: 'First Copy', phases: [ROW.id] },
      { id: 'shared-pipeline', name: 'Second Copy', phases: [ROW.id] }
    ];
    const { ctx, acks, writes } = run({ phases: [ROW], pipelines });

    await handler(ctx, remove(ROW.id));

    expect(acks[0]).toMatchObject({
      status: 'rejected', reason: 'phase-removal-blocked',
      result: { dependentPipelineIds: ['shared-pipeline'], total: 1 }
    });
    expect(writes()).toEqual([]);
  });

  it('ignores an invalid configured Pipeline row', async () => {
    const pipelines = [{ id: 'Invalid Pipeline Id', name: 'Invalid', phases: [ROW.id] }];
    const { ctx, acks, writes } = run({ phases: [ROW], pipelines });

    await handler(ctx, remove(ROW.id));

    expect(acks[0].status).toBe('accepted');
    expect(writes()).toEqual([[]]);
  });

  it('rejects a reset that would leave a configured Pipeline unresolved', async () => {
    const pipelines = [{ id: 'custom-pipeline', name: 'Custom', phases: [ROW.id] }];
    const { ctx, acks, writes } = run({ phases: [ROW], pipelines });

    await handler(ctx, reset());

    expect(acks[0]).toMatchObject({
      status: 'rejected', reason: 'phase-removal-blocked',
      result: { dependentPipelineIds: ['custom-pipeline'] }
    });
    expect(writes()).toEqual([]);
  });

  it('checks configured Pipeline rows even when the runtime catalog fell back', async () => {
    const pipelines = [{ id: 'configured-pipeline', name: 'Configured', phases: [ROW.id] }];
    const { ctx, acks, writes } = run({
      phases: [ROW], pipelines, runtimePipelines: []
    });

    await handler(ctx, remove(ROW.id));

    expect(acks[0]).toMatchObject({
      status: 'rejected', reason: 'phase-removal-blocked',
      result: { dependentPipelineIds: ['configured-pipeline'] }
    });
    expect(writes()).toEqual([]);
  });
});
