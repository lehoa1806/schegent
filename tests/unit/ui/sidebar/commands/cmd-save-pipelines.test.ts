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
//
// Feature 099 (T496f, FR-046) — the `pipelineOverrides` capability this file was
// built around is DELETED with the layer tier: gates 11 and 12 asked whether one
// layer could redefine what another declares, and one layer poses no such
// question. Two of the four cases below were about the gate firing; what replaces
// them is the negative that must now hold forever — a Pipeline save consults no
// override capability at all, so the gate cannot come back unnoticed. The two
// reset-to-defaults cases keep their claims exactly and lose only the setting
// that used to make them interesting.
//
// The I-5 case ('still returns rejection when audit append throws') is gone with
// the gate that produced the rejection: a Pipeline save has no trust denial left
// to audit. The invariant itself — an audit failure never swallows the ack — is
// unchanged and still pinned on the Phase path, in `cmd-save-phases.test.ts`
// ('returns trust denial even when audit append fails').

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    capabilities: new Map<string, boolean>(),
    scopes: new Map<string, 'user' | 'workspace' | 'workspace-trust'>(),
    asked: [] as string[],
    canonicalBasename: 'test-workspace' as string
  };
  return { state };
});

vi.mock('../../../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (capability: string) => {
    mocks.state.asked.push(capability);
    return mocks.state.capabilities.get(capability) ?? true;
  },
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
  SavePipelinesCommand
} from '../../../../../src/ui/sidebar/messages';
import { FakeCatalogStore, layerWrites } from '../../../../fixtures/fake-catalog-store';
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

/** Feature 099 (T496f, FR-044a) — seeding rows does not move a revision. */
const SEEDED_REVISION = new FakeCatalogStore().revisionOf('pipeline');

// Feature 082 (T038) — gate 5 resolves every `phaseId` against the effective
// Phase catalog; `done` is authored in these fixtures. Feature 098 (T080) — the
// Spec Kit rows join it, because the payloads below name `speckit-specify` and
// `finalize` and the built-in Phase layer that used to supply them is empty.
// Without them gate 5 answers `pipeline-validation` and no test here reaches what
// it is about.
const PHASE_ROWS: readonly unknown[] = [
  { id: 'done', name: 'Done', version: 1, instruction: 'Done.' },
  ...SPECKIT_PHASE_DEFS
];

function buildCtx(opts: {
  auditAppendThrows?: boolean;
  current?: readonly unknown[];
} = {}): {
  ctx: Parameters<typeof savePipelinesHandler>[0];
  acks: CommandAckMessage[];
  auditCalls: CapturedAudit[];
  store: FakeCatalogStore;
  warnings: string[];
} {
  const acks: CommandAckMessage[] = [];
  const auditCalls: CapturedAudit[] = [];
  const warnings: string[] = [];
  const store = new FakeCatalogStore({
    phases: PHASE_ROWS,
    pipelines: opts.current ?? []
  });
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
  const ctx = {
    deps: {
      executeCommand: vi.fn(),
      queueRemover: { remove: vi.fn() },
      logger,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      audit: audit as any,
      catalogStore: store,
      refreshCatalog: vi.fn(async () => undefined),
      readPipelineConfig: () => ({
        rows: store.rowsOf('pipeline'),
        revision: store.revisionOf('pipeline')
      }),
      readPhaseConfig: () => ({
        rows: store.rowsOf('phase'),
        revision: store.revisionOf('phase')
      })
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'test-correlation-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { ctx, acks, auditCalls, store, warnings };
}

function makeCmd(
  pipelines: readonly unknown[],
  mutation: PipelineCatalogMutation = { kind: 'create', pipelineId: 'custom-flow' }
): SavePipelinesCommand {
  return {
    type: CMD_SAVE_PIPELINES,
    correlationId: 'test-correlation-1',
    payload: {
      expectedRevision: SEEDED_REVISION,
      mutation,
      pipelines
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  mocks.state.capabilities.clear();
  mocks.state.scopes.clear();
  mocks.state.asked.length = 0;
  mocks.state.canonicalBasename = 'test-workspace';
});

describe('cmd-save-pipelines trust gate (059, T019) — I-2 reset-to-defaults', () => {
  // Feature 098 (T036) — this used to submit a payload byte-equal to
  // `BUILT_IN_PIPELINES` under an `edit` mutation. The defaults are the empty
  // layer now, so the same payload is `[]`, and what distinguishes this case from
  // its `{ kind: 'reset' }` neighbour below is the mutation kind, not the bytes:
  // an operator who removes their last override lands back on the defaults, and
  // does so through the ordinary remove path rather than a reset.
  it('accepts a payload byte-equal to the defaults under a non-reset mutation', async () => {
    const current = [
      { id: 'custom-flow', name: 'Custom Flow', version: 1, phases: ['speckit-specify', 'finalize'] }
    ];
    const { ctx, acks, auditCalls, store } = buildCtx({ current });
    await savePipelinesHandler(
      ctx,
      makeCmd([], { kind: 'remove', pipelineId: 'custom-flow' })
    );
    expect(acks[0].status).toBe('accepted');
    expect(auditCalls).toEqual([]);
    expect(store.layerSaves).toHaveLength(1);
    expect(store.layerSaves[0].kind).toBe('pipeline');
  });

  it('accepts a layer-emptying reset', async () => {
    const current = [
      { id: 'custom-flow', name: 'Custom Flow', version: 1, phases: ['speckit-specify', 'finalize'] }
    ];
    const { ctx, acks, auditCalls, store } = buildCtx({ current });
    await savePipelinesHandler(ctx, makeCmd([], { kind: 'reset' }));
    expect(acks[0].status).toBe('accepted');
    expect(auditCalls).toEqual([]);
    expect(layerWrites(store)).toEqual([[]]);
    expect(store.rowsOf('pipeline')).toEqual([]);
  });
});

describe('cmd-save-pipelines (099, T496f) — no override capability is left to consult', () => {
  const CUSTOM = [
    {
      id: 'custom-flow',
      name: 'Custom Flow',
      phases: ['speckit-specify', 'finalize', 'done']
    }
  ];

  // FR-046. The two cases this replaces set `pipelineOverrides` to false and then
  // true, and asserted the save was denied and then allowed. There is no such
  // capability any more, so the surviving claim is the one a reintroduced gate
  // would break: the answer does not depend on the resolver at all.
  it('accepts a non-default Pipeline with every capability denied', async () => {
    for (const capability of ['pipelineOverrides', 'workflowOverrides', 'phases', 'retryConditions']) {
      mocks.state.capabilities.set(capability, false);
    }
    const { ctx, acks, auditCalls, store } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd(CUSTOM));
    expect(acks[0].status).toBe('accepted');
    expect(auditCalls).toEqual([]);
    expect(store.layerSaves).toHaveLength(1);
  });

  it('never asks the resolver about an override capability', async () => {
    const { ctx, acks } = buildCtx();
    await savePipelinesHandler(ctx, makeCmd(CUSTOM));
    expect(acks[0].status).toBe('accepted');
    expect(mocks.state.asked).not.toContain('pipelineOverrides');
    expect(mocks.state.asked).not.toContain('workflowOverrides');
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
