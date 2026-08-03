// Feature 084 (FR-046a, FR-037) — the `import` mutation intent.
//
// Import reuses `CMD_SAVE_PHASES` rather than adding a mutating command
// (research R2), but a plain `create` cannot satisfy FR-046a: the version gate
// requires a create of a new identity to declare `version: 1`, and
// `withHostVersions` assigns 1 regardless. That renumbers a declared value and
// breaks the byte-identical round trip (SC-003).
//
// `{ kind: 'import' }` is a `create` to the shared intent algebra — same diff,
// same shape check, same gates — whose target identity keeps the version the
// document authored. The invariant the version gate protects is a version
// *transition* on an existing row, and an import target is by construction an
// identity the layer does not have. These tests pin both halves: the authored
// version survives for the target, and every other row still has to echo the
// version the host currently holds.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => new Map<string, boolean>());
vi.mock('../../../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (name: string) => capabilities.get(name) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));
vi.mock('../../../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: '/tmp/import-intent' },
    name: 'import-intent',
    index: 0
  })
}));

import { phaseLayerRevision } from '../../../../../src/config/process-catalog';
import { handler } from '../../../../../src/ui/sidebar/commands/cmd-save-phases';
import { CMD_SAVE_PHASES } from '../../../../../src/ui/sidebar/messages';
import type {
  CommandAckMessage,
  SavePhasesCommand
} from '../../../../../src/ui/sidebar/messages';

const EXISTING = [{ id: 'held', name: 'Held', version: 4, instruction: 'Hold.' }];

/** A document-authored row: `version` is whatever the source installation held. */
const IMPORTED = { id: 'brought-in', name: 'Brought In', version: 7, instruction: 'Do it.' };

function harness(current: readonly unknown[] = EXISTING) {
  const acks: CommandAckMessage[] = [];
  const writes: unknown[] = [];
  const ctx = {
    deps: {
      executeCommand: vi.fn(),
      queueRemover: { remove: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), sanitize: String },
      readPhaseConfig: () => ({ user: [], workspace: current }),
      updateConfig: vi.fn(async (_key: string, value: unknown) => {
        writes.push(value);
      })
    },
    correlationId: 'import-intent',
    postAck: async (ack: CommandAckMessage) => {
      acks.push(ack);
      return true;
    }
  } as unknown as Parameters<typeof handler>[0];
  return { ctx, acks, writes };
}

function importCommand(
  phases: readonly unknown[],
  phaseId = 'brought-in',
  current: readonly unknown[] = EXISTING
): SavePhasesCommand {
  return {
    type: CMD_SAVE_PHASES,
    correlationId: 'import-intent',
    payload: {
      scope: 'workspace',
      expectedRevision: phaseLayerRevision(current),
      mutation: { kind: 'import', phaseId },
      phases
    }
  };
}

beforeEach(() => capabilities.clear());

describe('Feature 084 — the import mutation intent', () => {
  it('stores the version the document authored (FR-046a)', async () => {
    const { ctx, acks, writes } = harness();
    await handler(ctx, importCommand([...EXISTING, IMPORTED]));

    expect(acks[0]).toMatchObject({ status: 'accepted', result: { mutation: 'import' } });
    expect(writes[0]).toEqual([
      expect.objectContaining({ id: 'held', version: 4 }),
      expect.objectContaining({ id: 'brought-in', version: 7 })
    ]);
  });

  it('renumbers nothing else about the imported row (FR-046a)', async () => {
    const { ctx, writes } = harness();
    const carried = {
      ...IMPORTED,
      description: 'As authored.',
      model: 'claude-opus-4',
      effort: 'high',
      timeoutSeconds: 900,
      loopable: true,
      isRequired: false,
      retryCondition: 'open_questions > 0'
    };
    await handler(ctx, importCommand([...EXISTING, carried]));

    expect(writes[0]).toEqual([expect.objectContaining({ id: 'held' }), carried]);
  });

  it('is a create to the diff check: an id already in the layer is refused', async () => {
    const { ctx, acks, writes } = harness();
    await handler(
      ctx,
      importCommand([{ ...EXISTING[0], instruction: 'Rewritten.' }], 'held')
    );

    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'phase-mutation-mismatch' });
    expect(writes).toEqual([]);
  });

  it('still refuses a version transition dictated for a row it is not importing', async () => {
    const { ctx, acks, writes } = harness();
    await handler(ctx, importCommand([{ ...EXISTING[0], version: 5 }, IMPORTED]));

    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'phase-version-invalid' });
    expect(writes).toEqual([]);
  });

  it('refuses a stale revision without writing (FR-038)', async () => {
    const { ctx, acks, writes } = harness();
    await handler(ctx, {
      ...importCommand([...EXISTING, IMPORTED]),
      payload: {
        ...importCommand([...EXISTING, IMPORTED]).payload,
        expectedRevision: 'someone-else-wrote'
      }
    } as SavePhasesCommand);

    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'stale-catalog' });
    expect(writes).toEqual([]);
  });

  it('requires the phases capability (FR-040)', async () => {
    capabilities.set('phases', false);
    const { ctx, acks, writes } = harness();
    await handler(ctx, importCommand([...EXISTING, IMPORTED]));

    expect(acks[0].status).toBe('rejected');
    expect(writes).toEqual([]);
  });

  it('requires the retryConditions capability for a document that declares one (FR-012a)', async () => {
    capabilities.set('retryConditions', false);
    const { ctx, acks, writes } = harness();
    await handler(
      ctx,
      importCommand([...EXISTING, { ...IMPORTED, retryCondition: 'open_questions > 0' }])
    );

    expect(acks[0].status).toBe('rejected');
    expect(writes).toEqual([]);
  });
});
