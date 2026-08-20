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
//
// Feature 099 (T496f, FR-042) — "leaves the id with no effective source" used to
// have two ways to be false: another layer supplied the id, or the surviving row
// in this layer did. Only the second survives the collapse to one catalog, and it
// is the one that was never separately pinned — a removal that drops one of two
// rows claiming an id leaves the id resolvable, and a removal that leaves only an
// INVALID row does not. Both cases below are those, and gate 13 answers them the
// same way it answered their cross-layer twins.

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
import { handler } from '../../../../../src/ui/sidebar/commands/cmd-save-pipelines';
import { CMD_SAVE_PIPELINES } from '../../../../../src/ui/sidebar/messages';
import type {
  CommandAckMessage,
  SavePipelinesCommand
} from '../../../../../src/ui/sidebar/messages';

const PHASE_ROW = { id: 'done', name: 'Done', version: 1, instruction: 'Done.' };
const ROW = { id: 'custom-flow', name: 'Custom Flow', version: 1, phases: ['done'] };

/** Feature 099 (T496f, FR-044a) — seeding rows does not move a revision. */
const SEEDED_REVISION = new FakeCatalogStore().revisionOf('pipeline');

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
  current?: readonly unknown[];
  workflows?: readonly WorkflowRef[];
  /** Hosts that expose no Workflow references at all omit the seam entirely. */
  omitWorkflowRefs?: boolean;
}) {
  const acks: CommandAckMessage[] = [];
  const store = new FakeCatalogStore({
    phases: [PHASE_ROW],
    pipelines: options.current ?? []
  });
  const ctx = {
    deps: {
      executeCommand: vi.fn(),
      queueRemover: { remove: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), sanitize: String },
      catalogStore: store,
      refreshCatalog: vi.fn(async () => undefined),
      readPhaseConfig: () => ({ rows: store.rowsOf('phase'), revision: store.revisionOf('phase') }),
      readPipelineConfig: () => ({
        rows: store.rowsOf('pipeline'),
        revision: store.revisionOf('pipeline')
      }),
      ...(options.omitWorkflowRefs
        ? {}
        : { readWorkflowPipelineRefs: () => options.workflows ?? [] })
    },
    correlationId: 'remove',
    postAck: async (ack: CommandAckMessage) => { acks.push(ack); return true; }
  } as unknown as Parameters<typeof handler>[0];
  return { ctx, acks, store, writes: () => layerWrites(store) };
}

function remove(
  pipelineId: string,
  proposed: readonly unknown[] = []
): SavePipelinesCommand {
  return {
    type: CMD_SAVE_PIPELINES,
    correlationId: 'remove',
    payload: {
      expectedRevision: SEEDED_REVISION,
      mutation: { kind: 'remove', pipelineId },
      pipelines: proposed
    }
  };
}

function reset(): SavePipelinesCommand {
  return {
    type: CMD_SAVE_PIPELINES,
    correlationId: 'remove',
    payload: {
      expectedRevision: SEEDED_REVISION,
      mutation: { kind: 'reset' },
      pipelines: []
    }
  };
}

beforeEach(() => capabilities.clear());

describe('safe Pipeline source removal (US7, FR-022, FR-022a, FR-024)', () => {
  // Feature 098 (T036, FR-010) — this named a built-in Pipeline and expected
  // `built-in-immutable`. That reason is keyed on the id being present in the
  // built-in layer, which now holds nothing, so it can no longer be produced. The
  // safety property it stood for survives on its own terms: a removal naming an id
  // no writable layer owns is still rejected and still writes nothing. Only the
  // reason code changes, to the generic mismatch.
  it('rejects removal of an id no layer owns', async () => {
    const { ctx, acks, writes } = run({});

    await handler(ctx, remove('speckit-new-feature'));

    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'pipeline-mutation-mismatch' });
    expect(writes()).toEqual([]);
  });

  it('blocks removal that would leave a consuming Workflow reference unresolved', async () => {
    const { ctx, acks, writes } = run({
      current: [ROW],
      workflows: [
        { workflowId: 'wf-z', pipelineId: ROW.id, kind: 'run-request' },
        { workflowId: 'wf-a', pipelineId: ROW.id, kind: 'run-request' }
      ]
    });

    await handler(ctx, remove(ROW.id));

    expect(acks[0]).toMatchObject({
      status: 'rejected',
      reason: 'pipeline-removal-blocked',
      result: {
        pipelineIds: [ROW.id],
        dependentWorkflowIds: ['wf-a', 'wf-z'],
        total: 2
      }
    });
    expect(writes()).toEqual([]);
  });

  it('permits removal of one of two rows claiming an id, because the id stays resolvable', async () => {
    // The successor of 'permits removal when a lower-precedence valid source
    // remains effective'. The rescuing source is a second row in the same catalog
    // rather than a second layer, and the gate's question is unchanged: after this
    // save, does the id still resolve? It does, so the Workflow reference does not
    // dangle and the removal goes through.
    const duplicate = { ...ROW, version: 2, name: 'Second Copy' };
    const { ctx, acks, writes } = run({
      current: [ROW, duplicate],
      workflows: [{ workflowId: 'wf-1', pipelineId: ROW.id, kind: 'run-request' }]
    });

    await handler(ctx, remove(ROW.id, [ROW]));

    expect(acks[0].status).toBe('accepted');
    expect(writes()).toEqual([[ROW]]);
  });

  it('permits removal when no consuming Workflow references the id', async () => {
    const { ctx, acks, writes } = run({
      current: [ROW],
      workflows: [{ workflowId: 'wf-1', pipelineId: 'other-flow', kind: 'run-request' }]
    });

    await handler(ctx, remove(ROW.id));

    expect(acks[0].status).toBe('accepted');
    expect(writes()).toEqual([[]]);
  });

  it('permits removal when the host exposes no Workflow references at all', async () => {
    const { ctx, acks, writes } = run({ current: [ROW], omitWorkflowRefs: true });

    await handler(ctx, remove(ROW.id));

    expect(acks[0].status).toBe('accepted');
    expect(writes()).toEqual([[]]);
  });

  // A remaining source only rescues the removal when it is *valid*; an invalid row
  // never becomes effective, so the reference would still dangle.
  //
  // Feature 099 (T496f) — the invalid rescuer used to sit in the OTHER layer,
  // outside the payload, so it reached gate 13 and was rejected there. With one
  // catalog it is in the payload gate 5 validates, and gate 5 answers first. The
  // property is preserved and in fact strengthened: such a save is refused
  // outright, so an invalid row cannot rescue a removal by any route. The reason
  // literal is the earlier gate's, which is what makes the ordering observable.
  it('never lets an invalid remaining row rescue a removal, because gate 5 refuses it first', async () => {
    const invalid = { ...ROW, version: 2, phases: [] };
    const { ctx, acks, writes } = run({
      current: [ROW, invalid],
      workflows: [{ workflowId: 'wf-1', pipelineId: ROW.id, kind: 'run-request' }]
    });

    await handler(ctx, remove(ROW.id, [invalid]));

    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'pipeline-validation' });
    expect(writes()).toEqual([]);
  });

  it('blocks a reset that would leave a consuming Workflow reference unresolved', async () => {
    const { ctx, acks, writes } = run({
      current: [ROW],
      workflows: [{ workflowId: 'wf-1', pipelineId: ROW.id, kind: 'run-request' }]
    });

    await handler(ctx, reset());

    expect(acks[0]).toMatchObject({
      status: 'rejected',
      reason: 'pipeline-removal-blocked',
      result: { pipelineIds: [ROW.id], dependentWorkflowIds: ['wf-1'] }
    });
    expect(writes()).toEqual([]);
  });

  it('reports each consuming Workflow once even when it references the id twice', async () => {
    const { ctx, acks } = run({
      current: [ROW],
      workflows: [
        { workflowId: 'wf-1', pipelineId: ROW.id, kind: 'run-request' },
        { workflowId: 'wf-1', pipelineId: ROW.id, kind: 'run-request' }
      ]
    });

    await handler(ctx, remove(ROW.id));

    expect(acks[0]).toMatchObject({
      status: 'rejected',
      reason: 'pipeline-removal-blocked',
      result: { dependentWorkflowIds: ['wf-1'], total: 1 }
    });
  });
});
