// Feature 100 (FR-R3-016) T514 — the ingress contract for the six lifecycle
// commands, and the gate order above it.
//
// The successor to `save-phases-scoped.test.ts`, `save-pipelines-scoped.test.ts`,
// and `save-workflows-scoped.test.ts`, which are deleted with the envelopes they
// pinned. Those three suites covered a gate table built around a whole-array save:
// a `scope` naming the layer to write, an `expectedRevision` over that layer, a
// `mutation` tag declaring the intent, and a per-row version gate. None of the four
// exists. An operation now addresses **one** definition, declares its intent by
// being the command it is, and gates on that definition's own draft token
// (FR-051, FR-012).
//
// What carried over, and where:
//
//   - **Gate 2, envelope shape.** Asserted here against `validateInboundMessage`,
//     because the router never sees a payload that fails there. The inverted cases
//     the 099 suites introduced carry over intact and get a third sibling: an
//     envelope still naming a `scope`, still carrying a `mutation`, or still
//     carrying an `expectedRevision` on a per-definition operation was built
//     against a contract this host no longer implements, and is refused rather
//     than stripped.
//   - **Gate 1, `config-ops-unavailable`.** Untrusted workspaces get a `null`
//     lifecycle service, which is a rejection with a name rather than a handler
//     that throws.
//   - **Gate 3, `stale-catalog`.** The token is per-definition now, and the
//     refusal carries the record the retry needs. Its *ordering* against the trust
//     gate is pinned per handler in
//     `tests/unit/ui/sidebar/commands/lifecycle-staleness-before-trust.test.ts`;
//     what is pinned here is that the ordering survives a real dispatch.
//   - **Gate 15, `persistence-failed`.** A store that lands a prefix and stops is
//     reported, and the ack says how much landed without naming what.
//   - **The accepted ack.** Was `{ revision, mutation }`; it is now the pointer
//     the operation moved.
//
// What did not carry over, and why: the mutation-intent algebra (`create`,
// `update`, `reset`, `import`, `remove`) and its mismatch gates, the per-row
// version gate, and the two override capabilities. The first two are the retired
// surface itself. The third was deleted in 099 (FR-046) and its negative is pinned
// in `tests/unit/state/capability-trust-resolver.test.ts`.
//
// Gate 2 is asserted against the validator; every other gate is asserted through a
// real `MessageRouter.dispatch`, so the ordering between them is exercised rather
// than each gate in isolation.

import { describe, expect, it, vi } from 'vitest';

import { validateInboundMessage } from '../../src/contracts/runtime-validators';
import {
  CMD_DEACTIVATE_DEFINITION,
  CMD_DISCARD_DEFINITION_DRAFT,
  CMD_PUBLISH_DEFINITION,
  CMD_PUBLISH_PACKAGE,
  CMD_RESTORE_DEFINITION_VERSION,
  CMD_SAVE_DEFINITION_DRAFT
} from '../../src/contracts/sidebar-ipc';
import { SanitizedLogger } from '../../src/lib/logger';
import { MessageRouter, type RouterDeps } from '../../src/ui/sidebar/message-router';
import { CMD_ACK } from '../../src/ui/sidebar/messages';
import type { CommandAckMessage } from '../../src/ui/sidebar/messages';
import { FakeCatalogStore } from '../fixtures/fake-catalog-store';

const KIND = 'phase' as const;
const ID = 'custom-phase';
const BODY = { name: 'Custom', instruction: 'Run.' };

/** A definition the store holds with a pending draft, so a token can be wrong. */
const SEEDED = Object.freeze({ id: ID, name: 'Custom', version: 1, instruction: 'Run.' });

// ---------------------------------------------------------------------------
// Gate 2 — the envelope, at the transport boundary
// ---------------------------------------------------------------------------

const TARGET_ONLY = [
  CMD_PUBLISH_DEFINITION,
  CMD_DEACTIVATE_DEFINITION,
  CMD_DISCARD_DEFINITION_DRAFT
] as const;

function targetEnvelope(type: string): Record<string, unknown> {
  return {
    type,
    correlationId: 'lifecycle-contract',
    payload: { kind: KIND, id: ID, expectedDraftVersion: 'v3' }
  };
}

const DRAFT_ENVELOPE = {
  type: CMD_SAVE_DEFINITION_DRAFT,
  correlationId: 'lifecycle-contract',
  payload: { kind: KIND, id: ID, expectedDraftVersion: 'no-draft', body: BODY }
};

const RESTORE_ENVELOPE = {
  type: CMD_RESTORE_DEFINITION_VERSION,
  correlationId: 'lifecycle-contract',
  payload: { kind: KIND, id: ID, expectedDraftVersion: 'v3', fromVersionId: 'v1' }
};

const PACKAGE_ENVELOPE = {
  type: CMD_PUBLISH_PACKAGE,
  correlationId: 'lifecycle-contract',
  payload: {
    layers: [{ kind: KIND, expectedRevision: 'rev-phase-0', definitions: [{ id: ID, body: BODY }] }]
  }
};

/** Every per-definition envelope, for the checks that are the same across all five. */
const PER_DEFINITION: readonly { readonly name: string; readonly envelope: Record<string, unknown> }[] =
  [
    { name: CMD_SAVE_DEFINITION_DRAFT, envelope: DRAFT_ENVELOPE },
    { name: CMD_RESTORE_DEFINITION_VERSION, envelope: RESTORE_ENVELOPE },
    ...TARGET_ONLY.map((type) => ({ name: type, envelope: targetEnvelope(type) }))
  ];

function withPayload(
  envelope: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  return { ...envelope, payload: { ...(envelope.payload as Record<string, unknown>), ...patch } };
}

function withoutPayloadKey(envelope: Record<string, unknown>, key: string): Record<string, unknown> {
  const payload = { ...(envelope.payload as Record<string, unknown>) };
  delete payload[key];
  return { ...envelope, payload };
}

describe('lifecycle IPC contract — gate 2, the envelope', () => {
  for (const command of PER_DEFINITION) {
    it(`accepts the exact ${command.name} envelope`, () => {
      expect(validateInboundMessage(command.envelope)).toMatchObject({
        ok: true,
        command: command.envelope
      });
    });

    it(`rejects a ${command.name} envelope with no payload at all`, () => {
      const { payload: _payload, ...rest } = command.envelope;
      expect(validateInboundMessage(rest)).toMatchObject({ ok: false });
    });

    for (const key of ['kind', 'id', 'expectedDraftVersion']) {
      it(`rejects a ${command.name} envelope missing ${key}`, () => {
        // The three control fields choose what is written and gate the write. A
        // missing one must never arrive at the store as `undefined`.
        expect(validateInboundMessage(withoutPayloadKey(command.envelope, key))).toMatchObject({
          ok: false,
          reason: 'invalid-payload'
        });
      });
    }

    it(`rejects a ${command.name} envelope naming an unknown kind`, () => {
      expect(validateInboundMessage(withPayload(command.envelope, { kind: 'model' }))).toMatchObject(
        { ok: false, reason: 'invalid-payload' }
      );
    });

    it(`rejects a ${command.name} envelope whose token is not a string`, () => {
      expect(
        validateInboundMessage(withPayload(command.envelope, { expectedDraftVersion: 3 }))
      ).toMatchObject({ ok: false, reason: 'invalid-payload' });
    });

    it(`rejects a ${command.name} envelope with an over-long id`, () => {
      expect(
        validateInboundMessage(withPayload(command.envelope, { id: 'x'.repeat(65) }))
      ).toMatchObject({ ok: false, reason: 'invalid-payload' });
    });

    it(`rejects a ${command.name} envelope that still carries a scope (099 FR-042)`, () => {
      // Inherited from the retired suites, and still the same claim: a caller
      // pinned to the layer tier must fail loudly at the boundary rather than have
      // its extra field quietly dropped on the way to a handler that ignores it.
      expect(validateInboundMessage(withPayload(command.envelope, { scope: 'user' }))).toMatchObject(
        { ok: false, reason: 'invalid-payload' }
      );
    });

    it(`rejects a ${command.name} envelope that still declares a mutation (FR-051)`, () => {
      // The successor of every `*-mutation-mismatch` gate in the retired suites.
      // The intent is the command; a caller still tagging it is a caller built
      // against the whole-array save.
      expect(
        validateInboundMessage(withPayload(command.envelope, { mutation: { kind: 'create' } }))
      ).toMatchObject({ ok: false, reason: 'invalid-payload' });
    });

    it(`rejects a ${command.name} envelope that still carries an expectedRevision`, () => {
      // The per-kind revision is the *package* publish's token (FR-036). On a
      // per-definition operation it is the wrong granularity, and accepting it
      // would let a caller believe it had gated a write it had not.
      expect(
        validateInboundMessage(withPayload(command.envelope, { expectedRevision: 'rev-phase-0' }))
      ).toMatchObject({ ok: false, reason: 'invalid-payload' });
    });

    it(`rejects an undeclared key on ${command.name}`, () => {
      expect(
        validateInboundMessage(withPayload(command.envelope, { instruction: 'not at this level' }))
      ).toMatchObject({ ok: false, reason: 'invalid-payload' });
    });
  }

  describe('the draft save carries a body, checked for presence and nothing else', () => {
    it('accepts a body the host would reject as a definition', () => {
      // 099 FR-010: the store holds a body verbatim and validates nothing, and the
      // publish gate is where a definition has to be well-formed. A shape check
      // here would be a second, weaker validator in front of the real one — and it
      // would refuse to save the half-finished edit a draft exists for.
      expect(
        validateInboundMessage(
          withPayload(DRAFT_ENVELOPE, { body: { name: 42, phases: 'not an array' } })
        )
      ).toMatchObject({ ok: true });
    });

    it('accepts a null body', () => {
      expect(validateInboundMessage(withPayload(DRAFT_ENVELOPE, { body: null }))).toMatchObject({
        ok: true
      });
    });

    it('rejects an absent body', () => {
      // `body: null` is a body an operator can author; `body` absent is an envelope
      // that forgot what it was saving.
      expect(validateInboundMessage(withoutPayloadKey(DRAFT_ENVELOPE, 'body'))).toMatchObject({
        ok: false,
        reason: 'invalid-payload'
      });
    });

    it('accepts an optional note', () => {
      expect(
        validateInboundMessage(withPayload(DRAFT_ENVELOPE, { note: 'why I changed it' }))
      ).toMatchObject({ ok: true });
    });

    it.each([{ note: 3 }, { note: 'x'.repeat(513) }])('rejects a malformed note %o', (patch) => {
      expect(validateInboundMessage(withPayload(DRAFT_ENVELOPE, patch))).toMatchObject({
        ok: false,
        reason: 'invalid-payload'
      });
    });
  });

  describe('restore names the version it copies from', () => {
    it('rejects a restore with no fromVersionId', () => {
      expect(validateInboundMessage(withoutPayloadKey(RESTORE_ENVELOPE, 'fromVersionId'))).toMatchObject(
        { ok: false, reason: 'invalid-payload' }
      );
    });

    it.each([{ fromVersionId: '' }, { fromVersionId: 3 }, { fromVersionId: 'x'.repeat(129) }])(
      'rejects a malformed fromVersionId %o',
      (patch) => {
        expect(validateInboundMessage(withPayload(RESTORE_ENVELOPE, patch))).toMatchObject({
          ok: false,
          reason: 'invalid-payload'
        });
      }
    );
  });

  describe('the package publish is the one envelope that still addresses layers', () => {
    it('accepts a single-layer document', () => {
      expect(validateInboundMessage(PACKAGE_ENVELOPE)).toMatchObject({ ok: true });
    });

    it('accepts a multi-layer document in an order the host will reorder itself (FR-035)', () => {
      // Deliberately not a shape check: the publish sequence ranks by kind, so a
      // validator refusing an out-of-order document would reject an envelope the
      // host handles correctly.
      expect(
        validateInboundMessage(
          withPayload(PACKAGE_ENVELOPE, {
            layers: [
              {
                kind: 'pipeline',
                expectedRevision: 'rev-pipeline-0',
                definitions: [{ id: 'standard', body: { phases: [] } }]
              },
              { kind: KIND, expectedRevision: 'rev-phase-0', definitions: [{ id: ID, body: BODY }] }
            ]
          })
        )
      ).toMatchObject({ ok: true });
    });

    it.each([
      { layers: [] },
      { layers: 'phase' },
      { layers: [{ kind: KIND, definitions: [{ id: ID, body: BODY }] }] },
      { layers: [{ kind: KIND, expectedRevision: 'r', definitions: [] }] },
      { layers: [{ kind: 'model', expectedRevision: 'r', definitions: [{ id: ID, body: BODY }] }] },
      { layers: [{ kind: KIND, expectedRevision: 'r', definitions: [{ id: ID }] }] },
      { layers: [{ kind: KIND, expectedRevision: 'r', definitions: [{ body: BODY }] }] },
      {
        layers: [
          { kind: KIND, expectedRevision: 'r', definitions: [{ id: ID, body: BODY, scope: 'user' }] }
        ]
      }
    ])('rejects a malformed package payload %o', (patch) => {
      expect(validateInboundMessage(withPayload(PACKAGE_ENVELOPE, patch))).toMatchObject({
        ok: false,
        reason: 'invalid-payload'
      });
    });

    it('rejects a document over the definition bound', () => {
      // A package is an imported document, not a hand-built one, and an unbounded
      // one would be an unbounded write sequence.
      expect(
        validateInboundMessage(
          withPayload(PACKAGE_ENVELOPE, {
            layers: [
              {
                kind: KIND,
                expectedRevision: 'r',
                definitions: Array.from({ length: 501 }, (_unused, index) => ({
                  id: `phase-${index}`,
                  body: BODY
                }))
              }
            ]
          })
        )
      ).toMatchObject({ ok: false, reason: 'invalid-payload' });
    });
  });
});

// ---------------------------------------------------------------------------
// Gates 1, 3 and 15 — through a real dispatch
// ---------------------------------------------------------------------------

interface AckCapture {
  readonly posted: CommandAckMessage[];
  readonly post: (message: CommandAckMessage) => Promise<boolean>;
}

function makeAckCapture(): AckCapture {
  const posted: CommandAckMessage[] = [];
  return {
    posted,
    post: vi.fn(async (message: CommandAckMessage) => {
      posted.push(message);
      return true;
    })
  };
}

function makeDeps(overrides: Partial<RouterDeps> = {}): RouterDeps {
  return {
    executeCommand: vi.fn(async () => undefined as unknown) as unknown as RouterDeps['executeCommand'],
    queueRemover: { remove: vi.fn(async () => true) },
    refreshCatalog: async () => undefined,
    isPrimary: () => true,
    isTrusted: () => true,
    logger: new SanitizedLogger(),
    ...overrides
  } as unknown as RouterDeps;
}

async function dispatch(
  message: unknown,
  overrides: Partial<RouterDeps> = {}
): Promise<CommandAckMessage> {
  const capture = makeAckCapture();
  await new MessageRouter(makeDeps(overrides)).dispatch(message as never, capture.post);
  expect(capture.posted).toHaveLength(1);
  expect(capture.posted[0].type).toBe(CMD_ACK);
  return capture.posted[0];
}

/**
 * A lifecycle service whose every operation returns one prepared outcome.
 *
 * The outcome is supplied untyped so a single helper can serve arms belonging to
 * six different unions; what each test asserts is the ack the router builds from
 * it, which is the mapping under test.
 */
function lifecycleReturning(
  outcome: unknown,
  calls: string[] = []
): NonNullable<RouterDeps['catalogLifecycle']> {
  const run = (op: string) => {
    calls.push(op);
    return Promise.resolve(outcome);
  };
  return {
    saveDraft: () => run('saveDraft'),
    publish: () => run('publish'),
    restore: () => run('restore'),
    deactivate: () => run('deactivate'),
    discardDraft: () => run('discardDraft'),
    publishPackage: () => run('publishPackage')
  } as unknown as NonNullable<RouterDeps['catalogLifecycle']>;
}

describe('lifecycle IPC contract — gate 1, no lifecycle wiring', () => {
  for (const command of PER_DEFINITION) {
    it(`${command.name} is rejected as config-ops-unavailable`, async () => {
      // The shape an untrusted workspace takes: the host builds no store and no
      // lifecycle service, so every operation is refused by name rather than
      // throwing its way into the router's generic handler-failed ack.
      const ack = await dispatch(command.envelope, { catalogLifecycle: null, catalogStore: null });
      expect(ack.status).toBe('rejected');
      expect(ack.reason).toBe('config-ops-unavailable');
    });
  }
});

describe('lifecycle IPC contract — gate 3, the draft token', () => {
  it('refuses a stale token and names the record the retry needs', async () => {
    // The successor of `stale-catalog { currentRevision, current }`. The token is
    // per-definition, and what comes back is the definition as the store holds it
    // — two version ids, a state, and the token to present next. No body, so
    // nothing an operator authored reaches the ack.
    const store = new FakeCatalogStore({ phases: [SEEDED] });
    const calls: string[] = [];
    const ack = await dispatch(withPayload(DRAFT_ENVELOPE, { expectedDraftVersion: 'v99' }), {
      catalogStore: store,
      catalogLifecycle: lifecycleReturning({ outcome: 'unchanged' }, calls)
    });

    expect(ack.status).toBe('rejected');
    expect(ack.reason).toBe('stale-catalog');
    expect(ack.result).toMatchObject({ current: { kind: KIND, id: ID } });
    expect(JSON.stringify(ack.result)).not.toContain('instruction');
    // Refused before the service, so the write never had a chance to happen.
    expect(calls).toEqual([]);
    expect(store.lifecycleWrites).toEqual([]);
  });

  it('reaches the service on the token the store actually holds', async () => {
    // Without this the case above would pass on a handler that refused everything.
    const store = new FakeCatalogStore({ phases: [SEEDED] });
    const calls: string[] = [];
    const ack = await dispatch(
      withPayload(DRAFT_ENVELOPE, { expectedDraftVersion: 'no-draft', body: { instruction: 'New.' } }),
      {
        catalogStore: store,
        catalogLifecycle: lifecycleReturning({ outcome: 'saved', draftVersionId: 'v2' }, calls)
      }
    );

    expect(calls).toEqual(['saveDraft']);
    expect(ack.status).toBe('accepted');
    // The accepted ack was `{ revision, mutation }`; it is the pointer the
    // operation moved, plus whether a version was appended at all (FR-011a).
    expect(ack.result).toMatchObject({ draftVersionId: 'v2', appended: true });
  });

  it('reports an unchanged save as accepted with nothing appended', async () => {
    const store = new FakeCatalogStore({ phases: [SEEDED] });
    const ack = await dispatch(DRAFT_ENVELOPE, {
      catalogStore: store,
      catalogLifecycle: lifecycleReturning({ outcome: 'unchanged', draftVersionId: 'v1' })
    });

    expect(ack.status).toBe('accepted');
    expect(ack.result).toMatchObject({ draftVersionId: 'v1', appended: false });
  });
});

describe('lifecycle IPC contract — gate 15, persistence', () => {
  it('reports a prefix write as persistence-failed, counting rather than naming', async () => {
    // The version ids are the store's own words and the operator's repair does not
    // depend on which prefix landed — an unreferenced record is collectable and not
    // an error (099 FR-029). So the ack carries the count and the log carries the
    // rest, and the write is **not** reversed.
    const store = new FakeCatalogStore({ phases: [SEEDED] });
    const ack = await dispatch(DRAFT_ENVELOPE, {
      catalogStore: store,
      catalogLifecycle: lifecycleReturning({ outcome: 'partial', wrote: ['v2'], errno: 'ENOSPC' })
    });

    expect(ack.status).toBe('rejected');
    expect(ack.reason).toBe('persistence-failed');
    expect(ack.result).toMatchObject({ partial: true, wrote: 1 });
    expect(JSON.stringify(ack.result)).not.toContain('v2');
  });
});
