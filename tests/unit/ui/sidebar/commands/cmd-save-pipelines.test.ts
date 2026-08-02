// Feature 059 (US4, T019) — cmd-save-pipelines trust-gate unit tests.
// Covers the CMD_SAVE_PIPELINES branch of
// `specs/059-fine-grained-trust-scopes/contracts/save-command-trust-gate-contract.md`:
//   - Reset-is-allowed (built-in pipelines bypass the gate).
//   - Non-default + capability denied → trust-denied.
//   - Audit-write throws → rejection still returned, logger.warn called.
//
// The resolver and canonical-folder picker are mocked at module level
// per the cmd-save-phases test pattern.
//
// Feature 082 (T025) migrated these to the scoped, revisioned envelope. The
// 059 invariants are unchanged — only the payload shape and the way a
// "reset to defaults" is expressed moved: it is now either a layer-emptying
// `{ kind: 'reset' }` or a payload byte-equal to `BUILT_IN_PIPELINES`.

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
import type {
  CommandAckMessage,
  SavePipelinesCommand,
  TrustDeniedError
} from '../../../../../src/ui/sidebar/messages';
import { BUILT_IN_PIPELINES } from '../../../../../src/config/pipeline-config';
import { pipelineLayerRevision } from '../../../../../src/config/pipeline-catalog';
import type { PipelineCatalogMutation } from '../../../../../src/contracts/pipeline-definitions';

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
  workspace?: readonly unknown[];
} = {}): {
  ctx: Parameters<typeof savePipelinesHandler>[0];
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
      if (opts.auditAppendThrows) throw new Error('append failed');
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
      updateConfig: updateConfig as any,
      readPipelineConfig: () => ({ user: [], workspace: opts.workspace ?? [] }),
      // Feature 082 (T038) — gate 5 resolves every `phaseId` against the
      // effective Phase catalog; `done` is workspace-authored in these fixtures.
      readPhaseConfig: () => ({
        user: [],
        workspace: [{ id: 'done', name: 'Done', version: 1, instruction: 'Done.' }]
      })
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

function makeCmd(
  pipelines: readonly unknown[],
  mutation: PipelineCatalogMutation = { kind: 'create', pipelineId: 'custom-flow' },
  current: readonly unknown[] = []
): SavePipelinesCommand {
  return {
    type: CMD_SAVE_PIPELINES,
    correlationId: 'test-correlation-1',
    payload: {
      scope: 'workspace',
      expectedRevision: pipelineLayerRevision(current),
      mutation,
      pipelines
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  mocks.state.capabilities.clear();
  mocks.state.scopes.clear();
  mocks.state.canonicalBasename = 'test-workspace';
});

describe('cmd-save-pipelines trust gate (059, T019) — I-2 reset-to-defaults', () => {
  it('accepts BUILT_IN_PIPELINES payload even when allowPipelineOverrides is false', async () => {
    mocks.state.capabilities.set('pipelineOverrides', false);
    mocks.state.scopes.set('pipelineOverrides', 'workspace');
    // The operator has a shadowing copy of the built-ins with one row renamed
    // and restores it, so the submitted layer becomes byte-equal to the
    // built-ins. That is the 082 shape of the 059 "reset to defaults" payload.
    const renamed = [{ ...BUILT_IN_PIPELINES[0], name: 'Renamed Flow' }, ...BUILT_IN_PIPELINES.slice(1)];
    const { ctx, acks, auditCalls, updateConfigCalls } = buildCtx({ workspace: renamed });
    await savePipelinesHandler(
      ctx,
      makeCmd(
        [...BUILT_IN_PIPELINES],
        { kind: 'edit', pipelineId: BUILT_IN_PIPELINES[0].id },
        renamed
      )
    );
    expect(acks[0].status).toBe('accepted');
    expect(auditCalls).toEqual([]);
    expect(updateConfigCalls).toHaveLength(1);
    expect(updateConfigCalls[0].key).toBe('pipelines');
  });

  it('accepts a layer-emptying reset even when allowPipelineOverrides is false', async () => {
    mocks.state.capabilities.set('pipelineOverrides', false);
    mocks.state.scopes.set('pipelineOverrides', 'workspace');
    const current = [
      { id: 'custom-flow', name: 'Custom Flow', version: 1, phases: ['speckit-specify', 'finalize'] }
    ];
    const { ctx, acks, auditCalls, updateConfigCalls } = buildCtx({ workspace: current });
    await savePipelinesHandler(ctx, makeCmd([], { kind: 'reset' }, current));
    expect(acks[0].status).toBe('accepted');
    expect(auditCalls).toEqual([]);
    expect(updateConfigCalls).toEqual([{ key: 'pipelines', value: [] }]);
  });
});

describe('cmd-save-pipelines trust gate (059, T019) — capability denial', () => {
  it('denies non-default pipelines when allowPipelineOverrides is false', async () => {
    mocks.state.capabilities.set('pipelineOverrides', false);
    mocks.state.scopes.set('pipelineOverrides', 'user');
    const { ctx, acks, auditCalls, updateConfigCalls } = buildCtx();
    const pipelines = [
      {
        id: 'custom-flow',
        name: 'Custom Flow',
        phases: ['speckit-specify', 'finalize', 'done']
      }
    ];
    await savePipelinesHandler(ctx, makeCmd(pipelines));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('trust-denied');
    const err = acks[0].result as TrustDeniedError;
    expect(err.kind).toBe('trust-denied');
    expect(err.capability).toBe('pipelineOverrides');
    expect(err.resolvedScope).toBe('user');
    expect(updateConfigCalls).toEqual([]);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].eventType).toBe('trust.capability-denied');
    expect(auditCalls[0].payload.capability).toBe('pipelineOverrides');
    expect(auditCalls[0].payload.resolvedScope).toBe('user');
    expect(auditCalls[0].payload.workspaceBasename).toBe('test-workspace');
    expect(typeof auditCalls[0].payload.reason).toBe('string');
    expect(auditCalls[0].outcome).toBe('failure');
  });

  it('accepts non-default pipelines when allowPipelineOverrides is true', async () => {
    mocks.state.capabilities.set('pipelineOverrides', true);
    const { ctx, acks, auditCalls, updateConfigCalls } = buildCtx();
    const pipelines = [
      {
        id: 'custom-flow',
        name: 'Custom Flow',
        phases: ['speckit-specify', 'finalize', 'done']
      }
    ];
    await savePipelinesHandler(ctx, makeCmd(pipelines));
    expect(acks[0].status).toBe('accepted');
    expect(auditCalls).toEqual([]);
    expect(updateConfigCalls).toHaveLength(1);
  });
});

describe('cmd-save-pipelines trust gate (059, T019) — I-5 audit-before-return resilience', () => {
  it('still returns rejection when audit append throws', async () => {
    mocks.state.capabilities.set('pipelineOverrides', false);
    mocks.state.scopes.set('pipelineOverrides', 'workspace');
    const { ctx, acks, updateConfigCalls, warnings } = buildCtx({
      auditAppendThrows: true
    });
    const pipelines = [
      {
        id: 'custom-flow',
        name: 'Custom Flow',
        phases: ['speckit-specify', 'finalize', 'done']
      }
    ];
    await savePipelinesHandler(ctx, makeCmd(pipelines));
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('trust-denied');
    expect((acks[0].result as TrustDeniedError).capability).toBe('pipelineOverrides');
    expect(updateConfigCalls).toEqual([]);
    expect(warnings.some((w) => w.includes('trust.capability-denied'))).toBe(true);
  });
});

// Feature 082 (US4, T048) — SC-005: duplicating a built-in is additive only.
//
// A duplicate names its source across a scope boundary, which is the one
// mutation whose payload references a layer it is not allowed to write. The
// handler persists exactly one layer — the writable target — so the built-in
// catalog stays code-resident and byte-for-byte identical. Asserting this at
// the command boundary is what makes "built-ins are immutable" (FR-024) a
// property of the save algebra rather than an accident of the UI never
// offering a control.
describe('cmd-save-pipelines duplicate of a built-in (082, T048, SC-005)', () => {
  const SOURCE = BUILT_IN_PIPELINES[0];

  function duplicateCmd(): SavePipelinesCommand {
    return makeCmd(
      [
        {
          id: `${SOURCE.id}-copy`,
          name: `${SOURCE.name} (Copy)`,
          version: 1,
          phases: [...SOURCE.phases]
        }
      ],
      {
        kind: 'duplicate',
        sourceScope: 'built-in',
        sourcePipelineId: SOURCE.id,
        pipelineId: `${SOURCE.id}-copy`
      }
    );
  }

  it('writes only the target scope and leaves the built-in catalog unchanged', async () => {
    mocks.state.capabilities.set('pipelineOverrides', true);
    const before = JSON.stringify(BUILT_IN_PIPELINES);
    const { ctx, acks, updateConfigCalls } = buildCtx();

    await savePipelinesHandler(ctx, duplicateCmd());

    expect(acks[0].status).toBe('accepted');
    expect(updateConfigCalls).toHaveLength(1);
    expect(updateConfigCalls[0].key).toBe('pipelines');
    expect(updateConfigCalls[0].value).toEqual([
      expect.objectContaining({ id: `${SOURCE.id}-copy`, version: 1 })
    ]);
    // The source id never reaches the persisted layer — only the copy does.
    expect(JSON.stringify(updateConfigCalls[0].value)).not.toContain(`"id":"${SOURCE.id}"`);
    expect(JSON.stringify(BUILT_IN_PIPELINES)).toBe(before);
  });

  it('leaves the built-ins unchanged even when the duplicate is rejected', async () => {
    mocks.state.capabilities.set('pipelineOverrides', false);
    mocks.state.scopes.set('pipelineOverrides', 'workspace');
    const before = JSON.stringify(BUILT_IN_PIPELINES);
    const { ctx, acks, updateConfigCalls } = buildCtx();

    await savePipelinesHandler(ctx, duplicateCmd());

    expect(acks[0].status).toBe('rejected');
    expect(updateConfigCalls).toEqual([]);
    expect(JSON.stringify(BUILT_IN_PIPELINES)).toBe(before);
  });

  it('rejects a payload that also rewrites the built-in source row', async () => {
    mocks.state.capabilities.set('pipelineOverrides', true);
    const before = JSON.stringify(BUILT_IN_PIPELINES);
    const { ctx, acks, updateConfigCalls } = buildCtx();

    await savePipelinesHandler(
      ctx,
      makeCmd(
        [
          { id: `${SOURCE.id}-copy`, name: 'Copy', version: 1, phases: [...SOURCE.phases] },
          { ...SOURCE, name: 'Rewritten built-in' }
        ],
        {
          kind: 'duplicate',
          sourceScope: 'built-in',
          sourcePipelineId: SOURCE.id,
          pipelineId: `${SOURCE.id}-copy`
        }
      )
    );

    expect(acks[0].status).toBe('rejected');
    expect(acks[0].reason).toBe('pipeline-mutation-mismatch');
    expect(updateConfigCalls).toEqual([]);
    expect(JSON.stringify(BUILT_IN_PIPELINES)).toBe(before);
  });
});
