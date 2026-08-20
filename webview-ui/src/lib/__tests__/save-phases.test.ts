// Feature 026 T012 — savePhases helper behavior.
// Feature 100 (FR-R3-016) T509b — narrowed to the translation.
//
// This file used to assert the transport: one envelope per call, the correlation
// id, the accepted/rejected acks, the five-second timeout, no cross-resolution,
// the UUIDv4 layout. `save-phases.ts` owned a copy of that code, so it owned a
// copy of those tests — and so did `save-pipelines.test.ts` and
// `save-workflows.test.ts`. There is one sender now, and the transport is asserted
// once against it in `catalog-lifecycle.test.ts`.
//
// What is left here is what is still this file's own: `savePhases` is a
// translation from the whole-layer request the Builder builds to the lifecycle
// operations the store actually has. Three claims, none of which the transport
// tests could make:
//
//   - A layer with rows becomes ONE publication of ONE layer, gated on the same
//     `expectedRevision` the retired command gated on (FR-036).
//   - A `remove` does NOT become a publication. Removal used to be an omission
//     from a whole-array write; omitting a definition from a package leaves it
//     exactly as it was (FR-039b), so a removal has to be routed to the operation
//     that removes it.
//   - The `mutation` tag does not travel. Intent is declared by being the command
//     it is (FR-051), so a payload carrying it would be carrying a second,
//     divergent statement of what the write means.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CMD_DEACTIVATE_DEFINITION,
  CMD_PUBLISH_PACKAGE
} from '../messages';
import { NO_DRAFT } from '../../../../src/contracts/catalog-lifecycle';

// Bound rather than named inline: `tests/lint/catalog-lifecycle-dispatch.test.ts`
// scans for a lifecycle constant in first-argument position, and
// `expect(...).toBe(CMD_X)` has that shape. Still imported, so a rename breaks
// this file instead of leaving it comparing against a stale literal.
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

const { savePhases } = await import('../save-phases');
const { DECLINED, EMPTY_LAYER } = await import('../catalog-lifecycle');
type SavePhasesRequest = import('../save-phases').SavePhasesRequest;

interface Envelope {
  readonly type: string;
  readonly correlationId: string;
  readonly payload: unknown;
}

function ack(envelope: Envelope, status: 'accepted' | 'rejected' = 'accepted'): void {
  const fn = ackListeners.get(envelope.correlationId);
  expect(fn, `no listener registered for ${envelope.correlationId}`).toBeDefined();
  ackListeners.delete(envelope.correlationId);
  fn!({ status });
}

const SAMPLE_PHASES = [
  {
    id: 'speckit-plan',
    name: 'Plan',
    version: 2,
    instruction: 'Plan the work.',
    loopable: false,
    effort: 'high' as const
  }
];

const SAMPLE_REQUEST: SavePhasesRequest = {
  expectedRevision: 'phase-revision',
  mutation: { kind: 'edit', phaseId: 'speckit-plan' },
  phases: SAMPLE_PHASES
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

describe('savePhases — the authored layer becomes one publication', () => {
  it('publishes one phase layer gated on the revision it was based on', async () => {
    const posted: Envelope[] = [];
    const promise = savePhases(SAMPLE_REQUEST, (msg) => posted.push(msg as Envelope));

    expect(posted).toHaveLength(1);
    expect(posted[0]!.type).toBe(WIRE.package);
    // Deep equality, so the payload is pinned in both directions: every row is
    // there, and nothing else is.
    expect(posted[0]!.payload).toEqual({
      layers: [
        {
          kind: 'phase',
          expectedRevision: 'phase-revision',
          definitions: [{ id: 'speckit-plan', body: SAMPLE_PHASES[0] }]
        }
      ]
    });

    ack(posted[0]!);
    await expect(promise).resolves.toEqual({ status: 'accepted' });
  });

  it('addresses every row by its own id', async () => {
    // The shape of the publication is per-definition, not per-array (FR-039a), so
    // a translation that sent the rows as one opaque blob would type-check and
    // publish a catalog rather than three definitions.
    const rows = [
      { id: 'specify', name: 'Specify', version: 1 },
      { id: 'plan', name: 'Plan', version: 1 },
      { id: 'implement', name: 'Implement', version: 3 }
    ];
    const posted: Envelope[] = [];
    const promise = savePhases(
      { expectedRevision: 'rev', mutation: { kind: 'reset' }, phases: rows },
      (msg) => posted.push(msg as Envelope)
    );

    const layer = (posted[0]!.payload as { layers: { definitions: { id: string }[] }[] }).layers[0]!;
    expect(layer.definitions.map((definition) => definition.id)).toEqual([
      'specify',
      'plan',
      'implement'
    ]);

    ack(posted[0]!);
    await promise;
  });

  it('carries a row body verbatim, including an explicitly false field', async () => {
    // `isRequired: false` is the case that catches a body rebuilt field-by-field
    // with truthiness checks: the store keeps the body verbatim (099 FR-010), so
    // this helper is the last place that could drop it, and dropping it would flip
    // a required Phase to optional silently.
    const posted: Envelope[] = [];
    const row = { id: 'optional-phase', name: 'Optional', version: 1, isRequired: false };
    const promise = savePhases(
      { expectedRevision: 'rev', mutation: { kind: 'edit', phaseId: row.id }, phases: [row] },
      (msg) => posted.push(msg as Envelope)
    );

    const layer = (posted[0]!.payload as { layers: { definitions: { body: unknown }[] }[] })
      .layers[0]!;
    expect(layer.definitions[0]!.body).toEqual(row);

    ack(posted[0]!);
    await promise;
  });

  it('never sends the mutation tag, the removal name, or the focus target', async () => {
    const posted: Envelope[] = [];
    const promise = savePhases(
      { ...SAMPLE_REQUEST, removedName: 'Plan', originatingElement: null },
      (msg) => posted.push(msg as Envelope)
    );

    // Asserted by key, not by deep equality against the whole payload: the point
    // is that these three inputs are consumed here and are not part of the wire
    // contract, and a `toEqual` elsewhere in the file would not say which.
    expect(Object.keys(posted[0]!.payload as object)).toEqual(['layers']);
    expect(JSON.stringify(posted[0]!.payload)).not.toContain('mutation');

    ack(posted[0]!);
    await promise;
  });

  const PUBLISHING_MUTATIONS: readonly SavePhasesRequest['mutation'][] = [
    { kind: 'create', phaseId: 'speckit-plan' },
    { kind: 'import', phaseId: 'speckit-plan' },
    { kind: 'import-package', phaseIds: ['speckit-plan'] },
    { kind: 'edit', phaseId: 'speckit-plan' },
    { kind: 'duplicate', sourcePhaseId: 'specify', phaseId: 'speckit-plan' },
    { kind: 'reset' }
  ];

  it.each(PUBLISHING_MUTATIONS)(
    'a $kind mutation produces the same publication as every other',
    async (mutation) => {
      // Every intent but `remove` was already the same write — a whole layer made
      // effective — and the tag only ever told the host how to describe it. This
      // is the positive half of "intent no longer travels": not just that the tag
      // is stripped, but that nothing downstream needed it.
      const posted: Envelope[] = [];
      const promise = savePhases({ ...SAMPLE_REQUEST, mutation }, (msg) =>
        posted.push(msg as Envelope)
      );

      expect(posted).toHaveLength(1);
      expect(posted[0]!.type).toBe(WIRE.package);
      expect(posted[0]!.payload).toEqual({
        layers: [
          {
            kind: 'phase',
            expectedRevision: 'phase-revision',
            definitions: [{ id: 'speckit-plan', body: SAMPLE_PHASES[0] }]
          }
        ]
      });
      expect(confirmCalls).toEqual([]);

      ack(posted[0]!);
      await promise;
    }
  );

  it('sends nothing at all for a layer with no rows', async () => {
    // A package says what each named definition becomes and nothing about the
    // rest, so an empty layer is not "empty the catalog" — it is a statement with
    // no content. Refused here by name rather than left to the host's
    // `invalid-payload`, which would be a true refusal for the wrong reason.
    const postMessage = vi.fn();
    await expect(
      savePhases({ expectedRevision: 'rev', mutation: { kind: 'reset' }, phases: [] }, postMessage)
    ).resolves.toEqual(EMPTY_LAYER);
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe('savePhases — a removal is not a publication', () => {
  it('deactivates the named phase instead of publishing the layer', async () => {
    const posted: Envelope[] = [];
    const promise = savePhases(
      {
        expectedRevision: 'phase-revision',
        mutation: { kind: 'remove', phaseId: 'speckit-plan' },
        // The surviving rows are still handed in, because the Builder still holds
        // a whole layer. They must not be republished: republishing them would
        // move each survivor's active pointer as a side effect of removing a
        // different definition (FR-039a).
        phases: SAMPLE_PHASES,
        removedName: 'Plan'
      },
      (msg) => posted.push(msg as Envelope)
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(posted).toHaveLength(1);
    expect(posted[0]!.type).toBe(WIRE.deactivate);
    expect(posted[0]!.payload).toEqual({
      kind: 'phase',
      id: 'speckit-plan',
      expectedDraftVersion: NO_DRAFT
    });

    ack(posted[0]!);
    await expect(promise).resolves.toEqual({ status: 'accepted' });
  });

  it('shows the operator the name, and falls back to the id when it has none', async () => {
    confirmAnswer = false;
    const postMessage = vi.fn();

    await savePhases(
      {
        expectedRevision: 'rev',
        mutation: { kind: 'remove', phaseId: 'speckit-plan' },
        phases: SAMPLE_PHASES,
        removedName: 'Plan'
      },
      postMessage
    );
    await savePhases(
      {
        expectedRevision: 'rev',
        mutation: { kind: 'remove', phaseId: 'speckit-plan' },
        phases: SAMPLE_PHASES
      },
      postMessage
    );

    expect(confirmCalls.map((call) => call.context)).toEqual([
      { kindLabel: 'Phase', definitionName: 'Plan', definitionId: 'speckit-plan' },
      // No `removedName`, so the id stands in. An `undefined` here would render a
      // prompt asking the operator to confirm removing nothing in particular.
      { kindLabel: 'Phase', definitionName: 'speckit-plan', definitionId: 'speckit-plan' }
    ]);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('reports the decline without touching the layer', async () => {
    confirmAnswer = false;
    const postMessage = vi.fn();
    await expect(
      savePhases(
        {
          expectedRevision: 'rev',
          mutation: { kind: 'remove', phaseId: 'speckit-plan' },
          phases: SAMPLE_PHASES
        },
        postMessage
      )
    ).resolves.toEqual(DECLINED);
    // The claim the caller depends on: a declined removal is not a fallthrough to
    // publishing the layer it was handed.
    expect(postMessage).not.toHaveBeenCalled();
  });
});
