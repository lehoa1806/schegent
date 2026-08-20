// Feature 098 (T068, FR-044, SC-003) — every shipped document makes a complete
// trip: document → plan → committed catalog → resolved as effective.
//
// `examples-coverage.test.ts` (T059) sits next to this file and asserts the
// set-level claim: the Pipeline documents plan `import` rows rather than the
// sixteen `skip` rows the built-in layer used to force. This file is the
// per-document, per-id claim, and it is written to fail on three things that one
// cannot see:
//
//   1. EVERY document, not every Pipeline document. T059 filters to
//      `kind: Pipeline`, so `model-catalog.yaml` is only ever asserted to exist.
//      Model ids ship in the VSIX like any other definition and land through the
//      same preflight, so they are imported and resolved here too.
//   2. Each document against its OWN empty catalog. T059 walks one accumulating
//      installation, which is the right shape for "what does the operator end up
//      with"; it is the wrong shape for FR-044, which is about each document
//      landing on a fresh install. A document that only imports cleanly because
//      an earlier one wrote something it needed would pass there and fail here.
//   3. Ids read from the PARSED DOCUMENT, not from the plan. T059 asserts the
//      set of row outcomes is `{import}` — true of a plan that dropped nine of
//      ten resources, since the surviving row is still an import. Here the
//      declared ids are walked out of the document's own node tree and compared
//      against the plan's rows, so a dropped resource is a set mismatch rather
//      than a silent pass.
//
// On the file name: the round trip FR-044 names is document → catalog →
// resolution, which is what this file walks. The other two trips have their own
// homes and are not repeated here — text → resources → text losslessness is
// `pipeline-package-round-trip.test.ts`, and re-importing an already-imported
// document (SC-004) is `phase-import-skip.test.ts`.
//
// The ids are taken from `parseDocumentText`'s generic node tree rather than
// from `parsePipelinePackage`, deliberately: the mapper and the planner are the
// components under test here, so reading the expectation through the mapper
// would make a resource it drops invisible to the comparison. The parser is a
// layer below both, and using it beats a text scan — these documents carry block
// scalars whose prompt text contains lines that look like YAML keys.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const capabilities = vi.hoisted(() => new Map<string, boolean>());
vi.mock('../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (name: string) => capabilities.get(name) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));
vi.mock('../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: '/tmp/examples-round-trip' },
    name: 'examples-round-trip',
    index: 0
  })
}));

import { resolvePipelineCatalog } from '../../../src/config/pipeline-catalog';
import { resolvePhaseCatalog } from '../../../src/config/process-catalog';
import {
  CMD_PREFLIGHT_PROCESS_YAML,
  CMD_PUBLISH_PACKAGE,
  CMD_SAVE_MODELS
} from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ImportPlan,
  ImportPlanRow,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult,
  PublishPackageCommand,
  SaveModelsCommand
} from '../../../src/contracts/sidebar-ipc';
import type { PipelineDefinition } from '../../../src/contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../../../src/runner/backend-runner-factory';
import type { YamlNode } from '../../../src/services/process-yaml/types';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';
import { publishDefinitionPackage } from '../../../src/ui/sidebar/commands/cmd-catalog-lifecycle';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { handler as saveModelsHandler } from '../../../src/ui/sidebar/commands/cmd-save-models';
import { fakeCatalogLifecycle } from '../../fixtures/fake-catalog-lifecycle';
import { FakeCatalogStore } from '../../fixtures/fake-catalog-store';

const EXAMPLES_DIR = resolve(__dirname, '..', '..', '..', 'examples');
const CORRELATION = 'examples-round-trip-1';

/** Every document that ships, discovered rather than listed (FR-041). */
const EXAMPLES: readonly string[] = readdirSync(EXAMPLES_DIR)
  .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
  .sort();

const readExample = (name: string): string => readFileSync(resolve(EXAMPLES_DIR, name), 'utf8');

// ---------------------------------------------------------------------------
// What the document says it declares
// ---------------------------------------------------------------------------

/** One declared resource, keyed so a Phase and a Pipeline sharing an id stay distinct. */
type DeclaredKey = string;

function entryOf(node: YamlNode | undefined, key: string): YamlNode | undefined {
  if (node === undefined || node.kind !== 'mapping') return undefined;
  return node.entries.find((entry) => entry.key === key)?.value;
}

function scalarOf(node: YamlNode | undefined): string | undefined {
  return node !== undefined && node.kind === 'scalar' ? node.value : undefined;
}

function itemsOf(node: YamlNode | undefined): readonly YamlNode[] {
  return node !== undefined && node.kind === 'sequence' ? node.items : [];
}

/**
 * A missing id is thrown rather than skipped. Dropping it would shrink the
 * expectation set, which is the one way this walk could make a defective
 * document look fully imported.
 */
function required(value: string | undefined, what: string, name: string): string {
  if (value === undefined) throw new Error(`${name}: no ${what} found where the grammar puts one`);
  return value;
}

/**
 * The ids a document declares, read off the parsed tree.
 *
 * An unhandled `kind` throws instead of contributing nothing: an example of a
 * new kind must be a loud failure here, not a document that quietly ships
 * uncovered.
 */
function declaredKeys(name: string, text: string): readonly DeclaredKey[] {
  const parsed = parseDocumentText(text);
  if (!parsed.ok) throw new Error(`${name}: ${parsed.refusal.code}: ${parsed.refusal.message}`);
  const root = parsed.node;
  const kind = scalarOf(entryOf(root, 'kind'));

  if (kind === 'Pipeline') {
    const pipelineId = required(scalarOf(entryOf(entryOf(root, 'metadata'), 'id')), 'metadata.id', name);
    const included = entryOf(root, 'included');
    const phaseKeys = itemsOf(entryOf(included, 'phases')).map((phase) =>
      `phase::${required(scalarOf(entryOf(entryOf(phase, 'metadata'), 'phaseId')), 'included phase id', name)}`
    );
    return [`pipeline::${pipelineId}`, ...phaseKeys];
  }

  if (kind === 'ModelCatalog') {
    return itemsOf(entryOf(root, 'groups')).flatMap((group) => {
      const backend = required(scalarOf(entryOf(group, 'backend')), 'group backend', name);
      return itemsOf(entryOf(group, 'models')).map(
        (model) => `model::${backend}::${required(scalarOf(model), 'model id', name)}`
      );
    });
  }

  throw new Error(
    `${name}: declares kind '${kind ?? '<absent>'}', which this test does not know how to ` +
      'walk; extend declaredKeys() rather than letting the document ship uncovered'
  );
}

/** The same key, derived from a plan row instead. */
function rowKey(row: ImportPlanRow): DeclaredKey {
  if (row.resourceKind === 'modelCatalog' && (row.outcome === 'import' || row.outcome === 'skip')) {
    return `model::${row.backend}::${row.modelId}`;
  }
  return `${row.resourceKind}::${row.resourceId ?? '<none>'}`;
}

// ---------------------------------------------------------------------------
// A fresh installation, per document
// ---------------------------------------------------------------------------

type ModelsConfig = Record<BackendRunnerKind, readonly string[]>;

/**
 * Feature 099 (T496f, FR-041/FR-042) — an installation is now a catalog store
 * and the Model Catalog, which is out of 099's scope and still a setting.
 *
 * The three definition catalogs used to be three per-layer settings arrays and
 * this fixture carried the layer pair for each. There is one layer, and it lives
 * in the store, so a fresh install is an empty store — the same claim the
 * `{ user: [], workspace: [] }` triple made, with nothing left to enumerate.
 */
interface Installation {
  readonly store: FakeCatalogStore;
  models: ModelsConfig;
}

/** What a fresh install holds: nothing, in every catalog. */
function emptyInstallation(): Installation {
  const models = Object.fromEntries(
    SUPPORTED_BACKENDS.map((backend) => [backend, [] as readonly string[]])
  ) as ModelsConfig;
  return { store: new FakeCatalogStore(), models };
}

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    sanitize: (value: string) => value
  };
}

/**
 * Feature 100 (T512, FR-043) — each definition layer carries `ids` (every entry at
 * every state) beside `rows` (the active bodies), because the presence gate reads
 * the former and the catalogs resolve from the latter.
 */
function readDeps(inst: Installation) {
  const layer = (kind: 'phase' | 'pipeline' | 'workflow') => () => ({
    rows: inst.store.rowsOf(kind),
    revision: inst.store.revisionOf(kind),
    ids: new Set(inst.store.idsOf(kind))
  });
  return {
    readPhaseConfig: layer('phase'),
    readPipelineConfig: layer('pipeline'),
    readWorkflowConfig: layer('workflow'),
    readModelsConfig: () => inst.models,
    audit: { append: async () => undefined },
    logger: logger()
  };
}

async function planFor(inst: Installation, text: string): Promise<ImportPlan> {
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      ...readDeps(inst),
      openProcessYamlDocument: async () => ({
        outcome: 'read' as const,
        bytes: new Uint8Array(Buffer.from(text, 'utf8'))
      })
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
  expect(
    result.outcome,
    result.outcome === 'refused' ? `${result.refusal.code}: ${result.refusal.message}` : ''
  ).toBe('planned');
  if (result.outcome !== 'planned') throw new Error('unreachable');
  return result.plan;
}

function imported<T>(plan: ImportPlan, kind: 'phase' | 'pipeline'): readonly T[] {
  const definitions: T[] = [];
  for (const row of plan.rows) {
    if (row.outcome === 'import' && row.resourceKind === kind) {
      definitions.push(row.definition as T);
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

/** The `import`-outcome model rows grouped by backend — never a pre-merged catalog. */
function modelDelta(plan: ImportPlan): Record<string, readonly string[]> {
  const delta: Record<string, string[]> = {};
  for (const row of plan.rows) {
    if (row.outcome === 'import' && row.resourceKind === 'modelCatalog') {
      (delta[row.backend] ??= []).push(row.modelId);
    }
  }
  return delta;
}

/**
 * Commit a planned document through the real handlers: the definitions as one
 * package, then the models. Nothing is stubbed at a write gate, so a Pipeline
 * whose Phases had not landed is rejected here rather than silently accepted.
 *
 * Feature 100 (T514) — the Phases-then-Pipelines ordering is inside the host now
 * (it ranks the layers), so this harness no longer has to get it right for the
 * import to work. The Model Catalog is still its own command: it is a settings key
 * that feature 096 left alone, not a catalog layer.
 */
async function commit(inst: Installation, plan: ImportPlan): Promise<readonly CommandAckMessage[]> {
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      ...readDeps(inst),
      catalogStore: inst.store,
      catalogLifecycle: fakeCatalogLifecycle(inst.store),
      refreshCatalog: async () => undefined,
      readConfig: () => undefined,
      // The Model Catalog is the one kind still written through settings
      // (feature 096, untouched by 099); the definition kinds go to the store.
      updateConfig: async (key: string, value: unknown) => {
        if (key !== 'models') throw new Error(`unexpected settings write: ${key}`);
        inst.models = value as ModelsConfig;
      },
      executeCommand: vi.fn(),
      queueRemover: { remove: vi.fn() }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: CORRELATION
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const layers: PublishPackageCommand['payload']['layers'][number][] = [];

  const phases = imported<PhaseDefinition>(plan, 'phase');
  if (phases.length > 0) {
    layers.push({
      kind: 'phase',
      expectedRevision: plan.computedAgainstRevision,
      definitions: phases.map((definition) => ({
        id: definition.phaseId,
        body: phaseRow(definition)
      }))
    });
  }

  const pipelines = imported<PipelineDefinition>(plan, 'pipeline');
  if (pipelines.length > 0) {
    const revision = plan.computedAgainstPipelineRevision;
    expect(revision).toBeDefined();
    layers.push({
      kind: 'pipeline',
      expectedRevision: revision!,
      definitions: pipelines.map((definition) => ({
        id: definition.pipelineId,
        body: pipelineRow(definition)
      }))
    });
  }

  if (layers.length > 0) {
    await publishDefinitionPackage(ctx, {
      type: CMD_PUBLISH_PACKAGE,
      correlationId: CORRELATION,
      payload: { layers }
    } satisfies PublishPackageCommand);
  }

  const models = modelDelta(plan);
  if (Object.keys(models).length > 0) {
    const revision = plan.computedAgainstModelsRevision;
    expect(revision).toBeDefined();
    await saveModelsHandler(ctx, {
      type: CMD_SAVE_MODELS,
      correlationId: CORRELATION,
      payload: { models, expectedRevision: revision!, mutation: { kind: 'import-package' } }
    } as SaveModelsCommand);
  }

  return acks;
}

// ---------------------------------------------------------------------------
// What the catalogs resolve afterwards
// ---------------------------------------------------------------------------

function phaseCatalog(inst: Installation) {
  return resolvePhaseCatalog({
    rows: inst.store.rowsOf('phase'),
    revision: inst.store.revisionOf('phase')
  });
}

function pipelineCatalog(inst: Installation) {
  return resolvePipelineCatalog({
    rows: inst.store.rowsOf('pipeline'),
    revision: inst.store.revisionOf('pipeline'),
    phaseCatalog: phaseCatalog(inst).effective
  });
}

/**
 * The keys the installation resolves as effective.
 *
 * Phases and Pipelines carry a per-row status, so `effective` is read off the
 * record. The Model Catalog is a single settings key with no per-row status, so a
 * model resolves effective exactly when the config holds it under the backend it
 * was declared with.
 */
function effectiveKeys(inst: Installation): ReadonlySet<DeclaredKey> {
  const keys = new Set<DeclaredKey>();
  for (const record of phaseCatalog(inst).records) {
    if (record.status === 'effective') keys.add(`phase::${record.phaseId}`);
  }
  for (const record of pipelineCatalog(inst).records) {
    if (record.status === 'effective') keys.add(`pipeline::${record.pipelineId}`);
  }
  for (const [backend, models] of Object.entries(inst.models)) {
    for (const modelId of models) keys.add(`model::${backend}::${modelId}`);
  }
  return keys;
}

// ---------------------------------------------------------------------------

describe('Feature 098 T068 — every shipped document round-trips into an empty catalog', () => {
  it('finds documents to walk', () => {
    // Without this, a directory that stopped shipping documents would make every
    // `it.each` below vacuous rather than red.
    expect(EXAMPLES.length).toBeGreaterThan(0);
    expect(EXAMPLES).toContain('model-catalog.yaml');
  });

  it.each(EXAMPLES)('%s plans one import row per declared id and zero skip rows', async (name) => {
    const plan = await planFor(emptyInstallation(), readExample(name));
    const declared = declaredKeys(name, readExample(name));

    // Stated as counts first: the four sum to `rows.length`, so naming each one
    // reports WHICH outcome a regression produced rather than just "not import".
    expect(plan.counts, `plan outcome counts for ${name}`).toEqual({
      import: declared.length,
      skip: 0,
      blocked: 0,
      invalid: 0
    });
    // And then as identity, which is the part the counts cannot carry: a plan of
    // the right size describing the wrong resources.
    expect(new Set(plan.rows.map(rowKey)), `planned ids for ${name}`).toEqual(new Set(declared));
  });

  it.each(EXAMPLES)('%s commits without a rejection', async (name) => {
    const acks = await commit(emptyInstallation(), await planFor(emptyInstallation(), readExample(name)));
    expect(acks.length, `no save handler ran for ${name}`).toBeGreaterThan(0);
    for (const ack of acks) {
      expect(ack.status, `${name}: ${JSON.stringify(ack.result)}`).toBe('accepted');
    }
  });

  it.each(EXAMPLES)('%s resolves every id it declares as effective', async (name) => {
    const inst = emptyInstallation();
    // The catalog is empty before the import, so nothing below can be inherited
    // from a layer the document did not write.
    expect(effectiveKeys(inst).size, `catalog before importing ${name}`).toBe(0);

    await commit(inst, await planFor(inst, readExample(name)));

    const resolved = effectiveKeys(inst);
    for (const key of declaredKeys(name, readExample(name))) {
      expect(resolved, `${name} declares ${key}, which does not resolve effective`).toContain(key);
    }
  });

  it('leaves no invalid record behind once every document has been imported', async () => {
    // The one accumulating case, and it is here for what a per-document walk
    // cannot see: two documents whose ids collide, or a Pipeline in one document
    // whose Phases live in another. Both show up as a non-effective record.
    const inst = emptyInstallation();
    for (const name of EXAMPLES) {
      await commit(inst, await planFor(inst, readExample(name)));
    }

    expect(phaseCatalog(inst).records.filter((r) => r.status !== 'effective')).toEqual([]);
    expect(pipelineCatalog(inst).records.filter((r) => r.status !== 'effective')).toEqual([]);

    const resolved = effectiveKeys(inst);
    for (const name of EXAMPLES) {
      for (const key of declaredKeys(name, readExample(name))) {
        expect(resolved, `${key} (from ${name}) after every document imported`).toContain(key);
      }
    }
  });
});
