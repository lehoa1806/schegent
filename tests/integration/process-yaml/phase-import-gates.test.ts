// Feature 084 T057..T062 — the gates the import commit passes through, and the
// order they run in.
//
// Covers QS-28 through QS-33. The commit reuses the shipped `CMD_SAVE_PHASES`,
// so what these tests pin is not new gate code but that an import is subject to
// every gate an authored Phase is, in the same order:
//
//   revision  →  validation  →  mutation intent  →  trust
//
// FR-039 makes that order load-bearing rather than incidental: a stale write by
// an untrusted operator must report staleness. If the trust gate ran first, the
// operator would be told to fix their trust settings and would still be stale
// afterwards.
//
// FR-041's gate is the router's `MUTATING_COMMANDS` membership, one level above
// the handler, so the secondary-window test drives the router rather than the
// handler.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => new Map<string, boolean>());
const resolvedScopes = vi.hoisted(() => new Map<string, string>());
vi.mock('../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (name: string) => capabilities.get(name) ?? true,
  getResolvedScope: (name: string) => resolvedScopes.get(name) ?? 'workspace'
}));
vi.mock('../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: '/tmp/import-gates' },
    name: 'import-gates',
    index: 0
  })
}));

import { SanitizedLogger } from '../../../src/lib/logger';
import { phaseLayerRevision } from '../../../src/config/process-catalog';
import { CMD_PREFLIGHT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ImportPlan,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult
} from '../../../src/contracts/sidebar-ipc';
import type { WritablePhaseDefinitionScope } from '../../../src/contracts/process-definitions';
import { MessageRouter } from '../../../src/ui/sidebar/message-router';
import type { RouterDeps } from '../../../src/ui/sidebar/message-router';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { handler as saveHandler } from '../../../src/ui/sidebar/commands/cmd-save-phases';
import { CMD_SAVE_PHASES } from '../../../src/ui/sidebar/messages';
import type { SavePhasesCommand } from '../../../src/ui/sidebar/messages';

interface AuditEntry {
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
}

interface Layers {
  user: readonly unknown[];
  workspace: readonly unknown[];
}

function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

function document(body: readonly string[]): string {
  return ['apiVersion: schegent/v1', 'kind: Phase', ...body, ''].join('\n');
}

const PLAIN_DOCUMENT = document([
  'metadata:',
  '  phaseId: brought-in',
  '  name: Brought In',
  '  version: 2',
  'spec:',
  '  instruction: Do the thing.'
]);

/** The same Phase, declaring a retry condition, so the row-level gate applies. */
const RETRYING_DOCUMENT = document([
  'metadata:',
  '  phaseId: brought-in',
  '  name: Brought In',
  '  version: 2',
  'spec:',
  '  instruction: Do the thing.',
  '  retryCondition: open_questions > 0'
]);

const HELD_ROW = Object.freeze({ id: 'held', name: 'Held', version: 4, instruction: 'Hold.' });

// ---------------------------------------------------------------------------
// Preflight and commit
// ---------------------------------------------------------------------------

async function planFor(text: string, layers: Layers): Promise<ImportPlan> {
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      readPhaseConfig: () => ({ user: layers.user, workspace: layers.workspace }),
      openProcessYamlDocument: async () => ({ outcome: 'read' as const, bytes: bytes(text) }),
      audit: { append: async () => undefined },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'gates-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const command: PreflightProcessYamlCommand = {
    type: CMD_PREFLIGHT_PROCESS_YAML,
    correlationId: 'gates-1',
    payload: { resourceKind: 'phase' }
  };
  await preflightHandler(ctx, command);
  const result = acks[0]!.result as PreflightProcessYamlResult;
  expect(result.outcome).toBe('planned');
  if (result.outcome !== 'planned') throw new Error('unreachable');
  return result.plan;
}

/**
 * The request the webview builds from a plan. Mirrors `buildImportSave` in
 * `webview-ui/src/components/ProcessImport/process-import-state.ts`, which is
 * pinned on its own side; what these tests need from it is a realistic payload
 * to drive the handler with.
 */
function commitCommand(
  plan: ImportPlan,
  scope: WritablePhaseDefinitionScope,
  layer: readonly unknown[],
  overrides: { readonly expectedRevision?: string } = {}
): SavePhasesCommand {
  const row = plan.rows.find((candidate) => candidate.outcome === 'import');
  expect(row?.outcome).toBe('import');
  if (row?.outcome !== 'import') throw new Error('unreachable');
  const { phaseId, ...declared } = row.definition;
  return {
    type: CMD_SAVE_PHASES,
    correlationId: 'gates-1',
    payload: {
      scope,
      expectedRevision: overrides.expectedRevision ?? plan.computedAgainstRevision[scope],
      mutation: { kind: 'import', phaseId },
      phases: [...layer, { id: phaseId, ...declared }]
    }
  };
}

interface CommitRun {
  readonly ack: CommandAckMessage;
  readonly audits: readonly AuditEntry[];
  readonly writes: number;
}

async function commit(command: SavePhasesCommand, layers: Layers): Promise<CommitRun> {
  const acks: CommandAckMessage[] = [];
  const audits: AuditEntry[] = [];
  let writes = 0;
  const ctx = {
    deps: {
      readPhaseConfig: () => ({ user: layers.user, workspace: layers.workspace }),
      updateConfig: async (key: string, value: unknown, scope: WritablePhaseDefinitionScope) => {
        expect(key).toBe('phases');
        writes += 1;
        layers[scope] = value as readonly unknown[];
      },
      readConfig: () => undefined,
      executeCommand: vi.fn(),
      queueRemover: { remove: vi.fn() },
      audit: {
        append: async (entry: AuditEntry) => {
          audits.push(entry);
          return undefined;
        }
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'gates-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  await saveHandler(ctx, command);
  expect(acks).toHaveLength(1);
  return { ack: acks[0]!, audits, writes };
}

beforeEach(() => {
  capabilities.clear();
  resolvedScopes.clear();
});

// ---------------------------------------------------------------------------
// T057 — the revision gate, and its position relative to the trust gate
// ---------------------------------------------------------------------------

describe('Feature 084 — the revision gate (T057, QS-28, FR-038, SC-011)', () => {
  it('refuses a superseded revision, leaves the layer untouched, and says to recompute', async () => {
    const layers: Layers = { user: [], workspace: [] };
    const plan = await planFor(PLAIN_DOCUMENT, layers);

    // The operator authored something else in the target layer between the
    // preflight and the confirmation.
    layers.user = [HELD_ROW];
    const revisionBefore = phaseLayerRevision(layers.user);

    const run = await commit(commitCommand(plan, 'user', []), layers);

    expect(run.ack.status).toBe('rejected');
    expect(run.ack.reason).toBe('stale-catalog');
    expect(run.writes).toBe(0);
    expect(layers.user).toEqual([HELD_ROW]);
    expect(phaseLayerRevision(layers.user)).toBe(revisionBefore);

    // The operator is told what to do about it, and against which revision.
    const result = run.ack.result as {
      currentRevision: string;
      current: { legalActions: readonly string[] };
    };
    expect(result.currentRevision).toBe(revisionBefore);
    expect(result.current.legalActions).toContain('reapply');
  });

  it('is scoped per layer — a change to the other layer does not stale the write', async () => {
    const layers: Layers = { user: [], workspace: [] };
    const plan = await planFor(PLAIN_DOCUMENT, layers);
    layers.workspace = [HELD_ROW];

    const run = await commit(commitCommand(plan, 'user', []), layers);
    expect(run.ack.status).toBe('accepted');
    expect(run.writes).toBe(1);
  });

  it('reports staleness, not untrustedness, when both gates would fire (T057, QS-29, FR-039)', async () => {
    capabilities.set('phases', false);
    const layers: Layers = { user: [], workspace: [] };
    const plan = await planFor(PLAIN_DOCUMENT, layers);
    layers.user = [HELD_ROW];

    const run = await commit(commitCommand(plan, 'user', []), layers);

    // Both conditions hold. The revision gate is the one that answers.
    expect(run.ack.reason).toBe('stale-catalog');
    expect(run.ack.reason).not.toBe('trust-denied');
    expect(run.writes).toBe(0);
    // And no denial was recorded, because the trust gate was never reached —
    // the log agrees with the answer the operator got.
    expect(run.audits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T058 — the `phases` capability
// ---------------------------------------------------------------------------

describe('Feature 084 — the phases capability (T058, QS-30, FR-040)', () => {
  it('writes nothing and reports a capability denial', async () => {
    capabilities.set('phases', false);
    const layers: Layers = { user: [], workspace: [] };
    const plan = await planFor(PLAIN_DOCUMENT, layers);

    const run = await commit(commitCommand(plan, 'user', []), layers);

    expect(run.ack.status).toBe('rejected');
    expect(run.ack.reason).toBe('trust-denied');
    expect(run.writes).toBe(0);
    expect(layers.user).toEqual([]);

    // The reason names the capability, so the operator can act on it.
    const err = run.ack.result as { kind: string; capability: string; reason: string };
    expect(err.kind).toBe('trust-denied');
    expect(err.capability).toBe('phases');
    expect(err.reason.length).toBeGreaterThan(0);
  });

  it('is the same capability authoring a Phase requires — an import is not a side door', async () => {
    // Allowed: the identical commit lands. Nothing about the import path grants
    // a write the authoring path would not.
    capabilities.set('phases', true);
    const layers: Layers = { user: [], workspace: [] };
    const plan = await planFor(PLAIN_DOCUMENT, layers);
    const run = await commit(commitCommand(plan, 'user', []), layers);
    expect(run.ack.status).toBe('accepted');
    expect(layers.user).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// T059 / T060 — the retry-condition capability
// ---------------------------------------------------------------------------

describe('Feature 084 — the retryConditions capability (T059, QS-31, FR-012a, SC-018)', () => {
  it('refuses a document declaring a retryCondition, naming the capability', async () => {
    capabilities.set('retryConditions', false);
    const layers: Layers = { user: [], workspace: [] };
    const plan = await planFor(RETRYING_DOCUMENT, layers);

    const run = await commit(commitCommand(plan, 'user', []), layers);

    expect(run.ack.reason).toBe('trust-denied');
    const err = run.ack.result as { capability: string; rowIndex?: number };
    expect(err.capability).toBe('retryConditions');
    // The row-granular gate names which row, so a multi-row layer is actionable.
    expect(err.rowIndex).toBe(0);
    expect(run.writes).toBe(0);
  });

  it('never stores the Phase with the field stripped', async () => {
    capabilities.set('retryConditions', false);
    const layers: Layers = { user: [], workspace: [] };
    const plan = await planFor(RETRYING_DOCUMENT, layers);

    await commit(commitCommand(plan, 'user', []), layers);

    // SC-018: the refusal is total. A Phase that quietly lost its retry
    // condition would run differently from the one the operator imported.
    expect(layers.user).toEqual([]);
    expect(JSON.stringify(layers)).not.toContain('brought-in');
  });

  it('lands whole, retryCondition included, once the capability is allowed', async () => {
    capabilities.set('retryConditions', true);
    const layers: Layers = { user: [], workspace: [] };
    const plan = await planFor(RETRYING_DOCUMENT, layers);

    const run = await commit(commitCommand(plan, 'user', []), layers);

    expect(run.ack.status).toBe('accepted');
    expect(layers.user).toEqual([
      {
        id: 'brought-in',
        name: 'Brought In',
        version: 2,
        instruction: 'Do the thing.',
        retryCondition: 'open_questions > 0'
      }
    ]);
  });

  it('re-reads the capability at commit rather than trusting the preflight (T060, QS-32)', async () => {
    // Allowed during the preflight, so the plan is built with the flag clear of
    // any denial, then denied before the operator confirms.
    capabilities.set('retryConditions', true);
    const layers: Layers = { user: [], workspace: [] };
    const plan = await planFor(RETRYING_DOCUMENT, layers);

    capabilities.set('retryConditions', false);
    const run = await commit(commitCommand(plan, 'user', []), layers);

    expect(run.ack.reason).toBe('trust-denied');
    expect((run.ack.result as { capability: string }).capability).toBe('retryConditions');
    expect(run.writes).toBe(0);
  });

  it('does not gate a Phase that declares no retryCondition', async () => {
    capabilities.set('retryConditions', false);
    const layers: Layers = { user: [], workspace: [] };
    const plan = await planFor(PLAIN_DOCUMENT, layers);

    const run = await commit(commitCommand(plan, 'user', []), layers);
    expect(run.ack.status).toBe('accepted');
  });
});

// ---------------------------------------------------------------------------
// T062 — the advisory flag
// ---------------------------------------------------------------------------

describe('Feature 084 — requiresRetryConditionCapability is advisory (T062, FR-012a)', () => {
  function flagFor(plan: ImportPlan): boolean {
    const row = plan.rows[0]!;
    expect(row.outcome).toBe('import');
    if (row.outcome !== 'import') throw new Error('unreachable');
    return row.requiresRetryConditionCapability;
  }

  it('is set when the document declares a retryCondition and clear when it does not', async () => {
    const layers: Layers = { user: [], workspace: [] };
    expect(flagFor(await planFor(RETRYING_DOCUMENT, layers))).toBe(true);
    expect(flagFor(await planFor(PLAIN_DOCUMENT, layers))).toBe(false);
  });

  it('does not answer the gate — it reports the document, not the capability', async () => {
    // The flag is a property of the DOCUMENT, so it reads the same whether the
    // capability is allowed or denied. A UI that warns from it is warning about
    // what the document needs, not about what the host will permit.
    const layers: Layers = { user: [], workspace: [] };
    capabilities.set('retryConditions', true);
    const allowed = flagFor(await planFor(RETRYING_DOCUMENT, layers));
    capabilities.set('retryConditions', false);
    const denied = flagFor(await planFor(RETRYING_DOCUMENT, layers));
    expect(allowed).toBe(denied);
    expect(allowed).toBe(true);
  });

  it('is not what the commit consults — a commit the flag never described is still gated', async () => {
    // A commit assembled without any plan at all, as a compromised or
    // out-of-date webview could send. The gate reads the row's own
    // `retryCondition`, so there is nothing here for a forged flag to bypass.
    capabilities.set('retryConditions', false);
    const layers: Layers = { user: [], workspace: [] };
    const forged: SavePhasesCommand = {
      type: CMD_SAVE_PHASES,
      correlationId: 'gates-1',
      payload: {
        scope: 'user',
        expectedRevision: phaseLayerRevision([]),
        mutation: { kind: 'import', phaseId: 'brought-in' },
        phases: [
          {
            id: 'brought-in',
            name: 'Brought In',
            version: 2,
            instruction: 'Do the thing.',
            retryCondition: 'open_questions > 0'
          }
        ]
      }
    };

    const run = await commit(forged, layers);
    expect(run.ack.reason).toBe('trust-denied');
    expect((run.ack.result as { capability: string }).capability).toBe('retryConditions');
    expect(run.writes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T061 — the primary-window gate
// ---------------------------------------------------------------------------

describe('Feature 084 — a secondary window refuses the write (T061, QS-33, FR-041)', () => {
  function routerDeps(overrides: Partial<RouterDeps> = {}): RouterDeps {
    return {
      executeCommand: vi.fn(
        async () => undefined as unknown
      ) as unknown as RouterDeps['executeCommand'],
      queueRemover: { remove: vi.fn(async () => true) },
      updateConfig: vi.fn(async () => undefined),
      readPhaseConfig: () => ({ user: [], workspace: [] }),
      isPrimary: () => false,
      isTrusted: () => true,
      logger: new SanitizedLogger(),
      ...overrides
    };
  }

  it('refuses the import commit with a stated reason and writes nothing', async () => {
    const updateConfig = vi.fn(async () => undefined);
    const notifyWarning = vi.fn();
    const router = new MessageRouter(routerDeps({ updateConfig, notifyWarning }));
    const posted: CommandAckMessage[] = [];

    await router.dispatch(
      {
        type: CMD_SAVE_PHASES,
        correlationId: 'gates-secondary',
        payload: {
          scope: 'user',
          expectedRevision: phaseLayerRevision([]),
          mutation: { kind: 'import', phaseId: 'brought-in' },
          phases: [{ id: 'brought-in', name: 'Brought In', version: 2, instruction: 'Do.' }]
        }
      },
      async (msg: CommandAckMessage) => {
        posted.push(msg);
        return true;
      }
    );

    expect(posted).toHaveLength(1);
    expect(posted[0]!.status).toBe('rejected');
    expect(posted[0]!.reason).toBe('secondary-window-readonly');
    expect(updateConfig).not.toHaveBeenCalled();
    // FR-041 requires a STATED reason, and the ack reason alone is not what an
    // operator sees; the router also surfaces it.
    expect(notifyWarning).toHaveBeenCalledTimes(1);
    expect(String(notifyWarning.mock.calls[0]![0])).toContain('window');
  });

  it('lets the same command through on the primary window, so the gate is the window', async () => {
    const router = new MessageRouter(routerDeps({ isPrimary: () => true }));
    const posted: CommandAckMessage[] = [];

    await router.dispatch(
      {
        type: CMD_SAVE_PHASES,
        correlationId: 'gates-primary',
        payload: {
          scope: 'user',
          expectedRevision: phaseLayerRevision([]),
          mutation: { kind: 'import', phaseId: 'brought-in' },
          phases: [{ id: 'brought-in', name: 'Brought In', version: 2, instruction: 'Do.' }]
        }
      },
      async (msg: CommandAckMessage) => {
        posted.push(msg);
        return true;
      }
    );

    expect(posted).toHaveLength(1);
    // Accepted, not merely "rejected for some other reason" — otherwise this
    // would pass even if the command were unreachable for an unrelated cause,
    // and would not establish that the window is what the gate reads.
    expect(posted[0]!.status).toBe('accepted');
  });
});
