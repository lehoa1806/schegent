import { beforeEach, describe, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => new Map<string, boolean>());
vi.mock('../../../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (name: string) => capabilities.get(name) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));
vi.mock('../../../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({ uri: { fsPath: '/tmp/identity' }, name: 'identity', index: 0 })
}));

import { FakeCatalogStore, layerWrites } from '../../../../fixtures/fake-catalog-store';
import { handler } from '../../../../../src/ui/sidebar/commands/cmd-save-phases';
import { CMD_SAVE_PHASES } from '../../../../../src/ui/sidebar/messages';
import type { CommandAckMessage, SavePhasesCommand } from '../../../../../src/ui/sidebar/messages';

const CURRENT = [{ id: 'stable-id', name: 'Stable', version: 3, instruction: 'Run.' }];

/** Feature 099 (T496f, FR-044a) — seeding rows does not move a revision. */
const SEEDED_REVISION = new FakeCatalogStore().revisionOf('phase');

function harness() {
  const acks: CommandAckMessage[] = [];
  const store = new FakeCatalogStore({ phases: CURRENT });
  const ctx = {
    deps: {
      executeCommand: vi.fn(), queueRemover: { remove: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), sanitize: String },
      catalogStore: store,
      refreshCatalog: vi.fn(async () => undefined),
      readPhaseConfig: () => ({ rows: store.rowsOf('phase'), revision: store.revisionOf('phase') })
    },
    correlationId: 'identity',
    postAck: async (ack: CommandAckMessage) => { acks.push(ack); return true; }
  } as unknown as Parameters<typeof handler>[0];
  return { ctx, acks, store, writes: () => layerWrites(store) };
}

function edit(phases: readonly unknown[]): SavePhasesCommand {
  return {
    type: CMD_SAVE_PHASES,
    correlationId: 'identity',
    payload: {
      expectedRevision: SEEDED_REVISION,
      mutation: { kind: 'edit', phaseId: 'stable-id' }, phases
    }
  };
}

beforeEach(() => capabilities.clear());

describe('Phase identity and host-owned versions', () => {
  it('rejects changing an existing id and directs the operator to duplicate', async () => {
    const { ctx, acks, writes } = harness();
    await handler(ctx, edit([{ id: 'renamed-id', name: 'Stable', version: 3, instruction: 'Run.' }]));
    expect(acks[0]).toMatchObject({
      status: 'rejected', reason: 'phase-identity-immutable',
      result: { phaseId: 'stable-id', legalActions: ['duplicate'] }
    });
    expect(writes()).toEqual([]);
  });

  it('increments a changed row exactly once', async () => {
    const { ctx, acks, writes } = harness();
    await handler(ctx, edit([{ ...CURRENT[0], name: 'Changed' }]));
    expect(acks[0].status).toBe('accepted');
    expect(writes()[0]).toEqual([expect.objectContaining({ id: 'stable-id', version: 4 })]);
  });

  it('preserves an unchanged row version', async () => {
    const { ctx, acks, writes } = harness();
    await handler(ctx, edit(CURRENT));
    expect(acks[0].status).toBe('accepted');
    expect(writes()[0]).toEqual([expect.objectContaining({ version: 3 })]);
  });

  it('rejects an operator-supplied version transition', async () => {
    const { ctx, acks, writes } = harness();
    await handler(ctx, edit([{ ...CURRENT[0], name: 'Changed', version: 4 }]));
    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'phase-version-invalid' });
    expect(writes()).toEqual([]);
  });
});
