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
import { pipelineLayerRevision } from '../../../../../src/config/pipeline-catalog';
// Feature 098 (T080) — see the fixture header for why the Phase ids the payloads
// below reference are the real Spec Kit ones.
import { SPECKIT_PHASE_DEFS } from '../../../../fixtures/speckit-catalog-fixture';
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
      // Feature 098 (T080) — the Spec Kit rows join it, because the payloads below
      // name `speckit-specify` and `finalize` and the built-in Phase layer that used
      // to supply them is empty. Without them gate 5 answers `pipeline-validation`
      // and no test here reaches the trust gate it is about.
      readPhaseConfig: () => ({
        user: [],
        workspace: [
          { id: 'done', name: 'Done', version: 1, instruction: 'Done.' },
          ...SPECKIT_PHASE_DEFS
        ]
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
  // Feature 098 (T036) — this used to submit a payload byte-equal to
  // `BUILT_IN_PIPELINES` under an `edit` mutation. The defaults are the empty
  // layer now, so the same payload is `[]`, and what distinguishes this case from
  // its `{ kind: 'reset' }` neighbour below is the mutation kind, not the bytes:
  // `restoresDefaults` is a disjunction, and this exercises the second arm — an
  // operator who removes their last override lands back on the defaults and so
  // needs no capability, even though the command is not a reset.
  it('accepts a payload byte-equal to the defaults under a non-reset mutation', async () => {
    mocks.state.capabilities.set('pipelineOverrides', false);
    mocks.state.scopes.set('pipelineOverrides', 'workspace');
    const current = [
      { id: 'custom-flow', name: 'Custom Flow', version: 1, phases: ['speckit-specify', 'finalize'] }
    ];
    const { ctx, acks, auditCalls, updateConfigCalls } = buildCtx({ workspace: current });
    await savePipelinesHandler(
      ctx,
      makeCmd([], { kind: 'remove', pipelineId: 'custom-flow' }, current)
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

// Feature 098 (T036, FR-010, FR-024) — a describe block here duplicated
// `BUILT_IN_PIPELINES[0]` under `{ sourceScope: 'built-in' }` and asserted that
// the handler wrote only the target layer, leaving the built-in catalog
// byte-identical. Neither half is reachable any more: the built-in layer holds no
// row to name as a source, so no operator can issue that mutation, and the layer
// it protected is a frozen empty array that nothing can change. The gate the
// block exercised on the way past — `pipeline-mutation-mismatch`, for a payload
// that rewrites a row outside the mutation target — is covered on live rows in
// `tests/contract/save-pipelines-scoped.test.ts`.
