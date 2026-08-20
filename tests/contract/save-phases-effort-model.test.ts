// Feature 026 T011a — IPC contract test for CMD_SAVE_PHASES carrying
// per-phase `effort` and `model` overrides.
//
// Scope:
//   (a) `CMD_SAVE_PHASES` is intentionally NOT a member of MUTATING_COMMANDS
//       (regression guard — mirrors the pinned-list assertion at
//       tests/unit/ui/sidebar/mutating-commands-pinned-list.test.ts:60-63).
//   (b) A valid payload setting BOTH `effort: 'high'` and a permitted
//       `model: '<id>'` on the same row is accepted by the host and the
//       row is sent to the Phase catalog byte-for-byte.
//   (c) A row carrying `effort: 'turbo'` (not in EFFORT_LEVELS) is
//       rejected with a per-row validation error code and the prior
//       state is preserved (no layer save at all).
//   (d) A row carrying `model: '<unknown-id>'` (not in the permitted
//       set) is rejected with a per-row validation error code and the
//       prior state is preserved.
//   (e) A multi-row save where one row passes and one row fails is
//       all-or-nothing: NO row is persisted, the response carries a
//       per-row error code, and the user-layer state is unchanged.
//
// Covers FR-004 + FR-005 at the IPC contract layer; complements T017
// (validator unit) and T018 (integration audit).

import { describe, it, expect, vi } from 'vitest';
import {
  MessageRouter,
  type RouterDeps,
  MUTATING_COMMANDS,
  isMutatingCommand
} from '../../src/ui/sidebar/message-router';
import {
  CMD_SAVE_PHASES,
  type CommandAckMessage,
  type SidebarCommand
} from '../../src/ui/sidebar/messages';
import { SanitizedLogger } from '../../src/lib/logger';
import { FakeCatalogStore, layerWrites } from '../fixtures/fake-catalog-store';

interface CapturedAck {
  msg: CommandAckMessage;
}

// Feature 099 (T496f, FR-042a) — the write port is the versioned catalog store,
// so "forwards byte-for-byte to `updateConfig('phases', ...)`" is now "sends
// byte-for-byte as the one Phase layer". `layerWrites` projects a layer save back
// to the array of rows these assertions are written against; the claim under test
// — what the host decided to persist — has not moved.
function buildRouter(): {
  router: MessageRouter;
  acks: CapturedAck[];
  store: FakeCatalogStore;
  writes: () => readonly (readonly unknown[])[];
} {
  const acks: CapturedAck[] = [];
  const store = new FakeCatalogStore();
  const deps: RouterDeps = {
    executeCommand: vi.fn().mockResolvedValue(undefined),
    queueRemover: { remove: vi.fn().mockResolvedValue(true) },
    isPrimary: () => true,
    isTrusted: () => true,
    notifyWarning: vi.fn(),
    logger: new SanitizedLogger(),
    catalogStore: store,
    refreshCatalog: async () => undefined,
    readPhaseConfig: () => ({ rows: store.rowsOf('phase'), revision: store.revisionOf('phase') })
  };
  const router = new MessageRouter(deps);
  return { router, acks, store, writes: () => layerWrites(store) };
}

/** Feature 099 (T496f, FR-044a) — an empty store's revision, before any save. */
const SEEDED_REVISION = new FakeCatalogStore().revisionOf('phase');

function savePayload(phases: readonly unknown[], phaseId = 'speckit-plan') {
  return {
    expectedRevision: SEEDED_REVISION,
    mutation: { kind: 'create' as const, phaseId },
    phases
  };
}

async function dispatch(
  router: MessageRouter,
  command: SidebarCommand,
  acks: CapturedAck[]
): Promise<void> {
  await router.dispatch(command, async (msg) => {
    acks.push({ msg });
    return true;
  });
}

describe('Feature 026 T011a — CMD_SAVE_PHASES contract for effort + model', () => {
  it('(a) CMD_SAVE_PHASES IS in MUTATING_COMMANDS (Feature 056 FR-002)', () => {
    // Feature 056 Track 1 (FR-002) reclassified CMD_SAVE_PHASES (and the
    // sibling catalog / general-settings saves) as mutating. The prior
    // assertion that secondary windows could save phases encoded the
    // F-001 documentation-vs-implementation drift the principal review
    // flagged.
    expect(MUTATING_COMMANDS.has(CMD_SAVE_PHASES)).toBe(true);
    expect(isMutatingCommand(CMD_SAVE_PHASES)).toBe(true);
  });

  it('(b) accepts a row carrying BOTH effort and a permitted model and forwards byte-for-byte', async () => {
    const { router, store, writes } = buildRouter();
    const acks: CapturedAck[] = [];
    const phases = [
      {
        id: 'speckit-plan',
        name: 'Plan',
        instruction: 'Plan the work.',
        loopable: false,
        effort: 'high',
        model: 'claude-sonnet-4-6'
      }
    ];
    await dispatch(
      router,
      {
        type: CMD_SAVE_PHASES,
        correlationId: 'save-1',
        payload: savePayload(phases)
      } as SidebarCommand,
      acks
    );
    expect(acks).toHaveLength(1);
    expect(acks[0].msg.status).toBe('accepted');
    expect(store.layerSaves.map((request) => request.kind)).toEqual(['phase']);
    expect(writes()[0]).toEqual([
      expect.objectContaining({ ...phases[0], version: 1 })
    ]);
  });

  it('(c) rejects a row with effort: "turbo" with a per-row error code and does not persist', async () => {
    const { router, store, writes } = buildRouter();
    const acks: CapturedAck[] = [];
    await dispatch(
      router,
      {
        type: CMD_SAVE_PHASES,
        correlationId: 'save-2',
        payload: savePayload([
            {
              id: 'speckit-plan',
              name: 'Plan',
              instruction: 'Plan the work.',
              loopable: false,
              effort: 'turbo'
            }
          ])
      } as SidebarCommand,
      acks
    );
    expect(acks[0].msg.status).toBe('rejected');
    expect(acks[0].msg).toMatchObject({
      reason: 'phase-validation',
      result: { errors: [expect.objectContaining({ phaseId: 'speckit-plan', field: 'effort' })] }
    });
    expect(writes()).toEqual([]);
    expect(store.layerSaves).toEqual([]);
  });

  it('(d) rejects a row with an unknown model with a per-row error code and does not persist', async () => {
    const { router, store, writes } = buildRouter();
    const acks: CapturedAck[] = [];
    await dispatch(
      router,
      {
        type: CMD_SAVE_PHASES,
        correlationId: 'save-3',
        payload: savePayload([
            {
              id: 'speckit-plan',
              name: 'Plan',
              instruction: 'Plan the work.',
              loopable: false,
              model: '' // empty-string model fails per-row validation (FR-005 shape)
            }
          ])
      } as SidebarCommand,
      acks
    );
    expect(acks[0].msg.status).toBe('rejected');
    expect(acks[0].msg).toMatchObject({
      reason: 'phase-validation',
      result: { errors: [expect.objectContaining({ phaseId: 'speckit-plan', field: 'model' })] }
    });
    expect(writes()).toEqual([]);
    expect(store.layerSaves).toEqual([]);
  });

  it('(e) all-or-nothing multi-row save: one bad row blocks all writes', async () => {
    const { router, store, writes } = buildRouter();
    const acks: CapturedAck[] = [];
    const phases = [
      {
        id: 'speckit-plan',
        name: 'Plan',
        instruction: 'Plan the work.',
        loopable: false,
        effort: 'high' // valid
      },
      {
        id: 'speckit-implement',
        name: 'Implement',
        instruction: 'Implement the work.',
        loopable: false,
        effort: 'turbo' // invalid — pollutes the batch
      }
    ];
    await dispatch(
      router,
      {
        type: CMD_SAVE_PHASES,
        correlationId: 'save-4',
        payload: savePayload(phases)
      } as SidebarCommand,
      acks
    );
    expect(acks[0].msg.status).toBe('rejected');
    expect(acks[0].msg).toMatchObject({
      reason: 'phase-validation',
      result: { errors: [expect.objectContaining({ phaseId: 'speckit-implement', field: 'effort' })] }
    });
    expect(writes()).toEqual([]);
    expect(store.layerSaves).toEqual([]);
  });

  it('(e-bis) rejects an all-valid batch whose diff exceeds one declared mutation', async () => {
    const { router, store, writes } = buildRouter();
    const acks: CapturedAck[] = [];
    const phases = [
      {
        id: 'speckit-plan',
        name: 'Plan',
        instruction: 'Plan the work.',
        loopable: false,
        effort: 'high',
        model: 'claude-sonnet-4-6'
      },
      {
        id: 'speckit-implement',
        name: 'Implement',
        instruction: 'Implement the work.',
        loopable: false,
        effort: 'max',
        model: 'claude-opus-4-7'
      }
    ];
    await dispatch(
      router,
      {
        type: CMD_SAVE_PHASES,
        correlationId: 'save-5',
        payload: savePayload(phases)
      } as SidebarCommand,
      acks
    );
    expect(acks[0].msg.status).toBe('rejected');
    expect(acks[0].msg.reason).toBe('phase-mutation-mismatch');
    expect(writes()).toEqual([]);
    expect(store.layerSaves).toEqual([]);
  });
});
