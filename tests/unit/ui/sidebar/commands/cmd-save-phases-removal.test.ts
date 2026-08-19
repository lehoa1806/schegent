import { beforeEach, describe, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => new Map<string, boolean>());
vi.mock('../../../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (name: string) => capabilities.get(name) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));
vi.mock('../../../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({ uri: { fsPath: '/tmp/removal' }, name: 'removal', index: 0 })
}));

import { phaseLayerRevision } from '../../../../../src/config/process-catalog';
import { handler } from '../../../../../src/ui/sidebar/commands/cmd-save-phases';
import { CMD_SAVE_PHASES } from '../../../../../src/ui/sidebar/messages';
import type { CommandAckMessage, SavePhasesCommand } from '../../../../../src/ui/sidebar/messages';

const ROW = { id: 'custom-phase', name: 'Custom', version: 1, instruction: 'Run.' };

function run(options: {
  workspace?: readonly unknown[];
  user?: readonly unknown[];
  pipelines?: readonly unknown[];
  userPipelines?: readonly unknown[];
  runtimePipelines?: readonly unknown[];
}) {
  const workspace = options.workspace ?? [];
  const acks: CommandAckMessage[] = [];
  const writes: unknown[] = [];
  const ctx = {
    deps: {
      executeCommand: vi.fn(), queueRemover: { remove: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), sanitize: String },
      readPhaseConfig: () => ({ user: options.user ?? [], workspace }),
      readPipelineConfig: () => ({
        user: options.userPipelines ?? [], workspace: options.pipelines ?? []
      }),
      getCatalog: () => ({
        phases: [], models: {}, defaultPipelineId: 'default',
        pipelines: options.runtimePipelines ?? options.pipelines ?? []
      }),
      updateConfig: vi.fn(async (_key: string, value: unknown) => { writes.push(value); })
    },
    correlationId: 'remove',
    postAck: async (ack: CommandAckMessage) => { acks.push(ack); return true; }
  } as unknown as Parameters<typeof handler>[0];
  return { ctx, acks, writes, workspace };
}

function remove(
  id: string,
  current: readonly unknown[],
  proposed: readonly unknown[] = []
): SavePhasesCommand {
  return {
    type: CMD_SAVE_PHASES,
    correlationId: 'remove',
    payload: {
      scope: 'workspace', expectedRevision: phaseLayerRevision(current),
      mutation: { kind: 'remove', phaseId: id }, phases: proposed
    }
  };
}

function reset(current: readonly unknown[]): SavePhasesCommand {
  return {
    type: CMD_SAVE_PHASES,
    correlationId: 'reset',
    payload: {
      scope: 'workspace', expectedRevision: phaseLayerRevision(current),
      mutation: { kind: 'reset' }, phases: []
    }
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
  // `cmd-save-pipelines.test.ts` ('accepts a layer-emptying reset even when
  // allowPipelineOverrides is false'), and the Workflow layer has behaved this way
  // since feature 086 with a layer that was always empty. This is the Phase layer.
  it('accepts a layer-emptying reset with the phases capability denied, and writes an empty layer', async () => {
    capabilities.set('phases', false);
    const { ctx, acks, writes } = run({ workspace: [ROW] });

    await handler(ctx, reset([ROW]));

    expect(acks[0].status).toBe('accepted');
    expect(writes).toEqual([[]]);
  });

  it('still denies a non-empty save with the capability denied, so the reset carve-out is narrow', async () => {
    // The companion assertion: the reset is admitted because it empties the layer,
    // not because the gate stopped running. A `reset` mutation carrying rows is not
    // a reset (`cmd-save-phases.ts` conjoins the kind with an empty payload), so it
    // reaches the gate like any other write.
    capabilities.set('phases', false);
    const { ctx, acks, writes } = run({ workspace: [ROW] });

    await handler(ctx, {
      type: CMD_SAVE_PHASES,
      correlationId: 'reset-with-rows',
      payload: {
        scope: 'workspace', expectedRevision: phaseLayerRevision([ROW]),
        mutation: { kind: 'reset' }, phases: [{ ...ROW, name: 'Renamed' }]
      }
    } as SavePhasesCommand);

    expect(acks[0].status).toBe('rejected');
    expect(writes).toEqual([]);
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
    await handler(ctx, remove('speckit-plan', []));
    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'phase-mutation-mismatch' });
    expect(writes).toEqual([]);
  });

  it('allows workspace removal when a valid user source remains', async () => {
    const { ctx, acks, writes } = run({ workspace: [ROW], user: [{ ...ROW, name: 'Fallback' }] });
    await handler(ctx, remove(ROW.id, [ROW]));
    expect(acks[0].status).toBe('accepted');
    expect(writes).toEqual([[]]);
  });

  it('reports dependent pipelines when removal would leave an unresolved id', async () => {
    const pipelines = [
      { id: 'pipeline-z', name: 'Z', phases: [ROW.id] },
      { id: 'pipeline-a', name: 'A', phases: [ROW.id] }
    ];
    const { ctx, acks, writes } = run({ workspace: [ROW], pipelines });
    await handler(ctx, remove(ROW.id, [ROW]));
    expect(acks[0]).toMatchObject({
      status: 'rejected', reason: 'phase-removal-blocked',
      result: { dependentPipelineIds: ['pipeline-a', 'pipeline-z'], total: 2 }
    });
    expect(writes).toEqual([]);
  });

  it('removes one duplicate persisted source row so the remaining row becomes valid', async () => {
    const duplicateRows = [ROW, { ...ROW, version: 2 }];
    const { ctx, acks, writes } = run({ workspace: duplicateRows });

    await handler(ctx, remove(ROW.id, duplicateRows, [ROW]));

    expect(acks[0].status).toBe('accepted');
    expect(writes).toEqual([[ROW]]);
  });

  it('ignores a workspace Pipeline row shadowed by a user Pipeline with the same id', async () => {
    const pipelines = [{ id: 'shared-pipeline', name: 'Workspace', phases: [ROW.id] }];
    // Feature 098 (T080) — the shadowing user Pipeline used to name `speckit-plan`,
    // which resolved out of the built-in Phase layer. It has to name a Phase some
    // configured layer supplies now, or it is itself invalid and shadows nothing —
    // which would leave the workspace row effective and block the removal, testing
    // the opposite of what this case is about.
    const userPhase = { id: 'user-phase', name: 'User Phase', version: 1, instruction: 'Run.' };
    const userPipelines = [{ id: 'shared-pipeline', name: 'User', phases: [userPhase.id] }];
    const { ctx, acks, writes } = run({
      workspace: [ROW],
      user: [userPhase],
      pipelines,
      userPipelines
    });

    await handler(ctx, remove(ROW.id, [ROW]));

    expect(acks[0].status).toBe('accepted');
    expect(writes).toEqual([[]]);
  });

  it('ignores an invalid configured Pipeline row', async () => {
    const pipelines = [{ id: 'Invalid Pipeline Id', name: 'Invalid', phases: [ROW.id] }];
    const { ctx, acks, writes } = run({ workspace: [ROW], pipelines });

    await handler(ctx, remove(ROW.id, [ROW]));

    expect(acks[0].status).toBe('accepted');
    expect(writes).toEqual([[]]);
  });

  it('rejects a reset that would leave a configured Pipeline unresolved', async () => {
    const pipelines = [{ id: 'custom-pipeline', name: 'Custom', phases: [ROW.id] }];
    const { ctx, acks, writes } = run({ workspace: [ROW], pipelines });
    const reset: SavePhasesCommand = {
      type: CMD_SAVE_PHASES,
      correlationId: 'reset',
      payload: {
        scope: 'workspace', expectedRevision: phaseLayerRevision([ROW]),
        mutation: { kind: 'reset' }, phases: []
      }
    };

    await handler(ctx, reset);

    expect(acks[0]).toMatchObject({
      status: 'rejected', reason: 'phase-removal-blocked',
      result: { dependentPipelineIds: ['custom-pipeline'] }
    });
    expect(writes).toEqual([]);
  });

  it('checks configured Pipeline rows even when the runtime catalog fell back', async () => {
    const pipelines = [{ id: 'configured-pipeline', name: 'Configured', phases: [ROW.id] }];
    const { ctx, acks, writes } = run({
      workspace: [ROW], pipelines, runtimePipelines: []
    });

    await handler(ctx, remove(ROW.id, [ROW]));

    expect(acks[0]).toMatchObject({
      status: 'rejected', reason: 'phase-removal-blocked',
      result: { dependentPipelineIds: ['configured-pipeline'] }
    });
    expect(writes).toEqual([]);
  });
});
