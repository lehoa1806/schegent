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

import { phaseLayerRevision } from '../../../../../src/config/process-catalog';
import { handler } from '../../../../../src/ui/sidebar/commands/cmd-save-phases';
import { CMD_SAVE_PHASES } from '../../../../../src/ui/sidebar/messages';
import type { CommandAckMessage, SavePhasesCommand, TrustDeniedError } from '../../../../../src/ui/sidebar/messages';

const CUSTOM = { id: 'optional-audit', name: 'Optional Audit', instruction: 'Audit.', isRequired: false };

function harness(options: {
  user?: readonly unknown[];
  workspace?: readonly unknown[];
  auditThrows?: boolean;
  persistThrows?: boolean;
} = {}) {
  const workspace = options.workspace ?? [];
  const acks: CommandAckMessage[] = [];
  const writes: Array<{ key: string; value: unknown; scope?: string }> = [];
  const audits: Array<{ payload: Record<string, unknown> }> = [];
  const ctx = {
    deps: {
      executeCommand: vi.fn(),
      queueRemover: { remove: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), sanitize: String },
      audit: { append: vi.fn(async (entry: { payload: Record<string, unknown> }) => {
        if (options.auditThrows) throw new Error('audit failed');
        audits.push(entry);
      }) },
      updateConfig: vi.fn(async (key: string, value: unknown, scope?: string) => {
        if (options.persistThrows) throw new Error('persist failed');
        writes.push({ key, value, scope });
      }),
      readPhaseConfig: () => ({ user: options.user ?? [], workspace }),
      getCatalog: () => ({ pipelines: [], phases: [], models: {}, defaultPipelineId: 'default' })
    },
    postAck: async (message: CommandAckMessage) => { acks.push(message); return true; },
    correlationId: 'save-phases'
  } as unknown as Parameters<typeof handler>[0];
  return { ctx, acks, writes, audits };
}

function command(
  phases: readonly unknown[],
  mutation: SavePhasesCommand['payload']['mutation'],
  current: readonly unknown[] = [],
  expectedRevision = phaseLayerRevision(current),
  scope: 'user' | 'workspace' = 'workspace'
): SavePhasesCommand {
  return {
    type: CMD_SAVE_PHASES,
    correlationId: 'save-phases',
    payload: { scope, expectedRevision, mutation, phases }
  };
}

beforeEach(() => {
  mocks.capabilities.clear();
  mocks.scopes.clear();
  mocks.basename = 'catalog-workspace';
});

describe('CMD_SAVE_PHASES atomic mutation and trust behavior', () => {
  it('persists an optional Phase in the selected scope', async () => {
    const { ctx, acks, writes } = harness();
    await handler(ctx, command([CUSTOM], { kind: 'create', phaseId: CUSTOM.id }));
    expect(acks[0].status).toBe('accepted');
    expect(writes).toEqual([{ key: 'phases', scope: 'workspace', value: [
      expect.objectContaining({ ...CUSTOM, version: 1 })
    ] }]);
  });

  it('persists a complete user layer in the selected scope', async () => {
    const { ctx, acks, writes } = harness({ user: [] });
    await handler(ctx, command(
      [CUSTOM],
      { kind: 'create', phaseId: CUSTOM.id },
      [],
      phaseLayerRevision([]),
      'user'
    ));
    expect(acks[0].status).toBe('accepted');
    expect(writes).toEqual([{
      key: 'phases', scope: 'user',
      value: [expect.objectContaining({ ...CUSTOM, version: 1 })]
    }]);
  });

  it('rejects a stale layer revision without writing', async () => {
    const { ctx, acks, writes } = harness();
    await handler(ctx, command([CUSTOM], { kind: 'create', phaseId: CUSTOM.id }, [], 'stale'));
    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'stale-catalog' });
    expect(writes).toEqual([]);
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
    const { ctx, acks, writes } = harness({ workspace: current });
    await handler(ctx, command(
      [{ ...first, name: 'Edited' }, third, second],
      { kind: 'edit', phaseId: first.id }, current
    ));
    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'phase-mutation-mismatch' });
    expect(writes).toEqual([]);
  });

  it('allows moving only the row named by the edit intent', async () => {
    const first = { ...CUSTOM, version: 1 };
    const second = { id: 'second', name: 'Second', version: 1, instruction: 'Run.' };
    const third = { id: 'third', name: 'Third', version: 1, instruction: 'Run.' };
    const current = [first, second, third];
    const { ctx, acks, writes } = harness({ workspace: current });
    await handler(ctx, command(
      [second, first, third], { kind: 'edit', phaseId: first.id }, current
    ));
    expect(acks[0].status).toBe('accepted');
    expect((writes[0].value as readonly { id: string }[]).map((row) => row.id))
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
    const { ctx, acks, writes } = harness({ workspace: current });
    await handler(ctx, command(proposed, { kind: 'edit', phaseId: CUSTOM.id }, current));
    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'phase-mutation-mismatch' });
    expect(writes).toEqual([]);
  });

  it('increments host-owned version on edit', async () => {
    const current = [{ ...CUSTOM, version: 4 }];
    const edited = [{ ...CUSTOM, name: 'Optional Audit Updated', version: 4 }];
    const { ctx, acks, writes } = harness({ workspace: current });
    await handler(ctx, command(edited, { kind: 'edit', phaseId: CUSTOM.id }, current));
    expect(acks[0].status).toBe('accepted');
    expect(writes[0].value).toEqual([expect.objectContaining({ name: 'Optional Audit Updated', version: 5 })]);
  });

  it('allows reset to clear a writable layer even when custom phases are denied', async () => {
    mocks.capabilities.set('phases', false);
    const current = [{ ...CUSTOM, version: 1 }];
    const { ctx, acks, writes } = harness({ workspace: current });
    await handler(ctx, command([], { kind: 'reset' }, current));
    expect(acks[0].status).toBe('accepted');
    expect(writes[0].value).toEqual([]);
  });

  it('denies a custom mutation when the phases capability is unavailable', async () => {
    mocks.capabilities.set('phases', false);
    mocks.scopes.set('phases', 'workspace');
    const { ctx, acks, writes, audits } = harness();
    await handler(ctx, command([CUSTOM], { kind: 'create', phaseId: CUSTOM.id }));
    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'trust-denied' });
    expect((acks[0].result as TrustDeniedError).capability).toBe('phases');
    expect(writes).toEqual([]);
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
    const { ctx, acks, writes } = harness({ persistThrows: true });
    await handler(ctx, command([CUSTOM], { kind: 'create', phaseId: CUSTOM.id }));
    expect(acks[0]).toMatchObject({ status: 'rejected', reason: 'persistence-failed' });
    expect(writes).toEqual([]);
  });
});
