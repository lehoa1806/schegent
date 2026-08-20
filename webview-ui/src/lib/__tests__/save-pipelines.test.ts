// Feature 082 (US1, T021) — savePipelines helper behavior.
// Feature 100 (FR-R3-016) T509b — narrowed to the translation.
//
// The transport half of this file (correlation, pending, acks, timeout, no
// cross-resolution, UUIDv4) moved to `catalog-lifecycle.test.ts`, where the code
// it tests now lives once. See `save-phases.test.ts` for why all three save tests
// were cut the same way.
//
// What stays is Pipeline-specific, and it is the reason this file is not a copy of
// `save-phases.test.ts`:
//
//   - The pre-082 helper posted `{ pipelines }` and dropped every authored
//     contract field on the floor. The row is now a definition *body*, forwarded
//     verbatim, so ports, bindings, execution defaults, and recommendedNext have
//     to survive — and the store does not validate a body (099 FR-010), so this
//     helper is the last place that could damage them.
//   - A Pipeline row has two authored identity spellings, `pipelineId` and `id`.
//     A package addresses definitions by id, so one of them has to be picked here,
//     and a row carrying neither has to go somewhere other than the wire.

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

const { savePipelines } = await import('../save-pipelines');
const { EMPTY_LAYER } = await import('../catalog-lifecycle');
type SavePipelinesRequest = import('../save-pipelines').SavePipelinesRequest;

interface Envelope {
  readonly type: string;
  readonly correlationId: string;
  readonly payload: unknown;
}

interface PackagePayload {
  readonly layers: readonly {
    readonly kind: string;
    readonly expectedRevision: string;
    readonly definitions: readonly { readonly id: string; readonly body: unknown }[];
  }[];
}

function ack(envelope: Envelope): void {
  const fn = ackListeners.get(envelope.correlationId);
  expect(fn, `no listener registered for ${envelope.correlationId}`).toBeDefined();
  ackListeners.delete(envelope.correlationId);
  fn!({ status: 'accepted' });
}

// A fully authored row: id/name/version plus every optional contract field. If
// the helper ever reshapes the body, the deep-equality assertion below fails
// rather than silently publishing a lossy definition.
const AUTHORED_ROW = {
  id: 'custom-flow',
  name: 'Custom Flow',
  description: 'Specify, then finalize.',
  version: 3,
  phases: ['speckit-specify', 'speckit-plan', 'finalize'],
  inputs: [{ portId: 'brief', label: 'Feature brief', type: 'text' as const }],
  outputs: [{ portId: 'spec', label: 'Spec document', type: 'markdown' as const }],
  bindings: [
    {
      kind: 'input' as const,
      phaseIndex: 0,
      inputKey: 'notes',
      source: { from: 'pipeline-input' as const, portId: 'brief' }
    },
    {
      kind: 'output' as const,
      phaseIndex: 2,
      portId: 'spec',
      outputKey: 'document'
    }
  ],
  executionDefaults: { runner: 'claude', effort: 'high' as const },
  recommendedNext: ['release']
};

const SAMPLE_REQUEST: SavePipelinesRequest = {
  expectedRevision: 'a'.repeat(64),
  mutation: { kind: 'edit', pipelineId: 'custom-flow' },
  pipelines: [AUTHORED_ROW]
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

describe('savePipelines — the authored layer becomes one publication', () => {
  it('publishes one pipeline layer with the whole authored row as the body', async () => {
    const posted: Envelope[] = [];
    const promise = savePipelines(SAMPLE_REQUEST, (msg) => posted.push(msg as Envelope));

    expect(posted).toHaveLength(1);
    expect(posted[0]!.type).toBe(WIRE.package);
    // Deep equality, not a subset check: ports, bindings, executionDefaults, and
    // recommendedNext must all survive the trip to the store.
    expect(posted[0]!.payload).toEqual({
      layers: [
        {
          kind: 'pipeline',
          expectedRevision: 'a'.repeat(64),
          definitions: [{ id: 'custom-flow', body: AUTHORED_ROW }]
        }
      ]
    });

    ack(posted[0]!);
    await expect(promise).resolves.toEqual({ status: 'accepted' });
  });

  it('never sends the mutation tag', async () => {
    const posted: Envelope[] = [];
    const promise = savePipelines(SAMPLE_REQUEST, (msg) => posted.push(msg as Envelope));
    expect(Object.keys(posted[0]!.payload as object)).toEqual(['layers']);
    expect(JSON.stringify(posted[0]!.payload)).not.toContain('mutation');
    ack(posted[0]!);
    await promise;
  });

  const PUBLISHING_MUTATIONS: readonly SavePipelinesRequest['mutation'][] = [
    { kind: 'create', pipelineId: 'custom-flow' },
    { kind: 'import-package', pipelineIds: ['custom-flow'] },
    { kind: 'edit', pipelineId: 'custom-flow' },
    { kind: 'duplicate', sourcePipelineId: 'speckit-new-feature', pipelineId: 'custom-flow' },
    { kind: 'reset' }
  ];

  it.each(PUBLISHING_MUTATIONS)(
    'a $kind mutation produces the same publication as every other',
    async (mutation) => {
      const posted: Envelope[] = [];
      const promise = savePipelines({ ...SAMPLE_REQUEST, mutation }, (msg) =>
        posted.push(msg as Envelope)
      );

      expect(posted).toHaveLength(1);
      expect(posted[0]!.type).toBe(WIRE.package);
      expect(posted[0]!.payload).toEqual({
        layers: [
          {
            kind: 'pipeline',
            expectedRevision: 'a'.repeat(64),
            definitions: [{ id: 'custom-flow', body: AUTHORED_ROW }]
          }
        ]
      });
      expect(confirmCalls).toEqual([]);

      ack(posted[0]!);
      await promise;
    }
  );
});

describe('savePipelines — choosing the id a definition is addressed by', () => {
  it('prefers the portable pipelineId over the legacy id', async () => {
    // Both spellings are accepted by the host validator, so a row can carry both,
    // and they can disagree — a row imported from a document keeps `pipelineId`
    // while the editor writes `id`. Publishing under the wrong one would create a
    // second definition instead of a version of the existing one.
    const posted: Envelope[] = [];
    const promise = savePipelines(
      {
        ...SAMPLE_REQUEST,
        pipelines: [{ ...AUTHORED_ROW, pipelineId: 'portable-flow' }]
      },
      (msg) => posted.push(msg as Envelope)
    );

    const layer = (posted[0]!.payload as PackagePayload).layers[0]!;
    expect(layer.definitions.map((definition) => definition.id)).toEqual(['portable-flow']);
    // The body still carries both keys unchanged: the choice is about addressing,
    // not about rewriting what the operator authored.
    expect(layer.definitions[0]!.body).toEqual({ ...AUTHORED_ROW, pipelineId: 'portable-flow' });

    ack(posted[0]!);
    await promise;
  });

  it('falls back to the legacy id when the row carries no pipelineId', async () => {
    const posted: Envelope[] = [];
    const promise = savePipelines(SAMPLE_REQUEST, (msg) => posted.push(msg as Envelope));
    const layer = (posted[0]!.payload as PackagePayload).layers[0]!;
    expect(layer.definitions.map((definition) => definition.id)).toEqual(['custom-flow']);
    ack(posted[0]!);
    await promise;
  });

  it('drops a row with neither spelling rather than publishing an empty id', async () => {
    // An empty id would be refused by the host as a malformed layer, and reported
    // against the whole document instead of the row that caused it — so the
    // operator would be told their valid Pipelines failed.
    const { id: _id, ...unnamed } = AUTHORED_ROW;
    const posted: Envelope[] = [];
    const promise = savePipelines(
      { ...SAMPLE_REQUEST, pipelines: [unnamed, { ...AUTHORED_ROW, id: 'keeps-its-id' }] },
      (msg) => posted.push(msg as Envelope)
    );

    const layer = (posted[0]!.payload as PackagePayload).layers[0]!;
    expect(layer.definitions.map((definition) => definition.id)).toEqual(['keeps-its-id']);

    ack(posted[0]!);
    await promise;
  });

  it('sends nothing when every row was dropped, or when there were none', async () => {
    const { id: _id, ...unnamed } = AUTHORED_ROW;
    const postMessage = vi.fn();
    await expect(
      savePipelines({ ...SAMPLE_REQUEST, pipelines: [unnamed] }, postMessage)
    ).resolves.toEqual(EMPTY_LAYER);
    await expect(savePipelines({ ...SAMPLE_REQUEST, pipelines: [] }, postMessage)).resolves.toEqual(
      EMPTY_LAYER
    );
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe('savePipelines — a removal is not a publication', () => {
  it('deactivates the named pipeline and leaves the surviving rows alone', async () => {
    const posted: Envelope[] = [];
    const promise = savePipelines(
      {
        ...SAMPLE_REQUEST,
        mutation: { kind: 'remove', pipelineId: 'custom-flow' },
        removedName: 'Custom Flow'
      },
      (msg) => posted.push(msg as Envelope)
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(posted).toHaveLength(1);
    expect(posted[0]!.type).toBe(WIRE.deactivate);
    expect(posted[0]!.payload).toEqual({
      kind: 'pipeline',
      id: 'custom-flow',
      expectedDraftVersion: NO_DRAFT
    });
    expect(confirmCalls).toEqual([
      {
        actionKey: 'catalog.deactivate-definition',
        context: {
          kindLabel: 'Pipeline',
          definitionName: 'Custom Flow',
          definitionId: 'custom-flow'
        }
      }
    ]);

    ack(posted[0]!);
    await expect(promise).resolves.toEqual({ status: 'accepted' });
  });

  it('removes by the mutation id, not by whichever row happens to be first', async () => {
    // The removal target comes from the mutation, and the layer handed in is the
    // one that remains — so a translation that read the id off the rows would
    // deactivate a survivor.
    const posted: Envelope[] = [];
    const promise = savePipelines(
      {
        ...SAMPLE_REQUEST,
        mutation: { kind: 'remove', pipelineId: 'gone-flow' },
        pipelines: [AUTHORED_ROW]
      },
      (msg) => posted.push(msg as Envelope)
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(posted[0]!.payload).toEqual({
      kind: 'pipeline',
      id: 'gone-flow',
      expectedDraftVersion: NO_DRAFT
    });

    ack(posted[0]!);
    await promise;
  });
});
