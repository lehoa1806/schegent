// BUG-001 (FR-012, T022) — foundational field validation tests for
// cmd-save-phases. These cover the pre-persist validation that runs
// BEFORE the trust gate and BEFORE updateConfig.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    capabilities: new Map<string, boolean>(),
    scopes: new Map<string, 'user' | 'workspace' | 'workspace-trust'>(),
    canonicalBasename: 'test-workspace' as string
  };
  return { state };
});

vi.mock('../../../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (capability: string) =>
    mocks.state.capabilities.get(capability) ?? true,
  getResolvedScope: (capability: string) =>
    mocks.state.scopes.get(capability) ?? 'workspace-trust'
}));

vi.mock('../../../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: `/tmp/${mocks.state.canonicalBasename}`, scheme: 'file' },
    name: mocks.state.canonicalBasename,
    index: 0
  })
}));

import { handler as saveHandler } from '../../../../../src/ui/sidebar/commands/cmd-save-phases';
import { CMD_SAVE_PHASES } from '../../../../../src/ui/sidebar/messages';
import type { CommandAckMessage, SavePhasesCommand } from '../../../../../src/ui/sidebar/messages';
import { SUPPORTED_BACKENDS } from '../../../../../src/runner/backend-runner-factory';

function buildCtx(): {
  ctx: Parameters<typeof saveHandler>[0];
  acks: CommandAckMessage[];
  updateConfigCalls: Array<{ key: string; value: unknown }>;
} {
  const acks: CommandAckMessage[] = [];
  const updateConfigCalls: Array<{ key: string; value: unknown }> = [];
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    sanitize: (s: string) => s
  };
  const audit = {
    append: vi.fn(async () => {})
  };
  const updateConfig = vi.fn(async (key: string, value: unknown) => {
    updateConfigCalls.push({ key, value });
  });
  const ctx = {
    deps: {
      executeCommand: vi.fn(),
      queueRemover: { remove: vi.fn() },
      logger,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      audit: audit as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateConfig: updateConfig as any
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'test-validation-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { ctx, acks, updateConfigCalls };
}

function makeCmd(phases: readonly unknown[]): SavePhasesCommand {
  return {
    type: CMD_SAVE_PHASES,
    correlationId: 'test-validation-1',
    payload: { phases }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  mocks.state.capabilities.clear();
  mocks.state.scopes.clear();
});

describe('cmd-save-phases foundational validation (BUG-001, FR-012)', () => {
  it('rejects phase with invalid id pattern', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await saveHandler(ctx, makeCmd([
      { id: 'INVALID-UPPER', name: 'Test', instruction: 'Do something' }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toContain('phase-validation:INVALID-UPPER:id:invalid-pattern');
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects phase with empty id', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await saveHandler(ctx, makeCmd([
      { id: '', name: 'Test', instruction: 'Do something' }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toContain('id:invalid-pattern');
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects phase with empty name', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await saveHandler(ctx, makeCmd([
      { id: 'valid-id', name: '', instruction: 'Do something' }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('phase-validation:valid-id:name:must-be-non-empty');
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects phase with name exceeding 80 chars', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await saveHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'a'.repeat(81), instruction: 'Do something' }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('phase-validation:valid-id:name:exceeds-max-length');
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects phase with empty instruction', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await saveHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test', instruction: '' }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('phase-validation:valid-id:instruction:must-be-non-empty');
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects phase with instruction exceeding 8192 chars', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await saveHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test', instruction: 'x'.repeat(8193) }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('phase-validation:valid-id:instruction:exceeds-max-length');
    expect(updateConfigCalls).toEqual([]);
  });


  it('accepts phase with all valid foundational fields', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await saveHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test Phase', instruction: 'Do something useful' }
    ]));
    expect(acks[0].status).toBe('accepted');
    expect(updateConfigCalls).toHaveLength(1);
    expect(updateConfigCalls[0].key).toBe('phases');
  });

  it('round-trips a legacy boolean loopable field', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    const phases = [
      { id: 'legacy-loop', name: 'Legacy loop', instruction: 'Do work', loopable: true }
    ];

    await saveHandler(ctx, makeCmd(phases));

    expect(acks[0].status).toBe('accepted');
    expect(updateConfigCalls[0].value).toEqual(phases);
  });

  it('rejects a non-boolean loopable field', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();

    await saveHandler(ctx, makeCmd([
      { id: 'legacy-loop', name: 'Legacy loop', instruction: 'Do work', loopable: 'yes' }
    ]));

    expect(acks[0]).toMatchObject({
      status: 'rejected',
      reason: 'phase-validation:legacy-loop:loopable:must-be-boolean'
    });
    expect(updateConfigCalls).toEqual([]);
  });

  it.each(SUPPORTED_BACKENDS)('accepts supported runner %s', async (runner) => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await saveHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test Phase', instruction: 'Do work', runner }
    ]));
    expect(acks[0].status).toBe('accepted');
    expect(updateConfigCalls).toHaveLength(1);
  });

  it.each(['unknown', '', 42, null])('rejects invalid runner %j', async (runner) => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await saveHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test Phase', instruction: 'Do work', runner }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toContain('runner:must-be-one-of-claude,codex,agy');
    expect(updateConfigCalls).toEqual([]);
  });

  it.each([
    'speckit-specify',
    'specify-brainstorm',
    'superpowers-implement',
    'finalize',
    'superpowers-review-close'
  ] as const)('accepts protected phase %s with its pinned runner omitted', async (id) => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await saveHandler(ctx, makeCmd([
      { id, name: 'Git phase', instruction: 'Commit and merge the work.' }
    ]));

    expect(acks[0].status).toBe('accepted');
    expect(updateConfigCalls).toHaveLength(1);
  });

  it.each([
    'speckit-specify',
    'specify-brainstorm',
    'superpowers-implement',
    'finalize',
    'superpowers-review-close'
  ] as const)('rejects protected phase %s with runner codex', async (id) => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await saveHandler(ctx, makeCmd([
      {
        id,
        name: 'Git phase',
        instruction: 'Commit and merge the work.',
        runner: 'codex'
      }
    ]));

    expect(acks[0]).toMatchObject({
      status: 'rejected',
      reason: `phase-validation:${id}:runner:git-metadata-write-required`
    });
    expect(updateConfigCalls).toEqual([]);
  });

  it.each(['claude', 'agy'] as const)(
    'accepts a Git-mutating phase with explicit %s runner',
    async (runner) => {
      const { ctx, acks, updateConfigCalls } = buildCtx();
      await saveHandler(ctx, makeCmd([
        {
          id: 'finalize',
          name: 'Finalize',
          instruction: 'Commit and merge the work.',
          runner
        }
      ]));

      expect(acks[0].status).toBe('accepted');
      expect(updateConfigCalls).toHaveLength(1);
    }
  );

  it('rejects on first invalid phase in a multi-phase payload', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await saveHandler(ctx, makeCmd([
      { id: 'good-phase', name: 'Good', instruction: 'Valid instruction' },
      { id: 'bad-phase', name: '', instruction: 'Also valid' }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('phase-validation:bad-phase:name:must-be-non-empty');
    expect(updateConfigCalls).toEqual([]);
  });

  it('validation runs before trust gate (rejects invalid even when trust is denied)', async () => {
    mocks.state.capabilities.set('phases', false);
    const { ctx, acks } = buildCtx();
    // The payload is non-default AND invalid. The foundational validation
    // must fire first, not the trust gate.
    await saveHandler(ctx, makeCmd([
      { id: 'UPPER', name: 'Test', instruction: 'x' }
    ]));
    expect(acks[0].status).toBe('rejected');
    // If trust gate fired first, reason would be 'trust-denied'.
    // Foundational validation must win.
    expect(acks[0].reason).toContain('id:invalid-pattern');
  });
});
