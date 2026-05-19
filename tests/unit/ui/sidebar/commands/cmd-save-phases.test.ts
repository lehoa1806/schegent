// Feature 059 (US1, T009) — cmd-save-phases trust-gate unit tests.
// Covers the gate semantics from
// `specs/059-fine-grained-trust-scopes/contracts/save-command-trust-gate-contract.md`:
//   I-2 Reset-is-allowed
//   I-3 Row-granularity retry-condition gate (US3, T017)
//   I-4 One denial per save (precedence)
//   I-5 Audit-before-return
//   I-7 Reason templates are exhaustive.
//
// The resolver is mocked at module level so the gate can be exercised
// without touching VS Code APIs. The integration test
// `tests/integration/trust-scopes-trusted-workspace.test.ts` exercises
// the host end-to-end.

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
import type { CommandAckMessage, SavePhasesCommand, TrustDeniedError } from '../../../../../src/ui/sidebar/messages';
import { BUILT_IN_PHASES } from '../../../../../src/config/pipeline-config';

interface CapturedAudit {
  runId: string;
  phase: string;
  iteration: number;
  eventType: string;
  payload: Record<string, unknown>;
  outcome: string;
  correlationId?: string;
}

function buildCtx(opts: {
  updateConfigThrows?: boolean;
  auditAppendThrows?: boolean;
} = {}): {
  ctx: Parameters<typeof saveHandler>[0];
  acks: CommandAckMessage[];
  auditCalls: CapturedAudit[];
  updateConfigCalls: Array<{ key: string; value: unknown }>;
  warnings: string[];
} {
  const acks: CommandAckMessage[] = [];
  const auditCalls: CapturedAudit[] = [];
  const updateConfigCalls: Array<{ key: string; value: unknown }> = [];
  const warnings: string[] = [];
  const logger = {
    info: vi.fn(),
    warn: (msg: string) => warnings.push(msg),
    error: vi.fn(),
    debug: vi.fn(),
    sanitize: (s: string) => s
  };
  const audit = {
    append: vi.fn(async (entry: CapturedAudit) => {
      if (opts.auditAppendThrows) {
        throw new Error('append failed');
      }
      auditCalls.push(entry);
    })
  };
  const updateConfig = vi.fn(async (key: string, value: unknown) => {
    if (opts.updateConfigThrows) throw new Error('update failed');
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
    correlationId: 'test-correlation-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { ctx, acks, auditCalls, updateConfigCalls, warnings };
}

function makeCmd(phases: readonly unknown[]): SavePhasesCommand {
  return {
    type: CMD_SAVE_PHASES,
    correlationId: 'test-correlation-1',
    payload: { phases }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  mocks.state.capabilities.clear();
  mocks.state.scopes.clear();
  mocks.state.canonicalBasename = 'test-workspace';
});

describe('cmd-save-phases trust gate (059, T009) — I-2 reset-to-defaults', () => {
  it('accepts BUILT_IN_PHASES payload even when allowCustomPhases is false', async () => {
    mocks.state.capabilities.set('phases', false);
    mocks.state.scopes.set('phases', 'workspace');
    const { ctx, acks, auditCalls, updateConfigCalls } = buildCtx();
    await saveHandler(ctx, makeCmd([...BUILT_IN_PHASES]));
    expect(acks[0].status).toBe('accepted');
    expect(auditCalls).toEqual([]);
    expect(updateConfigCalls).toHaveLength(1);
    expect(updateConfigCalls[0].key).toBe('phases');
  });
});

describe('cmd-save-phases trust gate (059, T009) — capability denial', () => {
  it('denies non-default phases when allowCustomPhases is false', async () => {
    mocks.state.capabilities.set('phases', false);
    mocks.state.scopes.set('phases', 'workspace');
    const { ctx, acks, auditCalls, updateConfigCalls } = buildCtx();
    const phases = [
      {
        id: 'speckit-specify',
        name: 'Modified Specify',
        instruction: 'Custom instruction',
        loopable: false
      }
    ];
    await saveHandler(ctx, makeCmd(phases));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('trust-denied');
    const err = acks[0].result as TrustDeniedError;
    expect(err.kind).toBe('trust-denied');
    expect(err.capability).toBe('phases');
    expect(err.resolvedScope).toBe('workspace');
    expect(updateConfigCalls).toEqual([]);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].eventType).toBe('trust.capability-denied');
    expect(auditCalls[0].payload.capability).toBe('phases');
    expect(auditCalls[0].payload.resolvedScope).toBe('workspace');
    expect(auditCalls[0].payload.workspaceBasename).toBe('test-workspace');
    expect(typeof auditCalls[0].payload.reason).toBe('string');
    expect(auditCalls[0].outcome).toBe('failure');
  });

  it('accepts non-default phases when allowCustomPhases is true', async () => {
    mocks.state.capabilities.set('phases', true);
    const { ctx, acks, auditCalls, updateConfigCalls } = buildCtx();
    const phases = [
      {
        id: 'speckit-specify',
        name: 'Modified Specify',
        instruction: 'Custom instruction',
        loopable: false
      }
    ];
    await saveHandler(ctx, makeCmd(phases));
    expect(acks[0].status).toBe('accepted');
    expect(auditCalls).toEqual([]);
    expect(updateConfigCalls).toHaveLength(1);
  });
});

describe('cmd-save-phases trust gate (059, T009) — I-5 audit-before-return resilience', () => {
  it('still returns rejection when audit append throws', async () => {
    mocks.state.capabilities.set('phases', false);
    mocks.state.scopes.set('phases', 'workspace');
    const { ctx, acks, updateConfigCalls, warnings } = buildCtx({ auditAppendThrows: true });
    const phases = [
      {
        id: 'speckit-specify',
        name: 'Modified Specify',
        instruction: 'Custom instruction',
        loopable: false
      }
    ];
    await saveHandler(ctx, makeCmd(phases));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('trust-denied');
    expect((acks[0].result as TrustDeniedError).capability).toBe('phases');
    expect(updateConfigCalls).toEqual([]);
    expect(warnings.some((w) => w.includes('trust.capability-denied'))).toBe(true);
  });
});

describe('cmd-save-phases trust gate (T017, US3) — row-granularity retry-conditions', () => {
  it('denies non-default retryCondition on row when allowCustomRetryConditions is false', async () => {
    // Allow phases overall; deny only retry-conditions.
    mocks.state.capabilities.set('phases', true);
    mocks.state.capabilities.set('retryConditions', false);
    mocks.state.scopes.set('retryConditions', 'user');
    const { ctx, acks, auditCalls, updateConfigCalls } = buildCtx();
    // Row 0: identical to built-in (no retryCondition declared on built-ins).
    // Row 1: introduces a custom retryCondition → triggers the gate.
    const phases = [
      { id: 'speckit-specify', name: 'Spec-kit Specify', instruction: 'i', loopable: false },
      {
        id: 'speckit-clarify',
        name: 'Spec-kit Clarify',
        instruction: 'i',
        loopable: true,
        retryCondition: 'open_questions > 0'
      }
    ];
    await saveHandler(ctx, makeCmd(phases));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('trust-denied');
    const err = acks[0].result as TrustDeniedError;
    expect(err.capability).toBe('retryConditions');
    expect(err.rowIndex).toBe(1);
    expect(err.resolvedScope).toBe('user');
    expect(updateConfigCalls).toEqual([]);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].payload.capability).toBe('retryConditions');
    expect(auditCalls[0].payload.rowIndex).toBe(1);
  });

  it('accepts row whose retryCondition matches the built-in default', async () => {
    mocks.state.capabilities.set('phases', true);
    mocks.state.capabilities.set('retryConditions', false);
    const { ctx, acks, updateConfigCalls } = buildCtx();
    // Built-in phases have NO retryCondition; therefore submitting a row
    // *without* retryCondition is the default and should be accepted.
    const phases = [
      { id: 'speckit-specify', name: 'Spec-kit Specify', instruction: 'i', loopable: false }
    ];
    await saveHandler(ctx, makeCmd(phases));
    expect(acks[0].status).toBe('accepted');
    expect(updateConfigCalls).toHaveLength(1);
  });

  it('I-4 precedence: when both phases AND retryConditions would fire, rejection cites phases', async () => {
    mocks.state.capabilities.set('phases', false);
    mocks.state.capabilities.set('retryConditions', false);
    mocks.state.scopes.set('phases', 'workspace');
    mocks.state.scopes.set('retryConditions', 'user');
    const { ctx, acks, auditCalls } = buildCtx();
    const phases = [
      {
        id: 'speckit-clarify',
        name: 'Renamed Clarify',
        instruction: 'overridden',
        loopable: true,
        retryCondition: 'open_questions > 0'
      }
    ];
    await saveHandler(ctx, makeCmd(phases));
    expect(acks[0].status).toBe('rejected');
    const err = acks[0].result as TrustDeniedError;
    expect(err.capability).toBe('phases'); // precedence: phases wins
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].payload.capability).toBe('phases');
  });
});

describe('cmd-save-phases trust gate (059, T009) — I-6 workspaceBasename derivation', () => {
  it('uses path.basename of canonical workspace folder', async () => {
    mocks.state.canonicalBasename = 'my-project';
    mocks.state.capabilities.set('phases', false);
    mocks.state.scopes.set('phases', 'workspace');
    const { ctx, auditCalls } = buildCtx();
    const phases = [
      { id: 'custom-phase', name: 'Custom', instruction: 'i', loopable: false }
    ];
    await saveHandler(ctx, makeCmd(phases));
    expect(auditCalls[0].payload.workspaceBasename).toBe('my-project');
    // Path separators MUST NOT appear in the basename.
    expect(String(auditCalls[0].payload.workspaceBasename)).not.toMatch(/[\\/]/);
  });
});
