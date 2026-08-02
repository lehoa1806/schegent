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

beforeEach(() => capabilities.clear());

describe('safe Phase source removal', () => {
  it('rejects removal of a built-in source', async () => {
    const { ctx, acks, writes } = run({});
    await handler(ctx, remove('speckit-plan', []));
    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'built-in-immutable' });
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
    const userPipelines = [{ id: 'shared-pipeline', name: 'User', phases: ['speckit-plan'] }];
    const { ctx, acks, writes } = run({ workspace: [ROW], pipelines, userPipelines });

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
