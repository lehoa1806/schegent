// Feature 083 (US1, T033) — saveWorkflows helper behavior.
// Feature 100 (FR-R3-016) T509b — narrowed to the translation.
//
// The transport half moved to `catalog-lifecycle.test.ts`; see
// `save-phases.test.ts` for why. What is Workflow-specific and stays here:
//
//   - Authored node and connection **order** is part of the payload's meaning
//     (FR-049). The row becomes the definition body unchanged, and the store keeps
//     a body verbatim (099 FR-010) without validating it, so this helper is both
//     the last place order could be lost and the last place a graph could be
//     silently normalised.
//   - `reset` has no successor operation. It emptied the whole layer in one write,
//     which a package cannot express — a package says what each named definition
//     becomes and nothing about the rest (FR-039b). The union arm survives because
//     it is declared in the shared snapshot types, so what it does now has to be
//     pinned rather than assumed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CMD_DEACTIVATE_DEFINITION, CMD_PUBLISH_PACKAGE } from '../messages';
import { NO_DRAFT } from '../../../../src/contracts/catalog-lifecycle';

// Bound, not named inline — see the note in `save-phases.test.ts`.
const WIRE = {
  package: CMD_PUBLISH_PACKAGE,
  deactivate: CMD_DEACTIVATE_DEFINITION
} as const;

type AckListener = (ack: {
  status: 'accepted' | 'rejected';
  reason?: string;
  result?: unknown;
}) => void;

const ackListeners = new Map<string, AckListener>();

vi.mock('../snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending(): void {},
    onceAck(id: string, fn: AckListener): () => void {
      ackListeners.set(id, fn);
      return () => ackListeners.delete(id);
    }
  }
}));

const confirmCalls: { readonly actionKey: string; readonly context: unknown }[] = [];
let confirmAnswer = true;

vi.mock('../use-confirm', () => ({
  useConfirm(actionKey: string, options?: { context?: unknown }): Promise<boolean> {
    confirmCalls.push({ actionKey, context: options?.context });
    return Promise.resolve(confirmAnswer);
  }
}));

const { saveWorkflows } = await import('../save-workflows');
const { EMPTY_LAYER } = await import('../catalog-lifecycle');
type SaveWorkflowsRequest = import('../save-workflows').SaveWorkflowsRequest;
type SaveWorkflowRow = import('../save-workflows').SaveWorkflowRow;

interface Envelope {
  readonly type: string;
  readonly correlationId: string;
  readonly payload: unknown;
}

interface PackagePayload {
  readonly layers: readonly {
    readonly kind: string;
    readonly expectedRevision: string;
    readonly definitions: readonly { readonly id: string; readonly body: SaveWorkflowRow }[];
  }[];
}

function ack(envelope: Envelope): void {
  const fn = ackListeners.get(envelope.correlationId);
  expect(fn, `no listener registered for ${envelope.correlationId}`).toBeDefined();
  ackListeners.delete(envelope.correlationId);
  fn!({ status: 'accepted' });
}

// A fully authored graph: two nodes, a conditional connection, a default
// connection, and a selection rule. The deep equality below fails if the helper
// reshapes any of it.
const AUTHORED_ROW = {
  workflowId: 'release-train',
  name: 'Release Train',
  description: 'Draft, then ship if the draft passed.',
  version: 2,
  nodes: [
    { nodeId: 'draft', pipelineId: 'spec-pipeline' },
    { nodeId: 'ship', pipelineId: 'release-pipeline' }
  ],
  connections: [
    {
      from: { nodeId: 'draft', portId: 'spec' },
      to: { nodeId: 'ship', portId: 'brief' },
      condition: {
        left: { source: 'node-status' as const, nodeId: 'draft' },
        operator: 'equals' as const,
        right: 'succeeded'
      },
      selection: 'first' as const
    },
    {
      from: { nodeId: 'draft', portId: 'notes' },
      to: { nodeId: 'ship', portId: 'notes' },
      isDefault: true
    }
  ],
  startNodeIds: ['draft']
};

const SAMPLE_REQUEST: SaveWorkflowsRequest = {
  expectedRevision: 'a'.repeat(64),
  mutation: { kind: 'edit', workflowId: 'release-train' },
  workflows: [AUTHORED_ROW]
};

beforeEach(() => {
  ackListeners.clear();
  confirmCalls.length = 0;
  confirmAnswer = true;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('saveWorkflows — the authored graph becomes one publication', () => {
  it('publishes one workflow layer with the whole authored graph as the body', async () => {
    const posted: Envelope[] = [];
    const promise = saveWorkflows(SAMPLE_REQUEST, (msg) => posted.push(msg as Envelope));

    expect(posted).toHaveLength(1);
    expect(posted[0]!.type).toBe(WIRE.package);
    // Deep equality, not a subset check: nodes, connections, conditions,
    // selection rules, and allowed starts must survive the trip to the store.
    expect(posted[0]!.payload).toEqual({
      layers: [
        {
          kind: 'workflow',
          expectedRevision: 'a'.repeat(64),
          definitions: [{ id: 'release-train', body: AUTHORED_ROW }]
        }
      ]
    });

    ack(posted[0]!);
    await expect(promise).resolves.toEqual({ status: 'accepted' });
  });

  it('preserves authored node and connection order (FR-049)', async () => {
    // Order is meaning here: `startNodeIds` and the first-matching-connection rule
    // both read positionally, so a helper that sorted or deduped the graph would
    // change which node runs first without changing anything the operator sees.
    const posted: Envelope[] = [];
    const promise = saveWorkflows(SAMPLE_REQUEST, (msg) => posted.push(msg as Envelope));

    const body = (posted[0]!.payload as PackagePayload).layers[0]!.definitions[0]!.body;
    expect(body.nodes.map((node) => node.nodeId)).toEqual(['draft', 'ship']);
    expect(body.connections.map((edge) => edge.from.portId)).toEqual(['spec', 'notes']);
    expect(body.startNodeIds).toEqual(['draft']);

    ack(posted[0]!);
    await promise;
  });

  it('addresses each workflow by its workflowId, the only identity spelling', async () => {
    // Unlike a Pipeline row there is no legacy `id` form to fall back to, so the
    // extraction is unconditional — which makes it worth pinning that it reads
    // `workflowId` and not `id`, since a row carrying a stray `id` must not win.
    const posted: Envelope[] = [];
    const promise = saveWorkflows(
      {
        ...SAMPLE_REQUEST,
        mutation: { kind: 'import-package', workflowIds: ['release-train', 'hotfix'] },
        workflows: [AUTHORED_ROW, { ...AUTHORED_ROW, workflowId: 'hotfix', name: 'Hotfix' }]
      },
      (msg) => posted.push(msg as Envelope)
    );

    const layer = (posted[0]!.payload as PackagePayload).layers[0]!;
    expect(layer.definitions.map((definition) => definition.id)).toEqual([
      'release-train',
      'hotfix'
    ]);

    ack(posted[0]!);
    await promise;
  });

  it('never sends the mutation tag', async () => {
    const posted: Envelope[] = [];
    const promise = saveWorkflows(SAMPLE_REQUEST, (msg) => posted.push(msg as Envelope));
    expect(Object.keys(posted[0]!.payload as object)).toEqual(['layers']);
    expect(JSON.stringify(posted[0]!.payload)).not.toContain('mutation');
    ack(posted[0]!);
    await promise;
  });

  const PUBLISHING_MUTATIONS: readonly SaveWorkflowsRequest['mutation'][] = [
    { kind: 'create', workflowId: 'release-train' },
    { kind: 'import-package', workflowIds: ['release-train'] },
    { kind: 'edit', workflowId: 'release-train' },
    { kind: 'duplicate', sourceWorkflowId: 'release-train', workflowId: 'release-train' }
  ];

  it.each(PUBLISHING_MUTATIONS)(
    'a $kind mutation produces the same publication as every other',
    async (mutation) => {
      const posted: Envelope[] = [];
      const promise = saveWorkflows({ ...SAMPLE_REQUEST, mutation }, (msg) =>
        posted.push(msg as Envelope)
      );

      expect(posted).toHaveLength(1);
      expect(posted[0]!.type).toBe(WIRE.package);
      expect(posted[0]!.payload).toEqual({
        layers: [
          {
            kind: 'workflow',
            expectedRevision: 'a'.repeat(64),
            definitions: [{ id: 'release-train', body: AUTHORED_ROW }]
          }
        ]
      });
      expect(confirmCalls).toEqual([]);

      ack(posted[0]!);
      await promise;
    }
  );

  it('a reset with no rows empties nothing, because emptying is no longer one write', async () => {
    // The Reset action is gone from the editor for this reason (FR-051): a package
    // publish of zero definitions says nothing at all, so a helper that sent it
    // would report success having changed nothing. Refused by name instead.
    const postMessage = vi.fn();
    await expect(
      saveWorkflows({ ...SAMPLE_REQUEST, mutation: { kind: 'reset' }, workflows: [] }, postMessage)
    ).resolves.toEqual(EMPTY_LAYER);
    expect(postMessage).not.toHaveBeenCalled();
    expect(confirmCalls).toEqual([]);
  });
});

describe('saveWorkflows — a removal is not a publication', () => {
  it('deactivates the named workflow and leaves the surviving graphs alone', async () => {
    const posted: Envelope[] = [];
    const promise = saveWorkflows(
      {
        ...SAMPLE_REQUEST,
        mutation: { kind: 'remove', workflowId: 'release-train' },
        removedName: 'Release Train'
      },
      (msg) => posted.push(msg as Envelope)
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(posted).toHaveLength(1);
    expect(posted[0]!.type).toBe(WIRE.deactivate);
    expect(posted[0]!.payload).toEqual({
      kind: 'workflow',
      id: 'release-train',
      expectedDraftVersion: NO_DRAFT
    });
    expect(confirmCalls).toEqual([
      {
        actionKey: 'catalog.deactivate-definition',
        context: {
          kindLabel: 'Workflow',
          definitionName: 'Release Train',
          definitionId: 'release-train'
        }
      }
    ]);

    ack(posted[0]!);
    await expect(promise).resolves.toEqual({ status: 'accepted' });
  });

  it('removes by the mutation id, not by whichever row happens to be first', async () => {
    const posted: Envelope[] = [];
    const promise = saveWorkflows(
      { ...SAMPLE_REQUEST, mutation: { kind: 'remove', workflowId: 'gone-train' } },
      (msg) => posted.push(msg as Envelope)
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(posted[0]!.payload).toEqual({
      kind: 'workflow',
      id: 'gone-train',
      expectedDraftVersion: NO_DRAFT
    });

    ack(posted[0]!);
    await promise;
  });
});
