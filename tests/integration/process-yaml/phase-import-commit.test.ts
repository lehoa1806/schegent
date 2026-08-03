// Feature 084 T041 — the import commit, across both host commands.
//
// Covers QS-34 (all-or-nothing), QS-35 (origin is the chosen scope), and QS-36
// (`version` preserved as authored). The preflight handler produces the plan and
// the shipped `CMD_SAVE_PHASES` handler applies it, against one mutable
// installation both read, so a commit here is observable to a later resolve
// exactly as it would be in a real window.
//
// The plan-to-request translation is the webview's, and is pinned as pure logic
// in `webview-ui/src/components/__tests__/process-import-state.test.ts`. It is
// mirrored below rather than imported because the webview is a separate program;
// what this file asserts is that the two HOST commands compose over the shape
// the contract specifies.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => new Map<string, boolean>());
vi.mock('../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (name: string) => capabilities.get(name) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));
vi.mock('../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: '/tmp/import-commit' },
    name: 'import-commit',
    index: 0
  })
}));

import { BUILT_IN_PHASES } from '../../../src/config/pipeline-config';
import { phaseLayerRevision, resolvePhaseCatalog } from '../../../src/config/process-catalog';
import { CMD_PREFLIGHT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ImportPlan,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult
} from '../../../src/contracts/sidebar-ipc';
import type { WritablePhaseDefinitionScope } from '../../../src/contracts/process-definitions';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { handler as saveHandler } from '../../../src/ui/sidebar/commands/cmd-save-phases';
import { CMD_SAVE_PHASES } from '../../../src/ui/sidebar/messages';
import type { SavePhasesCommand } from '../../../src/ui/sidebar/messages';

/** The two writable layers, mutated in place by an accepted commit. */
interface Installation {
  user: readonly unknown[];
  workspace: readonly unknown[];
}

function installation(seed: Partial<Installation> = {}): Installation {
  return { user: seed.user ?? [], workspace: seed.workspace ?? [] };
}

function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

function document(body: readonly string[]): string {
  return ['apiVersion: schegent/v1', 'kind: Phase', ...body, ''].join('\n');
}

/** Every field the commit must carry through unchanged, `version` included. */
const IMPORTED_DOCUMENT = document([
  'metadata:',
  '  phaseId: brought-in',
  '  name: Brought In',
  '  version: 9',
  'spec:',
  '  instruction: Do the thing.'
]);

const HELD_ROW = Object.freeze({ id: 'held', name: 'Held', version: 4, instruction: 'Hold.' });

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

interface PreflightRun {
  readonly result: PreflightProcessYamlResult;
  readonly opens: number;
}

async function preflight(inst: Installation, text: string): Promise<PreflightRun> {
  const acks: CommandAckMessage[] = [];
  let opens = 0;
  const ctx = {
    deps: {
      readPhaseConfig: () => ({ user: inst.user, workspace: inst.workspace }),
      openProcessYamlDocument: async () => {
        opens += 1;
        return { outcome: 'read' as const, bytes: bytes(text) };
      },
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
    correlationId: 'import-commit-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const command: PreflightProcessYamlCommand = {
    type: CMD_PREFLIGHT_PROCESS_YAML,
    correlationId: 'import-commit-1',
    payload: { resourceKind: 'phase' }
  };
  await preflightHandler(ctx, command);
  expect(acks).toHaveLength(1);
  return { result: acks[0]!.result as PreflightProcessYamlResult, opens };
}

/** The plan a document is expected to produce, or a failure if it did not. */
async function planFor(inst: Installation, text: string): Promise<ImportPlan> {
  const { result } = await preflight(inst, text);
  expect(result.outcome).toBe('planned');
  if (result.outcome !== 'planned') throw new Error('unreachable');
  return result.plan;
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

/**
 * The request the webview builds from a plan, per contracts "Commit": the layer
 * as held plus the declared definition, the plan's revision for the CHOSEN
 * scope, and the `import` intent naming the added identity.
 */
function commitCommand(
  plan: ImportPlan,
  scope: WritablePhaseDefinitionScope,
  layer: readonly unknown[]
): SavePhasesCommand {
  const row = plan.rows.find((candidate) => candidate.outcome === 'import');
  expect(row?.outcome).toBe('import');
  if (row?.outcome !== 'import') throw new Error('unreachable');
  const { phaseId, ...declared } = row.definition;
  return {
    type: CMD_SAVE_PHASES,
    correlationId: 'import-commit-1',
    payload: {
      scope,
      expectedRevision: plan.computedAgainstRevision[scope],
      mutation: { kind: 'import', phaseId },
      phases: [...layer, { id: phaseId, ...declared }]
    }
  };
}

interface CommitRun {
  readonly ack: CommandAckMessage;
  readonly writes: number;
}

async function commit(
  inst: Installation,
  command: SavePhasesCommand,
  opts: { readonly writeThrows?: Error } = {}
): Promise<CommitRun> {
  const acks: CommandAckMessage[] = [];
  let writes = 0;
  const ctx = {
    deps: {
      readPhaseConfig: () => ({ user: inst.user, workspace: inst.workspace }),
      updateConfig: async (key: string, value: unknown, scope: WritablePhaseDefinitionScope) => {
        writes += 1;
        if (opts.writeThrows) throw opts.writeThrows;
        expect(key).toBe('phases');
        inst[scope] = value as readonly unknown[];
      },
      readConfig: () => undefined,
      executeCommand: vi.fn(),
      queueRemover: { remove: vi.fn() },
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
    correlationId: 'import-commit-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  await saveHandler(ctx, command);
  expect(acks).toHaveLength(1);
  return { ack: acks[0]!, writes };
}

function resolved(inst: Installation) {
  return resolvePhaseCatalog({
    builtIn: BUILT_IN_PHASES,
    user: inst.user,
    workspace: inst.workspace
  });
}

/** The layer exactly as stored, for a byte-for-byte comparison. */
function snapshot(inst: Installation, scope: WritablePhaseDefinitionScope): string {
  return JSON.stringify(inst[scope]);
}

beforeEach(() => capabilities.clear());

describe('Feature 084 QS-34 — a commit that cannot persist changes nothing', () => {
  it('leaves the layer byte-for-byte unchanged and its revision unmoved on a stale revision', async () => {
    const inst = installation({ workspace: [HELD_ROW] });
    const plan = await planFor(inst, IMPORTED_DOCUMENT);

    // Someone else writes the target layer between the preflight and the confirm,
    // so the revision the plan was computed against no longer describes it.
    inst.workspace = [HELD_ROW, { id: 'landed-first', name: 'Landed First', version: 1, instruction: 'First.' }];
    const before = snapshot(inst, 'workspace');
    const revisionBefore = phaseLayerRevision(inst.workspace);

    const { ack, writes } = await commit(inst, commitCommand(plan, 'workspace', [HELD_ROW]));

    expect(ack).toMatchObject({ status: 'rejected', reason: 'stale-catalog' });
    expect(writes).toBe(0);
    expect(snapshot(inst, 'workspace')).toBe(before);
    expect(phaseLayerRevision(inst.workspace)).toBe(revisionBefore);
    expect(resolved(inst).effective.some((def) => def.phaseId === 'brought-in')).toBe(false);
  });

  it('leaves the layer byte-for-byte unchanged when the write itself fails (FR-043, SC-017)', async () => {
    const inst = installation({ workspace: [HELD_ROW] });
    const plan = await planFor(inst, IMPORTED_DOCUMENT);
    const before = snapshot(inst, 'workspace');
    const revisionBefore = phaseLayerRevision(inst.workspace);

    const { ack } = await commit(inst, commitCommand(plan, 'workspace', [HELD_ROW]), {
      writeThrows: new Error('EACCES: settings.json is read-only')
    });

    // FR-044a — the save is one all-or-nothing write, so a failure cannot leave
    // the imported row half-applied, and it is not reported as an import.
    expect(ack).toMatchObject({ status: 'rejected', reason: 'persistence-failed' });
    expect(snapshot(inst, 'workspace')).toBe(before);
    expect(phaseLayerRevision(inst.workspace)).toBe(revisionBefore);
    expect(resolved(inst).records.some((record) => record.phaseId === 'brought-in')).toBe(false);
  });

  it('leaves the layer unchanged when the phases capability is denied (FR-040)', async () => {
    capabilities.set('phases', false);
    const inst = installation({ workspace: [HELD_ROW] });
    const plan = await planFor(inst, IMPORTED_DOCUMENT);
    const before = snapshot(inst, 'workspace');

    const { ack, writes } = await commit(inst, commitCommand(plan, 'workspace', [HELD_ROW]));

    expect(ack.status).toBe('rejected');
    expect(writes).toBe(0);
    expect(snapshot(inst, 'workspace')).toBe(before);
  });
});

describe('Feature 084 QS-35 — the origin is the scope the operator chose (FR-046)', () => {
  it('resolves an imported Phase in the chosen layer, whichever one that is', async () => {
    for (const scope of ['user', 'workspace'] as const) {
      const inst = installation();
      const plan = await planFor(inst, IMPORTED_DOCUMENT);
      const { ack } = await commit(inst, commitCommand(plan, scope, []));

      expect(ack).toMatchObject({ status: 'accepted', result: { scope, mutation: 'import' } });
      const record = resolved(inst).records.find((row) => row.phaseId === 'brought-in');
      expect(record).toMatchObject({ scope, status: 'effective' });
      // The layer the operator did not pick is untouched.
      const other = scope === 'user' ? 'workspace' : 'user';
      expect(inst[other]).toEqual([]);
    }
  });

  it('admits no origin claim in the document at all', async () => {
    // There is no key for a scope, so a document that tries to name one is an
    // unknown-key defect rather than an instruction the commit could honor.
    const claiming = document([
      'metadata:',
      '  phaseId: brought-in',
      '  name: Brought In',
      '  version: 9',
      '  scope: workspace',
      'spec:',
      '  instruction: Do the thing.'
    ]);
    const plan = await planFor(installation(), claiming);

    expect(plan.counts).toEqual({ import: 0, skip: 0, invalid: 1 });
    const [row] = plan.rows;
    expect(row?.outcome).toBe('invalid');
    if (row?.outcome !== 'invalid') return;
    expect(row.defects.map((defect) => defect.field)).toContain('scope');
  });
});

describe('Feature 084 QS-36 — `version` is preserved as authored (FR-046a)', () => {
  it('stores and resolves the version the document declared, not a fresh 1', async () => {
    const inst = installation({ user: [HELD_ROW] });
    const plan = await planFor(inst, IMPORTED_DOCUMENT);

    const { ack } = await commit(inst, commitCommand(plan, 'user', [HELD_ROW]));
    expect(ack.status).toBe('accepted');

    expect(inst.user).toEqual([
      HELD_ROW,
      { id: 'brought-in', name: 'Brought In', version: 9, instruction: 'Do the thing.' }
    ]);
    const definition = resolved(inst).effective.find((def) => def.phaseId === 'brought-in');
    expect(definition?.version).toBe(9);
    // The rest of the layer keeps the version the host currently holds.
    expect(resolved(inst).effective.find((def) => def.phaseId === 'held')?.version).toBe(4);
  });
});
