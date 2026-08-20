// Feature 056 Track 1 (FR-001..FR-005) — Regression tests proving the catalog
// write commands are rejected on secondary VS Code windows.
//
// MUTATING_COMMANDS is the only gate preventing a secondary host from rewriting
// the catalog during a multi-window session (AGENTS.md hard rule). These tests pin
// the policy in source and would fail loudly if anyone reverted
// message-router.ts.
//
// Feature 099 (T496f, FR-042a) — the write the gate stands in front of used to be
// `updateConfig`; it became `CatalogStore.saveLayer`.
//
// Feature 100 (T514, FR-047) — and now it is the six lifecycle commands. The three
// per-kind layer saves this file used to dispatch are gone, so the coverage here
// grew from three commands to seven: five per-definition operations, the package
// publish, and the Model catalog save that was always the odd one out (it still
// writes settings rather than the store).
//
// Two things make this file worth more than the pinned list next door. It goes
// through the real `MessageRouter.dispatch`, so a command that were dropped from
// `MUTATING_COMMANDS` *and* handled anyway would fail here and pass there. And it
// asserts on the write ports rather than only on the ack: the claim is that a
// secondary host reaches no write at all, which a rejection ack alone does not
// establish — a handler that acked `rejected` after calling the service would
// satisfy the ack assertion and still have moved the catalog.

import { describe, it, expect, vi } from 'vitest';
import { MessageRouter } from '../../../../src/ui/sidebar/message-router';
import type { RouterDeps } from '../../../../src/ui/sidebar/message-router';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { FakeCatalogStore } from '../../../fixtures/fake-catalog-store';
import { CMD_ACK, CMD_SAVE_MODELS } from '../../../../src/ui/sidebar/messages';
import type { CommandAckMessage } from '../../../../src/ui/sidebar/messages';
import {
  CMD_DEACTIVATE_DEFINITION,
  CMD_DISCARD_DEFINITION_DRAFT,
  CMD_PUBLISH_DEFINITION,
  CMD_PUBLISH_PACKAGE,
  CMD_RESTORE_DEFINITION_VERSION,
  CMD_SAVE_DEFINITION_DRAFT
} from '../../../../src/contracts/sidebar-ipc';

/** One stored row, so the definition the commands below name actually exists. */
const PHASE_ROW = Object.freeze({
  id: 'held-phase',
  name: 'Held Phase',
  instruction: 'Do the thing.'
});

interface AckCapture {
  posted: CommandAckMessage[];
  post: (msg: CommandAckMessage) => Promise<boolean>;
}

function makeAckCapture(): AckCapture {
  const posted: CommandAckMessage[] = [];
  return {
    posted,
    post: vi.fn(async (msg: CommandAckMessage) => {
      posted.push(msg);
      return true;
    })
  };
}

/**
 * Every lifecycle operation, recorded rather than performed.
 *
 * The router's handlers reach this and not the store, so asserting on the store
 * alone would pass on a secondary host that had called the service and let it
 * write. Both are checked below.
 */
interface RecordingLifecycle {
  readonly calls: string[];
  readonly ops: unknown;
}

function recordingLifecycle(): RecordingLifecycle {
  const calls: string[] = [];
  const refuse = (op: string) => {
    calls.push(op);
    return Promise.resolve({
      outcome: 'refused' as const,
      refusal: {
        reason: 'no-definition' as const,
        current: {
          kind: 'phase' as const,
          id: PHASE_ROW.id,
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
    calls,
    ops: {
      saveDraft: () => refuse('saveDraft'),
      publish: () => refuse('publish'),
      restore: () => refuse('restore'),
      deactivate: () => refuse('deactivate'),
      discardDraft: () => refuse('discardDraft'),
      publishPackage: () => {
        calls.push('publishPackage');
        return Promise.resolve({
          outcome: 'refused' as const,
          refusal: { reason: 'validation-failed' as const, kind: 'phase' as const, defects: [] }
        });
      }
    }
  };
}

function makeDeps(
  store: FakeCatalogStore,
  lifecycle: RecordingLifecycle,
  overrides: Partial<RouterDeps> = {}
): RouterDeps {
  return {
    executeCommand: vi.fn(async () => undefined as unknown) as unknown as RouterDeps['executeCommand'],
    queueRemover: { remove: vi.fn(async () => true) },
    catalogStore: store,
    catalogLifecycle: lifecycle.ops,
    refreshCatalog: async () => undefined,
    isPrimary: () => false,
    isTrusted: () => true,
    logger: new SanitizedLogger(),
    ...overrides
  } as unknown as RouterDeps;
}

/** Nothing reached any write port, by any route. */
function expectNoWrite(store: FakeCatalogStore, lifecycle: RecordingLifecycle): void {
  expect(lifecycle.calls).toEqual([]);
  expect(store.lifecycleWrites).toEqual([]);
  expect(store.draftLayerSaves).toEqual([]);
  expect(store.publishLayers).toEqual([]);
}

/**
 * The catalog-writing commands, with a payload each that would be accepted on a
 * primary host — the gate must be what refuses them, not a malformed payload.
 */
const COMMANDS: readonly { readonly name: string; readonly message: unknown }[] = [
  {
    name: 'CMD_SAVE_DEFINITION_DRAFT',
    message: {
      type: CMD_SAVE_DEFINITION_DRAFT,
      correlationId: 'cid-save-draft-secondary',
      payload: {
        kind: 'phase',
        id: PHASE_ROW.id,
        expectedDraftVersion: 'no-draft',
        body: { instruction: 'Edited elsewhere.' }
      }
    }
  },
  {
    name: 'CMD_PUBLISH_DEFINITION',
    message: {
      type: CMD_PUBLISH_DEFINITION,
      correlationId: 'cid-publish-secondary',
      payload: { kind: 'phase', id: PHASE_ROW.id, expectedDraftVersion: 'no-draft' }
    }
  },
  {
    name: 'CMD_RESTORE_DEFINITION_VERSION',
    message: {
      type: CMD_RESTORE_DEFINITION_VERSION,
      correlationId: 'cid-restore-secondary',
      payload: {
        kind: 'phase',
        id: PHASE_ROW.id,
        expectedDraftVersion: 'no-draft',
        fromVersionId: 'v1'
      }
    }
  },
  {
    name: 'CMD_DEACTIVATE_DEFINITION',
    message: {
      type: CMD_DEACTIVATE_DEFINITION,
      correlationId: 'cid-deactivate-secondary',
      payload: { kind: 'phase', id: PHASE_ROW.id, expectedDraftVersion: 'no-draft' }
    }
  },
  {
    name: 'CMD_DISCARD_DEFINITION_DRAFT',
    message: {
      type: CMD_DISCARD_DEFINITION_DRAFT,
      correlationId: 'cid-discard-secondary',
      payload: { kind: 'phase', id: PHASE_ROW.id, expectedDraftVersion: 'no-draft' }
    }
  },
  {
    name: 'CMD_PUBLISH_PACKAGE',
    message: {
      type: CMD_PUBLISH_PACKAGE,
      correlationId: 'cid-publish-package-secondary',
      payload: {
        layers: [
          {
            kind: 'phase',
            expectedRevision: 'unused-on-a-secondary-host',
            definitions: [{ id: PHASE_ROW.id, body: { instruction: 'Do the thing.' } }]
          }
        ]
      }
    }
  }
];

describe('Feature 056 Track 1 — secondary-host gate for catalog writes', () => {
  for (const command of COMMANDS) {
    it(`${command.name} is rejected on a secondary host (FR-002)`, async () => {
      const store = new FakeCatalogStore({ phases: [PHASE_ROW] });
      const lifecycle = recordingLifecycle();
      const router = new MessageRouter(makeDeps(store, lifecycle));
      const cap = makeAckCapture();

      await router.dispatch(command.message as never, cap.post);

      expect(cap.posted).toHaveLength(1);
      expect(cap.posted[0].type).toBe(CMD_ACK);
      expect(cap.posted[0].status).toBe('rejected');
      expect(cap.posted[0].reason).toBe('secondary-window-readonly');
      expectNoWrite(store, lifecycle);
    });
  }

  it('CMD_SAVE_MODELS is rejected on a secondary host (FR-002)', async () => {
    // The one catalog command that still writes settings rather than the store, and
    // therefore the one whose "no write" is asserted against `updateConfig`.
    const updateConfig = vi.fn(async () => undefined);
    const store = new FakeCatalogStore();
    const lifecycle = recordingLifecycle();
    const router = new MessageRouter(makeDeps(store, lifecycle, { updateConfig }));
    const cap = makeAckCapture();

    await router.dispatch(
      {
        type: CMD_SAVE_MODELS,
        correlationId: 'cid-models-secondary',
        payload: { models: { claude: [], codex: [], agy: [] } }
      },
      cap.post
    );

    expect(cap.posted).toHaveLength(1);
    expect(cap.posted[0].type).toBe(CMD_ACK);
    expect(cap.posted[0].status).toBe('rejected');
    expect(cap.posted[0].reason).toBe('secondary-window-readonly');
    expect(updateConfig).not.toHaveBeenCalled();
    expectNoWrite(store, lifecycle);
  });

  it('a draft save still reaches the service on the primary host (FR-001)', async () => {
    // Without this the suite above would pass on a router that rejected every
    // command on every host. The service refuses — what is asserted is that the
    // gate was cleared and the handler got as far as the one dependency it has.
    const store = new FakeCatalogStore({ phases: [PHASE_ROW] });
    const lifecycle = recordingLifecycle();
    const router = new MessageRouter(makeDeps(store, lifecycle, { isPrimary: () => true }));
    const cap = makeAckCapture();

    await router.dispatch(
      {
        type: CMD_SAVE_DEFINITION_DRAFT,
        correlationId: 'cid-save-draft-primary',
        payload: {
          kind: 'phase',
          id: PHASE_ROW.id,
          expectedDraftVersion: 'no-draft',
          body: { instruction: 'Edited here.' }
        }
      } as never,
      cap.post
    );

    expect(cap.posted).toHaveLength(1);
    expect(cap.posted[0].reason).not.toBe('secondary-window-readonly');
    expect(lifecycle.calls).toEqual(['saveDraft']);
  });
});
