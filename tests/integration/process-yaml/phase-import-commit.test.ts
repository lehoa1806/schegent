// Feature 084 T041 — the import commit, across both host commands.
//
// Covers QS-34 (all-or-nothing), QS-35 (the write is targeted), and QS-36
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
//
// Feature 099 (T496f, FR-042) — the installation is the catalog store rather than
// a user/workspace settings pair, and there is one catalog per kind. QS-34 and
// QS-36 are unchanged claims against the new write port. QS-35 asked which of two
// layers an import landed in; with one layer that question has no content, so the
// case carries the property one axis over — see its own note.

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

import { resolvePhaseCatalog } from '../../../src/config/process-catalog';
import { CMD_PREFLIGHT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ImportPlan,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult
} from '../../../src/contracts/sidebar-ipc';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { handler as saveHandler } from '../../../src/ui/sidebar/commands/cmd-save-phases';
import { CMD_SAVE_PHASES } from '../../../src/ui/sidebar/messages';
import type { SavePhasesCommand } from '../../../src/ui/sidebar/messages';
import { FakeCatalogStore } from '../../fixtures/fake-catalog-store';

/** A Pipeline and a Workflow row, so a Phase write has neighbours it could clobber. */
const NEIGHBOUR_PIPELINE = Object.freeze({
  id: 'held-pipeline',
  name: 'Held Pipeline',
  version: 1,
  phases: [{ phaseId: 'held' }]
});
const NEIGHBOUR_WORKFLOW = Object.freeze({
  id: 'held-workflow',
  name: 'Held Workflow',
  version: 1,
  nodes: []
});

/** The one catalog, mutated in place by an accepted commit. */
function installation(phases: readonly unknown[] = []): FakeCatalogStore {
  return new FakeCatalogStore({
    phases,
    pipelines: [NEIGHBOUR_PIPELINE],
    workflows: [NEIGHBOUR_WORKFLOW]
  });
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

/** The row another window lands between the preflight and the confirm. */
const LANDED_FIRST = Object.freeze({
  id: 'landed-first',
  name: 'Landed First',
  version: 1,
  instruction: 'First.'
});

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

interface PreflightRun {
  readonly result: PreflightProcessYamlResult;
  readonly opens: number;
}

async function preflight(store: FakeCatalogStore, text: string): Promise<PreflightRun> {
  const acks: CommandAckMessage[] = [];
  let opens = 0;
  const ctx = {
    deps: {
      readPhaseConfig: () => ({
        rows: store.rowsOf('phase'),
        revision: store.revisionOf('phase')
      }),
      catalogStore: store,
      refreshCatalog: async () => undefined,
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
    payload: {}
  };
  await preflightHandler(ctx, command);
  expect(acks).toHaveLength(1);
  return { result: acks[0]!.result as PreflightProcessYamlResult, opens };
}

/** The plan a document is expected to produce, or a failure if it did not. */
async function planFor(store: FakeCatalogStore, text: string): Promise<ImportPlan> {
  const { result } = await preflight(store, text);
  expect(result.outcome).toBe('planned');
  if (result.outcome !== 'planned') throw new Error('unreachable');
  return result.plan;
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

/**
 * The request the webview builds from a plan, per contracts "Commit": the catalog
 * as held plus the declared definition, the plan's revision, and the `import`
 * intent naming the added identity.
 */
function commitCommand(plan: ImportPlan, layer: readonly unknown[]): SavePhasesCommand {
  const row = plan.rows.find(
    (candidate) => candidate.outcome === 'import' && candidate.resourceKind === 'phase'
  );
  expect(row?.outcome).toBe('import');
  if (row?.outcome !== 'import' || row.resourceKind !== 'phase') {
    throw new Error('unreachable');
  }
  const { phaseId, ...declared } = row.definition;
  return {
    type: CMD_SAVE_PHASES,
    correlationId: 'import-commit-1',
    payload: {
      expectedRevision: plan.computedAgainstRevision,
      mutation: { kind: 'import', phaseId },
      phases: [...layer, { id: phaseId, ...declared }]
    }
  };
}

interface CommitRun {
  readonly ack: CommandAckMessage;
  readonly writes: number;
}

async function commit(store: FakeCatalogStore, command: SavePhasesCommand): Promise<CommitRun> {
  const acks: CommandAckMessage[] = [];
  const savesBefore = store.layerSaves.length;
  const ctx = {
    deps: {
      readPhaseConfig: () => ({
        rows: store.rowsOf('phase'),
        revision: store.revisionOf('phase')
      }),
      catalogStore: store,
      refreshCatalog: async () => undefined,
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
  return { ack: acks[0]!, writes: store.layerSaves.length - savesBefore };
}

function resolved(store: FakeCatalogStore) {
  return resolvePhaseCatalog({
    rows: store.rowsOf('phase'),
    revision: store.revisionOf('phase')
  });
}

/** The catalog exactly as stored, for a byte-for-byte comparison. */
function snapshot(store: FakeCatalogStore): string {
  return JSON.stringify(store.rowsOf('phase'));
}

beforeEach(() => capabilities.clear());

describe('Feature 084 QS-34 — a commit that cannot persist changes nothing', () => {
  it('leaves the catalog byte-for-byte unchanged and its revision unmoved on a stale revision', async () => {
    const store = installation([HELD_ROW]);
    const plan = await planFor(store, IMPORTED_DOCUMENT);

    // Someone else writes the catalog between the preflight and the confirm, so
    // the revision the plan was computed against no longer describes it.
    const interleaved = await store.saveLayer({
      kind: 'phase',
      expectedRevision: store.revisionOf('phase'),
      definitions: [HELD_ROW, LANDED_FIRST].map((row) => ({ id: row.id, body: row }))
    });
    expect(interleaved.outcome).toBe('saved');
    const before = snapshot(store);
    const revisionBefore = store.revisionOf('phase');

    const { ack, writes } = await commit(store, commitCommand(plan, [HELD_ROW]));

    expect(ack).toMatchObject({ status: 'rejected', reason: 'stale-catalog' });
    expect(writes).toBe(0);
    expect(snapshot(store)).toBe(before);
    expect(store.revisionOf('phase')).toBe(revisionBefore);
    expect(resolved(store).effective.some((def) => def.phaseId === 'brought-in')).toBe(false);
  });

  it('leaves the catalog byte-for-byte unchanged when the write itself fails (FR-043, SC-017)', async () => {
    const store = installation([HELD_ROW]);
    const plan = await planFor(store, IMPORTED_DOCUMENT);
    const before = snapshot(store);
    const revisionBefore = store.revisionOf('phase');

    // Feature 099 — the write that fails is the store's, not a settings write, so
    // the failure arrives as the store's own refusal rather than a thrown EACCES.
    store.nextLayerVerdict = { outcome: 'refused', reason: 'not-writable', id: null };
    const { ack } = await commit(store, commitCommand(plan, [HELD_ROW]));

    // FR-044a — the save is one all-or-nothing write, so a failure cannot leave
    // the imported row half-applied, and it is not reported as an import.
    expect(ack).toMatchObject({ status: 'rejected', reason: 'persistence-failed' });
    expect(ack.result).toMatchObject({ storeRefusal: 'not-writable' });
    expect(snapshot(store)).toBe(before);
    expect(store.revisionOf('phase')).toBe(revisionBefore);
    expect(resolved(store).records.some((record) => record.phaseId === 'brought-in')).toBe(false);
  });

  it('leaves the catalog unchanged when the phases capability is denied (FR-040)', async () => {
    capabilities.set('phases', false);
    const store = installation([HELD_ROW]);
    const plan = await planFor(store, IMPORTED_DOCUMENT);
    const before = snapshot(store);

    const { ack, writes } = await commit(store, commitCommand(plan, [HELD_ROW]));

    expect(ack.status).toBe('rejected');
    expect(writes).toBe(0);
    expect(snapshot(store)).toBe(before);
  });
});

// Feature 084 QS-35 asserted that an import landed in the scope the operator
// chose and that the OTHER writable layer was untouched. Feature 099 (FR-042)
// deletes the layer tier, so "which layer" is no longer a question the operator
// answers. The property that mattered — a save reaches exactly the catalog it
// named and nothing else — survives one axis over, on the three catalog KINDS: a
// Phase import must not touch the Pipeline or Workflow catalog. FR-046's other
// half, that a document may not name an origin at all, is unchanged and stronger:
// `scope` is now not a key anywhere in the model.
describe('Feature 084 QS-35 — the write reaches the catalog it named, and no other (FR-046)', () => {
  it('resolves an imported Phase in the Phase catalog and leaves the other kinds alone', async () => {
    const store = installation();
    const plan = await planFor(store, IMPORTED_DOCUMENT);
    const { ack } = await commit(store, commitCommand(plan, []));

    expect(ack).toMatchObject({ status: 'accepted', result: { mutation: 'import' } });
    expect(ack.result).toMatchObject({ revision: store.revisionOf('phase') });
    const record = resolved(store).records.find((row) => row.phaseId === 'brought-in');
    expect(record).toMatchObject({ status: 'effective' });

    // The catalogs the operator did not import into are untouched — not merely
    // equal by luck, but never written at all.
    expect(store.layerSaves.map((request) => request.kind)).toEqual(['phase']);
    expect(store.rowsOf('pipeline')).toEqual([NEIGHBOUR_PIPELINE]);
    expect(store.rowsOf('workflow')).toEqual([NEIGHBOUR_WORKFLOW]);
    expect(store.revisionOf('pipeline')).toBe('rev-pipeline-0');
    expect(store.revisionOf('workflow')).toBe('rev-workflow-0');
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

    expect(plan.counts).toEqual({ import: 0, skip: 0, invalid: 1, blocked: 0 });
    const [row] = plan.rows;
    expect(row?.outcome).toBe('invalid');
    if (row?.outcome !== 'invalid') return;
    expect(row.defects.map((defect) => defect.field)).toContain('scope');
  });
});

describe('Feature 084 QS-36 — `version` is preserved as authored (FR-046a)', () => {
  it('stores and resolves the version the document declared, not a fresh 1', async () => {
    const store = installation([HELD_ROW]);
    const plan = await planFor(store, IMPORTED_DOCUMENT);

    const { ack } = await commit(store, commitCommand(plan, [HELD_ROW]));
    expect(ack.status).toBe('accepted');

    expect(store.rowsOf('phase')).toEqual([
      HELD_ROW,
      { id: 'brought-in', name: 'Brought In', version: 9, instruction: 'Do the thing.' }
    ]);
    const definition = resolved(store).effective.find((def) => def.phaseId === 'brought-in');
    expect(definition?.version).toBe(9);
    // The rest of the catalog keeps the version the host currently holds.
    expect(resolved(store).effective.find((def) => def.phaseId === 'held')?.version).toBe(4);
  });
});
