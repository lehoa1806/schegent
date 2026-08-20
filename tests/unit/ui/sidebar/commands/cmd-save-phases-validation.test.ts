import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  capabilities: new Map<string, boolean>()
}));

vi.mock('../../../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (capability: string) => mocks.capabilities.get(capability) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));

vi.mock('../../../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: '/tmp/catalog-validation', scheme: 'file' },
    name: 'catalog-validation',
    index: 0
  })
}));

import type { PhaseFieldError } from '../../../../../src/contracts/process-definitions';
import { FakeCatalogStore, layerWrites } from '../../../../fixtures/fake-catalog-store';
import { handler } from '../../../../../src/ui/sidebar/commands/cmd-save-phases';
import { CMD_SAVE_PHASES } from '../../../../../src/ui/sidebar/messages';
import type { CommandAckMessage, SavePhasesCommand } from '../../../../../src/ui/sidebar/messages';

/**
 * Feature 099 (T496f, FR-042/FR-042a) — the harness holds one catalog behind the
 * versioned store rather than a `{ user, workspace }` pair behind `updateConfig`.
 * `writes()` projects the store's layer saves back to the array-of-rows shape the
 * assertions below are written against, so what each case claims is unchanged;
 * only the port it is claimed through moved.
 */
function harness(
  sanitize: (value: string) => string = String,
  current: readonly unknown[] = []
) {
  const acks: CommandAckMessage[] = [];
  const store = new FakeCatalogStore({ phases: current });
  const ctx = {
    deps: {
      executeCommand: vi.fn(),
      queueRemover: { remove: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), sanitize },
      catalogStore: store,
      refreshCatalog: vi.fn(async () => undefined),
      readPhaseConfig: () => ({ rows: store.rowsOf('phase'), revision: store.revisionOf('phase') })
    },
    postAck: async (message: CommandAckMessage) => { acks.push(message); return true; },
    correlationId: 'phase-validation'
  } as unknown as Parameters<typeof handler>[0];
  return { ctx, acks, store, writes: () => layerWrites(store) };
}

/**
 * What a store reports for the Phase catalog before anything is saved into it.
 *
 * Feature 099 (FR-044a) — the revision is the manifest's, not a hash over the
 * rows, so seeding the harness with rows does not move it. That is why every case
 * below echoes this one value where it used to echo `phaseLayerRevision(current)`.
 */
const SEEDED_REVISION = new FakeCatalogStore().revisionOf('phase');

function command(phases: readonly unknown[], phaseId = 'valid-id'): SavePhasesCommand {
  return {
    type: CMD_SAVE_PHASES,
    correlationId: 'phase-validation',
    payload: {
      expectedRevision: SEEDED_REVISION,
      mutation: { kind: 'create', phaseId },
      phases
    }
  };
}

function errors(ack: CommandAckMessage): readonly PhaseFieldError[] {
  expect(ack).toMatchObject({ status: 'rejected', reason: 'phase-validation' });
  return (ack.result as { errors: readonly PhaseFieldError[] }).errors;
}

beforeEach(() => mocks.capabilities.clear());

describe('CMD_SAVE_PHASES shared Phase Definition validation', () => {
  it('rejects an invalid portable identity', async () => {
    const { ctx, acks, writes } = harness();
    await handler(ctx, command([{ id: 'INVALID', name: 'Invalid', instruction: 'Run.' }], 'INVALID'));
    expect(errors(acks[0])).toContainEqual(expect.objectContaining({ field: 'phaseId', code: 'invalid-pattern' }));
    expect(writes()).toEqual([]);
  });

  it('rejects an empty name', async () => {
    const { ctx, acks } = harness();
    await handler(ctx, command([{ id: 'valid-id', name: '', instruction: 'Run.' }]));
    expect(errors(acks[0])).toContainEqual(expect.objectContaining({ field: 'name', code: 'invalid-length' }));
  });

  it('requires exactly one directive kind', async () => {
    const { ctx, acks } = harness();
    await handler(ctx, command([{ id: 'valid-id', name: 'Valid', instruction: 'Run.', skill: 'skill-a' }]));
    expect(errors(acks[0])).toContainEqual(expect.objectContaining({ field: 'directive', code: 'exactly-one-required' }));
  });

  it('accepts a skill directive and persists a host-owned version', async () => {
    const { ctx, acks, writes } = harness();
    await handler(ctx, command([{ id: 'valid-id', name: 'Valid', skill: 'speckit-plan' }]));
    expect(acks[0].status).toBe('accepted');
    expect(writes()).toEqual([[expect.objectContaining({ id: 'valid-id', skill: 'speckit-plan', version: 1 })]]);
  });

  it('rejects unknown authored fields', async () => {
    const { ctx, acks } = harness();
    await handler(ctx, command([{ id: 'valid-id', name: 'Valid', instruction: 'Run.', hostPolicy: true }]));
    expect(errors(acks[0])).toContainEqual(expect.objectContaining({ field: 'hostPolicy', code: 'unknown-field' }));
  });

  it('sanitizes structured validation details before acknowledgement', async () => {
    const { ctx, acks } = harness((value) => value.replace(/TOKEN=abcdefgh/g, '[REDACTED]'));
    await handler(ctx, command([{
      id: 'valid-id', name: 'Valid', instruction: 'Run.', 'TOKEN=abcdefgh': true
    }]));
    expect(errors(acks[0])).toContainEqual(expect.objectContaining({ field: '[REDACTED]' }));
    expect(JSON.stringify(acks[0])).not.toContain('TOKEN=abcdefgh');
  });

  it.each([
    ['effort', 'turbo'],
    ['runner', 'unknown'],
    ['timeoutSeconds', 0],
    ['loopable', 'yes'],
    ['isRequired', 'false']
  ])('rejects invalid %s values', async (field, value) => {
    const { ctx, acks } = harness();
    await handler(ctx, command([{ id: 'valid-id', name: 'Valid', instruction: 'Run.', [field]: value }]));
    expect(errors(acks[0])).toContainEqual(expect.objectContaining({ field }));
  });

  it('rejects invalid retry-condition syntax', async () => {
    const { ctx, acks } = harness();
    await handler(ctx, command([{ id: 'valid-id', name: 'Valid', instruction: 'Run.', retryCondition: '(' }]));
    expect(errors(acks[0])).toContainEqual(expect.objectContaining({ field: 'retryCondition' }));
  });

  it('rejects duplicate ids within one source layer', async () => {
    const { ctx, acks } = harness();
    const row = { id: 'valid-id', name: 'Valid', instruction: 'Run.' };
    await handler(ctx, command([row, row]));
    expect(errors(acks[0])).toContainEqual(expect.objectContaining({ code: 'duplicate-in-scope' }));
  });

  it('requires a Git-capable runner on a custom row that shadows a protected built-in id', async () => {
    const { ctx, acks, writes } = harness();
    // Feature 098 T018 — the save gate reads the row's declared `sideEffects`,
    // so the row declares it. The id is retained only to keep the case
    // recognisable; FR-008 leaves no id list for it to be on.
    await handler(ctx, command([
      {
        id: 'speckit-specify', name: 'Custom Specify', instruction: 'Run safely.',
        runner: 'codex', sideEffects: 'git'
      }
    ], 'speckit-specify'));
    expect(errors(acks[0])).toContainEqual(expect.objectContaining({
      phaseId: 'speckit-specify', field: 'runner', code: 'git-metadata-write-required'
    }));
    expect(writes()).toEqual([]);
  });

  it('allows the default runner on a custom row that shadows a protected built-in id', async () => {
    const { ctx, acks } = harness();
    await handler(ctx, command([
      { id: 'finalize', name: 'Custom Finalize', instruction: 'Commit safely.' }
    ], 'finalize'));
    expect(acks[0].status).toBe('accepted');
  });

  it.each(['claude', 'agy'] as const)('accepts protected built-in shadows using %s', async (runner) => {
    const { ctx, acks } = harness();
    await handler(ctx, command([
      {
        id: 'finalize', name: 'Custom Finalize', instruction: 'Commit safely.',
        runner, sideEffects: 'git'
      }
    ], 'finalize'));
    expect(acks[0].status).toBe('accepted');
  });

  it('validates the entire proposed layer before any persistence', async () => {
    const { ctx, acks, writes } = harness();
    await handler(ctx, command([
      { id: 'valid-id', name: 'Valid', instruction: 'Run.' },
      { id: 'bad-id', name: '', instruction: 'Run.' }
    ]));
    expect(errors(acks[0])).toContainEqual(expect.objectContaining({ phaseId: 'bad-id', field: 'name' }));
    expect(writes()).toEqual([]);
  });

  it('repairs an invalid persisted row without treating it as a new identity', async () => {
    const current = [{
      id: 'valid-id', name: 'Valid', version: 2, instruction: 'Run.', retryCondition: '('
    }];
    const { ctx, acks, writes } = harness(String, current);
    const base = command([{ id: 'valid-id', name: 'Valid', version: 2, instruction: 'Run.' }]);
    const edit: SavePhasesCommand = {
      ...base,
      payload: {
        ...base.payload,
        mutation: { kind: 'edit', phaseId: 'valid-id' }
      }
    };

    await handler(ctx, edit);

    expect(acks[0].status).toBe('accepted');
    expect(writes()).toEqual([[
      expect.objectContaining({ id: 'valid-id', version: 3, instruction: 'Run.' })
    ]]);
  });

  it('repairs a malformed persisted identity as one atomic edit', async () => {
    const current = [{ id: 'INVALID', name: 'Invalid', version: 2, instruction: 'Run.' }];
    const { ctx, acks, writes } = harness(String, current);
    const base = command([{ id: 'repaired-id', name: 'Repaired', version: 2, instruction: 'Run.' }]);
    await handler(ctx, {
      ...base,
      payload: {
        ...base.payload,
        mutation: { kind: 'edit', phaseId: 'INVALID' }
      }
    });
    expect(acks[0].status).toBe('accepted');
    expect(writes()).toEqual([[
      expect.objectContaining({ id: 'repaired-id', version: 3, instruction: 'Run.' })
    ]]);
  });

  it('removes a malformed persisted identity as one atomic removal', async () => {
    const current = [{ id: 'INVALID', name: 'Invalid', version: 2, instruction: 'Run.' }];
    const { ctx, acks, writes } = harness(String, current);
    const base = command([]);
    await handler(ctx, {
      ...base,
      payload: {
        ...base.payload,
        mutation: { kind: 'remove', phaseId: 'INVALID' }
      }
    });
    expect(acks[0].status).toBe('accepted');
    expect(writes()).toEqual([[]]);
  });

  it('repairs a persisted row with no string identity through its synthetic handle', async () => {
    const current = [{ name: 'Invalid', version: 2, instruction: 'Run.' }];
    const { ctx, acks, writes } = harness(String, current);
    const base = command([{ id: 'repaired-id', name: 'Repaired', version: 2, instruction: 'Run.' }]);
    await handler(ctx, {
      ...base,
      payload: {
        ...base.payload,
        mutation: { kind: 'edit', phaseId: '?invalid-1' }
      }
    });
    expect(acks[0].status).toBe('accepted');
    expect(writes()).toEqual([[
      expect.objectContaining({ id: 'repaired-id', version: 3 })
    ]]);
  });

  it('removes a persisted row with no string identity through its synthetic handle', async () => {
    const current = [{ name: 'Invalid', instruction: 'Run.' }];
    const { ctx, acks, writes } = harness(String, current);
    const base = command([]);
    await handler(ctx, {
      ...base,
      payload: {
        ...base.payload,
        mutation: { kind: 'remove', phaseId: '?invalid-1' }
      }
    });
    expect(acks[0].status).toBe('accepted');
    expect(writes()).toEqual([[]]);
  });

  it('repairs one duplicate legacy identity by assigning it a new id', async () => {
    const current = [
      { id: 'duplicate-id', name: 'One', version: 1, instruction: 'One.' },
      { id: 'duplicate-id', name: 'Two', version: 2, instruction: 'Two.' }
    ];
    const proposed = [
      { id: 'repaired-id', name: 'One', version: 1, instruction: 'One.' },
      { id: 'duplicate-id', name: 'Two', version: 2, instruction: 'Two.' }
    ];
    const { ctx, acks, writes } = harness(String, current);
    const base = command(proposed);
    await handler(ctx, {
      ...base,
      payload: {
        ...base.payload,
        mutation: { kind: 'edit', phaseId: 'duplicate-id' }
      }
    });
    expect(acks[0].status).toBe('accepted');
    expect(writes()).toEqual([[
      expect.objectContaining({ id: 'repaired-id', version: 2 }),
      expect.objectContaining({ id: 'duplicate-id', version: 2 })
    ]]);
  });
});
