// BUG-001 (FR-013, T022) — foundational field validation tests for
// cmd-save-pipelines. These cover the pre-persist validation that runs
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

import { handler as savePipelinesHandler } from '../../../../../src/ui/sidebar/commands/cmd-save-pipelines';
import { CMD_SAVE_PIPELINES } from '../../../../../src/ui/sidebar/messages';
import type { CommandAckMessage, SavePipelinesCommand } from '../../../../../src/ui/sidebar/messages';

function buildCtx(): {
  ctx: Parameters<typeof savePipelinesHandler>[0];
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

function makeCmd(pipelines: readonly unknown[]): SavePipelinesCommand {
  return {
    type: CMD_SAVE_PIPELINES,
    correlationId: 'test-validation-1',
    payload: { pipelines }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  mocks.state.capabilities.clear();
  mocks.state.scopes.clear();
});

describe('cmd-save-pipelines foundational validation (BUG-001, FR-013)', () => {
  it('rejects pipeline with invalid id pattern', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'UPPER-CASE', name: 'Test', phases: ['speckit-specify'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toContain('pipeline-validation:UPPER-CASE:id:invalid-pattern');
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects pipeline with empty id', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: '', name: 'Test', phases: ['speckit-specify'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toContain('id:invalid-pattern');
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects pipeline with empty name', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: '', phases: ['speckit-specify'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation:valid-id:name:must-be-non-empty');
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects pipeline with name exceeding 80 chars', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'a'.repeat(81), phases: ['speckit-specify'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation:valid-id:name:exceeds-max-length');
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects pipeline with empty phases array', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test', phases: [] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation:valid-id:phases:must-be-non-empty');
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects pipeline with non-array phases', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test', phases: 'not-an-array' }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation:valid-id:phases:must-be-non-empty');
    expect(updateConfigCalls).toEqual([]);
  });

  it('rejects pipeline with non-string phase entries', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-id', name: 'Test', phases: [42, 'speckit-specify'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation:valid-id:phases:must-be-strings');
    expect(updateConfigCalls).toEqual([]);
  });

  it('accepts pipeline with all valid foundational fields', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'valid-flow', name: 'Valid Flow', phases: ['speckit-specify', 'finalize'] }
    ]));
    expect(acks[0].status).toBe('accepted');
    expect(updateConfigCalls).toHaveLength(1);
    expect(updateConfigCalls[0].key).toBe('pipelines');
  });

  it('rejects on first invalid pipeline in a multi-pipeline payload', async () => {
    const { ctx, acks, updateConfigCalls } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'good-flow', name: 'Good', phases: ['speckit-specify'] },
      { id: 'bad-flow', name: '', phases: ['speckit-specify'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-validation:bad-flow:name:must-be-non-empty');
    expect(updateConfigCalls).toEqual([]);
  });

  it('validation runs before trust gate (rejects invalid even when trust is denied)', async () => {
    mocks.state.capabilities.set('pipelineOverrides', false);
    const { ctx, acks } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd([
      { id: 'INVALID', name: 'Test', phases: ['speckit-specify'] }
    ]));
    expect(acks[0].status).toBe('rejected');
    // Foundational validation must fire before trust gate.
    expect(acks[0].reason).toContain('id:invalid-pattern');
  });
});
