// Feature 100 (FR-R3-016) T510 — staleness is checked before trust, in every
// handler (FR-014, US6 AS3).
//
// The condition under test is the one where the two gates disagree: an operation
// that is *both* stale and untrusted. Exactly one refusal reaches the operator, and
// it must be the staleness.
//
// Why the order is a requirement rather than a preference. `trust-denied` is a
// standing condition — the workspace may not do this, and the operator fixes it
// once, in settings. `stale-catalog` is about *this attempt* — another window moved
// the definition — and the refusal carries the token the retry needs. Report the
// trust denial first and the operator grants the capability, retries, and only then
// discovers they were about to overwrite work they never saw. The staleness is the
// answer that changes what they do next, so it is the answer they get.
//
// Both gates are pre-checks, and neither is the authority: the store re-evaluates
// the draft token against the manifest it is about to write, because a gate checked
// before a write is a gate a concurrent writer can slip under. What the ordering
// buys is not correctness of the write — the store owns that — but correctness of
// the *report*. That is why this file asserts on the ack and on whether the service
// was reached, and never on what was written.
//
// The trust axis is set by flipping the stubbed `workspace.isTrusted`, which the
// capability resolver re-reads on every call (Feature 059 I-1, I-2: an untrusted
// workspace is a ceiling and denies every capability). No settings need mocking.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { workspace } from 'vscode';
import {
  deactivateDefinition,
  discardDefinitionDraft,
  publishDefinition,
  publishDefinitionPackage,
  restoreDefinitionVersion,
  saveDefinitionDraft
} from '../../../../../src/ui/sidebar/commands/cmd-catalog-lifecycle';
import type { HandlerContext } from '../../../../../src/ui/sidebar/commands/handler-contract';
import type { CatalogLifecycleOps } from '../../../../../src/catalog';
import type {
  CatalogReadResult,
  CatalogSnapshot,
  StoredDefinition
} from '../../../../../src/contracts/catalog-store';
import {
  CMD_DEACTIVATE_DEFINITION,
  CMD_DISCARD_DEFINITION_DRAFT,
  CMD_PUBLISH_DEFINITION,
  CMD_PUBLISH_PACKAGE,
  CMD_RESTORE_DEFINITION_VERSION,
  CMD_SAVE_DEFINITION_DRAFT
} from '../../../../../src/contracts/sidebar-ipc';

const KIND = 'phase' as const;
const ID = 'contested';
/** What the store holds. The caller below claims to have seen something else. */
const CURRENT_DRAFT = 'v7';
const STALE_TOKEN = 'v6';
const LAYER_REVISION = 'r9';
const STALE_REVISION = 'r8';

/**
 * A body declaring a retry condition, so the Phase draft path asks for *two*
 * capabilities and the content-keyed one cannot jump the queue either.
 */
const RETRYING_BODY = { instruction: 'Do the thing.', retryCondition: 'open_questions > 0' };

function definition(): StoredDefinition {
  return {
    kind: KIND,
    id: ID,
    status: 'effective',
    activeVersionId: 'v5',
    body: { instruction: 'Do the thing.' },
    draftVersionId: CURRENT_DRAFT,
    draftBody: RETRYING_BODY,
    createdAt: 1,
    updatedAt: 2,
    versions: []
  };
}

function snapshot(): CatalogSnapshot {
  return {
    storeFormatVersion: 1,
    definitions: [definition()],
    faults: [],
    collectable: [],
    revisions: { phase: LAYER_REVISION, pipeline: LAYER_REVISION, workflow: LAYER_REVISION }
  };
}

interface Recorded {
  readonly acks: { status: string; reason?: string }[];
  readonly serviceCalls: string[];
}

/**
 * A lifecycle service that records the operation and refuses.
 *
 * It refuses rather than succeeds so no arm of the commit module needs a fully
 * populated success outcome to be exercised, and it refuses with `no-definition` —
 * a reason neither gate can produce — so "the gate let this through" is
 * distinguishable from either gate firing, by the ack alone.
 */
function fakeLifecycle(recorded: Recorded): CatalogLifecycleOps {
  const refuse = (op: string) => {
    recorded.serviceCalls.push(op);
    return Promise.resolve({
      outcome: 'refused' as const,
      refusal: {
        reason: 'no-definition' as const,
        current: {
          kind: KIND,
          id: ID,
          state: null,
          draftVersionId: null,
          activeVersionId: null,
          expectedDraftVersion: 'no-draft' as const
        },
        legalActions: [] as const
      }
    });
  };
  return {
    saveDraft: () => refuse('saveDraft'),
    publish: () => refuse('publish'),
    restore: () => refuse('restore'),
    deactivate: () => refuse('deactivate'),
    discardDraft: () => refuse('discardDraft'),
    publishPackage: () => {
      recorded.serviceCalls.push('publishPackage');
      return Promise.resolve({
        outcome: 'refused' as const,
        refusal: { reason: 'validation-failed' as const, kind: KIND, defects: [] }
      });
    }
  } as unknown as CatalogLifecycleOps;
}

function contextWith(recorded: Recorded): HandlerContext {
  return {
    correlationId: 'c1',
    postAck: async (message: { status: string; reason?: string }) => {
      recorded.acks.push({ status: message.status, reason: message.reason });
    },
    deps: {
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
        sanitize: (value: string) => value
      },
      catalogStore: {
        read: (): Promise<CatalogReadResult> =>
          Promise.resolve({ outcome: 'read', snapshot: snapshot() })
      },
      catalogLifecycle: fakeLifecycle(recorded)
    }
  } as unknown as HandlerContext;
}

/**
 * Flip the stubbed workspace-trust ceiling.
 *
 * The stub's `isTrusted` is a plain mutable field; `@types/vscode` declares it
 * readonly, which is true of the real API and false of the stub the vitest alias
 * supplies. One cast in one place, rather than a hand-written `vi.mock` factory
 * that would have to restate every other piece of the `workspace` surface the
 * trust resolver and the folder picker reach through.
 */
function setWorkspaceTrusted(value: boolean): void {
  (workspace as { isTrusted: boolean }).isTrusted = value;
}

let recorded: Recorded;

beforeEach(() => {
  recorded = { acks: [], serviceCalls: [] };
});

afterEach(() => {
  setWorkspaceTrusted(true);
});

/** The single reason the operator was given, which must always be exactly one. */
function soleReason(): string | undefined {
  expect(recorded.acks).toHaveLength(1);
  return recorded.acks[0]!.reason;
}

/**
 * The five per-definition handlers, each invoked with a token the store disagrees
 * with. `gated` records whether the handler asks for a capability at all — the two
 * removal operations deliberately do not (removal is not an authoring capability),
 * so for those the ordering is unobservable and only the staleness half applies.
 */
const HANDLERS: readonly {
  readonly name: string;
  readonly gated: boolean;
  readonly run: (ctx: HandlerContext, token: string) => Promise<void>;
}[] = [
  {
    name: 'saveDefinitionDraft',
    gated: true,
    run: (ctx, token) =>
      saveDefinitionDraft(ctx, {
        type: CMD_SAVE_DEFINITION_DRAFT,
        correlationId: 'c1',
        payload: { kind: KIND, id: ID, expectedDraftVersion: token, body: RETRYING_BODY }
      })
  },
  {
    name: 'publishDefinition',
    gated: true,
    run: (ctx, token) =>
      publishDefinition(ctx, {
        type: CMD_PUBLISH_DEFINITION,
        correlationId: 'c1',
        payload: { kind: KIND, id: ID, expectedDraftVersion: token }
      })
  },
  {
    name: 'restoreDefinitionVersion',
    gated: true,
    run: (ctx, token) =>
      restoreDefinitionVersion(ctx, {
        type: CMD_RESTORE_DEFINITION_VERSION,
        correlationId: 'c1',
        payload: { kind: KIND, id: ID, expectedDraftVersion: token, fromVersionId: 'v2' }
      })
  },
  {
    name: 'deactivateDefinition',
    gated: false,
    run: (ctx, token) =>
      deactivateDefinition(ctx, {
        type: CMD_DEACTIVATE_DEFINITION,
        correlationId: 'c1',
        payload: { kind: KIND, id: ID, expectedDraftVersion: token }
      })
  },
  {
    name: 'discardDefinitionDraft',
    gated: false,
    run: (ctx, token) =>
      discardDefinitionDraft(ctx, {
        type: CMD_DISCARD_DEFINITION_DRAFT,
        correlationId: 'c1',
        payload: { kind: KIND, id: ID, expectedDraftVersion: token }
      })
  }
];

describe('T510 — a stale and untrusted operation reports the staleness (FR-014, US6 AS3)', () => {
  for (const handler of HANDLERS) {
    it(`${handler.name} reports stale-catalog, not trust-denied`, async () => {
      setWorkspaceTrusted(false);
      await handler.run(contextWith(recorded), STALE_TOKEN);
      expect(soleReason()).toBe('stale-catalog');
    });

    it(`${handler.name} does not reach the service when stale and untrusted`, async () => {
      // Neither gate is a no-op that logs and continues. The refusal is terminal.
      setWorkspaceTrusted(false);
      await handler.run(contextWith(recorded), STALE_TOKEN);
      expect(recorded.serviceCalls).toEqual([]);
    });

    it(`${handler.name} reports stale-catalog in a trusted workspace too`, async () => {
      // The staleness is not an artefact of the trust denial happening to be second.
      await handler.run(contextWith(recorded), STALE_TOKEN);
      expect(soleReason()).toBe('stale-catalog');
    });
  }
});

describe('T510 — the trust gate still fires when nothing is stale', () => {
  for (const handler of HANDLERS.filter((candidate) => candidate.gated)) {
    it(`${handler.name} reports trust-denied on a current token`, async () => {
      // The other half of the ordering. Without this the tests above would pass on
      // a handler that had simply lost its trust gate.
      setWorkspaceTrusted(false);
      await handler.run(contextWith(recorded), CURRENT_DRAFT);
      expect(soleReason()).toBe('trust-denied');
      expect(recorded.serviceCalls).toEqual([]);
    });
  }

  for (const handler of HANDLERS.filter((candidate) => !candidate.gated)) {
    it(`${handler.name} is ungated and reaches the service on a current token`, async () => {
      // Removal is not an authoring capability: a workspace that may not author
      // Phases is not thereby required to keep running the ones it has.
      setWorkspaceTrusted(false);
      await handler.run(contextWith(recorded), CURRENT_DRAFT);
      expect(recorded.serviceCalls).toHaveLength(1);
      expect(soleReason()).toBe('no-definition');
    });
  }

  for (const handler of HANDLERS) {
    it(`${handler.name} reaches the service when current and trusted`, async () => {
      await handler.run(contextWith(recorded), CURRENT_DRAFT);
      expect(recorded.serviceCalls).toHaveLength(1);
      expect(soleReason()).toBe('no-definition');
    });
  }
});

describe('T510 — the package publish orders its layer gate the same way', () => {
  function run(ctx: HandlerContext, revision: string): Promise<void> {
    return publishDefinitionPackage(ctx, {
      type: CMD_PUBLISH_PACKAGE,
      correlationId: 'c1',
      payload: {
        layers: [
          {
            kind: KIND,
            expectedRevision: revision,
            definitions: [{ id: ID, body: RETRYING_BODY }]
          }
        ]
      }
    });
  }

  it('reports stale-catalog when the layer revision moved and the workspace is untrusted', async () => {
    // The package path has no per-definition draft token — a document addresses a
    // whole kind at once — so its staleness is the per-layer `expectedRevision`
    // carried over from feature 099 (FR-036). Same ordering, different token.
    setWorkspaceTrusted(false);
    await run(contextWith(recorded), STALE_REVISION);
    expect(soleReason()).toBe('stale-catalog');
    expect(recorded.serviceCalls).toEqual([]);
  });

  it('reports trust-denied on a current layer revision', async () => {
    setWorkspaceTrusted(false);
    await run(contextWith(recorded), LAYER_REVISION);
    expect(soleReason()).toBe('trust-denied');
    expect(recorded.serviceCalls).toEqual([]);
  });

  it('reaches the service on a current layer revision in a trusted workspace', async () => {
    await run(contextWith(recorded), LAYER_REVISION);
    expect(recorded.serviceCalls).toEqual(['publishPackage']);
    expect(soleReason()).toBe('validation-failed');
  });
});
