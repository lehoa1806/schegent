// Feature 082 (US7, T051) — safe Pipeline source removal (gate 13).
//
// `cmd-save-phases-removal.test.ts` pins the symmetric Phase case; this file
// pins the Pipeline half. Gate 13 blocks a removal only when BOTH conditions
// hold: the removal leaves the `pipelineId` with no effective source, AND a
// consuming Workflow still references it (FR-022, clarification 1). Either
// condition alone permits the removal, and a blocked removal must name the
// consuming Workflow ids (FR-022a). The built-in layer is never a removal
// target at all (FR-024) — that rejection comes from gate 8, ahead of this one.
//
// "Consuming Workflow" is not a persisted catalog entity in this slice, so the
// handler reads the references the host can see through one seam
// (`readWorkflowPipelineRefs`). These tests exercise that seam directly, which
// is exactly the extension point a future Workflow catalog replaces.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => new Map<string, boolean>());
vi.mock('../../../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (name: string) => capabilities.get(name) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));
vi.mock('../../../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({ uri: { fsPath: '/tmp/removal' }, name: 'removal', index: 0 })
}));

import { pipelineLayerRevision } from '../../../../../src/config/pipeline-catalog';
import { BUILT_IN_PIPELINES } from '../../../../../src/config/pipeline-config';
import { handler } from '../../../../../src/ui/sidebar/commands/cmd-save-pipelines';
import { CMD_SAVE_PIPELINES } from '../../../../../src/ui/sidebar/messages';
import type {
  CommandAckMessage,
  SavePipelinesCommand
} from '../../../../../src/ui/sidebar/messages';

const PHASE_ROW = { id: 'done', name: 'Done', version: 1, instruction: 'Done.' };
const ROW = { id: 'custom-flow', name: 'Custom Flow', version: 1, phases: ['done'] };

// Feature 083 (FR-041) added a second consumer sense, so the host now stamps
// every reference with a `kind`. These fixtures pin the run-request half; the
// definition half and the two-list split live in
// `tests/contract/save-pipelines-scoped.test.ts`.
interface WorkflowRef {
  readonly workflowId: string;
  readonly pipelineId: string;
  readonly kind: 'run-request';
}

function run(options: {
  workspace?: readonly unknown[];
  user?: readonly unknown[];
  workflows?: readonly WorkflowRef[];
  /** Hosts that expose no Workflow references at all omit the seam entirely. */
  omitWorkflowRefs?: boolean;
}) {
  const acks: CommandAckMessage[] = [];
  const writes: unknown[] = [];
  const ctx = {
    deps: {
      executeCommand: vi.fn(),
      queueRemover: { remove: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), sanitize: String },
      readPhaseConfig: () => ({ user: [], workspace: [PHASE_ROW] }),
      readPipelineConfig: () => ({
        user: options.user ?? [],
        workspace: options.workspace ?? []
      }),
      ...(options.omitWorkflowRefs
        ? {}
        : { readWorkflowPipelineRefs: () => options.workflows ?? [] }),
      updateConfig: vi.fn(async (_key: string, value: unknown) => { writes.push(value); })
    },
    correlationId: 'remove',
    postAck: async (ack: CommandAckMessage) => { acks.push(ack); return true; }
  } as unknown as Parameters<typeof handler>[0];
  return { ctx, acks, writes };
}

function remove(
  pipelineId: string,
  current: readonly unknown[],
  proposed: readonly unknown[] = []
): SavePipelinesCommand {
  return {
    type: CMD_SAVE_PIPELINES,
    correlationId: 'remove',
    payload: {
      scope: 'workspace',
      expectedRevision: pipelineLayerRevision(current),
      mutation: { kind: 'remove', pipelineId },
      pipelines: proposed
    }
  };
}

function reset(current: readonly unknown[]): SavePipelinesCommand {
  return {
    type: CMD_SAVE_PIPELINES,
    correlationId: 'remove',
    payload: {
      scope: 'workspace',
      expectedRevision: pipelineLayerRevision(current),
      mutation: { kind: 'reset' },
      pipelines: []
    }
  };
}

beforeEach(() => capabilities.clear());

describe('safe Pipeline source removal (US7, FR-022, FR-022a, FR-024)', () => {
  it('rejects removal of a built-in source', async () => {
    const { ctx, acks, writes } = run({});

    await handler(ctx, remove(BUILT_IN_PIPELINES[0].id, []));

    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'built-in-immutable' });
    expect(writes).toEqual([]);
  });

  it('blocks removal that would leave a consuming Workflow reference unresolved', async () => {
    const { ctx, acks, writes } = run({
      workspace: [ROW],
      workflows: [
        { workflowId: 'wf-z', pipelineId: ROW.id, kind: 'run-request' },
        { workflowId: 'wf-a', pipelineId: ROW.id, kind: 'run-request' }
      ]
    });

    await handler(ctx, remove(ROW.id, [ROW]));

    expect(acks[0]).toMatchObject({
      status: 'rejected',
      reason: 'pipeline-removal-blocked',
      result: {
        pipelineIds: [ROW.id],
        dependentWorkflowIds: ['wf-a', 'wf-z'],
        total: 2
      }
    });
    expect(writes).toEqual([]);
  });

  it('permits removal when a lower-precedence valid source remains effective', async () => {
    const { ctx, acks, writes } = run({
      workspace: [ROW],
      user: [{ ...ROW, name: 'Fallback' }],
      workflows: [{ workflowId: 'wf-1', pipelineId: ROW.id, kind: 'run-request' }]
    });

    await handler(ctx, remove(ROW.id, [ROW]));

    expect(acks[0].status).toBe('accepted');
    expect(writes).toEqual([[]]);
  });

  it('permits removal when no consuming Workflow references the id', async () => {
    const { ctx, acks, writes } = run({
      workspace: [ROW],
      workflows: [{ workflowId: 'wf-1', pipelineId: 'other-flow', kind: 'run-request' }]
    });

    await handler(ctx, remove(ROW.id, [ROW]));

    expect(acks[0].status).toBe('accepted');
    expect(writes).toEqual([[]]);
  });

  it('permits removal when the host exposes no Workflow references at all', async () => {
    const { ctx, acks, writes } = run({ workspace: [ROW], omitWorkflowRefs: true });

    await handler(ctx, remove(ROW.id, [ROW]));

    expect(acks[0].status).toBe('accepted');
    expect(writes).toEqual([[]]);
  });

  // A lower-precedence source only rescues the removal when it is *valid*; an
  // invalid row never becomes effective, so the reference would still dangle.
  it('does not treat an invalid lower-precedence source as a remaining source', async () => {
    const { ctx, acks, writes } = run({
      workspace: [ROW],
      user: [{ ...ROW, phases: [] }],
      workflows: [{ workflowId: 'wf-1', pipelineId: ROW.id, kind: 'run-request' }]
    });

    await handler(ctx, remove(ROW.id, [ROW]));

    expect(acks[0]).toMatchObject({
      status: 'rejected',
      reason: 'pipeline-removal-blocked',
      result: { dependentWorkflowIds: ['wf-1'], total: 1 }
    });
    expect(writes).toEqual([]);
  });

  it('blocks a reset that would leave a consuming Workflow reference unresolved', async () => {
    const { ctx, acks, writes } = run({
      workspace: [ROW],
      workflows: [{ workflowId: 'wf-1', pipelineId: ROW.id, kind: 'run-request' }]
    });

    await handler(ctx, reset([ROW]));

    expect(acks[0]).toMatchObject({
      status: 'rejected',
      reason: 'pipeline-removal-blocked',
      result: { pipelineIds: [ROW.id], dependentWorkflowIds: ['wf-1'] }
    });
    expect(writes).toEqual([]);
  });

  it('reports each consuming Workflow once even when it references the id twice', async () => {
    const { ctx, acks } = run({
      workspace: [ROW],
      workflows: [
        { workflowId: 'wf-1', pipelineId: ROW.id, kind: 'run-request' },
        { workflowId: 'wf-1', pipelineId: ROW.id, kind: 'run-request' }
      ]
    });

    await handler(ctx, remove(ROW.id, [ROW]));

    expect(acks[0]).toMatchObject({
      status: 'rejected',
      reason: 'pipeline-removal-blocked',
      result: { dependentWorkflowIds: ['wf-1'], total: 1 }
    });
  });
});
