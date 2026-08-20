import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  capabilities: new Map<string, boolean>(),
  scopes: new Map<string, 'user' | 'workspace' | 'workspace-trust'>(),
  basename: 'catalog-workspace'
}));

vi.mock('../../../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (capability: string) => mocks.capabilities.get(capability) ?? true,
  getResolvedScope: (capability: string) => mocks.scopes.get(capability) ?? 'workspace-trust'
}));

vi.mock('../../../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: `/tmp/${mocks.basename}`, scheme: 'file' },
    name: mocks.basename,
    index: 0
  })
}));

import { FakeCatalogStore, layerWrites } from '../../../../fixtures/fake-catalog-store';
import { handler } from '../../../../../src/ui/sidebar/commands/cmd-save-phases';
import { CMD_SAVE_PHASES } from '../../../../../src/ui/sidebar/messages';
import type { CommandAckMessage, SavePhasesCommand, TrustDeniedError } from '../../../../../src/ui/sidebar/messages';

const CUSTOM = { id: 'optional-audit', name: 'Optional Audit', instruction: 'Audit.', isRequired: false };

/**
 * The revision a freshly seeded store reports.
 *
 * Feature 099 (T496f, FR-044a) — a revision is the manifest's, not a hash over
 * the rows, so seeding a store with existing Phases does NOT move it. Every case
 * below can therefore name one constant instead of recomputing
 * `phaseLayerRevision(current)` per call, and the stale case is the one that
 * deliberately names something else.
 */
const SEEDED_REVISION = new FakeCatalogStore().revisionOf('phase');

function harness(options: {
  current?: readonly unknown[];
  auditThrows?: boolean;
  /** Answer the save with a store refusal instead of performing it. */
  persistRefused?: boolean;
} = {}) {
  const acks: CommandAckMessage[] = [];
  const audits: Array<{ payload: Record<string, unknown> }> = [];
  const store = new FakeCatalogStore({ phases: options.current ?? [] });
  if (options.persistRefused === true) {
    store.nextLayerVerdict = { outcome: 'refused', reason: 'not-writable', id: null };
  }
  const ctx = {
    deps: {
      executeCommand: vi.fn(),
      queueRemover: { remove: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), sanitize: String },
      audit: { append: vi.fn(async (entry: { payload: Record<string, unknown> }) => {
        if (options.auditThrows) throw new Error('audit failed');
        audits.push(entry);
      }) },
      catalogStore: store,
      refreshCatalog: vi.fn(async () => undefined),
      readPhaseConfig: () => ({ rows: store.rowsOf('phase'), revision: store.revisionOf('phase') }),
      getCatalog: () => ({ pipelines: [], phases: [], models: {}, defaultPipelineId: 'default' })
    },
    postAck: async (message: CommandAckMessage) => { acks.push(message); return true; },
    correlationId: 'save-phases'
  } as unknown as Parameters<typeof handler>[0];
  return { ctx, acks, audits, store, writes: () => layerWrites(store) };
}

function command(
  phases: readonly unknown[],
  mutation: SavePhasesCommand['payload']['mutation'],
  expectedRevision: string = SEEDED_REVISION
): SavePhasesCommand {
  return {
    type: CMD_SAVE_PHASES,
    correlationId: 'save-phases',
    payload: { expectedRevision, mutation, phases }
  };
}

beforeEach(() => {
  mocks.capabilities.clear();
  mocks.scopes.clear();
  mocks.basename = 'catalog-workspace';
});

describe('CMD_SAVE_PHASES atomic mutation and trust behavior', () => {
  it('persists an optional Phase into the one catalog', async () => {
    const { ctx, acks, writes, store } = harness();
    await handler(ctx, command([CUSTOM], { kind: 'create', phaseId: CUSTOM.id }));
    expect(acks[0].status).toBe('accepted');
    expect(store.layerSaves.map((request) => request.kind)).toEqual(['phase']);
    expect(writes()).toEqual([[expect.objectContaining({ ...CUSTOM, version: 1 })]]);
  });

  it('sends the complete layer under a request that names no scope (FR-043)', async () => {
    // Feature 099 (T496f) — the successor of "persists a complete user layer in
    // the selected scope". That case asserted the SAME command wrote a different
    // layer when the payload said so; with one catalog there is no other layer to
    // select, and the claim that survives is the negative one: the request the
    // handler builds carries no scope at all. An EXACT key set, so a build that
    // still sends one — under any value — fails here rather than passing with a
    // vestigial field.
    const { ctx, acks, store } = harness();
    await handler(ctx, command([CUSTOM], { kind: 'create', phaseId: CUSTOM.id }));
    expect(acks[0].status).toBe('accepted');
    expect(Object.keys(store.layerSaves[0]).sort())
      .toEqual(['definitions', 'expectedRevision', 'kind']);
    expect(store.rowsOf('phase'))
      .toEqual([expect.objectContaining({ ...CUSTOM, version: 1 })]);
  });

  it('rejects a stale layer revision without writing', async () => {
    const { ctx, acks, writes } = harness();
    await handler(ctx, command([CUSTOM], { kind: 'create', phaseId: CUSTOM.id }, 'stale'));
    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'stale-catalog' });
    expect(writes()).toEqual([]);
  });

  it('rejects a payload diff that exceeds the declared mutation', async () => {
    const { ctx, acks } = harness();
    await handler(ctx, command([
      CUSTOM,
      { id: 'second', name: 'Second', instruction: 'Run.' }
    ], { kind: 'create', phaseId: CUSTOM.id }));
    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'phase-mutation-mismatch' });
  });

  it('rejects reordering unrelated rows under a single-row edit intent', async () => {
    const first = { ...CUSTOM, version: 1 };
    const second = { id: 'second', name: 'Second', version: 1, instruction: 'Run.' };
    const third = { id: 'third', name: 'Third', version: 1, instruction: 'Run.' };
    const current = [first, second, third];
    const { ctx, acks, writes } = harness({ current });
    await handler(ctx, command(
      [{ ...first, name: 'Edited' }, third, second],
      { kind: 'edit', phaseId: first.id }
    ));
    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'phase-mutation-mismatch' });
    expect(writes()).toEqual([]);
  });

  it('allows moving only the row named by the edit intent', async () => {
    const first = { ...CUSTOM, version: 1 };
    const second = { id: 'second', name: 'Second', version: 1, instruction: 'Run.' };
    const third = { id: 'third', name: 'Third', version: 1, instruction: 'Run.' };
    const current = [first, second, third];
    const { ctx, acks, writes } = harness({ current });
    await handler(ctx, command([second, first, third], { kind: 'edit', phaseId: first.id }));
    expect(acks[0].status).toBe('accepted');
    expect((writes()[0] as readonly { id: string }[]).map((row) => row.id))
      .toEqual(['second', first.id, 'third']);
  });

  it('rejects silently normalizing an untouched invalid row', async () => {
    const current = [
      { ...CUSTOM, version: 1 },
      { id: 'invalid-row', name: 'Invalid', version: 1, instruction: 'Run.', loopable: 'yes' }
    ];
    const proposed = [
      { ...CUSTOM, name: 'Edited', version: 1 },
      { id: 'invalid-row', name: 'Invalid', version: 1, instruction: 'Run.' }
    ];
    const { ctx, acks, writes } = harness({ current });
    await handler(ctx, command(proposed, { kind: 'edit', phaseId: CUSTOM.id }));
    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'phase-mutation-mismatch' });
    expect(writes()).toEqual([]);
  });

  it('increments host-owned version on edit', async () => {
    const current = [{ ...CUSTOM, version: 4 }];
    const edited = [{ ...CUSTOM, name: 'Optional Audit Updated', version: 4 }];
    const { ctx, acks, writes } = harness({ current });
    await handler(ctx, command(edited, { kind: 'edit', phaseId: CUSTOM.id }));
    expect(acks[0].status).toBe('accepted');
    expect(writes()[0]).toEqual([expect.objectContaining({ name: 'Optional Audit Updated', version: 5 })]);
  });

  it('allows reset to clear a writable layer even when custom phases are denied', async () => {
    mocks.capabilities.set('phases', false);
    const current = [{ ...CUSTOM, version: 1 }];
    const { ctx, acks, writes, store } = harness({ current });
    await handler(ctx, command([], { kind: 'reset' }));
    expect(acks[0].status).toBe('accepted');
    expect(writes()[0]).toEqual([]);
    // Un-naming every id IS the removal, so the catalog is empty afterwards (FR-026).
    expect(store.rowsOf('phase')).toEqual([]);
  });

  it('denies a custom mutation when the phases capability is unavailable', async () => {
    mocks.capabilities.set('phases', false);
    mocks.scopes.set('phases', 'workspace');
    const { ctx, acks, writes, audits } = harness();
    await handler(ctx, command([CUSTOM], { kind: 'create', phaseId: CUSTOM.id }));
    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'trust-denied' });
    expect((acks[0].result as TrustDeniedError).capability).toBe('phases');
    expect(writes()).toEqual([]);
    expect(audits).toHaveLength(1);
  });

  it('denies a custom retry condition at row granularity', async () => {
    mocks.capabilities.set('phases', true);
    mocks.capabilities.set('retryConditions', false);
    const row = { ...CUSTOM, retryCondition: 'exitCode != 0' };
    const { ctx, acks } = harness();
    await handler(ctx, command([row], { kind: 'create', phaseId: row.id }));
    expect((acks[0].result as TrustDeniedError)).toMatchObject({ capability: 'retryConditions', rowIndex: 0 });
  });

  it('returns trust denial even when audit append fails', async () => {
    mocks.capabilities.set('phases', false);
    const { ctx, acks } = harness({ auditThrows: true });
    await handler(ctx, command([CUSTOM], { kind: 'create', phaseId: CUSTOM.id }));
    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'trust-denied' });
  });

  it('uses only the canonical workspace basename in denial evidence', async () => {
    mocks.capabilities.set('phases', false);
    mocks.basename = 'my-project';
    const { ctx, audits } = harness();
    await handler(ctx, command([CUSTOM], { kind: 'create', phaseId: CUSTOM.id }));
    expect(audits[0].payload.workspaceBasename).toBe('my-project');
  });

  it('leaves the prior layer unchanged when persistence fails', async () => {
    // Feature 099 (T496f, FR-029) — this used to make the settings writer throw.
    // The store never throws; it names the fault, and `not-writable` is the same
    // fault by its own name. The ack reason is unchanged, and what the case is
    // really about is unchanged too: the seeded layer is still exactly what a
    // reader sees afterwards.
    const current = [{ ...CUSTOM, version: 3 }];
    const { ctx, acks, store } = harness({ current, persistRefused: true });
    await handler(ctx, command([CUSTOM, { id: 'second', name: 'Second', instruction: 'Run.' }], { kind: 'create', phaseId: 'second' }));
    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'persistence-failed' });
    expect((acks[0].result as { storeRefusal?: string }).storeRefusal).toBe('not-writable');
    expect(store.rowsOf('phase')).toEqual(current);
  });
});
