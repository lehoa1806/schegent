// Feature 085 T043/T044 — the confirmed package write, across both host commands.
//
// A package can write two catalogs, and two catalog writes cannot be one atomic
// operation (FR-042). Everything below follows from taking that seriously rather
// than pretending otherwise:
//
//   ordered      — Phases first, then the Pipeline (FR-038), so a Pipeline is
//                  never persisted ahead of a dependency this same import
//                  supplies. The order is checked BEHAVIORALLY, not just by the
//                  sequence of spy calls: the Pipeline save resolves its
//                  references against the effective Phase catalog, so reversing
//                  the two writes turns an accepted save into an
//                  `unknown-phase` rejection.
//   independent  — each write is reported on its own (FR-042), so a failed
//                  second write reports exactly what landed (FR-042a).
//   irreversible — a failed second write triggers NO compensating delete
//                  (FR-042c). Re-running the same document is the recovery
//                  (FR-042b), and it is self-healing because the landed Phases
//                  then plan `skip` and resolve the Pipeline's references.
//
// Feature 099 (T496f, FR-042) — "two catalogs" used to mean two configuration
// keys, each with a user and a workspace layer, and a package write picked one
// scope for both. The scope tier is deleted: there is one catalog per kind, so
// `scope` leaves every payload and the layers a proposal appends to are simply
// the rows the store holds. Every claim below is about the ORDER and the
// INDEPENDENCE of the two writes, and neither was ever a property of the scope.
//
// The plan-to-request translation is the webview's, and is pinned as pure logic
// in `webview-ui/src/components/__tests__/process-import-state.test.ts`. It is
// mirrored below rather than imported — the webview is a separate program —
// exactly as `phase-import-commit.test.ts` mirrors the single-Phase one. What
// this file asserts is that the two HOST commands compose over the shape the
// contract specifies.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const capabilities = vi.hoisted(() => new Map<string, boolean>());
vi.mock('../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (name: string) => capabilities.get(name) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));
vi.mock('../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: '/tmp/package-import' },
    name: 'package-import',
    index: 0
  })
}));

import { resolvePipelineCatalog } from '../../../src/config/pipeline-catalog';
import { resolvePhaseCatalog } from '../../../src/config/process-catalog';
import { CMD_PREFLIGHT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ImportPlan,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult
} from '../../../src/contracts/sidebar-ipc';
import type { PipelineDefinition } from '../../../src/contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { handler as savePhasesHandler } from '../../../src/ui/sidebar/commands/cmd-save-phases';
import { handler as savePipelinesHandler } from '../../../src/ui/sidebar/commands/cmd-save-pipelines';
import { CMD_SAVE_PHASES, CMD_SAVE_PIPELINES } from '../../../src/ui/sidebar/messages';
import type { SavePhasesCommand, SavePipelinesCommand } from '../../../src/ui/sidebar/messages';
import type { CatalogKind } from '../../../src/contracts/catalog-store';
import { FakeCatalogStore } from '../../fixtures/fake-catalog-store';

/** The catalog each write targets, and the order the two occur in. */
type LayerKey = 'phases' | 'pipelines';

const KIND_OF: Readonly<Record<LayerKey, CatalogKind>> = {
  phases: 'phase',
  pipelines: 'pipeline'
};

/** Both writable catalogs, behind the one store a package write goes through. */
interface Installation {
  readonly store: FakeCatalogStore;
}

function installation(seed: {
  readonly phases?: readonly unknown[];
  readonly pipelines?: readonly unknown[];
  readonly workflows?: readonly unknown[];
} = {}): Installation {
  return {
    store: new FakeCatalogStore({
      phases: seed.phases ?? [],
      pipelines: seed.pipelines ?? [],
      workflows: seed.workflows ?? []
    })
  };
}

/** The read seams every handler in this file shares, wired to one store. */
function catalogDeps(store: FakeCatalogStore): Record<string, unknown> {
  return {
    catalogStore: store,
    refreshCatalog: async () => undefined,
    readPhaseConfig: () => ({ rows: store.rowsOf('phase'), revision: store.revisionOf('phase') }),
    readPipelineConfig: () => ({
      rows: store.rowsOf('pipeline'),
      revision: store.revisionOf('pipeline')
    })
  };
}

/** The rows of both catalogs as the operator's preview saw them, for the proposal. */
interface Held {
  readonly phases: readonly unknown[];
  readonly pipelines: readonly unknown[];
}

function held(inst: Installation): Held {
  return { phases: inst.store.rowsOf('phase'), pipelines: inst.store.rowsOf('pipeline') };
}

/**
 * Someone else writes a catalog between the preview and the confirm.
 *
 * Feature 099 (T496f) — the cases that need this used to assign a layer array in
 * place. A revision is the store's now, not a hash of an array, so the way to
 * make a preview stale is to perform the write that moves it.
 */
async function concurrentWrite(
  inst: Installation,
  key: LayerKey,
  rows: readonly Record<string, unknown>[]
): Promise<void> {
  const kind = KIND_OF[key];
  const outcome = await inst.store.saveLayer({
    kind,
    expectedRevision: inst.store.revisionOf(kind),
    definitions: rows.map((row) => ({ id: row.id as string, body: row }))
  });
  expect(outcome.outcome).toBe('saved');
}

const CORRELATION = 'package-import-1';

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    sanitize: (value: string) => value
  };
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function packageDocument(body: readonly string[]): string {
  return ['apiVersion: schegent/v1', 'kind: Pipeline', ...body, ''].join('\n');
}

/**
 * Self-contained: the root's every reference is supplied by the same document.
 * `specify` and `plan` are free ids — the built-ins are all `speckit-` prefixed —
 * so nothing here resolves by accident.
 */
const SELF_CONTAINED = packageDocument([
  'metadata:',
  '  id: ship-it',
  '  name: Ship It',
  '  version: 3',
  'spec:',
  '  phaseIds:',
  '    - specify',
  '    - plan',
  '  inputs:',
  '    - portId: feature-brief',
  '      label: Feature brief',
  '      type: text',
  '      required: true',
  '  bindings:',
  '    - kind: input',
  '      phaseIndex: 0',
  '      inputKey: brief',
  '      source:',
  '        from: pipeline-input',
  '        portId: feature-brief',
  'included:',
  '  phases:',
  '    - metadata:',
  '        phaseId: specify',
  '        name: Specify',
  '        version: 2',
  '      spec:',
  '        instruction: Write the spec.',
  '    - metadata:',
  '        phaseId: plan',
  '        name: Plan',
  '        version: 5',
  '      spec:',
  '        instruction: Write the plan.'
]);

/**
 * The root references a Phase this document does not supply and no layer holds,
 * so the root is `blocked` while the one included Phase stays eligible (FR-039).
 */
const BLOCKED_ROOT = packageDocument([
  'metadata:',
  '  id: ship-it',
  '  name: Ship It',
  '  version: 3',
  'spec:',
  '  phaseIds:',
  '    - specify',
  '    - polish',
  'included:',
  '  phases:',
  '    - metadata:',
  '        phaseId: specify',
  '        name: Specify',
  '        version: 2',
  '      spec:',
  '        instruction: Write the spec.'
]);

const HELD_PHASE = Object.freeze({
  id: 'held',
  name: 'Held',
  version: 4,
  instruction: 'Hold.'
});

const HELD_PIPELINE = Object.freeze({
  // Feature 098 (T080) — the held Pipeline used to name `speckit-specify`, which
  // resolved out of the built-in Phase layer. That layer is empty, so it names the
  // held Phase instead: every installation below that holds this Pipeline holds
  // that Phase in the same scope. The row has to stay valid, because the point of
  // "held" is that an import leaves it standing — an invalid row would be rejected
  // by the write gate and the case would report a validation failure instead.
  id: 'held-pipeline',
  name: 'Held Pipeline',
  version: 2,
  phases: ['held']
});

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

async function planFor(inst: Installation, text: string): Promise<ImportPlan> {
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      ...catalogDeps(inst.store),
      openProcessYamlDocument: async () => ({
        outcome: 'read' as const,
        bytes: new Uint8Array(Buffer.from(text, 'utf8'))
      }),
      audit: { append: async () => undefined },
      logger: logger()
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: CORRELATION
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const command: PreflightProcessYamlCommand = {
    type: CMD_PREFLIGHT_PROCESS_YAML,
    correlationId: CORRELATION,
    payload: {}
  };
  await preflightHandler(ctx, command);
  expect(acks).toHaveLength(1);
  const result = acks[0]!.result as PreflightProcessYamlResult;
  expect(result.outcome).toBe('planned');
  if (result.outcome !== 'planned') throw new Error('unreachable');
  return result.plan;
}

// ---------------------------------------------------------------------------
// Commit — the webview's translation, mirrored
// ---------------------------------------------------------------------------

/** Only `import` rows are written; `skip`, `blocked`, and `invalid` are not (FR-037). */
function importedPhases(plan: ImportPlan): readonly PhaseDefinition[] {
  const definitions: PhaseDefinition[] = [];
  for (const row of plan.rows) {
    if (row.outcome === 'import' && row.resourceKind === 'phase') definitions.push(row.definition);
  }
  return definitions;
}

function importedPipelines(plan: ImportPlan): readonly PipelineDefinition[] {
  const definitions: PipelineDefinition[] = [];
  for (const row of plan.rows) {
    if (row.outcome === 'import' && row.resourceKind === 'pipeline') {
      definitions.push(row.definition);
    }
  }
  return definitions;
}

function phaseRow(definition: PhaseDefinition): Record<string, unknown> {
  const { phaseId, ...declared } = definition;
  return { id: phaseId, ...declared };
}

function pipelineRow(definition: PipelineDefinition): Record<string, unknown> {
  const { pipelineId, phaseIds, ...declared } = definition;
  return { id: pipelineId, phases: [...phaseIds], ...declared };
}

/**
 * One attempted layer write. Appending the added rows is what makes the
 * positional shape check pass: deleting them from the proposal reproduces the
 * layer the operator's preview described, in order.
 */
interface Attempt {
  readonly key: LayerKey;
  readonly command: SavePhasesCommand | SavePipelinesCommand;
}

function attemptsFor(plan: ImportPlan, layers: Held): readonly Attempt[] {
  const attempts: Attempt[] = [];
  const phases = importedPhases(plan);
  const pipelines = importedPipelines(plan);

  // FR-038 — the Phase attempt is built and run first, unconditionally.
  if (phases.length > 0) {
    attempts.push({
      key: 'phases',
      command: {
        type: CMD_SAVE_PHASES,
        correlationId: CORRELATION,
        payload: {
          expectedRevision: plan.computedAgainstRevision,
          mutation: {
            kind: 'import-package',
            phaseIds: phases.map((definition) => definition.phaseId)
          },
          phases: [...layers.phases, ...phases.map(phaseRow)]
        }
      }
    });
  }

  if (pipelines.length > 0) {
    // FR-043 — the Pipeline catalog carries ITS OWN revision, not the Phase
    // catalog's. A single revision could not gate two independently mutable
    // catalogs, and using the live one at confirm time would defeat FR-040.
    const revision = plan.computedAgainstPipelineRevision;
    expect(revision).toBeDefined();
    attempts.push({
      key: 'pipelines',
      command: {
        type: CMD_SAVE_PIPELINES,
        correlationId: CORRELATION,
        payload: {
          expectedRevision: revision!,
          mutation: {
            kind: 'import-package',
            pipelineIds: pipelines.map((definition) => definition.pipelineId)
          },
          pipelines: [...layers.pipelines, ...pipelines.map(pipelineRow)]
        }
      }
    });
  }

  return attempts;
}

interface LayerResult {
  readonly key: LayerKey;
  readonly ack: CommandAckMessage;
}

interface CommitRun {
  /** Catalogs a write request actually reached, in the order the store saw them. */
  readonly writes: readonly LayerKey[];
  readonly results: readonly LayerResult[];
  readonly outcome: 'imported' | 'partial' | 'failed';
}

/**
 * The webview's outcome rule, mirrored (FR-042a): the import is never reported
 * as wholly succeeded or wholly failed when it was neither.
 */
function outcomeOf(results: readonly LayerResult[]): CommitRun['outcome'] {
  const accepted = results.filter((result) => result.ack.status === 'accepted').length;
  if (accepted === results.length) return 'imported';
  return accepted === 0 ? 'failed' : 'partial';
}

async function commitPackage(
  inst: Installation,
  plan: ImportPlan,
  layers: Held,
  opts: { readonly failOn?: LayerKey } = {}
): Promise<CommitRun> {
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      ...catalogDeps(inst.store),
      readConfig: () => undefined,
      executeCommand: vi.fn(),
      queueRemover: { remove: vi.fn() },
      audit: { append: async () => undefined },
      logger: logger()
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: CORRELATION
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const results: LayerResult[] = [];
  const savesBefore = inst.store.layerSaves.length;
  for (const attempt of attemptsFor(plan, layers)) {
    // Feature 099 (T496f, FR-029) — `failOn` made the settings writer throw. The
    // store never throws; it names the fault, and `not-writable` is the same
    // fault by its own name, answering exactly one write.
    if (opts.failOn === attempt.key) {
      inst.store.nextLayerVerdict = { outcome: 'refused', reason: 'not-writable', id: null };
    }
    if (attempt.key === 'phases') {
      await savePhasesHandler(ctx, attempt.command as SavePhasesCommand);
    } else {
      await savePipelinesHandler(ctx, attempt.command as SavePipelinesCommand);
    }
    const ack = acks[acks.length - 1];
    expect(ack).toBeDefined();
    results.push({ key: attempt.key, ack: ack! });
    // A rejected write stops the sequence. The ordering exists so the Pipeline
    // never lands without its Phases; carrying on past a failed Phase write
    // would be exactly that.
    if (ack!.status !== 'accepted') break;
  }

  // The writes this run reached, in the order the store saw them. A gate that
  // rejects ahead of the store leaves no request behind, which is what the
  // `expect(run.writes).toEqual([])` cases are asserting.
  const writes = inst.store.layerSaves
    .slice(savesBefore)
    .map((request) => (request.kind === 'phase' ? 'phases' : 'pipelines') as LayerKey);

  return { writes, results, outcome: outcomeOf(results) };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function phaseCatalogOf(inst: Installation) {
  return resolvePhaseCatalog({
    rows: inst.store.rowsOf('phase'),
    revision: inst.store.revisionOf('phase')
  });
}

function effectivePhaseIds(inst: Installation): readonly string[] {
  return phaseCatalogOf(inst).effective.map((definition) => definition.phaseId);
}

function pipelineCatalogOf(inst: Installation) {
  return resolvePipelineCatalog({
    rows: inst.store.rowsOf('pipeline'),
    revision: inst.store.revisionOf('pipeline'),
    phaseCatalog: phaseCatalogOf(inst).effective
  });
}

function effectivePipelineIds(inst: Installation): readonly string[] {
  return pipelineCatalogOf(inst).effective.map((definition) => definition.pipelineId);
}

function snapshot(inst: Installation): string {
  return JSON.stringify({
    phases: inst.store.rowsOf('phase'),
    pipelines: inst.store.rowsOf('pipeline')
  });
}

beforeEach(() => capabilities.clear());

describe('Feature 085 T043 — the ordered two-layer write', () => {
  it('writes only the `import` rows, leaving `skip` untouched (FR-037)', async () => {
    // `specify` is already held, so it plans `skip` and stays at the version the
    // host holds — a skip is not a write, and not an overwrite either.
    const inst = installation({
      phases: [HELD_PHASE, { id: 'specify', name: 'Mine', version: 7, instruction: 'Mine.' }]
    });
    const plan = await planFor(inst, SELF_CONTAINED);
    expect(plan.counts).toEqual({ import: 2, skip: 1, blocked: 0, invalid: 0 });

    const run = await commitPackage(inst, plan, held(inst));

    expect(run.outcome).toBe('imported');
    expect(inst.store.rowsOf('phase')).toEqual([
      HELD_PHASE,
      { id: 'specify', name: 'Mine', version: 7, instruction: 'Mine.' },
      { id: 'plan', name: 'Plan', version: 5, instruction: 'Write the plan.' }
    ]);
    // The declared version survives the write it arrived on (FR-044).
    expect(inst.store.rowsOf('pipeline')).toEqual([
      expect.objectContaining({ id: 'ship-it', version: 3, phases: ['specify', 'plan'] })
    ]);
  });

  it('writes the Phase catalog before the Pipeline catalog (FR-038)', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan, held(inst));

    expect(run.writes).toEqual(['phases', 'pipelines']);
    expect(run.results.map((result) => result.ack.status)).toEqual(['accepted', 'accepted']);
    expect(run.outcome).toBe('imported');
  });

  it('accepts the Pipeline only because its Phases already landed (FR-038)', async () => {
    // The behavioral half of the ordering rule. The Pipeline save resolves
    // references against the EFFECTIVE Phase catalog, so this same command sent
    // first is a rejection rather than a save — which is what makes the order a
    // correctness rule and not a preference.
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    expect(effectivePhaseIds(inst)).not.toContain('specify');

    const reversed = await commitPackage(
      installation(),
      plan,
      { phases: [], pipelines: [] },
      // Nothing lands, so the Phase attempt cannot have run second.
      { failOn: 'phases' }
    );
    expect(reversed.outcome).toBe('failed');
    expect(reversed.writes).toEqual(['phases']);

    const run = await commitPackage(inst, plan, held(inst));
    expect(run.outcome).toBe('imported');
    expect(effectivePhaseIds(inst)).toEqual(expect.arrayContaining(['specify', 'plan']));
    expect(effectivePipelineIds(inst)).toContain('ship-it');
  });

  it('writes the eligible Phase even though the Pipeline is blocked (FR-039)', async () => {
    const inst = installation();
    const plan = await planFor(inst, BLOCKED_ROOT);
    expect(plan.counts).toEqual({ import: 1, skip: 0, blocked: 1, invalid: 0 });

    const run = await commitPackage(inst, plan, held(inst));

    // A blocked row is not a failed write — it was never eligible, so there is
    // no Pipeline attempt at all and nothing partial about the outcome.
    expect(run.writes).toEqual(['phases']);
    expect(run.outcome).toBe('imported');
    expect(effectivePhaseIds(inst)).toContain('specify');
    expect(inst.store.rowsOf('pipeline')).toEqual([]);
    const blocked = plan.rows.find((row) => row.outcome === 'blocked');
    expect(blocked).toMatchObject({
      resourceKind: 'pipeline',
      resourceId: 'ship-it',
      reason: { code: 'dependency-absent', dependency: { kind: 'phase', resourceId: 'polish' } }
    });
  });

  it('refuses both catalogs when the Phase catalog changed since preflight (FR-040)', async () => {
    const inst = installation({ phases: [HELD_PHASE] });
    const plan = await planFor(inst, SELF_CONTAINED);
    const layers = held(inst);

    await concurrentWrite(inst, 'phases', [
      HELD_PHASE,
      { id: 'landed', name: 'Landed', version: 1, instruction: 'First.' }
    ]);
    const before = snapshot(inst);

    const run = await commitPackage(inst, plan, layers);

    expect(run.results.map((result) => result.ack.status)).toEqual(['rejected']);
    expect(run.results[0]?.ack).toMatchObject({ reason: 'stale-catalog' });
    expect(run.outcome).toBe('failed');
    expect(run.writes).toEqual([]);
    expect(snapshot(inst)).toBe(before);
  });

  it('refuses the Pipeline catalog alone when only it changed since preflight (FR-040)', async () => {
    // `held` is the Phase this Pipeline names, so the concurrent write below is a
    // valid catalog rather than one the write gate would reject for its own reasons.
    const inst = installation({ phases: [HELD_PHASE] });
    const plan = await planFor(inst, SELF_CONTAINED);
    const layers = held(inst);

    // The two catalogs have independent revisions, so a concurrent Pipeline write
    // must stop the Pipeline half without pretending the Phase half is stale.
    await concurrentWrite(inst, 'pipelines', [HELD_PIPELINE]);

    const run = await commitPackage(inst, plan, layers);

    expect(run.writes).toEqual(['phases']);
    expect(run.results.map((result) => [result.key, result.ack.status])).toEqual([
      ['phases', 'accepted'],
      ['pipelines', 'rejected']
    ]);
    expect(run.results[1]?.ack).toMatchObject({ reason: 'stale-catalog' });
    expect(run.outcome).toBe('partial');
    expect(effectivePhaseIds(inst)).toEqual(expect.arrayContaining(['specify', 'plan']));
    expect(inst.store.rowsOf('pipeline')).toEqual([HELD_PIPELINE]);
  });

  it('reports staleness rather than the denied capability (FR-041)', async () => {
    // Both gates would fire. The operator is told the one that is actionable:
    // the preview no longer describes the catalog, so re-running the preflight
    // is the next step whether or not the capability is ever granted.
    capabilities.set('phases', false);
    const inst = installation({ phases: [HELD_PHASE] });
    const plan = await planFor(inst, SELF_CONTAINED);
    const layers = held(inst);
    await concurrentWrite(inst, 'phases', [
      HELD_PHASE,
      { id: 'landed', name: 'Landed', version: 1, instruction: 'First.' }
    ]);

    const run = await commitPackage(inst, plan, layers);

    expect(run.results[0]?.ack).toMatchObject({ status: 'rejected', reason: 'stale-catalog' });
    expect(run.writes).toEqual([]);
  });

  it('reports staleness on the Pipeline catalog with every capability denied (FR-041)', async () => {
    // Feature 099 (T496f, FR-046) — this denied `pipelineOverrides`, which is
    // deleted along with the layer tier: a Pipeline save consults no capability at
    // all now, so "both gates would fire" is unreachable on this path. What
    // survives is the half that still has teeth — the staleness answer does not
    // depend on the resolver — so every remaining capability is denied and the
    // Pipeline write must still report the actionable reason.
    //
    // The document's Phases are seeded, so they plan `skip` and the Pipeline is
    // the only attempt. Otherwise the denied `phases` capability would stop the
    // run one write earlier and the Pipeline gate would go unobserved.
    for (const capability of ['phases', 'retryConditions', 'pipelineOverrides']) {
      capabilities.set(capability, false);
    }
    const inst = installation({
      phases: [
        HELD_PHASE,
        { id: 'specify', name: 'Specify', version: 2, instruction: 'Write the spec.' },
        { id: 'plan', name: 'Plan', version: 5, instruction: 'Write the plan.' }
      ]
    });
    const plan = await planFor(inst, SELF_CONTAINED);
    expect(plan.counts).toEqual({ import: 1, skip: 2, blocked: 0, invalid: 0 });
    const layers = held(inst);
    await concurrentWrite(inst, 'pipelines', [HELD_PIPELINE]);

    const run = await commitPackage(inst, plan, layers);

    expect(run.results.map((result) => result.key)).toEqual(['pipelines']);
    expect(run.results[0]?.ack).toMatchObject({ status: 'rejected', reason: 'stale-catalog' });
    expect(run.writes).toEqual([]);
  });
});

describe('Feature 085 T044 — a failed second write is partial, and stays partial', () => {
  it('leaves the Phases written and reports the outcome as partial (FR-042a)', async () => {
    const inst = installation({ phases: [HELD_PHASE] });
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan, held(inst), { failOn: 'pipelines' });

    expect(run.outcome).toBe('partial');
    expect(run.results.map((result) => [result.key, result.ack.status])).toEqual([
      ['phases', 'accepted'],
      ['pipelines', 'rejected']
    ]);
    expect(run.results[1]?.ack).toMatchObject({ reason: 'persistence-failed' });
    // Exactly which resources landed is observable, which is what FR-042a asks
    // the surface to report: the two Phases did, the Pipeline did not.
    expect(effectivePhaseIds(inst)).toEqual(expect.arrayContaining(['specify', 'plan']));
    expect(effectivePipelineIds(inst)).not.toContain('ship-it');
  });

  it('triggers no compensating delete of the Phases that landed (FR-042c)', async () => {
    const inst = installation({ phases: [HELD_PHASE] });
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan, held(inst), { failOn: 'pipelines' });

    // Two attempts, two writes, and no third. Removing a resource the operator
    // never confirmed removing is a destructive write in its own right, and it
    // can destroy a concurrent edit.
    expect(run.writes).toEqual(['phases', 'pipelines']);
    expect(inst.store.rowsOf('phase')).toEqual([
      HELD_PHASE,
      { id: 'specify', name: 'Specify', version: 2, instruction: 'Write the spec.' },
      { id: 'plan', name: 'Plan', version: 5, instruction: 'Write the plan.' }
    ]);
  });

  it('is recovered by re-running the same document, with no manual cleanup (FR-042b)', async () => {
    const inst = installation({ phases: [HELD_PHASE] });
    const first = await planFor(inst, SELF_CONTAINED);
    await commitPackage(inst, first, held(inst), { failOn: 'pipelines' });

    // The same bytes, nothing edited, nothing removed by hand.
    const second = await planFor(inst, SELF_CONTAINED);

    // The landed Phases are present, so they plan `skip` — and a `skip` resolves
    // the root's references (FR-034), which is precisely why re-running heals.
    expect(second.counts).toEqual({ import: 1, skip: 2, blocked: 0, invalid: 0 });
    expect(
      second.rows.filter((row) => row.outcome === 'skip').map((row) => row.resourceId)
    ).toEqual(['specify', 'plan']);

    const run = await commitPackage(inst, second, held(inst));

    expect(run.writes).toEqual(['pipelines']);
    expect(run.outcome).toBe('imported');
    expect(effectivePipelineIds(inst)).toContain('ship-it');
    // The Phases were not rewritten, so the versions the first run stored stand.
    expect(inst.store.rowsOf('phase')).toEqual([
      HELD_PHASE,
      { id: 'specify', name: 'Specify', version: 2, instruction: 'Write the spec.' },
      { id: 'plan', name: 'Plan', version: 5, instruction: 'Write the plan.' }
    ]);
  });
});

// ---------------------------------------------------------------------------
// Feature 085 T052 — an import removes nothing, so it confirms nothing (FR-054)
// ---------------------------------------------------------------------------
//
// Every other mutating catalog action has a confirmation because it can destroy
// work: `catalog.remove-phase` and `catalog.remove-pipeline` erase a row, and
// `workspace.reset` erases a layer. Import has none, and FR-054 states the reason
// rather than the policy — it never removes or replaces an existing resource.
//
// So this pins the reason, not just the absence. The registry check alone would
// pass just as well on an import that silently overwrote a held row; what makes
// the missing gate CORRECT is that a write only ever appends, and a resource the
// host already holds plans `skip` (FR-030) and is left exactly as authored.

const IMPORT_PATH_COMMANDS: readonly string[] = [
  'CMD_PREFLIGHT_PROCESS_YAML',
  'CMD_SAVE_PHASES',
  'CMD_SAVE_PIPELINES'
];

describe('Feature 085 T052 — import registers no destructive-action confirmation (FR-054)', () => {
  it('names no import-path command in the destructive-command set', () => {
    // Read as text rather than imported: these are the two hand-maintained
    // tables the `useConfirm` gate is derived from, and the assertion is about
    // what they LIST. `tests/lint/destructive-actions.lint.test.ts` enforces the
    // gate over that list; this enforces that import stays off it.
    const lint = readFileSync(
      resolve(__dirname, '..', '..', 'lint', 'destructive-actions.lint.test.ts'),
      'utf8'
    );
    const listed = lint.slice(
      lint.indexOf('const DESTRUCTIVE_COMMANDS'),
      lint.indexOf('];', lint.indexOf('const DESTRUCTIVE_COMMANDS'))
    );
    for (const command of IMPORT_PATH_COMMANDS) expect(listed).not.toContain(command);
  });

  it('declares no confirmation copy for an import action', () => {
    // An `ActionKey` is the handle a confirmation is registered under. No import
    // key exists, so there is nothing for a call site to await — the gate cannot
    // be added by accident, only deliberately and with copy to match.
    const copy = readFileSync(
      resolve(__dirname, '..', '..', '..', 'webview-ui', 'src', 'lib', 'action-copy.ts'),
      'utf8'
    );
    const keys = copy.slice(copy.indexOf('export type ActionKey'), copy.indexOf(';', copy.indexOf('export type ActionKey')));
    expect(keys).toContain("'catalog.remove-phase'");
    expect(keys.toLowerCase()).not.toContain('import');
    expect(keys.toLowerCase()).not.toContain('exchange');
  });

  it('appends to the target catalog and rewrites nothing that was there', async () => {
    const MINE = Object.freeze({ id: 'mine', name: 'Mine', version: 9, instruction: 'Mine.' });
    const inst = installation({
      phases: [HELD_PHASE, MINE],
      pipelines: [HELD_PIPELINE]
    });
    const before = JSON.parse(snapshot(inst)) as {
      phases: readonly unknown[];
      pipelines: readonly unknown[];
    };

    const plan = await planFor(inst, SELF_CONTAINED);
    const run = await commitPackage(inst, plan, held(inst));
    expect(run.outcome).toBe('imported');

    // Each catalog is its prior contents, in order, followed by the imported rows.
    // Positional, because a row that moved is a row some other reader's index
    // now points past.
    expect(inst.store.rowsOf('phase').slice(0, before.phases.length)).toEqual(before.phases);
    expect(inst.store.rowsOf('pipeline').slice(0, before.pipelines.length)).toEqual(
      before.pipelines
    );
    expect(inst.store.rowsOf('phase').length).toBe(before.phases.length + 2);
    expect(inst.store.rowsOf('pipeline').length).toBe(before.pipelines.length + 1);
  });

  it('leaves a resource the host already holds exactly as its author wrote it', async () => {
    // The document declares `specify` at version 2 with its own instruction. The
    // host holds a different `specify`. The held one is what an operator would
    // lose if import replaced rather than skipped, so it is the case worth
    // pinning: nothing about it changes, not even its position.
    const AUTHORED = Object.freeze({
      id: 'specify',
      name: 'My Specify',
      version: 41,
      instruction: 'Mine, not the document.'
    });
    const inst = installation({ phases: [AUTHORED, HELD_PHASE] });

    const plan = await planFor(inst, SELF_CONTAINED);
    expect(plan.counts).toEqual({ import: 2, skip: 1, blocked: 0, invalid: 0 });

    await commitPackage(inst, plan, held(inst));

    expect(inst.store.rowsOf('phase')[0]).toEqual(AUTHORED);
    expect(
      inst.store.rowsOf('phase').filter((row) => (row as { id: string }).id === 'specify')
    ).toEqual([AUTHORED]);
  });

  it('touches no catalog it was not addressed to', async () => {
    // Feature 099 (T496f, FR-042) — this read "touches neither the other scope nor
    // the layer it was not addressed to", and half of it named a destination that
    // no longer exists. The surviving half is the one that was always the point: a
    // package declares the kinds it carries, and a kind it does not declare is not
    // written. This document is a Pipeline package, so the Workflow catalog is the
    // one it was not addressed to — untouched down to its revision, which is the
    // stronger reading, because a rewrite that happened to produce the same rows
    // would still move it.
    const WORKFLOW_ROW = Object.freeze({
      id: 'held-flow',
      name: 'Held Flow',
      version: 1,
      nodes: []
    });
    const inst = installation({ workflows: [WORKFLOW_ROW] });
    const untouchedRevision = inst.store.revisionOf('workflow');

    const plan = await planFor(inst, SELF_CONTAINED);
    const run = await commitPackage(inst, plan, held(inst));
    expect(run.outcome).toBe('imported');

    expect(inst.store.rowsOf('workflow')).toEqual([WORKFLOW_ROW]);
    expect(inst.store.revisionOf('workflow')).toBe(untouchedRevision);
    expect(inst.store.layerSaves.map((request) => request.kind)).toEqual(['phase', 'pipeline']);
  });

  it('removes nothing when the second write fails, so recovery needs no undo (FR-042c)', async () => {
    // The other half of why no confirmation is owed: the failure mode is a
    // partial APPEND, never a partial delete. Re-running the same document is
    // the recovery (FR-042b, pinned in T044 above), and it needs no permission
    // to destroy anything because there is nothing to destroy.
    const inst = installation({ phases: [HELD_PHASE] });
    const before = [...inst.store.rowsOf('phase')];

    const plan = await planFor(inst, SELF_CONTAINED);
    const run = await commitPackage(inst, plan, held(inst), { failOn: 'pipelines' });

    expect(run.outcome).toBe('partial');
    expect(inst.store.rowsOf('phase').slice(0, before.length)).toEqual(before);
    expect(inst.store.rowsOf('pipeline')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Feature 085 T058 — what the import leaves behind (FR-045, FR-046)
// ---------------------------------------------------------------------------
//
// FR-045: the document is a one-time input, not a source the catalog reads from.
// The catalog has exactly one source of rows, and a second one that happened to be
// a file on someone's disk would be a source no other installation has — a Pipeline
// that resolves here and nowhere else.
//
// FR-046: what import writes is a catalog row like any other. It goes through
// the same save command, the same validation, and the same cross-reference
// resolution an operator's own edit does — so an imported Pipeline cannot be
// valid in a way an authored one could not be, and cannot be invalid in a way
// the catalog would fail to notice.

describe('Feature 085 T058 — an import is not a catalog source (FR-045)', () => {
  it('reads the document once, and never again', async () => {
    let opens = 0;
    const inst = installation();
    const acks: CommandAckMessage[] = [];
    const ctx = {
      deps: {
        ...catalogDeps(inst.store),
        openProcessYamlDocument: async () => {
          opens += 1;
          return {
            outcome: 'read' as const,
            bytes: new Uint8Array(Buffer.from(SELF_CONTAINED, 'utf8'))
          };
        },
        audit: { append: async () => undefined },
        logger: logger()
      },
      postAck: async (msg: CommandAckMessage) => {
        acks.push(msg);
        return true;
      },
      correlationId: CORRELATION
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await preflightHandler(ctx, {
      type: CMD_PREFLIGHT_PROCESS_YAML,
      correlationId: CORRELATION,
      payload: {}
    } as PreflightProcessYamlCommand);
    expect(opens).toBe(1);

    const result = acks[0]!.result as PreflightProcessYamlResult;
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    // The commit is driven entirely by the plan. If the document were a source,
    // the write would need to consult it again.
    await commitPackage(inst, result.plan, held(inst));
    expect(opens).toBe(1);
    expect(effectivePipelineIds(inst)).toContain('ship-it');
  });

  it('survives the document changing underneath it after the commit', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    await commitPackage(inst, plan, held(inst));
    const after = snapshot(inst);

    // A later read of a document that now says something else must be
    // impossible, not merely unlikely: resolve the catalog again and see the
    // same rows. Nothing here has a handle on the file to re-read.
    await planFor(inst, BLOCKED_ROOT);
    expect(snapshot(inst)).toBe(after);
    expect(effectivePipelineIds(inst)).toContain('ship-it');
  });

  it('stores no trace of where the resource came from', async () => {
    // FR-050 forbids a path crossing the boundary at all; this is the storage
    // end of the same rule. A row that named its origin would also be a row
    // whose contents differ between two operators who imported the same bytes.
    //
    // Asserted on the key set rather than by scanning for suspicious words:
    // `source` is legitimate binding vocabulary, so a word list would either
    // miss a real origin field or fire on a real binding.
    //
    // The claim is one-directional — import ADDS nothing. The catalog's own
    // normalization drops an optional array that came out empty, which is why
    // this is a subset check and not deep equality: subtraction by a rule the
    // catalog applies to every row is not a trace of anything.
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    await commitPackage(inst, plan, held(inst));

    const addsNothing = (stored: readonly unknown[], declared: readonly Record<string, unknown>[]) => {
      expect(stored).toHaveLength(declared.length);
      stored.forEach((row, index) => {
        const expected = declared[index]!;
        for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
          expect(Object.keys(expected)).toContain(key);
          expect(value).toEqual(expected[key]);
        }
      });
    };

    addsNothing(inst.store.rowsOf('phase'), importedPhases(plan).map(phaseRow));
    addsNothing(inst.store.rowsOf('pipeline'), importedPipelines(plan).map(pipelineRow));
  });
});

describe('Feature 085 T058 — an imported Pipeline is a catalog row like any other (FR-046)', () => {
  it('resolves as effective, with the definition the document declared', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    await commitPackage(inst, plan, held(inst));

    const resolved = pipelineCatalogOf(inst);

    const record = resolved.records.find((row) => row.pipelineId === 'ship-it');
    expect(record?.status).toBe('effective');
    expect(record?.errors).toEqual([]);
    expect(resolved.effective.find((row) => row.pipelineId === 'ship-it')).toMatchObject({
      pipelineId: 'ship-it',
      name: 'Ship It',
      version: 3,
      phaseIds: ['specify', 'plan']
    });
  });

  it('is refused by the same validation an authored row is, not a lenient one', async () => {
    // A binding naming a port the Pipeline does not declare. Preflight plans the
    // row — the document is well formed — and the save command applies the same
    // cross-reference gate it applies to an operator's own edit. Import is not a
    // way around the catalog's rules.
    //
    // The Phases are seeded so this isolates the binding gate: with the layer
    // empty, `unknown-phase` would fire first and the binding defect would go
    // unobserved even though the save still failed.
    const seed = installation();
    const plan = await planFor(seed, SELF_CONTAINED);
    const inst = installation({ phases: importedPhases(plan).map(phaseRow) });
    const [pipeline] = importedPipelines(plan);
    expect(pipeline).toBeDefined();

    const acks: CommandAckMessage[] = [];
    const ctx = {
      deps: {
        ...catalogDeps(inst.store),
        readConfig: () => undefined,
        executeCommand: vi.fn(),
        queueRemover: { remove: vi.fn() },
        audit: { append: async () => undefined },
        logger: logger()
      },
      postAck: async (msg: CommandAckMessage) => {
        acks.push(msg);
        return true;
      },
      correlationId: CORRELATION
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const broken = {
      ...pipelineRow(pipeline!),
      bindings: [
        {
          kind: 'input',
          phaseIndex: 0,
          inputKey: 'brief',
          source: { from: 'pipeline-input', portId: 'no-such-port' }
        }
      ]
    };

    await savePipelinesHandler(ctx, {
      type: CMD_SAVE_PIPELINES,
      correlationId: CORRELATION,
      payload: {
        expectedRevision: plan.computedAgainstPipelineRevision!,
        mutation: { kind: 'import-package', pipelineIds: ['ship-it'] },
        pipelines: [broken]
      }
    } as SavePipelinesCommand);

    expect(acks).toHaveLength(1);
    expect(acks[0]!.status).toBe('rejected');
    expect(acks[0]!.reason).toBe('pipeline-validation');
    // The specific defect, not just the reason class: a coarse code alone would
    // pass on a rejection that happened for some unrelated reason.
    expect(acks[0]!.result).toMatchObject({
      errors: [{ pipelineId: 'ship-it', code: 'binding-unknown-input-port' }],
      total: 1
    });
    expect(inst.store.rowsOf('pipeline')).toEqual([]);
    // A rejected save must not reach a write.
    expect(inst.store.layerSaves).toEqual([]);
  });

  it('is refused when its Phases are not there, exactly as an authored row would be', async () => {
    // The other half of FR-046, and the reason FR-038 orders the two writes: a
    // Pipeline whose Phases have not landed does not resolve. Writing the
    // Pipeline catalog alone reproduces the reversed order and must fail.
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    const [pipeline] = importedPipelines(plan);

    const acks: CommandAckMessage[] = [];
    const ctx = {
      deps: {
        ...catalogDeps(inst.store),
        readConfig: () => undefined,
        executeCommand: vi.fn(),
        queueRemover: { remove: vi.fn() },
        audit: { append: async () => undefined },
        logger: logger()
      },
      postAck: async (msg: CommandAckMessage) => {
        acks.push(msg);
        return true;
      },
      correlationId: CORRELATION
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await savePipelinesHandler(ctx, {
      type: CMD_SAVE_PIPELINES,
      correlationId: CORRELATION,
      payload: {
        expectedRevision: plan.computedAgainstPipelineRevision!,
        mutation: { kind: 'import-package', pipelineIds: ['ship-it'] },
        pipelines: [pipelineRow(pipeline!)]
      }
    } as SavePipelinesCommand);

    expect(acks[0]!.status).toBe('rejected');
    expect(acks[0]!.reason).toBe('pipeline-validation');
    const detail = acks[0]!.result as { readonly errors: readonly { readonly code: string }[] };
    expect(detail.errors.map((error) => error.code)).toContain('unknown-phase');
    expect(JSON.stringify(detail.errors)).toContain('specify');
    expect(inst.store.layerSaves).toEqual([]);
  });
});
