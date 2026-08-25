// Feature 089 (T032, US1, FR-002, FR-008, SC-001) — one document, two adapters.
//
// **The two entry points, named** ([plan.md D8](../../../specs/089-headless-parity-qualification/plan.md)):
//
//   1. automation — `previewProcessDocument`, `importProcessDocument`, and
//      `exportProcessDefinitions` from `src/headless/process-yaml-api.ts`
//   2. operator   — `MessageRouter.dispatch` of `CMD_PREFLIGHT_PROCESS_YAML`,
//      then of `CMD_PUBLISH_PACKAGE`, and of `CMD_EXPORT_PROCESS_YAML` — the real
//      router running the real handlers
//
// The same bytes go in both, and what comes out is compared row by row on the
// four things an operator or a client acts on: the action, the reason, the
// resource id, and the blocked dependencies. Then each plan is confirmed into its
// OWN configuration fixture, and the two fixtures are compared on the effective
// catalogs they resolve to. Comparing the writes alone would pass on two surfaces
// that both wrote the same wrong thing; comparing what the catalog then resolves
// is the property the requirement is about.
//
// **What is shared and what is mirrored, stated plainly.** The publication
// handler IS shared — both arms dispatch the same `CMD_PUBLISH_PACKAGE` through
// the same router, so the per-layer revision gate, the trust gate, the two-pass
// write order, and the audit envelope are one implementation and cannot diverge.
// The plan-to-request composer is not: the operator's lives in the webview
// (`webview-ui/src/components/ProcessImport/process-import-state.ts`,
// `buildImportWrites`) and is pinned as pure logic by the webview's own unit
// test, and the webview is a separate program that a host test does not import —
// the same rule `pipeline-package-import.test.ts` and `workflow-package-import.
// test.ts` already follow. It is mirrored below, and `SIDEBAR_COMPOSER_SOURCE`
// records where the original lives so a reader can check the mirror rather than
// take it on faith.
//
// **Feature 100 (T514, FR-035, FR-039a) — one call against three.** The two arms
// no longer send the same NUMBER of commands, and pretending they do would be the
// easy way to make this file compile rather than hold. Automation sends one
// `CMD_PUBLISH_PACKAGE` carrying all three layers, because `importProcessDocument`
// hands the whole plan to a single operation whose own two passes own the order.
// The operator's confirmation walks the composer's writes and sends each through
// its own `savePhases`/`savePipelines`/`saveWorkflows`, so three single-layer
// publications go out, each gated and each stopping the sequence if it refuses.
//
// So the claim is restated rather than dropped: the CONCATENATION of the layers in
// the operator's requests equals the layers in automation's one request — same
// kinds, same order, same revisions, same bodies, same ids — and the catalogs
// afterwards resolve to the same definitions. What each layer NAMES is the half
// that matters most here (FR-039a): a publication publishes the head of every id
// it names, so a surface that appended the stored rows to its layers would promote
// an operator's untouched pending draft as a side effect of an import that says
// nothing about it. Both arms must name exactly the document's own ids, and
// `published` below is the recorder that says whether they do.
//
// The document is a three-layer Workflow package because that is the shape with
// the most to be wrong about: a two-layer package cannot catch a Workflow write
// that precedes its Pipelines.
//
// **What "byte-identical" means for export, precisely.** FR-009's assertion is
// the strictest in the feature, so it should not be overstated. The two surfaces
// do not independently produce bytes: `exportProcessDefinitions` returns
// `TextEncoder().encode(selection.text)`, and `cmd-export-process-yaml.ts` hands
// the same `selection.text` STRING to the injected save seam. So what the export
// cases establish is that both surfaces carry the identical string out of the one
// shared serializer, with exactly one deterministic UTF-8 encoding between the
// string and the bytes on each side and no decode round trip anywhere between.
// Given that, string identity and byte identity are the same claim — but they are
// asserted separately below, because the day someone adds a BOM, a newline
// normalization, or a second encoder to one path is the day they stop being.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => new Map<string, boolean>());
vi.mock('../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (name: string) => capabilities.get(name) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));
// Mutable, because the launch cases below need the operator's arm to read a REAL
// directory — the output gate resolves a target against it and probes the
// filesystem, so a path that does not exist would refuse for the wrong reason.
// The exchange cases never touch it, and keep the fixed placeholder.
const workspaceRoot = vi.hoisted(() => ({ path: '/tmp/headless-parity' }));
vi.mock('../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: workspaceRoot.path, scheme: 'file' },
    name: 'headless-parity',
    index: 0
  })
}));

import {
  buildCatalog,
  type PhaseDef,
  type PipelineDef
} from '../../../src/config/pipeline-config';
import { resolvePipelineCatalog } from '../../../src/config/pipeline-catalog';
import { resolvePhaseCatalog } from '../../../src/config/process-catalog';
import { resolveWorkflowCatalog } from '../../../src/config/workflow-catalog';
import {
  CMD_CONTINUE_WORKFLOW,
  type CommandAckMessage,
  type ConnectedRunProjection,
  type ContinueWorkflowPayload,
  type ImportPlan,
  type ImportPlanRow,
  type PreflightProcessYamlResult,
  type SidebarCommand
} from '../../../src/contracts/sidebar-ipc';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import { createConnectedRunSnapshot } from '../../../src/services/workflow-execution/connected-run-factory';
import type { ContinuationDeps } from '../../../src/services/workflow-execution/continuation-service';
import {
  appendAttempt,
  appendDecision,
  type ConnectedWorkflowRun
} from '../../../src/state/connected-workflow-run';
import { isNodeStartable, projectConnectedRun } from '../../../src/ui/sidebar/connected-run-projector';
import { continueWorkflowRun } from '../../../src/headless/workflow-run-api';
import {
  exportProcessDefinitions,
  importProcessDocument,
  previewProcessDocument,
  type ImportProcessDocumentResult,
  type ImportWritePort,
  type LayerSaveAck
} from '../../../src/headless/process-yaml-api';
import { launchPipelineRun } from '../../../src/headless/pipeline-run-api';
import { loadCatalog } from '../../../src/config/pipeline-config-loader';
import type { RunRequest } from '../../../src/contracts/run-request';
import type { NodeRunStartResult } from '../../../src/services/workflow-execution/node-run-starter';
import { MessageRouter, type RouterDeps } from '../../../src/ui/sidebar/message-router';
import {
  CMD_EXPORT_PROCESS_YAML,
  CMD_LAUNCH_PIPELINE,
  CMD_PREFLIGHT_PROCESS_YAML,
  CMD_SAVE_MODELS
} from '../../../src/ui/sidebar/messages';
import { CMD_PUBLISH_PACKAGE } from '../../../src/contracts/sidebar-ipc';
import type { PublishPackageCommand } from '../../../src/contracts/sidebar-ipc';
import type {
  PackagePublishOutcome,
  PackagePublishRequest,
  PackagePublishedLayer
} from '../../../src/contracts/catalog-lifecycle';
import { createHostCatalogLifecycle } from '../../../src/activation/catalog-store-wiring';
import {
  RecordingQueue,
  makeWorkspaceRoot,
  removeWorkspaceRoot,
  storedCatalog
} from './run-harness';
import type { ExportProcessYamlRequest } from '../../../src/contracts/sidebar-ipc/process-yaml';
import type { CatalogStore } from '../../../src/catalog';
import type { CatalogKind } from '../../../src/contracts/catalog-store';
import { FakeCatalogStore } from '../../fixtures/fake-catalog-store';
import type { BackendRunnerKind } from '../../../src/contracts/backend-kinds';
import type {
  ModelCatalogImportRow,
  ModelCatalogSkipRow
} from '../../../src/services/process-yaml/types';

/** Where the mirrored operator-side composer actually lives. */
const SIDEBAR_COMPOSER_SOURCE =
  'webview-ui/src/components/ProcessImport/process-import-state.ts';

type LayerKey = 'phases' | 'pipelines' | 'workflows';

/** The Model Catalog's one writable layer (research.md Decision 6). */
type ModelsLayer = Record<BackendRunnerKind, readonly string[]>;

/**
 * `LayerKey` plus `'models'` — the four things a commit can write.
 *
 * Feature 099 (T496f, FR-042a/FR-054) — the three catalog keys named a `{user,
 * workspace}` pair in configuration and now name a kind in the versioned store,
 * so the recorder below records a `saveLayer` for them and an `updateConfig` for
 * `'models'`, which is the one catalog still written through configuration.
 * What the key set is FOR has not changed: it is the write-order alphabet the
 * two surfaces are compared on.
 */
type RecordedLayerKey = LayerKey | 'models';

/** The store kind each recorded key names, so a `saveLayer` records under it. */
const RECORDED_KEY_OF: Record<CatalogKind, LayerKey> = {
  phase: 'phases',
  pipeline: 'pipelines',
  workflow: 'workflows'
};

// ---------------------------------------------------------------------------
// The document corpus
// ---------------------------------------------------------------------------

function includedResource(
  metadata: readonly string[],
  spec: readonly string[]
): readonly string[] {
  return [
    '    - metadata:',
    ...metadata.map((line) => `        ${line}`),
    '      spec:',
    ...spec.map((line) => `        ${line}`)
  ];
}

function workflowDocument(body: {
  readonly spec?: readonly string[];
  readonly pipelines?: readonly (readonly string[])[];
  readonly phases?: readonly (readonly string[])[];
}): string {
  const lines = [
    'apiVersion: schegent/v1',
    'kind: Workflow',
    'metadata:',
    '  id: parity-flow',
    '  name: Parity Flow',
    '  version: 3',
    'spec:',
    ...(body.spec ?? DEFAULT_SPEC).map((line) => `  ${line}`)
  ];
  if (body.pipelines !== undefined || body.phases !== undefined) {
    lines.push('included:');
    if (body.pipelines !== undefined) lines.push('  pipelines:', ...body.pipelines.flat());
    if (body.phases !== undefined) lines.push('  phases:', ...body.phases.flat());
  }
  return `${lines.join('\n')}\n`;
}

const DEFAULT_SPEC = [
  'nodes:',
  '  - nodeId: draft',
  '    pipelineId: parity-authoring',
  '  - nodeId: review',
  '    pipelineId: parity-review',
  'connections:',
  '  - from:',
  '      nodeId: draft',
  '      portId: spec-document',
  '    to:',
  '      nodeId: review',
  '      portId: spec',
  'startNodeIds:',
  '  - draft'
];

const INCLUDED_AUTHORING = includedResource(
  ['id: parity-authoring', 'name: Parity Authoring', 'version: 2'],
  [
    'phaseIds:',
    '  - parity-specify',
    'outputs:',
    '  - portId: spec-document',
    '    label: Spec',
    '    type: markdown'
  ]
);

const INCLUDED_REVIEW = includedResource(
  ['id: parity-review', 'name: Parity Review', 'version: 1'],
  ['phaseIds:', '  - parity-specify', 'inputs:', '  - portId: spec', '    label: Spec', '    type: text']
);

const INCLUDED_SPECIFY = includedResource(
  ['phaseId: parity-specify', 'name: Parity Specify', 'version: 2'],
  ['instruction: Write the spec.']
);

/** Every id the root names is supplied by the same document; nothing resolves by accident. */
const SELF_CONTAINED = workflowDocument({
  pipelines: [INCLUDED_AUTHORING, INCLUDED_REVIEW],
  phases: [INCLUDED_SPECIFY]
});

/**
 * One row of each outcome the plan can carry, so the row-by-row comparison is
 * over a set of four kinds and not over four instances of `import`:
 *
 *   import   the Phase and the one well-formed Pipeline
 *   skip     the Pipeline whose id the target layer already holds
 *   blocked  the root, which names a Pipeline nothing supplies
 *   invalid  the Pipeline whose id the grammar refuses
 *
 * `blocked` and `invalid` are the two that carry the fields most easily lost in
 * translation — a reason with a nested dependency, and a defect list — which is
 * why the comparison names them rather than comparing outcomes alone.
 */
const MIXED = workflowDocument({
  spec: [
    'nodes:',
    '  - nodeId: draft',
    '    pipelineId: parity-authoring',
    '  - nodeId: polish',
    '    pipelineId: no-such-pipeline',
    'startNodeIds:',
    '  - draft'
  ],
  pipelines: [
    INCLUDED_AUTHORING,
    includedResource(
      ['id: parity-held', 'name: Parity Held', 'version: 1'],
      ['phaseIds:', '  - parity-specify']
    ),
    includedResource(
      ['id: Not A Legal Id', 'name: Illegal', 'version: 1'],
      ['phaseIds:', '  - parity-specify']
    )
  ],
  phases: [INCLUDED_SPECIFY]
});

/** Already in the target layer, so `parity-held` plans as `skip` rather than `import`. */
const HELD_PIPELINE = Object.freeze({
  id: 'parity-held',
  name: 'Parity Held',
  version: 1,
  // Feature 098 (T080) — this named `speckit-specify`, which resolved out of the
  // built-in Phase layer. It names the Phase the document brings instead, which is
  // also what the document's own `parity-held` names. The row has to stay valid: a
  // Pipeline write carries the whole layer, held rows included, so an unresolvable
  // held row would fail the write and the case would see one layer written where
  // it means to observe two.
  phases: ['parity-specify']
});

/**
 * An unrelated Phase already in the target catalog. It collides with nothing
 * either document declares, so it changes no plan row.
 *
 * Feature 099 (T496f, FR-044) — its stated job was to give the Phase layer a
 * different revision from the Pipeline layer, which a revision derived from rows
 * needed a seed to achieve. Per-kind manifest revisions differ without it, so what
 * this row is for is the job it also always had: a held row the Phase write must
 * carry through unchanged, since a save presents the complete catalog and dropping
 * an untouched row would delete it.
 */
const HELD_PHASE = Object.freeze({
  id: 'parity-unrelated',
  name: 'Parity Unrelated',
  version: 1,
  instruction: 'Do something unrelated.'
});

/** The seed that makes the three layer revisions distinguishable. */
const SEEDED = { phases: [HELD_PHASE], pipelines: [HELD_PIPELINE] } as const;

const DOCUMENTS: readonly { readonly label: string; readonly text: string }[] = [
  { label: 'a self-contained package', text: SELF_CONTAINED },
  { label: 'a document with one row of each outcome', text: MIXED }
];

/**
 * A Model Catalog document, deliberately not a member of `DOCUMENTS` above.
 * FR-015 rules out a document mixing a Model Catalog with a Phase/Pipeline/
 * Workflow, so the two fixture families are never interchangeable — this one
 * is exercised by its own describe blocks (T013) rather than folded into the
 * `it.each(DOCUMENTS)` cases.
 *
 * Against `MODEL_CATALOG_SEED` below, plans one `import` (a new model under a
 * recognized backend) and both `skip` reasons (an already-existing model
 * under a recognized backend, and a model under a backend the catalog does
 * not recognize).
 */
const MODEL_CATALOG_DOCUMENT =
  [
    'apiVersion: schegent/v1',
    'kind: ModelCatalog',
    'groups:',
    '  - backend: claude',
    '    models:',
    '      - parity-model-new',
    '      - parity-model-existing',
    '  - backend: not-a-backend',
    '    models:',
    '      - parity-model-orphan'
  ].join('\n') + '\n';

/** What `MODEL_CATALOG_DOCUMENT` above plans against: one pre-existing model. */
const MODEL_CATALOG_SEED = Object.freeze({
  claude: ['parity-model-existing'],
  codex: [],
  agy: []
});

// ---------------------------------------------------------------------------
// One isolated configuration fixture per surface
// ---------------------------------------------------------------------------

/**
 * One surface's isolated durable state: the versioned store its three catalogs
 * live in, the configuration its Model Catalog lives in, and what it wrote.
 *
 * Feature 099 (T496f, FR-042a) — was three `{user, workspace}` pairs of rows.
 * The pairs are gone with the layer tier, and the three catalogs are no longer
 * rows in configuration at all; `catalog` is where they are. `models` stays as it
 * was, because feature 096 left it in configuration and this feature does not
 * move it.
 */
interface Store {
  readonly catalog: FakeCatalogStore;
  models: ModelsLayer;
  /** Layers written, in the order the commit points saw them. */
  readonly writes: RecordedLayerKey[];
  /**
   * Layers made live, and the ids each publication NAMED (feature 100, FR-039a).
   *
   * Separate from {@link writes} because a package publish has two passes and they
   * answer different questions. `writes` is the draft pass: what was durably
   * written, and so what "refused before any write" is read off. This is the
   * publish pass: which ids each surface promoted to Active. A layer can appear in
   * the first and not the second — that is what a partial import IS — and the ids
   * are carried because publishing an id it should not have named is the one
   * divergence a kind-only comparison would agree with.
   */
  readonly published: { readonly kind: CatalogKind; readonly ids: readonly string[] }[];
}

function makeStore(
  seed: {
    readonly phases?: readonly unknown[];
    readonly pipelines?: readonly unknown[];
    readonly models?: ModelsLayer;
  } = {}
): Store {
  return {
    catalog: new FakeCatalogStore({
      phases: seed.phases ?? [],
      pipelines: seed.pipelines ?? []
    }),
    models: seed.models ?? { claude: [], codex: [], agy: [] },
    writes: [],
    published: []
  };
}

/**
 * The store the router writes through: the fixture's own, plus the two recorders.
 *
 * Wrapped rather than recorded inside {@link FakeCatalogStore} so a write the
 * *fixture* performs — the intruder below — is not counted as a write this
 * surface performed.
 *
 * **Feature 100 (T514) — the recording points, and why they are these.** `saveLayer`
 * was one call and the recorder sat on it. A package publish is two passes, so
 * there are two:
 *
 *   `saveDraftLayer`  the draft pass, recorded only when the verdict says a record
 *                     LANDED. The call is not the write any more: the revision gate
 *                     moved inside the store, so a stale layer is a call that
 *                     returns `stale` having written nothing, and recording the call
 *                     would report a write that never happened. `unchanged` writes
 *                     nothing either, by FR-011a, so it is not a write here.
 *   `publishLayer`    the publish pass, recorded with the ids it named, because
 *                     FR-039a is a claim about which ids a publication carries and
 *                     nothing weaker can catch a layer that named one too many.
 *
 * That is what keeps `writes` able to say "refused before any write" the way the
 * `updateConfig` recorder it replaces could.
 */
function recordingStore(store: Store): CatalogStore {
  return {
    read: () => store.catalog.read(),
    applyLifecycleWrite: (write) => store.catalog.applyLifecycleWrite(write),
    saveDraftLayer: async (request) => {
      const outcome = await store.catalog.saveDraftLayer(request);
      if (outcome.outcome === 'saved' || outcome.outcome === 'partial') {
        store.writes.push(RECORDED_KEY_OF[request.kind]);
      }
      return outcome;
    },
    publishLayer: async (request) => {
      const outcome = await store.catalog.publishLayer(request);
      if (outcome.outcome === 'published') {
        store.published.push({ kind: request.kind, ids: [...request.ids] });
      }
      return outcome;
    },
    readVersion: (kind, id, versionId) => store.catalog.readVersion(kind, id, versionId),
    listVersions: (kind, id) => store.catalog.listVersions(kind, id),
    listDefinitions: (kind) => store.catalog.listDefinitions(kind)
  };
}

/** The row another window writes to move the Phase catalog out from under a plan. */
const INTRUDER_PHASE = Object.freeze({
  id: 'parity-intruder',
  name: 'Intruder',
  version: 1,
  instruction: 'Intrude.'
});

/**
 * Another window saves into the Phase catalog, moving its revision.
 *
 * Feature 099 (T496f, FR-044) — this was an assignment to `store.phases.user`,
 * which changed the rows the revision was derived FROM. A revision belongs to the
 * store now, so the only way to move it is to save, which is also what actually
 * happens in the situation this stands for. The save goes to the fixture's store
 * directly rather than through {@link recordingStore}: it is not a write either
 * surface performed, and counting it would make the `writes` assertions read an
 * intrusion as a save the import made.
 *
 * Feature 100 (T514) — a DRAFT write, which is the sharper form of the same
 * intrusion. It moves the Phase manifest revision, which is all the staleness gate
 * reads, while leaving the Active pointer where it was — so the effective catalog
 * the cases compare afterwards is untouched and the refusal cannot be confused
 * with a disagreement about rows. It is also what the other window would really
 * have done: the Builder's own edits land as drafts (FR-041).
 */
async function intrudeOnPhases(store: Store): Promise<void> {
  const outcome = await store.catalog.saveDraftLayer({
    kind: 'phase',
    definitions: [{ id: INTRUDER_PHASE.id, body: INTRUDER_PHASE }],
    expectedRevision: store.catalog.revisionOf('phase')
  });
  expect(outcome.outcome, 'the intruder save did not land').toBe('saved');
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
 * The dependency bag both surfaces read the catalog through.
 *
 * `RouterDeps` satisfies `ExchangeDeps` structurally, which is the whole point of
 * the extracted service ports — the same object is handed to the router and to
 * the headless entrypoint, so a divergence cannot be an artifact of two differently
 * shaped fixtures.
 */
function depsFor(store: Store, bytes?: Uint8Array) {
  // Feature 100 (T514, FR-047) — the real six operations over the RECORDING store,
  // not over the fixture's own. The recorders are what the write assertions read,
  // and a lifecycle built over the bare store would write past them; building it
  // here rather than with `fakeCatalogLifecycle` is what puts the wrapper
  // underneath. Everything above the disk — the validation, the reference scan,
  // the two-pass publish — is the shipped code, which is the point: both surfaces
  // reach one implementation of it.
  const recording = recordingStore(store);
  const lifecycle = createHostCatalogLifecycle(recording, () => '');
  if (lifecycle === null) throw new Error('unreachable: a store was supplied');
  return {
    catalogLifecycle: lifecycle,
    // Feature 099 (T496f, FR-041) — the three readers answered a `{user,
    // workspace}` pair whose revision the reader derived; they answer the store's
    // rows and the store's revision now. Both surfaces read through the same
    // three, which is what the pair was here to guarantee and still is.
    readPhaseConfig: () => ({
      rows: store.catalog.rowsOf('phase'),
      revision: store.catalog.revisionOf('phase')
    }),
    readPipelineConfig: () => ({
      rows: store.catalog.rowsOf('pipeline'),
      revision: store.catalog.revisionOf('pipeline')
    }),
    readWorkflowConfig: () => ({
      rows: store.catalog.rowsOf('workflow'),
      revision: store.catalog.revisionOf('workflow')
    }),
    readModelsConfig: () => store.models,
    catalogStore: recording,
    // A store write raises no configuration event, so the handler re-reads
    // explicitly (T493b). Nothing in this fixture caches a catalog across a
    // write, so the re-read has nothing to do — but the port must be present, or
    // every save would take the "wired no store" arm.
    refreshCatalog: async (): Promise<void> => undefined,
    ...(bytes !== undefined
      ? { openProcessYamlDocument: async () => ({ outcome: 'read' as const, bytes }) }
      : {}),
    // Feature 099 (T493d, T496f, FR-054) — this accepted four keys and a scope.
    // The Model Catalog is the only catalog still written through configuration,
    // so any other key arriving here is a handler writing where it must not. The
    // assertion is what says so, not the type: the bag is cast to `RouterDeps`,
    // which would let a wider call through silently.
    updateConfig: async (key: string, value: unknown) => {
      expect(key).toBe('models');
      store.writes.push('models');
      store.models = value as ModelsLayer;
    },
    executeCommand: vi.fn(),
    queueRemover: { remove: vi.fn() },
    isPrimary: () => true,
    isTrusted: () => true,
    audit: { append: async () => undefined },
    logger: logger()
  } as unknown as RouterDeps;
}

let dispatched = 0;

/**
 * Dispatch one command through the real router and return its ack.
 *
 * A fresh correlation id per dispatch: `MutationCommandExecutor` caches acks by
 * correlation id, so a reused one would replay the previous command's answer and
 * every write after the first would assert nothing.
 */
async function dispatch(
  deps: RouterDeps,
  type: string,
  payload: unknown
): Promise<CommandAckMessage> {
  dispatched += 1;
  const acks: CommandAckMessage[] = [];
  await new MessageRouter(deps).dispatch(
    {
      type,
      correlationId: `parity-${dispatched}-${type}`,
      payload: payload ?? {}
    } as unknown as SidebarCommand,
    async (message) => {
      acks.push(message);
      return true;
    }
  );
  const ack = acks[0];
  expect(ack, `no ack for ${type}`).toBeDefined();
  return ack!;
}

// ---------------------------------------------------------------------------
// Surface 1 — automation
// ---------------------------------------------------------------------------

function bytesOf(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

async function headlessPreview(store: Store, text: string): Promise<ImportPlan> {
  const result = await previewProcessDocument(depsFor(store), { bytes: bytesOf(text) });
  if (!('outcome' in result) || result.outcome !== 'planned') {
    throw new Error(`headless preview did not plan: ${JSON.stringify(result)}`);
  }
  return result.plan;
}

/**
 * The write port is the router, so the headless import reaches the same handler
 * the operator's does. Injecting a stub here instead would leave the two arms
 * comparing a real publication against a fake one.
 *
 * **The ack-to-outcome seam.** `ImportWritePort` speaks `PackagePublishOutcome`
 * while the router speaks `CommandAckMessage`, so this reads one back as the other.
 * In production nothing crosses that seam: the automation adapter holds
 * `lifecycle.publishPackage` directly and the outcome never becomes an ack first.
 * It is done here anyway, rather than handing the port the lifecycle, because the
 * whole subject of this file is that both surfaces reach the same HANDLER — the
 * pre-checks, the trust gate, and the audit envelope all live there, and a port
 * wired past them would compare two different amounts of code.
 *
 * The mapping is faithful in the direction that matters — which arm — and lossy in
 * two details it names. A `partial` ack reports per-layer COUNTS, not ids, so the
 * reconstructed `published` layers carry their kinds and empty id lists. And no ack
 * carries `pruned` at all: what retention removed reaches the operator through the
 * handler's log, not through the reply, so a reconstruction cannot recover it and
 * says so with an empty list rather than a guess.
 * {@link packageResults} reads only the kinds, so nothing downstream sees either gap,
 * and the raw acks are returned alongside for the assertions that need the
 * handler's own words.
 */
function packageWritePort(deps: RouterDeps, acks: CommandAckMessage[]): ImportWritePort {
  return {
    publishPackage: async (request: PackagePublishRequest): Promise<PackagePublishOutcome> => {
      const ack = await dispatch(deps, CMD_PUBLISH_PACKAGE, request);
      acks.push(ack);
      if (ack.status === 'accepted') {
        const result = ack.result as { readonly published: readonly PackagePublishedLayer[] };
        return { outcome: 'published', published: result.published, pruned: [] };
      }
      if (ack.reason === 'package-partial') {
        const result = ack.result as {
          readonly published: readonly { readonly kind: CatalogKind }[];
          readonly draftedOnly: readonly CatalogKind[];
          readonly failedKind: CatalogKind;
          readonly cause: string;
        };
        return {
          outcome: 'partial',
          published: result.published.map((layer) => ({ kind: layer.kind, ids: [] })),
          draftedOnly: result.draftedOnly,
          failedKind: result.failedKind,
          cause: result.cause,
          pruned: []
        };
      }
      const reason =
        ack.reason === 'stale-catalog'
          ? 'stale-layer'
          : ack.reason === 'validation-failed'
            ? 'validation-failed'
            : 'store-refused';
      return {
        outcome: 'refused',
        refusal: { reason, kind: null, defects: [], storeReason: ack.reason }
      };
    },
    saveModels: async (payload): Promise<LayerSaveAck> => {
      const ack = await dispatch(deps, CMD_SAVE_MODELS, payload);
      acks.push(ack);
      return ack.status === 'accepted'
        ? { status: 'accepted', result: ack.result }
        : { status: 'rejected', reason: ack.reason ?? 'unknown', result: ack.result };
    }
  };
}

/** What one arm's confirmation did: the port's report, and the acks behind it. */
interface HeadlessCommit {
  readonly result: ImportProcessDocumentResult;
  /** The router's own acks, in send order — the handler's words, not derived ones. */
  readonly acks: readonly CommandAckMessage[];
}

async function headlessImport(store: Store, plan: ImportPlan): Promise<HeadlessCommit> {
  const deps = depsFor(store);
  const acks: CommandAckMessage[] = [];
  const result = await importProcessDocument(packageWritePort(deps, acks), { plan });
  return { result, acks };
}

// ---------------------------------------------------------------------------
// Surface 2 — operator
// ---------------------------------------------------------------------------

async function sidebarPreview(store: Store, text: string): Promise<ImportPlan> {
  const ack = await dispatch(depsFor(store, bytesOf(text)), CMD_PREFLIGHT_PROCESS_YAML, {});
  const result = ack.result as PreflightProcessYamlResult;
  if (result.outcome !== 'planned') {
    throw new Error(`sidebar preflight did not plan: ${JSON.stringify(result)}`);
  }
  return result.plan;
}

type ImportRow<K extends ImportPlanRow['resourceKind']> = Extract<
  ImportPlanRow,
  { outcome: 'import'; resourceKind: K }
>;

function importRows<K extends ImportPlanRow['resourceKind']>(
  plan: ImportPlan,
  resourceKind: K
): readonly ImportRow<K>[] {
  return plan.rows.filter(
    (row): row is ImportRow<K> => row.outcome === 'import' && row.resourceKind === resourceKind
  );
}

/** One layer's publication, as the operator's confirmation sends it. */
interface LayerWrite {
  readonly key: LayerKey;
  readonly payload: PublishPackageCommand['payload'];
}

/** The layers a request declares — the unit the two surfaces are compared on. */
type PackageLayers = PublishPackageCommand['payload']['layers'];

/**
 * `buildImportWrites` plus the three `save*` functions it feeds, mirrored from
 * {@link SIDEBAR_COMPOSER_SOURCE} and `webview-ui/src/lib/save-{phases,pipelines,
 * workflows}.ts`.
 *
 * Kept structurally identical to the originals rather than tidied: each layer
 * carries the revision the PLAN was computed against, and nothing at all is
 * returned when a layer has rows but no revision to gate them with.
 *
 * Feature 099 (T496f, T489a, FR-043/FR-044) — the original's `scope` parameter
 * and the `scope` field on all three payloads are gone, and each layer's revision
 * is read as the plain string the plan now carries rather than indexed out of a
 * per-scope pair.
 *
 * **Feature 100 (T514, FR-039a, FR-039b) — two changes, and the mirror follows
 * both.** The composer's rows no longer carry the held layer: a publication is a
 * merge, and naming a stored id would publish that id's head, so the concatenation
 * is gone from the original and from here. And the three `CMD_SAVE_*` commands are
 * gone — each `save*` wraps its layer in a single-layer `CMD_PUBLISH_PACKAGE`. The
 * composer's `mutation` intent stops at those functions and is never sent, so the
 * mirror does not carry it: mirroring a field no operator's request contains would
 * compare the headless composer against a shape the host has no arm for.
 */
function sidebarWrites(plan: ImportPlan): readonly LayerWrite[] {
  const phases = importRows(plan, 'phase');
  const pipelines = importRows(plan, 'pipeline');
  const workflows = importRows(plan, 'workflow');
  const pipelineRevision = plan.computedAgainstPipelineRevision;
  const workflowRevision = plan.computedAgainstWorkflowRevision;
  if (pipelines.length > 0 && pipelineRevision === undefined) return [];
  if (workflows.length > 0 && workflowRevision === undefined) return [];

  const writes: LayerWrite[] = [];
  if (phases.length > 0) {
    writes.push({
      key: 'phases',
      payload: {
        layers: [
          {
            kind: 'phase',
            expectedRevision: plan.computedAgainstRevision,
            definitions: phases.map(({ definition }) => {
              const { phaseId, ...declared } = definition;
              return { id: phaseId, body: { id: phaseId, ...declared } };
            })
          }
        ]
      }
    });
  }
  if (pipelines.length > 0 && pipelineRevision !== undefined) {
    writes.push({
      key: 'pipelines',
      payload: {
        layers: [
          {
            kind: 'pipeline',
            expectedRevision: pipelineRevision,
            definitions: pipelines.map(({ definition }) => {
              const { pipelineId, phaseIds, ...declared } = definition;
              return {
                id: pipelineId,
                body: { id: pipelineId, phases: [...phaseIds], ...declared }
              };
            })
          }
        ]
      }
    });
  }
  if (workflows.length > 0 && workflowRevision !== undefined) {
    writes.push({
      key: 'workflows',
      payload: {
        layers: [
          {
            kind: 'workflow',
            expectedRevision: workflowRevision,
            definitions: workflows.map(({ definition }) => ({
              id: definition.workflowId,
              body: { ...definition }
            }))
          }
        ]
      }
    });
  }
  return writes;
}

/** Every layer the operator's requests declared, concatenated in send order. */
function sentLayers(writes: readonly LayerWrite[]): PackageLayers {
  return writes.flatMap((write) => write.payload.layers);
}

interface SidebarCommit {
  readonly results: readonly { readonly key: LayerKey; readonly ack: CommandAckMessage }[];
  readonly outcome: 'imported' | 'partial' | 'failed';
  readonly sent: readonly LayerWrite[];
}

async function sidebarImport(store: Store, plan: ImportPlan): Promise<SidebarCommit> {
  const deps = depsFor(store);
  const sent = sidebarWrites(plan);
  const results: { key: LayerKey; ack: CommandAckMessage }[] = [];
  for (const write of sent) {
    const ack = await dispatch(deps, CMD_PUBLISH_PACKAGE, write.payload);
    results.push({ key: write.key, ack });
    // A rejection stops the sequence. The order exists so a layer never lands
    // ahead of its dependency; carrying on past a refusal would be exactly that.
    if (ack.status !== 'accepted') break;
  }
  const accepted = results.filter((result) => result.ack.status === 'accepted').length;
  const outcome =
    results.length === 0
      ? 'failed'
      : accepted === results.length
        ? 'imported'
        : accepted === 0
          ? 'failed'
          : 'partial';
  return { results, outcome, sent };
}

// -- Export, both surfaces (T033) -------------------------------------------

/**
 * The operator's export. The save seam is injected and captures rather than
 * writes, which is also the only way to observe the document at all: no path
 * crosses this boundary in either direction, so the dialog is where the text
 * stops.
 */
async function sidebarExport(
  store: Store,
  selection: ExportProcessYamlRequest
): Promise<{ readonly ack: CommandAckMessage; readonly text: string | null }> {
  let captured: string | null = null;
  const deps = {
    ...(depsFor(store) as unknown as Record<string, unknown>),
    saveProcessYamlDocument: async (document: {
      suggestedFileName: string;
      text: string;
    }): Promise<{ outcome: 'saved' }> => {
      captured = document.text;
      return { outcome: 'saved' };
    }
  } as unknown as RouterDeps;
  const ack = await dispatch(deps, CMD_EXPORT_PROCESS_YAML, selection);
  return { ack, text: captured };
}

async function headlessExport(
  store: Store,
  selection: ExportProcessYamlRequest
): Promise<Uint8Array> {
  const result = await exportProcessDefinitions(depsFor(store), { selection });
  if (!('outcome' in result) || result.outcome !== 'serialized') {
    throw new Error(`headless export did not serialize: ${JSON.stringify(result)}`);
  }
  return result.bytes;
}

/**
 * A store holding the whole self-contained package, imported through the real
 * writes, plus a seeded Model Catalog so the new export case below (T013)
 * serializes actual groups rather than three empty ones. The Workflow package
 * import never touches `models` (FR-015 rules out a mixed document), so the
 * seed passes through untouched for every other case this store feeds.
 */
async function storeWithPackage(): Promise<Store> {
  const store = makeStore({ models: MODEL_CATALOG_SEED });
  const plan = await headlessPreview(store, SELF_CONTAINED);
  const { result } = await headlessImport(store, plan);
  expect(result.outcome, 'export fixture failed to import').toBe('imported');
  return store;
}

/**
 * A Pipeline whose referenced Phase is absent. The reference-relaxed pass still
 * resolves the Pipeline itself, so an `include-referenced` export of it reaches the
 * *dependency* arm of the refusal — the one arm that carries an identifier, and
 * therefore the only arm where a rebuilt refusal differs from a spread one.
 */
const GHOST_PIPELINE = Object.freeze({
  id: 'parity-ghost',
  name: 'Parity Ghost',
  version: 1,
  phases: ['parity-missing-phase']
});

/** Both refusal arms: the one that carries only a reason, and the one that names a dependency. */
const EXPORT_REFUSALS: readonly {
  readonly label: string;
  readonly seed: { readonly phases?: readonly unknown[]; readonly pipelines?: readonly unknown[] };
  readonly selection: ExportProcessYamlRequest;
  readonly expected: Record<string, unknown>;
}[] = [
  {
    label: 'an id no layer carries',
    seed: {},
    selection: { resourceKind: 'phase', resourceId: 'no-such-phase' },
    expected: { outcome: 'unavailable', reason: 'not-found' }
  },
  {
    label: 'a referenced Phase that does not resolve',
    seed: { pipelines: [GHOST_PIPELINE] },
    selection: {
      resourceKind: 'pipeline',
      resourceId: 'parity-ghost',
      inclusion: 'include-referenced'
    },
    expected: {
      outcome: 'unavailable',
      reason: 'dependency-does-not-resolve',
      unresolvedDependency: { kind: 'phase', resourceId: 'parity-missing-phase' }
    }
  }
];

/** Every inclusion mode the three kinds admit, so no serializer branch is unexercised. */
const EXPORTS: readonly { readonly label: string; readonly selection: ExportProcessYamlRequest }[] =
  [
    { label: 'a Phase', selection: { resourceKind: 'phase', resourceId: 'parity-specify' } },
    {
      label: 'a Pipeline, references only',
      selection: {
        resourceKind: 'pipeline',
        resourceId: 'parity-authoring',
        inclusion: 'references-only'
      }
    },
    {
      label: 'a Pipeline and its Phases',
      selection: {
        resourceKind: 'pipeline',
        resourceId: 'parity-authoring',
        inclusion: 'include-referenced'
      }
    },
    {
      label: 'a Workflow, references only',
      selection: {
        resourceKind: 'workflow',
        resourceId: 'parity-flow',
        inclusion: 'references-only'
      }
    },
    {
      label: 'a Workflow and its Pipelines',
      selection: {
        resourceKind: 'workflow',
        resourceId: 'parity-flow',
        inclusion: 'include-pipelines'
      }
    },
    {
      label: 'a Workflow and its whole closure',
      selection: {
        resourceKind: 'workflow',
        resourceId: 'parity-flow',
        inclusion: 'include-closure'
      }
    },
    // Model Catalog (T013): no `resourceId`, no `inclusion` — there is exactly
    // one catalog and no dependency bundling (contract §3). It carries no
    // `EXPORT_REFUSALS` counterpart because FR-007 never routes it to the
    // `unavailable` branch; an empty catalog is still a valid document.
    { label: 'the Model Catalog', selection: { resourceKind: 'modelCatalog' } }
  ];

// ---------------------------------------------------------------------------
// What the two are compared on
// ---------------------------------------------------------------------------

/**
 * The four fields T032 names, per row: the action, the reason, the resource id,
 * and the blocked dependencies.
 *
 * `reason` is the row's whole reason object for a `blocked` row — code, dependency,
 * and `via` — because a comparison on the code alone would agree while the two
 * surfaces pointed an operator at different dependencies. `defects` come along for
 * an `invalid` row on the same argument.
 */
function comparableRow(row: ImportPlanRow): Record<string, unknown> {
  return {
    action: row.outcome,
    resourceKind: row.resourceKind,
    resourceId: row.resourceId,
    reason: row.outcome === 'blocked' ? row.reason : undefined,
    blockedDependencies:
      row.outcome === 'blocked'
        ? [row.reason.dependency, ...(row.reason.code === 'dependency-blocked' ? [row.reason.via] : [])]
        : undefined,
    // `row.resourceKind !== 'modelCatalog'` narrows out `ModelCatalogSkipRow`,
    // whose skip reasons (`already-exists` / `unrecognized-backend`) are not a
    // presence status.
    //
    // Feature 099 (T496f, FR-049) — the pair was `{ in: row.presentIn, status }`.
    // `presentIn` named the layer the claiming row sat in and there is one layer,
    // so the field is deleted rather than answered with a constant. `status` is
    // the half an operator acts on and the half the two surfaces could disagree
    // about, and it stays inside the comparison.
    presence:
      row.outcome === 'skip' && row.resourceKind !== 'modelCatalog'
        ? { status: row.presentRowStatus }
        : undefined,
    defects: row.outcome === 'invalid' ? row.defects : undefined,
    // Model Catalog's own two fields (T013), named apart from `reason` above:
    // that field is typed to a `blocked` row's reason object, and a Model
    // Catalog skip's reason is one of two plain strings — folding the two
    // together would make rows that differ only in backend or in skip reason
    // compare equal.
    backend:
      (row.outcome === 'import' || row.outcome === 'skip') && row.resourceKind === 'modelCatalog'
        ? row.backend
        : undefined,
    modelCatalogSkipReason:
      row.resourceKind === 'modelCatalog' && row.outcome === 'skip' ? row.reason : undefined
  };
}

function comparablePlan(plan: ImportPlan): Record<string, unknown> {
  return {
    rows: plan.rows.map(comparableRow),
    counts: plan.counts,
    computedAgainstRevision: plan.computedAgainstRevision,
    computedAgainstPipelineRevision: plan.computedAgainstPipelineRevision,
    computedAgainstWorkflowRevision: plan.computedAgainstWorkflowRevision,
    computedAgainstModelsRevision: plan.computedAgainstModelsRevision
  };
}

/**
 * The three effective catalogs a store resolves to, ids and all.
 *
 * Feature 099 (T496f, FR-042) — each resolver took three layer arrays and a
 * shipped one; each takes one row list and the revision the store read them at.
 * The comparison this feeds is unchanged: what the two surfaces must agree on is
 * the definitions the catalog resolves to afterwards, and that is what still
 * comes back.
 */
function effectiveCatalogs(store: Store) {
  const phaseCatalog = resolvePhaseCatalog({
    rows: store.catalog.rowsOf('phase'),
    revision: store.catalog.revisionOf('phase')
  }).effective;
  const pipelineCatalog = resolvePipelineCatalog({
    rows: store.catalog.rowsOf('pipeline'),
    revision: store.catalog.revisionOf('pipeline'),
    phaseCatalog
  });
  const workflowCatalog = resolveWorkflowCatalog({
    rows: store.catalog.rowsOf('workflow'),
    revision: store.catalog.revisionOf('workflow'),
    pipelineCatalog
  });
  return {
    phases: phaseCatalog,
    pipelines: pipelineCatalog.effective,
    workflows: workflowCatalog.effective
  };
}

const IMPORTED_IDS = {
  phases: 'parity-specify',
  pipelines: 'parity-authoring',
  workflows: 'parity-flow'
} as const;

beforeEach(() => {
  capabilities.clear();
  dispatched = 0;
});

describe('the fixture drives both surfaces for real (positive controls)', () => {
  it('names a composer source that exists, so the mirror can be checked', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(__dirname, '../../..', SIDEBAR_COMPOSER_SOURCE),
      'utf8'
    );
    // Not a parity assertion — a staleness one. If the original is renamed or its
    // composer removed, the mirror below is describing something that no longer
    // exists and the header's claim about it is false.
    expect(source).toContain('export function buildImportWrites(');
  });

  it('reaches all three writes and changes the catalog (positive control)', async () => {
    // Without this, two surfaces that both refused before writing anything would
    // agree on an empty catalog and every assertion below would hold vacuously.
    const store = makeStore();
    const plan = await headlessPreview(store, SELF_CONTAINED);
    const { result } = await headlessImport(store, plan);

    expect(result.outcome).toBe('imported');
    expect(store.writes).toEqual(['phases', 'pipelines', 'workflows']);
    // Feature 100 (T514, FR-035) — and every drafted layer was then PUBLISHED, in
    // the same dependency order. Without this the `writes` line above would be
    // satisfied by an import that left the whole document as drafts, which is a
    // different outcome the operator reads differently.
    expect(store.published.map((layer) => layer.kind)).toEqual([
      'phase',
      'pipeline',
      'workflow'
    ]);
    const catalogs = effectiveCatalogs(store);
    expect(catalogs.phases.map((row) => row.phaseId)).toContain(IMPORTED_IDS.phases);
    expect(catalogs.pipelines.map((row) => row.pipelineId)).toContain(IMPORTED_IDS.pipelines);
    expect(catalogs.workflows.map((row) => row.workflowId)).toContain(IMPORTED_IDS.workflows);
  });

  it('plans against three catalog revisions that differ (positive control)', async () => {
    // A probe found this the hard way. If the three catalogs carry the same
    // revision, the three `expectedRevision` fields are interchangeable and a
    // Pipeline write gated on the PHASE catalog's revision compares equal to a
    // correct one. This control is what gives the payload comparison below the
    // resolution to see that mistake, and it fails if a future fixture flattens
    // them again.
    //
    // Feature 099 (T496f, FR-044) — the revisions were derived from the seeded
    // rows, so the fixture had to seed two catalogs differently to pull them
    // apart, and the case was named for that seeding. A revision is the store's
    // per-kind manifest revision now, so they are distinct by construction and
    // the seeding is no longer what produces the distinction. The property is the
    // same one and is still asserted here rather than assumed: it is the store's
    // guarantee, and a fixture is exactly where a guarantee gets quietly lost.
    const plan = await headlessPreview(makeStore(SEEDED), SELF_CONTAINED);
    const revisions = [
      plan.computedAgainstRevision,
      plan.computedAgainstPipelineRevision,
      plan.computedAgainstWorkflowRevision
    ];
    expect(revisions.every((revision) => revision !== undefined)).toBe(true);
    expect(new Set(revisions).size).toBe(3);
  });

  it('produces all four plan outcomes from the mixed document (positive control)', async () => {
    const store = makeStore({ pipelines: [HELD_PIPELINE] });
    const plan = await headlessPreview(store, MIXED);

    expect(new Set(plan.rows.map((row) => row.outcome))).toEqual(
      new Set(['import', 'skip', 'blocked', 'invalid'])
    );
    // A row-by-row comparison over a single outcome kind would not exercise the
    // reason or defect fields at all.
    expect(plan.rows.length).toBeGreaterThanOrEqual(4);
  });
});

describe('previewProcessDocument matches the sidebar preflight (T032, FR-002, SC-001)', () => {
  it.each(DOCUMENTS)('plans $label identically on both surfaces', async ({ text }) => {
    // Two stores seeded the same way, so neither surface can be reading a catalog
    // the other cannot see.
    const headlessStore = makeStore({ pipelines: [HELD_PIPELINE] });
    const sidebarStore = makeStore({ pipelines: [HELD_PIPELINE] });

    const headless = await headlessPreview(headlessStore, text);
    const sidebar = await sidebarPreview(sidebarStore, text);

    expect(comparablePlan(sidebar)).toEqual(comparablePlan(headless));
  });

  it('agrees on the blocked row down to the dependency it names', async () => {
    // The narrow assertion behind the broad one. `dependency-absent` on
    // `no-such-pipeline` is what tells an operator what to supply; a comparison
    // that stopped at `outcome: 'blocked'` would agree while the two surfaces sent
    // them looking for different things.
    const headless = await headlessPreview(makeStore({ pipelines: [HELD_PIPELINE] }), MIXED);
    const sidebar = await sidebarPreview(makeStore({ pipelines: [HELD_PIPELINE] }), MIXED);

    const blockedOf = (plan: ImportPlan) => plan.rows.filter((row) => row.outcome === 'blocked');
    const headlessBlocked = blockedOf(headless);
    expect(headlessBlocked).toHaveLength(1);
    expect(headlessBlocked[0]).toMatchObject({
      resourceId: 'parity-flow',
      reason: { code: 'dependency-absent', dependency: { resourceId: 'no-such-pipeline' } }
    });
    expect(blockedOf(sidebar).map(comparableRow)).toEqual(headlessBlocked.map(comparableRow));
  });

  it('changes nothing on either surface — preview is read-only (FR-002)', async () => {
    const headlessStore = makeStore({ pipelines: [HELD_PIPELINE] });
    const sidebarStore = makeStore({ pipelines: [HELD_PIPELINE] });

    await headlessPreview(headlessStore, SELF_CONTAINED);
    await sidebarPreview(sidebarStore, SELF_CONTAINED);

    expect(headlessStore.writes).toEqual([]);
    expect(sidebarStore.writes).toEqual([]);
  });
});

describe('importProcessDocument matches the sidebar commit (T032, FR-008, SC-001)', () => {
  /**
   * Both documents, and both stores seeded, because a probe showed the unseeded
   * single-document form could not tell a correct write from one gated on another
   * layer's revision — see the seeded control in the positive-controls block.
   */
  it.each(DOCUMENTS)('declares the same layers, in order, for $label', async ({ text }) => {
    const headlessStore = makeStore(SEEDED);
    const sidebarStore = makeStore(SEEDED);
    const headlessPlan = await headlessPreview(headlessStore, text);
    const sidebarPlan = await sidebarPreview(sidebarStore, text);

    // The operator's requests, from the mirrored composer, flattened to the layers
    // they declare. Three single-layer publications against automation's one
    // three-layer publication (see the header) — so the comparison is over the
    // layers, which is the unit both surfaces address a catalog in.
    const operator = sentLayers(sidebarWrites(sidebarPlan));

    // The automation request, recorded at the port rather than inferred. The
    // outcome is stubbed published so the call is observed rather than gated: a
    // real store here would refuse nothing, but stubbing keeps this case about the
    // request and leaves the write behaviour to the cases below.
    let sent: PackageLayers | null = null;
    await importProcessDocument(
      {
        publishPackage: async (request): Promise<PackagePublishOutcome> => {
          sent = request.layers;
          return { outcome: 'published', published: [], pruned: [] };
        },
        saveModels: async (): Promise<LayerSaveAck> => ({ status: 'accepted' })
      },
      { plan: headlessPlan }
    );

    expect(sent, 'automation sent no publication at all').not.toBeNull();
    // Exact, not `objectContaining`: a field one surface carries and the other
    // does not is precisely the divergence this file exists to catch, and the
    // per-layer `expectedRevision` is one an operator's recovery depends on.
    expect(sent).toEqual(operator);
  });

  it('names the document its own ids in every layer, on both surfaces (FR-039a)', async () => {
    // The narrow claim behind the payload comparison, stated as its own case
    // because the comparison alone would agree on two surfaces that BOTH named a
    // stored id. A publication publishes the head of every id it names, so a layer
    // carrying the held rows would promote an operator's pending draft of a
    // definition this document says nothing about.
    const headlessStore = makeStore(SEEDED);
    const sidebarStore = makeStore(SEEDED);
    const headlessPlan = await headlessPreview(headlessStore, SELF_CONTAINED);
    const sidebarPlan = await sidebarPreview(sidebarStore, SELF_CONTAINED);

    await headlessImport(headlessStore, headlessPlan);
    await sidebarImport(sidebarStore, sidebarPlan);

    // Read off the store, not off the request: what FR-039a bounds is what the
    // publish pass was asked to make live, and that is the last thing the ids
    // pass through before the pointer moves. Expected from the PLAN's import rows
    // rather than a literal list, so the claim is "exactly what this document said
    // to import" and cannot be satisfied by a hand-kept list drifting alongside
    // the fixture document.
    const expected = [
      { kind: 'phase', ids: importRows(headlessPlan, 'phase').map((row) => row.resourceId) },
      { kind: 'pipeline', ids: importRows(headlessPlan, 'pipeline').map((row) => row.resourceId) },
      { kind: 'workflow', ids: importRows(headlessPlan, 'workflow').map((row) => row.resourceId) }
    ];
    expect(expected.every((layer) => layer.ids.length > 0), 'a layer imported nothing').toBe(true);
    expect(headlessStore.published).toEqual(expected);
    expect(sidebarStore.published).toEqual(headlessStore.published);
    // And the seeded rows are still exactly where they were: untouched by a write
    // that never named them (FR-039b), and never published by one (FR-039a).
    for (const store of [headlessStore, sidebarStore]) {
      expect(store.catalog.stateOf('phase', HELD_PHASE.id)).toBe('active');
      expect(store.catalog.stateOf('pipeline', HELD_PIPELINE.id)).toBe('active');
    }
  });

  it.each([
    { label: 'a self-contained package', text: SELF_CONTAINED, held: [] as readonly unknown[] },
    { label: 'a document with one row of each outcome', text: MIXED, held: [HELD_PIPELINE] }
  ])('leaves the same effective catalogs after importing $label', async ({ text, held }) => {
    const headlessStore = makeStore({ pipelines: held });
    const sidebarStore = makeStore({ pipelines: held });

    const headlessResult = await headlessImport(
      headlessStore,
      await headlessPreview(headlessStore, text)
    );
    const sidebarResult = await sidebarImport(
      sidebarStore,
      await sidebarPreview(sidebarStore, text)
    );

    expect(headlessResult.result.outcome).toBe(sidebarResult.outcome);
    // Feature 100 (T514) — per-layer results still line up one-for-one on a
    // document that lands, because automation reports one result per declared
    // layer and the operator sends one layer per request. They would NOT line up
    // on a refusal: automation's single request refuses every declared layer at
    // once while the operator's sequence stops at the first, which is the shape
    // the staleness case below asserts on the acks instead.
    expect(headlessResult.result.results.map((result) => [result.key, result.ack.status])).toEqual(
      sidebarResult.results.map((result) => [result.key, result.ack.status])
    );
    expect(headlessStore.writes).toEqual(sidebarStore.writes);
    expect(headlessStore.published).toEqual(sidebarStore.published);
    // The property the requirement is about: not that the two wrote the same
    // bytes, but that the catalog afterwards resolves to the same definitions.
    expect(effectiveCatalogs(headlessStore)).toEqual(effectiveCatalogs(sidebarStore));
  });

  it('writes fewer layers, identically, when the document declares fewer', async () => {
    // The mixed document's root is blocked, so the Workflow layer is never
    // written. A surface that wrote a fixed three would diverge here and nowhere
    // else.
    const headlessStore = makeStore({ pipelines: [HELD_PIPELINE] });
    const sidebarStore = makeStore({ pipelines: [HELD_PIPELINE] });

    await headlessImport(headlessStore, await headlessPreview(headlessStore, MIXED));
    await sidebarImport(sidebarStore, await sidebarPreview(sidebarStore, MIXED));

    expect(headlessStore.writes).toEqual(['phases', 'pipelines']);
    expect(sidebarStore.writes).toEqual(headlessStore.writes);
  });

  it('refuses a stale revision identically on both surfaces (FR-008)', async () => {
    // The plan is computed, then the catalog moves underneath it. Both surfaces
    // carry the plan's revision into the write, so both must report the staleness
    // rather than overwrite the row that appeared.
    const headlessStore = makeStore();
    const sidebarStore = makeStore();
    const headlessPlan = await headlessPreview(headlessStore, SELF_CONTAINED);
    const sidebarPlan = await sidebarPreview(sidebarStore, SELF_CONTAINED);

    await intrudeOnPhases(headlessStore);
    await intrudeOnPhases(sidebarStore);

    const headlessResult = await headlessImport(headlessStore, headlessPlan);
    const sidebarResult = await sidebarImport(sidebarStore, sidebarPlan);

    expect(headlessResult.result.outcome).toBe('failed');
    expect(sidebarResult.outcome).toBe('failed');
    // Feature 100 (T514) — read off the ROUTER's acks, not off the port's report.
    // The two arms no longer send the same number of commands, so the derived
    // per-layer results differ in length by construction and comparing them would
    // be comparing the derivation rather than the refusal. What parity means here
    // is that the same handler refused both for the same reason, and its own ack
    // is where that is stated. Automation sends one request and gets one refusal;
    // the operator's sequence sends the Phase layer, is refused, and stops.
    const reasonsOf = (acks: readonly CommandAckMessage[]) =>
      acks.map((ack) => (ack.status === 'accepted' ? 'accepted' : ack.reason));
    expect(reasonsOf(headlessResult.acks)).toEqual(['stale-catalog']);
    expect(reasonsOf(sidebarResult.results.map((result) => result.ack))).toEqual([
      'stale-catalog'
    ]);
    // Refused before any write, on both: the revision gate lives inside the store
    // now, so this also says the store never drafted a row it then had to leave
    // behind (FR-036), and never published one (FR-039a).
    expect(headlessStore.writes).toEqual([]);
    expect(sidebarStore.writes).toEqual([]);
    expect(headlessStore.published).toEqual([]);
    expect(sidebarStore.published).toEqual([]);
  });
});

describe('exportProcessDefinitions matches the sidebar export (T033, FR-009, SC-002)', () => {
  it('produces a document that previews back to import rows (positive control)', async () => {
    // Two empty buffers compare equal. This is what rules that out: the exported
    // bytes are fed back through the preview path and must plan as a real package,
    // so the byte comparisons below are over a document with content in it.
    const bytes = await headlessExport(await storeWithPackage(), {
      resourceKind: 'workflow',
      resourceId: 'parity-flow',
      inclusion: 'include-closure'
    });
    expect(bytes.byteLength).toBeGreaterThan(0);

    const plan = await headlessPreview(makeStore(), Buffer.from(bytes).toString('utf8'));
    expect(plan.rows.filter((row) => row.outcome === 'import').length).toBeGreaterThanOrEqual(3);
  });

  it.each(EXPORTS)('writes byte-identical documents for $label', async ({ selection }) => {
    // One store, both surfaces: export is read-only, so there is nothing for the
    // two to diverge on except the document itself.
    const store = await storeWithPackage();

    const sidebar = await sidebarExport(store, selection);
    const headless = await headlessExport(store, selection);

    expect(sidebar.ack.status).toBe('accepted');
    expect(sidebar.text).not.toBeNull();

    const operatorBytes = Buffer.from(sidebar.text ?? '', 'utf8');
    const automationBytes = Buffer.from(headless);

    // Compared as text first, because that is the failure a reader can act on...
    expect(automationBytes.toString('utf8')).toBe(operatorBytes.toString('utf8'));
    // ...then as bytes, which is the assertion FR-009 actually makes. The two are
    // the same claim only while one deterministic encoder sits on each path; the
    // second assertion is what notices if that stops being true.
    expect(Buffer.compare(automationBytes, operatorBytes)).toBe(0);
  });

  it('changes nothing on either surface — export is read-only', async () => {
    const store = await storeWithPackage();
    const before = [...store.writes];

    await sidebarExport(store, { resourceKind: 'phase', resourceId: 'parity-specify' });
    await headlessExport(store, { resourceKind: 'phase', resourceId: 'parity-specify' });

    expect(store.writes).toEqual(before);
  });

  it.each(EXPORT_REFUSALS)(
    'refuses $label identically on both surfaces',
    async ({ seed, selection, expected }) => {
      const store = makeStore(seed);

      const sidebar = await sidebarExport(store, selection);
      const headless = await exportProcessDefinitions(depsFor(store), { selection });

      expect(sidebar.ack.status).toBe('rejected');
      expect(sidebar.text).toBeNull();
      // Asserted against a literal BEFORE the two are compared to each other. A
      // probe that rebuilt the headless refusal as `{ outcome, reason }` — dropping
      // the identifier FR-017 requires it to carry — passed a surface-to-surface
      // comparison on the `not-found` arm, where the rebuild happens to be
      // identical. Only the dependency arm below distinguishes them, and only the
      // literal says what the payload must actually contain.
      expect(headless).toEqual(expected);
      // Then the parity claim itself. The refusal payload is compared; the ack
      // envelope is not — the transport is the one difference the contract permits.
      expect(headless).toEqual(sidebar.ack.result);
    }
  );
});

// ---------------------------------------------------------------------------
// Model Catalog (T013, FR-002, FR-008, FR-009, FR-011, FR-013, FR-015)
// ---------------------------------------------------------------------------
//
// Import-commit parity here is narrower than the Phase/Pipeline/Workflow
// coverage above, and deliberately so. `cmd-save-models.ts` now runs the full
// gated sequence (T021: revision check, server-side re-plan, merge into the
// current catalog), but the operator-side composer (`buildImportWrites`,
// mirrored above as `sidebarWrites`) still has no Model Catalog branch — T023
// gave the webview a separate, simpler commit path
// (`runModelCatalogImportCommit`) instead of widening `buildImportWrites`,
// because a Model Catalog commit is one scope-less write, not an ordered
// multi-layer sequence. A two-surface "sidebar composer vs. headless
// composer" comparison here would therefore compare the real headless
// composition against a composer that deliberately does not exist. What IS
// true today, and what the tests below prove instead: the headless port
// composes the contract's delta-by-backend payload correctly, that payload
// reaches the real `CMD_SAVE_MODELS` handler and is merged into the current
// catalog exactly as the handler's gated sequence merges it, and whichever
// caller sends that payload gets the identical answer back — including an
// identical refusal when the catalog has moved underneath the plan (T026).

/** Every row this document plans, narrowed to the two Model Catalog arms. */
function modelCatalogRows(
  plan: ImportPlan
): readonly (ModelCatalogImportRow | ModelCatalogSkipRow)[] {
  return plan.rows.filter(
    (row): row is ModelCatalogImportRow | ModelCatalogSkipRow => row.resourceKind === 'modelCatalog'
  );
}

describe('previewProcessDocument matches the sidebar preflight — Model Catalog (T013, FR-002)', () => {
  it('plans the Model Catalog document identically on both surfaces', async () => {
    const headlessStore = makeStore({ models: MODEL_CATALOG_SEED });
    const sidebarStore = makeStore({ models: MODEL_CATALOG_SEED });

    const headless = await headlessPreview(headlessStore, MODEL_CATALOG_DOCUMENT);
    const sidebar = await sidebarPreview(sidebarStore, MODEL_CATALOG_DOCUMENT);

    expect(comparablePlan(sidebar)).toEqual(comparablePlan(headless));
  });

  it('produces one import row and both skip reasons (positive control)', async () => {
    const plan = await headlessPreview(
      makeStore({ models: MODEL_CATALOG_SEED }),
      MODEL_CATALOG_DOCUMENT
    );

    const rows = modelCatalogRows(plan);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.outcome))).toEqual(new Set(['import', 'skip']));
    const skipReasons = rows
      .filter((row): row is ModelCatalogSkipRow => row.outcome === 'skip')
      .map((row) => row.reason);
    expect(new Set(skipReasons)).toEqual(new Set(['already-exists', 'unrecognized-backend']));
    expect(plan.counts).toEqual({ import: 1, skip: 2, blocked: 0, invalid: 0 });
    expect(plan.computedAgainstModelsRevision).toBeDefined();
  });

  it('changes nothing on either surface — preview is read-only (FR-002)', async () => {
    const headlessStore = makeStore({ models: MODEL_CATALOG_SEED });
    const sidebarStore = makeStore({ models: MODEL_CATALOG_SEED });

    await headlessPreview(headlessStore, MODEL_CATALOG_DOCUMENT);
    await sidebarPreview(sidebarStore, MODEL_CATALOG_DOCUMENT);

    expect(headlessStore.writes).toEqual([]);
    expect(sidebarStore.writes).toEqual([]);
    expect(headlessStore.models).toEqual(MODEL_CATALOG_SEED);
    expect(sidebarStore.models).toEqual(MODEL_CATALOG_SEED);
  });
});

describe('importProcessDocument reaches the shared CMD_SAVE_MODELS handler — Model Catalog (T013, FR-008, FR-015)', () => {
  it('sends the import-outcome rows as a delta grouped by backend, and touches no other layer', async () => {
    const store = makeStore({ models: MODEL_CATALOG_SEED });
    const plan = await headlessPreview(store, MODEL_CATALOG_DOCUMENT);

    // Feature 100 (T514, FR-035) — one seam to refuse instead of three. The three
    // per-kind saves collapsed into a single publication, so "touches no other
    // layer" is now the claim that the publication is never sent at all: a
    // Model-Catalog-only document declares no layer for it to carry.
    let sentPayload: unknown;
    const result = await importProcessDocument(
      {
        publishPackage: async (): Promise<PackagePublishOutcome> => {
          throw new Error('publishPackage must not be called for a Model-Catalog-only document');
        },
        saveModels: async (payload) => {
          sentPayload = payload;
          return { status: 'accepted' };
        }
      },
      { plan }
    );

    expect(result.outcome).toBe('imported');
    expect(sentPayload).toEqual({
      models: { claude: ['parity-model-new'] },
      expectedRevision: plan.computedAgainstModelsRevision,
      mutation: { kind: 'import-package' }
    });
  });

  it('reaches the real CMD_SAVE_MODELS handler and merges what it sent into the current catalog (positive control)', async () => {
    // The gated sequence (T021) re-derives the delta server-side and merges
    // it into the CURRENT catalog rather than overwriting, so the stored
    // value is the seed plus the one imported model — not the delta standing
    // alone. This control proves the headless port reaches the real router
    // and the real handler, gate included.
    const store = makeStore({ models: MODEL_CATALOG_SEED });
    const plan = await headlessPreview(store, MODEL_CATALOG_DOCUMENT);

    const { result } = await headlessImport(store, plan);

    expect(result.outcome).toBe('imported');
    expect(store.models).toEqual({
      claude: ['parity-model-existing', 'parity-model-new'],
      codex: [],
      agy: []
    });
  });

  it('gives the same answer whichever caller sends the computed delta (same gates, same answer)', async () => {
    const planStore = makeStore({ models: MODEL_CATALOG_SEED });
    const plan = await headlessPreview(planStore, MODEL_CATALOG_DOCUMENT);

    const viaPort = makeStore({ models: MODEL_CATALOG_SEED });
    const viaRouter = makeStore({ models: MODEL_CATALOG_SEED });

    const portResult = await headlessImport(viaPort, plan);
    const portAck = portResult.result.results.find((result) => result.key === 'models')?.ack;

    const routerAck = await dispatch(depsFor(viaRouter), CMD_SAVE_MODELS, {
      models: { claude: ['parity-model-new'] },
      expectedRevision: plan.computedAgainstModelsRevision,
      mutation: { kind: 'import-package' }
    });

    expect(portAck?.status).toBe('accepted');
    expect(routerAck.status).toBe('accepted');
    expect(viaPort.models).toEqual(viaRouter.models);
  });

  it('refuses a stale revision identically, whichever caller sends it (T026, FR-008)', async () => {
    // The plan is computed, then the catalog moves underneath it on both
    // stores identically. Both callers carry the plan's revision into the
    // write, so both must report the staleness rather than merge into the
    // row that appeared — the same claim the Phase/Pipeline/Workflow test
    // above makes, narrowed to the one write Model Catalog has.
    const planStore = makeStore({ models: MODEL_CATALOG_SEED });
    const plan = await headlessPreview(planStore, MODEL_CATALOG_DOCUMENT);

    const viaPort = makeStore({ models: MODEL_CATALOG_SEED });
    const viaRouter = makeStore({ models: MODEL_CATALOG_SEED });
    const intruder = {
      claude: [...MODEL_CATALOG_SEED.claude, 'parity-model-intruder'],
      codex: [],
      agy: []
    };
    viaPort.models = intruder;
    viaRouter.models = intruder;

    const portResult = await headlessImport(viaPort, plan);
    const portAck = portResult.result.results.find((result) => result.key === 'models')?.ack;

    const routerAck = await dispatch(depsFor(viaRouter), CMD_SAVE_MODELS, {
      models: { claude: ['parity-model-new'] },
      expectedRevision: plan.computedAgainstModelsRevision,
      mutation: { kind: 'import-package' }
    });

    expect(portResult.result.outcome).toBe('failed');
    expect(portAck?.status).toBe('rejected');
    expect(portAck && 'reason' in portAck ? portAck.reason : undefined).toBe('stale-catalog');
    expect(routerAck.status).toBe('rejected');
    expect(routerAck.reason).toBe('stale-catalog');
    expect(viaPort.models).toEqual(intruder);
    expect(viaRouter.models).toEqual(intruder);
  });
});

// ---------------------------------------------------------------------------
// Pipeline launch (T034)
// ---------------------------------------------------------------------------
//
// Feature 089 (T034, US2, FR-010, FR-013, SC-003) — one request, two adapters,
// one queue row.
//
// The two entry points here are `launchPipelineRun` from
// `src/headless/pipeline-run-api.ts` and `MessageRouter.dispatch` of
// `CMD_LAUNCH_PIPELINE`, and they are thinner than the exchange pair: both call
// `startPipelineRun()` and neither adds a gate. That is exactly what makes the
// comparison worth writing — the contract's R6 ("there is no shorter path to the
// runner") is a claim about this seam, and the only way to hold it is to keep
// asserting that the four gates, in their fixed order, produce the same row from
// both sides.
//
// **The clock is pinned, and why that is not a dropped field.** `startPipelineRun`
// reads `Date.now()` twice — once as the validator's `now` (which becomes the
// plan's `frozenAt`) and once as the queue row's `scheduledAt`. Two runs
// milliseconds apart therefore produce two rows that differ in two fields, and
// the usual repair is to delete them before comparing. That would stop pinning
// them altogether: a surface that stamped the wrong one, or forgot to stamp it,
// would compare equal. Pinning `Date.now` instead keeps both fields inside the
// comparison.
//
// **On the audit sequence.** The obligations table names "audit event sequence"
// for this row, and the honest reading is that the sequence is empty on both
// sides: `NodeRunStartDeps` declares no audit member, `node-run-starter.ts`
// emits nothing, and the router's mutation executor emits nothing either — a
// run's audit trail begins downstream, at drain. So what is asserted is that
// NEITHER adapter adds an event of its own, over a recorder proven live by a
// command that does emit. The audit-boundary assertions proper are T036-T038.

// Feature 098 (T080) — the Pipeline named `speckit-specify` and the reader below
// supplied no Phases at all, because the built-in Phase layer resolved that id for
// free. It resolves nothing now, so the Pipeline would quarantine and both arms
// would refuse the launch identically — a parity that proves nothing. The Phase is
// authored here instead, in the same scope as the Pipeline that names it.
const LAUNCH_PHASE = Object.freeze({
  id: 'parity-launch-phase',
  name: 'Parity Launch Phase',
  version: 1,
  instruction: 'Launch.'
});

const LAUNCH_PIPELINE = Object.freeze({
  id: 'parity-launch',
  name: 'Parity Launch',
  phases: [LAUNCH_PHASE.id],
  outputs: [{ portId: 'report', label: 'Report', type: 'markdown' }]
});

/**
 * The effective catalog both arms resolve against, through the real loader.
 *
 * Feature 099 (T496f, FR-041) — the two definitions arrived through a reader that
 * answered them for the `user` scope. Definitions come from the store now, so they
 * are handed to the loader as a snapshot; the loader is the same one activation
 * runs, which is why both arms still resolve through it rather than a hand-built
 * catalog.
 */
const LAUNCH_CATALOG = loadCatalog(
  storedCatalog({ phases: [LAUNCH_PHASE], pipelines: [LAUNCH_PIPELINE] }),
  { getModels: () => undefined, getDefaultPipelineId: () => undefined }
).catalog;

/** A live audit port and the events it saw, in order. */
function auditRecorder() {
  const events: unknown[] = [];
  return {
    events,
    port: {
      append: async (event: unknown) => {
        events.push(event);
      }
    }
  };
}

/**
 * The launch dependency bag, built on the exchange one so both arms keep reading
 * the same config seams — and so the audit control below can dispatch a saving
 * command through the *same* object the launch cases use.
 */
function launchDeps(
  queue: RecordingQueue,
  audit: ReturnType<typeof auditRecorder>,
  store: Store = makeStore()
): RouterDeps {
  return {
    ...(depsFor(store) as unknown as Record<string, unknown>),
    guardedRun: queue,
    getCatalog: () => LAUNCH_CATALOG,
    defaultRunnerKind: 'claude',
    audit: audit.port
  } as unknown as RouterDeps;
}

function runRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    pipelineId: LAUNCH_PIPELINE.id,
    inputs: [],
    supplemental: [],
    outputs: [],
    instructions: 'Draft the report.',
    ...overrides
  };
}

interface LaunchArm {
  readonly result: unknown;
  readonly queue: RecordingQueue;
  readonly audit: readonly unknown[];
}

async function headlessLaunch(request: RunRequest): Promise<LaunchArm> {
  const queue = new RecordingQueue();
  const audit = auditRecorder();
  const result = await launchPipelineRun(launchDeps(queue, audit), {
    request,
    workspaceRoot: workspaceRoot.path
  });
  return { result, queue, audit: audit.events };
}

async function sidebarLaunch(request: RunRequest): Promise<LaunchArm> {
  const queue = new RecordingQueue();
  const audit = auditRecorder();
  const ack = await dispatch(launchDeps(queue, audit), CMD_LAUNCH_PIPELINE, { request });
  return { result: ack.result, queue, audit: audit.events };
}

describe('Pipeline launch parity (T034, US2, FR-010, FR-013)', () => {
  const FROZEN_NOW = 1_760_000_000_000;
  let root: string;

  beforeAll(async () => {
    root = await makeWorkspaceRoot();
    workspaceRoot.path = root;
  });

  afterAll(async () => {
    workspaceRoot.path = '/tmp/headless-parity';
    await removeWorkspaceRoot(root);
  });

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(FROZEN_NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records an audit event when a command emits one (positive control)', async () => {
    // The two launch assertions below are "both sequences are empty", which any
    // dead recorder satisfies. This proves the recorder in `launchDeps` is the
    // one the handlers reach: the same bag, and a command that does audit.
    //
    // A package publication specifically, because that is the write that emits a
    // commit event. Feature 100 (T514) — it no longer has to be ASKED to: the
    // `import-package` mutation intent used to be what turned auditing on, and
    // `cmd-save-phases.ts` built its `ImportCommitTarget` only when it saw one, so
    // this control had to send the intent or prove the opposite of what it claims.
    // A publication IS the commit, so `exchangeTargets` builds one target per
    // declared layer and the intent is gone.
    const audit = auditRecorder();
    const store = makeStore();
    const deps = launchDeps(new RecordingQueue(), audit, store);
    const ack = await dispatch(deps, CMD_PUBLISH_PACKAGE, {
      layers: [
        {
          kind: 'phase',
          expectedRevision: store.catalog.revisionOf('phase'),
          definitions: [{ id: HELD_PHASE.id, body: HELD_PHASE }]
        }
      ]
    });
    expect(ack.status, `publish rejected: ${ack.reason}`).toBe('accepted');
    expect(audit.events.length).toBeGreaterThan(0);
  });

  it('enqueues the same row, the same frozen snapshot, and no audit event', async () => {
    const request = runRequest({
      outputs: [{ portId: 'report', target: 'out/report.md' }]
    });
    const headless = await headlessLaunch(request);
    const sidebar = await sidebarLaunch(request);

    // Both arms reached the queue exactly once. `only` throws otherwise, so a
    // double enqueue cannot pass as a match.
    expect(headless.queue.only).toEqual(sidebar.queue.only);

    // The frozen snapshot, named separately because it is the durable half — the
    // `WorkflowRun` materializes from it later, at drain.
    const frozen = headless.queue.only.runPlan;
    expect(frozen).toEqual(sidebar.queue.only.runPlan);
    expect(frozen?.pipeline.id).toBe(LAUNCH_PIPELINE.id);
    expect(frozen?.pipeline.phases.map((phase) => phase.id)).toEqual([LAUNCH_PHASE.id]);
    expect(frozen?.outputs).toEqual([
      { portId: 'report', type: 'markdown', target: 'out/report.md', overwriteConfirmed: false }
    ]);
    expect(frozen?.frozenAt).toBe(FROZEN_NOW);

    // Neither adapter emitted an audit event of its own.
    expect(headless.audit).toEqual([]);
    expect(sidebar.audit).toEqual([]);

    // The one permitted vocabulary difference, pinned rather than skipped: the
    // seam's `queueItemId` is this wire's `requestId`, and nothing else differs.
    const started = headless.result as Extract<NodeRunStartResult, { outcome: 'enqueued' }>;
    expect(started.outcome).toBe('enqueued');
    expect(sidebar.result).toEqual({ outcome: 'enqueued', requestId: started.queueItemId });
  });

  it('refuses an unknown Pipeline id the same way, and enqueues nothing', async () => {
    const request = runRequest({ pipelineId: 'parity-no-such-pipeline' });
    const headless = await headlessLaunch(request);
    const sidebar = await sidebarLaunch(request);

    // The literal first: comparing the two arms to each other agrees when both
    // lost the same field, and `rejected-definition` carries exactly one.
    expect(headless.result).toEqual({ outcome: 'rejected-definition', reason: 'pipeline-not-found' });
    expect(sidebar.result).toEqual(headless.result);

    // FR-033's fail-closed half: no substituted built-in reached the queue.
    expect(headless.queue.submitted).toEqual([]);
    expect(sidebar.queue.submitted).toEqual([]);
  });

  it('refuses an output target that escapes the workspace the same way', async () => {
    const request = runRequest({
      outputs: [{ portId: 'report', target: '../outside-the-workspace.md' }]
    });
    const headless = await headlessLaunch(request);
    const sidebar = await sidebarLaunch(request);

    expect(headless.result).toEqual({
      outcome: 'rejected-validation',
      errors: [
        {
          field: 'outputs.report',
          code: 'path-escapes-workspace',
          message: 'This target resolves outside the workspace.'
        }
      ]
    });
    expect(sidebar.result).toEqual(headless.result);
    expect(headless.queue.submitted).toEqual([]);
    expect(sidebar.queue.submitted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Workflow continuation (T035)
// ---------------------------------------------------------------------------
//
// Feature 089 (T035, US2, FR-011, FR-014, SC-003) — one payload, two adapters,
// one recorded attempt.
//
// The pair is `continueWorkflowRun` from `src/headless/workflow-run-api.ts` and
// `MessageRouter.dispatch` of `CMD_CONTINUE_WORKFLOW`. Both call
// `continueConnectedRun()`, which owns gate 1 and the launcher-result to
// wire-result mapping; gates 2-7 live below it in `workflow-launcher.ts`. Neither
// adapter adds a gate.
//
// **What each adapter still supplies, and why that is the part worth asserting.**
// The handler resolves the workspace root from `getCanonicalWorkspaceRoot()`,
// reads the clock, and hands the projector over **by reference** —
// `projectConnectedRun` and `isNodeStartable`, the same two functions the view
// renders from. A headless caller resolves the root and the clock itself and must
// pass those same two references. Gate 4 *is* `isNodeStartable` over
// `projectConnectedRun`, so a caller that supplied a predicate of its own would be
// running a second eligibility oracle — a shorter path to the runner in R6's
// sense, and the one way this seam can diverge with neither service changing.
// Both arms below pass the identical references.
//
// **The run fixture**, one shape serving all three cases:
//
//   first  ──report→brief──▶  second  ──report→seed──▶  third
//
// with one terminal attempt on `first` and one recorded decision offering
// connection 0. So `second` is `available`, and `third` is `unvisited` — nothing
// has decided it, because `second` has never run. That gives the offered node, the
// node the projection does not offer, and (at any revision but 3) the stale
// record, with no contrivance in any of them.
//
// **Nothing here reads a catalog**, on either arm: a continuation resolves the
// graph, the Pipeline, and the Phases from what the run froze at launch. The
// catalog-read counters that prove it belong to `tests/contract/continue-workflow.
// test.ts`; what this file adds is that the two adapters agree.

// Feature 099 (T496f, FR-042) — all three carried `sourceScope: 'workspace'`.
// A definition has no scope now; the field is deleted rather than defaulted, and
// nothing below read it. What these three are for is unchanged: they are the
// definitions the run froze at launch, resolved from its own snapshot on both arms
// and never from a catalog.
const CONTINUE_PHASE: PhaseDef = {
  id: 'parity-continue-phase',
  name: 'Parity Continue Phase',
  version: 1,
  instruction: 'Continue the work.'
};

const CONTINUE_FLOW: PipelineDef = {
  id: 'parity-continue-flow',
  name: 'Parity Continue Flow',
  phases: [CONTINUE_PHASE.id],
  inputs: [{ portId: 'brief', label: 'Brief', type: 'text', required: true }],
  outputs: [{ portId: 'report', label: 'Report', type: 'markdown' }]
};

const CONTINUE_TAIL: PipelineDef = {
  id: 'parity-continue-tail',
  name: 'Parity Continue Tail',
  phases: [CONTINUE_PHASE.id],
  inputs: [{ portId: 'seed', label: 'Seed', type: 'text', required: true }],
  outputs: []
};

const CONTINUE_GRAPH: WorkflowDefinition = {
  workflowId: 'parity-continue',
  name: 'Parity Continue',
  version: 1,
  nodes: [
    { nodeId: 'first', pipelineId: CONTINUE_FLOW.id },
    { nodeId: 'second', pipelineId: CONTINUE_FLOW.id },
    { nodeId: 'third', pipelineId: CONTINUE_TAIL.id }
  ],
  connections: [
    { from: { nodeId: 'first', portId: 'report' }, to: { nodeId: 'second', portId: 'brief' } },
    { from: { nodeId: 'second', portId: 'report' }, to: { nodeId: 'third', portId: 'seed' } }
  ],
  startNodeIds: ['first']
};

const CONTINUE_RUN_ID = 'parity-continue-run';
const CONTINUE_STARTED_AT = 1_700_000_000_000;
/** Opened (1), one attempt on `first` (2), one decision (3). */
const CURRENT_REVISION = 3;
/** The clock both arms see: pinned for the operator's, passed to the automation's. */
const CONTINUE_NOW = 1_760_000_100_000;

function storedContinueRun(): ConnectedWorkflowRun {
  const snapshot = createConnectedRunSnapshot({
    connectedRunId: CONTINUE_RUN_ID,
    workflow: CONTINUE_GRAPH,
    catalog: buildCatalog(
      [CONTINUE_PHASE],
      [CONTINUE_FLOW, CONTINUE_TAIL],
      { claude: [], codex: [], agy: [] },
      CONTINUE_FLOW.id
    ),
    startedAt: CONTINUE_STARTED_AT,
    defaultRunnerKind: 'claude'
  });
  if (snapshot.outcome !== 'created') {
    throw new Error(`fixture could not open a run: ${snapshot.reason}`);
  }
  const withAttempt = appendAttempt(snapshot.run, 'first', {
    queueItemId: 'child-1',
    startedAt: CONTINUE_STARTED_AT
  });
  return appendDecision(withAttempt, {
    nodeId: 'first',
    attemptIndex: 0,
    decidedAt: CONTINUE_STARTED_AT + 1_000,
    operands: [],
    connections: [{ index: 0, matched: true, isDefault: false }],
    defaultApplied: false,
    eligible: [0]
  });
}

/**
 * What the projector derives from that run — pinned as a literal, because both
 * refusal arms below carry it and comparing the arms to each other would agree on
 * two identically empty projections.
 */
const CONTINUE_PROJECTION = {
  connectedRunId: CONTINUE_RUN_ID,
  workflowId: CONTINUE_GRAPH.workflowId,
  revision: CURRENT_REVISION,
  hydrating: false,
  nodes: [
    {
      nodeId: 'first',
      pipelineId: CONTINUE_FLOW.id,
      state: 'completed',
      actions: ['restart'],
      attemptCount: 1,
      latestQueueItemId: 'child-1'
    },
    {
      nodeId: 'second',
      pipelineId: CONTINUE_FLOW.id,
      state: 'available',
      actions: ['start'],
      attemptCount: 0
    },
    {
      nodeId: 'third',
      pipelineId: CONTINUE_TAIL.id,
      state: 'unvisited',
      actions: [],
      attemptCount: 0
    }
  ]
};

function continuePayload(
  overrides: Partial<ContinueWorkflowPayload> = {}
): ContinueWorkflowPayload {
  return {
    connectedRunId: CONTINUE_RUN_ID,
    expectedRevision: CURRENT_REVISION,
    nodeId: 'second',
    request: {
      pipelineId: CONTINUE_FLOW.id,
      inputs: [{ portId: 'brief', type: 'text', value: 'carry on' }],
      supplemental: [],
      outputs: [{ portId: 'report', target: 'out/second.md' }]
    },
    ...overrides
  } as ContinueWorkflowPayload;
}

interface ConnectedRunWrite {
  readonly run: ConnectedWorkflowRun;
  readonly expectedRevision: number;
}

interface ContinueArm {
  readonly result: unknown;
  readonly queue: RecordingQueue;
  readonly writes: readonly ConnectedRunWrite[];
}

/** One arm's isolated world: its own stored run, queue, and write log. */
function continueWorld() {
  const queue = new RecordingQueue();
  const writes: ConnectedRunWrite[] = [];
  const current = storedContinueRun();
  const connectedRuns = {
    get: (connectedRunId: string) =>
      connectedRunId === current.connectedRunId ? current : null,
    compareAndSetConnectedRun: async (run: ConnectedWorkflowRun, expectedRevision: number) => {
      writes.push({ run, expectedRevision });
      return { outcome: 'written' as const, run };
    },
    readChildState: () => 'completed' as const
  };
  const deps = {
    ...(depsFor(makeStore()) as unknown as Record<string, unknown>),
    guardedRun: queue,
    defaultRunnerKind: 'claude',
    connectedRuns
  } as unknown as RouterDeps & ContinuationDeps;
  return { queue, writes, deps };
}

async function headlessContinue(payload: ContinueWorkflowPayload): Promise<ContinueArm> {
  const world = continueWorld();
  const result = await continueWorkflowRun(
    // The projector by reference — the two functions the handler passes, not a
    // pair of look-alikes. See the note above on why this is the seam.
    { ...world.deps, projectRun: projectConnectedRun, isNodeStartable },
    { payload, workspaceRoot: workspaceRoot.path, startedAt: CONTINUE_NOW }
  );
  return { result, queue: world.queue, writes: world.writes };
}

async function sidebarContinue(payload: ContinueWorkflowPayload): Promise<ContinueArm> {
  const world = continueWorld();
  const ack = await dispatch(world.deps, CMD_CONTINUE_WORKFLOW, payload);
  return { result: ack.result, queue: world.queue, writes: world.writes };
}

function projectionOf(result: unknown): ConnectedRunProjection {
  return (result as { projection: ConnectedRunProjection }).projection;
}

describe('Workflow continuation parity (T035, US2, FR-011, FR-014)', () => {
  let root: string;

  beforeAll(async () => {
    root = await makeWorkspaceRoot();
    workspaceRoot.path = root;
  });

  afterAll(async () => {
    workspaceRoot.path = '/tmp/headless-parity';
    await removeWorkspaceRoot(root);
  });

  beforeEach(() => {
    // The operator's arm reads the clock inside the handler; the automation's is
    // handed the same value. Pinning keeps `startedAt` inside the comparison
    // rather than deleting it from both sides.
    vi.spyOn(Date, 'now').mockReturnValue(CONTINUE_NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records the same attempt, enqueues the same row, and returns the same revision', async () => {
    const headless = await headlessContinue(continuePayload());
    const sidebar = await sidebarContinue(continuePayload());

    expect(headless.result).toEqual({
      outcome: 'started',
      revision: CURRENT_REVISION + 1,
      queueItemId: 'q-1'
    });
    expect(sidebar.result).toEqual(headless.result);

    // The recorded attempt: one compare-and-set, against the revision the caller
    // addressed, carrying the new attempt on the node that was started.
    expect(headless.writes).toEqual(sidebar.writes);
    expect(headless.writes).toHaveLength(1);
    const written = headless.writes[0]!;
    expect(written.expectedRevision).toBe(CURRENT_REVISION);
    expect(written.run.revision).toBe(CURRENT_REVISION + 1);
    expect(written.run.nodes.second?.attempts).toEqual([
      { queueItemId: 'q-1', startedAt: CONTINUE_NOW }
    ]);
    // `first`'s attempt survives: a continuation appends, it never rewrites.
    expect(written.run.nodes.first?.attempts).toEqual([
      { queueItemId: 'child-1', startedAt: CONTINUE_STARTED_AT }
    ]);

    // The queued row, and the Pipeline it froze — resolved from the run's own
    // snapshot on both arms, never from a catalog.
    expect(headless.queue.only).toEqual(sidebar.queue.only);
    const frozen = headless.queue.only.runPlan;
    expect(frozen?.pipeline.id).toBe(CONTINUE_FLOW.id);
    expect(frozen?.outputs).toEqual([
      { portId: 'report', type: 'markdown', target: 'out/second.md', overwriteConfirmed: false }
    ]);
  });

  it('refuses a node the projection does not offer, and carries the same projection', async () => {
    // `third`'s own Pipeline, so eligibility is the only thing wrong: gate 4
    // precedes gate 4a, and a mismatched Pipeline id would refuse for the other
    // reason and prove nothing about the projection.
    const payload = continuePayload({
      nodeId: 'third',
      request: {
        pipelineId: CONTINUE_TAIL.id,
        inputs: [{ portId: 'seed', type: 'text', value: 'carry on' }],
        supplemental: [],
        outputs: []
      }
    });
    const headless = await headlessContinue(payload);
    const sidebar = await sidebarContinue(payload);

    expect(headless.result).toEqual({
      outcome: 'rejected-state',
      reason: 'node-not-eligible',
      projection: CONTINUE_PROJECTION
    });
    expect(sidebar.result).toEqual(headless.result);

    expect(headless.writes).toEqual([]);
    expect(sidebar.writes).toEqual([]);
    expect(headless.queue.submitted).toEqual([]);
    expect(sidebar.queue.submitted).toEqual([]);
  });

  it('refuses a stale expectedRevision with the authoritative record', async () => {
    const payload = continuePayload({ expectedRevision: CURRENT_REVISION - 1 });
    const headless = await headlessContinue(payload);
    const sidebar = await sidebarContinue(payload);

    expect(headless.result).toEqual({
      outcome: 'rejected-stale',
      projection: CONTINUE_PROJECTION
    });
    expect(sidebar.result).toEqual(headless.result);
    // The point of the arm (FR-014): the record reported is the one the store
    // holds, not the revision the caller addressed.
    expect(projectionOf(headless.result).revision).toBe(CURRENT_REVISION);
    expect(projectionOf(sidebar.result).revision).toBe(CURRENT_REVISION);

    expect(headless.writes).toEqual([]);
    expect(sidebar.writes).toEqual([]);
    expect(headless.queue.submitted).toEqual([]);
    expect(sidebar.queue.submitted).toEqual([]);
  });
});
