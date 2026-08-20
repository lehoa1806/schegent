// Feature 100 (FR-R3-016) T509a — the webview's single lifecycle dispatch surface.
//
// This file is a consolidation, not a new suite. `save-phases.test.ts`,
// `save-pipelines.test.ts`, and `save-workflows.test.ts` each carried its own copy
// of the same transport assertions — one envelope per call, `markPending`, the
// one-shot ack, the structured `result`, the five-second timeout, no
// cross-resolution, the RFC 4122 v4 layout — because each helper carried its own
// copy of the code. There is one `dispatch` now, so the transport is asserted once
// here.
//
// Feature 101 (T030) — those three files and the helpers under them are deleted.
// The translation each of them kept (an authored row to a definition body) went
// with its editor, and is asserted where the editor sends: the per-editor suites
// read the `body` off the draft write.
//
// Two things this file adds that no retired suite could have had:
//
//   1. **Which command each operation sends.** Six operations over one transport
//      means the transport passing says nothing about an operation posting the
//      wrong command, and every one of them takes a structurally similar target.
//   2. **The two confirmation gates (FR-049, FR-050).** They live inside the
//      sender rather than at the call sites, so "the prompt was shown" and "the
//      command was posted" are properties of this module and provable here. The
//      other four are asserted to be UNgated, which is the half that would
//      otherwise rot silently: a prompt added to publish would ask an operator to
//      confirm an additive operation, and nothing else would fail.
//
// A note on how the wire constants are referenced below. The lint in
// `tests/lint/catalog-lifecycle-dispatch.test.ts` scans the whole webview tree for
// a lifecycle constant in first-argument position — `(CMD_X` — because that is
// what a second dispatch surface looks like. `expect(...).toBe(CMD_X)` has the
// same shape, so the constants are bound into `WIRE` once and the assertions read
// the bindings. They are still imported, so a renamed command breaks this file
// rather than silently comparing against a stale literal.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CMD_DEACTIVATE_DEFINITION,
  CMD_DISCARD_DEFINITION_DRAFT,
  CMD_PUBLISH_DEFINITION,
  CMD_PUBLISH_PACKAGE,
  CMD_RESTORE_DEFINITION_VERSION,
  CMD_SAVE_DEFINITION_DRAFT
} from '../messages';
import { NO_DRAFT } from '../../../../src/contracts/catalog-lifecycle';

type AckListener = (ack: {
  status: 'accepted' | 'rejected';
  reason?: string;
  result?: unknown;
}) => void;

const ackListeners = new Map<string, AckListener>();
const pendingSet = new Set<string>();

vi.mock('../snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending(id: string): void {
      pendingSet.add(id);
    },
    onceAck(id: string, fn: AckListener): () => void {
      ackListeners.set(id, fn);
      return () => ackListeners.delete(id);
    }
  }
}));

/** Every confirmation the sender raised, and the answer it was given. */
const confirmCalls: { readonly actionKey: string; readonly context: unknown }[] = [];
let confirmAnswer = true;

vi.mock('../use-confirm', () => ({
  useConfirm(actionKey: string, options?: { context?: unknown }): Promise<boolean> {
    confirmCalls.push({ actionKey, context: options?.context });
    return Promise.resolve(confirmAnswer);
  }
}));

const {
  DECLINED,
  deactivateDefinition,
  discardDefinitionDraft,
  publishDefinition,
  publishDefinitionPackage,
  restoreDefinitionVersion,
  saveDefinitionDraft
} = await import('../catalog-lifecycle');

// See the header: bound rather than referenced inline so the single-sender lint
// keeps meaning "a module that dispatches" and not "a module that names".
const WIRE = {
  draft: CMD_SAVE_DEFINITION_DRAFT,
  publish: CMD_PUBLISH_DEFINITION,
  restore: CMD_RESTORE_DEFINITION_VERSION,
  deactivate: CMD_DEACTIVATE_DEFINITION,
  discard: CMD_DISCARD_DEFINITION_DRAFT,
  package: CMD_PUBLISH_PACKAGE
} as const;

interface Envelope {
  readonly type: string;
  readonly correlationId: string;
  readonly payload: unknown;
}

function fireAck(
  id: string,
  status: 'accepted' | 'rejected',
  reason?: string,
  result?: unknown
): void {
  const fn = ackListeners.get(id);
  expect(fn, `no listener registered for ${id}`).toBeDefined();
  ackListeners.delete(id);
  fn!({ status, reason, result });
}

const DRAFT_REQUEST = {
  kind: 'phase' as const,
  id: 'speckit-plan',
  expectedDraftVersion: NO_DRAFT,
  body: { id: 'speckit-plan', name: 'Plan', version: 2 },
  note: 'first cut'
};

const CONFIRM_OPTIONS = { definitionName: 'Plan', originatingElement: null };

beforeEach(() => {
  ackListeners.clear();
  pendingSet.clear();
  confirmCalls.length = 0;
  confirmAnswer = true;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the transport, asserted once for all six operations', () => {
  it('posts exactly one envelope carrying the request verbatim', async () => {
    const posted: unknown[] = [];
    const promise = saveDefinitionDraft(DRAFT_REQUEST, (msg) => posted.push(msg));

    expect(posted.length).toBe(1);
    const env = posted[0] as Envelope;
    expect(env.type).toBe(WIRE.draft);
    // Deep equality, not a subset check: the body is stored verbatim by the store
    // (099 FR-010), so this helper is the last place that could reshape it.
    expect(env.payload).toEqual(DRAFT_REQUEST);

    fireAck(env.correlationId, 'accepted');
    await promise;
  });

  it('marks the correlation id pending so the snapshot store can gate the UI', async () => {
    const postMessage = vi.fn();
    const promise = saveDefinitionDraft(DRAFT_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as Envelope;
    expect(pendingSet.has(env.correlationId)).toBe(true);
    fireAck(env.correlationId, 'accepted');
    await promise;
  });

  it('carries the structured result of an accepted ack', async () => {
    const postMessage = vi.fn();
    const promise = saveDefinitionDraft(DRAFT_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as Envelope;
    const result = { versionId: 'v3', revision: 'a'.repeat(64) };
    fireAck(env.correlationId, 'accepted', undefined, result);
    await expect(promise).resolves.toEqual({ status: 'accepted', result });
  });

  it('omits the result key entirely when the ack carries none', async () => {
    // Not cosmetic: `toEqual` treats a present `result: undefined` as equal to an
    // absent one, so callers that branch on `'result' in outcome` would see a
    // payload that is not there. The helper spreads conditionally for this reason.
    const postMessage = vi.fn();
    const promise = saveDefinitionDraft(DRAFT_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as Envelope;
    fireAck(env.correlationId, 'accepted');
    const outcome = await promise;
    expect('result' in outcome).toBe(false);
  });

  it('resolves rejected with the reason and the recovery payload behind it', async () => {
    const postMessage = vi.fn();
    const promise = publishDefinition(
      { kind: 'pipeline', id: 'release', expectedDraftVersion: 'v4' },
      postMessage
    );
    const env = postMessage.mock.calls[0][0] as Envelope;
    // The shape a `stale-catalog` refusal carries: the token the surface has to
    // adopt before retrying. Discarded by the retired `saveCatalogCommand`, which
    // is why the lifecycle sender resolves with it.
    const result = { currentDraftVersion: 'v5' };
    fireAck(env.correlationId, 'rejected', 'stale-catalog', result);
    await expect(promise).resolves.toEqual({
      status: 'rejected',
      reason: 'stale-catalog',
      result
    });
  });

  it('names an unexplained rejection rather than reporting undefined', async () => {
    const postMessage = vi.fn();
    const promise = publishDefinition(
      { kind: 'pipeline', id: 'release', expectedDraftVersion: 'v4' },
      postMessage
    );
    const env = postMessage.mock.calls[0][0] as Envelope;
    fireAck(env.correlationId, 'rejected');
    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'rejected' });
  });

  it('resolves { rejected, timeout } after five seconds without an ack', async () => {
    const promise = saveDefinitionDraft(DRAFT_REQUEST, vi.fn());
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'timeout' });
  });

  it('ignores a late ack after the timeout has already settled the promise', async () => {
    const postMessage = vi.fn();
    const promise = saveDefinitionDraft(DRAFT_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as Envelope;
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'timeout' });
    // The one-shot listener is unsubscribed on settle, so no listener remains to
    // deliver a stale accepted ack into a resolved promise.
    expect(ackListeners.has(env.correlationId)).toBe(false);
  });

  it('does NOT cross-resolve two operations in flight at once', async () => {
    // Two DIFFERENT operations, not two of the same: correlation is by id, and a
    // sender that keyed on the command type would pass a same-command version of
    // this and fail here.
    const postMessage = vi.fn();
    const draft = saveDefinitionDraft(DRAFT_REQUEST, postMessage);
    const publish = publishDefinition(
      { kind: 'phase', id: 'speckit-plan', expectedDraftVersion: 'v3' },
      postMessage
    );
    expect(postMessage).toHaveBeenCalledTimes(2);
    const first = postMessage.mock.calls[0][0] as Envelope;
    const second = postMessage.mock.calls[1][0] as Envelope;
    expect(first.correlationId).not.toBe(second.correlationId);

    // Acked out of order — the second must not settle the first.
    fireAck(second.correlationId, 'rejected', 'validation-failed');
    await expect(publish).resolves.toEqual({
      status: 'rejected',
      reason: 'validation-failed'
    });
    fireAck(first.correlationId, 'accepted');
    await expect(draft).resolves.toEqual({ status: 'accepted' });
  });

  it('uses crypto-grade UUIDv4 correlation ids (RFC 4122 layout) when not injected', async () => {
    const postMessage = vi.fn();
    const promise = saveDefinitionDraft(DRAFT_REQUEST, postMessage);
    const env = postMessage.mock.calls[0][0] as Envelope;
    expect(env.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    fireAck(env.correlationId, 'accepted');
    await promise;
  });
});

describe('each operation sends its own command', () => {
  // Six operations over one transport, so the transport block above says nothing
  // about an operation posting the wrong one — and all six take a structurally
  // similar target, so a copy-paste between them type-checks.
  const CASES = [
    {
      label: 'saveDefinitionDraft',
      type: WIRE.draft,
      send: (post: (msg: unknown) => void) => saveDefinitionDraft(DRAFT_REQUEST, post)
    },
    {
      label: 'publishDefinition',
      type: WIRE.publish,
      send: (post: (msg: unknown) => void) =>
        publishDefinition({ kind: 'phase', id: 'speckit-plan', expectedDraftVersion: 'v3' }, post)
    },
    {
      label: 'restoreDefinitionVersion',
      type: WIRE.restore,
      send: (post: (msg: unknown) => void) =>
        restoreDefinitionVersion(
          { kind: 'phase', id: 'speckit-plan', expectedDraftVersion: NO_DRAFT, fromVersionId: 'v1' },
          post
        )
    },
    {
      label: 'publishDefinitionPackage',
      type: WIRE.package,
      send: (post: (msg: unknown) => void) =>
        publishDefinitionPackage(
          {
            layers: [
              {
                kind: 'phase',
                expectedRevision: 'a'.repeat(64),
                definitions: [{ id: 'speckit-plan', body: { id: 'speckit-plan' } }]
              }
            ]
          },
          post
        )
    },
    {
      label: 'deactivateDefinition',
      type: WIRE.deactivate,
      send: (post: (msg: unknown) => void) =>
        deactivateDefinition(
          { kind: 'phase', id: 'speckit-plan', expectedDraftVersion: NO_DRAFT },
          CONFIRM_OPTIONS,
          post
        )
    },
    {
      label: 'discardDefinitionDraft',
      type: WIRE.discard,
      send: (post: (msg: unknown) => void) =>
        discardDefinitionDraft(
          { kind: 'phase', id: 'speckit-plan', expectedDraftVersion: 'v7' },
          { ...CONFIRM_OPTIONS, removesEntry: false },
          post
        )
    }
  ] as const;

  it.each(CASES)('$label posts its own command type', async ({ type, send }) => {
    const posted: Envelope[] = [];
    const promise = send((msg) => posted.push(msg as Envelope));
    // The two gated senders await a confirmation before posting, so the envelope
    // is not there synchronously. Flushing the microtask queue is what makes this
    // table cover gated and ungated operations in one shape.
    await vi.advanceTimersByTimeAsync(0);

    expect(posted).toHaveLength(1);
    expect(posted[0]!.type).toBe(type);
    fireAck(posted[0]!.correlationId, 'accepted');
    await promise;
  });

  it('the six send six distinct commands', () => {
    // The complement: a table where two rows expected the same type would pass
    // every row above while one operation shadowed another.
    expect(new Set(CASES.map((testCase) => testCase.type)).size).toBe(CASES.length);
  });
});

describe('the two confirmation gates (FR-049, FR-050)', () => {
  it('deactivate asks first, and posts nothing when the operator declines', async () => {
    confirmAnswer = false;
    const postMessage = vi.fn();
    const outcome = await deactivateDefinition(
      { kind: 'pipeline', id: 'release', expectedDraftVersion: NO_DRAFT },
      { definitionName: 'Release', originatingElement: null },
      postMessage
    );

    expect(outcome).toEqual(DECLINED);
    // The claim that matters: not that the result says declined, but that nothing
    // crossed the wire. A sender that posted and then reported `declined` would
    // satisfy the first assertion and deactivate the definition anyway.
    expect(postMessage).not.toHaveBeenCalled();
    expect(confirmCalls).toEqual([
      {
        actionKey: 'catalog.deactivate-definition',
        context: {
          kindLabel: 'Pipeline',
          definitionName: 'Release',
          definitionId: 'release'
        }
      }
    ]);
  });

  it('discard asks first, and carries whether the entry itself is lost', async () => {
    confirmAnswer = false;
    const postMessage = vi.fn();
    const outcome = await discardDefinitionDraft(
      { kind: 'workflow', id: 'draft-flow', expectedDraftVersion: 'v1' },
      { definitionName: 'Draft Flow', originatingElement: null, removesEntry: true },
      postMessage
    );

    expect(outcome).toEqual(DECLINED);
    expect(postMessage).not.toHaveBeenCalled();
    // `removesEntry` is the difference between losing an edit and losing the
    // definition (FR-030), and the prompt has to say which — so it has to arrive.
    expect(confirmCalls).toEqual([
      {
        actionKey: 'catalog.discard-draft',
        context: {
          kindLabel: 'Workflow',
          definitionName: 'Draft Flow',
          definitionId: 'draft-flow',
          removesEntry: true
        }
      }
    ]);
  });

  it('a confirmed removal reaches the wire exactly once', async () => {
    const posted: Envelope[] = [];
    const promise = deactivateDefinition(
      { kind: 'phase', id: 'speckit-plan', expectedDraftVersion: NO_DRAFT },
      CONFIRM_OPTIONS,
      (msg) => posted.push(msg as Envelope)
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(confirmCalls).toHaveLength(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.payload).toEqual({
      kind: 'phase',
      id: 'speckit-plan',
      expectedDraftVersion: NO_DRAFT
    });
    fireAck(posted[0]!.correlationId, 'accepted');
    await expect(promise).resolves.toEqual({ status: 'accepted' });
  });

  it('the other four are not gated, and must stay that way', async () => {
    // Publishing is additive and restore only writes a draft, whose destruction is
    // itself gated — asking here would ask twice for one decision. Asserted rather
    // than assumed because a prompt added to publish breaks nothing else: it would
    // simply make the operator confirm every publication forever.
    const postMessage = vi.fn();
    const pending = [
      saveDefinitionDraft(DRAFT_REQUEST, postMessage),
      publishDefinition({ kind: 'phase', id: 'speckit-plan', expectedDraftVersion: 'v3' }, postMessage),
      restoreDefinitionVersion(
        { kind: 'phase', id: 'speckit-plan', expectedDraftVersion: NO_DRAFT, fromVersionId: 'v2' },
        postMessage
      ),
      publishDefinitionPackage(
        {
          layers: [
            {
              kind: 'phase',
              expectedRevision: 'a'.repeat(64),
              definitions: [{ id: 'speckit-plan', body: {} }]
            }
          ]
        },
        postMessage
      )
    ];

    expect(confirmCalls).toEqual([]);
    // And each of them posted, so the empty confirmation list is not four calls
    // that never happened.
    expect(postMessage).toHaveBeenCalledTimes(4);
    for (const call of postMessage.mock.calls) {
      fireAck((call[0] as Envelope).correlationId, 'accepted');
    }
    await Promise.all(pending);
  });
});
