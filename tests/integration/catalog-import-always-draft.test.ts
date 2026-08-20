// Feature 100 (FR-R3-016) T514g — an import writes drafts, and only a publication
// can change what runs.
//
// FR-041 and FR-042 are one property stated twice: "every definition an import
// writes lands as a Draft, and the trigger surface is unchanged until a publication
// occurs", and "there is no import path that makes a definition triggerable without
// a publication". In the shipped design that property is not a check somewhere — it
// is the *shape* of `publishPackage`, which is two ordered passes: pass 1 writes
// every version record and every draft pointer, and pass 2 moves the active
// pointers. Nothing between the two is optional, and nothing in pass 1 can make a
// definition triggerable, because pass 1 does not touch an active pointer at all.
//
// So the assertion has to be taken at the seam between the two passes, on a real
// disk, from a window that did not perform the write. That is what this file does:
// the store is wrapped so that the **first** `publishLayer` call, before it is
// delegated, opens a fresh window on the same directory and records what that
// window sees. Every write is a real write; the publication really happens; the only
// thing the wrapper adds is an observer at the instant the production code sequences
// the two passes. A hand-rolled `saveDraftLayer`-then-stop would assert the same
// bytes about a sequence this test wrote itself, which is the weaker claim.
//
// Three things that window sees, and each is a separate half of the requirement:
//
//   - **Written.** The version records for all three definitions are on disk. This
//     is not "the import has not started yet" — the bytes are there.
//   - **Draft.** Every one of them derives as `'draft'` through the shared
//     projection, so a surface reading the store mid-flight reports drafts, and the
//     effective catalog of every kind is still empty.
//   - **Unchanged.** The resolutions a run reads — `catalog.phases`,
//     `catalog.pipelines`, and the effective Workflows — are deep-equal to what they
//     were before the import began.
//
// And the fourth claim, the other direction of FR-043/FR-044: the ids are already
// *present* mid-flight, at draft, which is what makes a re-run plan skips (T514f)
// and what makes an operator's own unpublished draft survive an import of the same
// id. The last describe is that case end to end, through the real preflight: a
// draft-only Pipeline plans as a skip, is absent from the publish request, and is
// still byte-identical and unpublished afterwards (FR-039a, FR-044, US5 AS5).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CatalogSession, storedLayerReaders } from '../../src/activation/catalog-loading';
import type { CatalogSessionPorts } from '../../src/activation/catalog-loading';
import { nodeDigest } from '../../src/activation/catalog-store-wiring';
import { publishPackage, storedIds, storedRows, type CatalogStore } from '../../src/catalog';
import { createDefinitionSemantics } from '../../src/config/definition-semantics';
import type { PhaseDef, PipelineDef } from '../../src/config/pipeline-config';
import { definitionStateOf } from '../../src/contracts/catalog-lifecycle';
import type {
  DefinitionState,
  PackagePublishOutcome,
  PackagePublishRequest
} from '../../src/contracts/catalog-lifecycle';
import type { CatalogKind, CatalogSnapshot } from '../../src/contracts/catalog-store';
import type { PipelineDefinition } from '../../src/contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../src/contracts/process-definitions';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
import { preflightProcessDocument } from '../../src/services/process-yaml/preflight-service';
import type { ImportPlan } from '../../src/services/process-yaml/types';
import { pipelineBody } from '../fixtures/catalog-lifecycle-harness';
import {
  createWorkspace,
  draftTokenFor,
  fingerprintOf,
  openStore,
  removeWorkspace,
  storeRootOf,
  treeOf
} from '../fixtures/catalog-real-fs';

const semantics = createDefinitionSemantics({ defaultPipelineId: () => '' });

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await createWorkspace('100-import-always-draft');
});

afterEach(async () => {
  await removeWorkspace(workspaceRoot);
});

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/**
 * A Pipeline package that supplies everything it references.
 *
 * Self-contained on purpose: a document with an unresolved reference would plan its
 * root as `blocked`, and then "the trigger surface did not change" would be true for
 * a reason that has nothing to do with drafts. `specify` and `plan` are free ids —
 * the built-in catalog is empty — so nothing here resolves by accident.
 */
const DOCUMENT = [
  'apiVersion: schegent/v1',
  'kind: Pipeline',
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
  '        instruction: Write the plan.',
  ''
].join('\n');

// ---------------------------------------------------------------------------
// Windows onto the store
// ---------------------------------------------------------------------------

function portsFor(store: CatalogStore): CatalogSessionPorts {
  return { store, reader: undefined, digest: nodeDigest, logger: { debug: () => undefined } };
}

/**
 * A window that has read nothing yet, and the catalog it resolves from a cold read.
 *
 * Opened fresh every time rather than refreshed, because the claims here are about
 * what *another* window sees — a session that had already loaded could report a
 * resolution from a snapshot older than the writes under test.
 */
async function openSession(): Promise<CatalogSession> {
  return await CatalogSession.open(portsFor(openStore(workspaceRoot)));
}

async function snapshotOf(store: CatalogStore): Promise<CatalogSnapshot> {
  const read = await store.read();
  if (read.outcome !== 'read') throw new Error(`store unreadable: ${read.fault.fault}`);
  return read.snapshot;
}

/** `<kind>/<id>` to the state the shared projection derives for it (FR-006). */
function statesOf(snapshot: CatalogSnapshot): Record<string, DefinitionState> {
  const states: Record<string, DefinitionState> = {};
  for (const definition of snapshot.definitions) {
    states[`${definition.kind}/${definition.id}`] = definitionStateOf(
      definition.draftVersionId,
      definition.activeVersionId
    );
  }
  return states;
}

function byKind<T>(of: (kind: CatalogKind) => T): Record<CatalogKind, T> {
  return {
    phase: of('phase'),
    pipeline: of('pipeline'),
    workflow: of('workflow')
  };
}

/**
 * What a run can trigger.
 *
 * Not the store and not `storedRows`, but the three *resolutions* the run path
 * actually reads: a definition is triggerable when it has resolved into one of
 * these. Compared by deep equality rather than by ids, so a body edited under an
 * unchanged id would fail this too.
 */
interface TriggerSurface {
  readonly phases: readonly PhaseDef[];
  readonly pipelines: readonly PipelineDef[];
  readonly workflows: readonly WorkflowDefinition[];
}

function triggerSurfaceOf(session: CatalogSession): TriggerSurface {
  return {
    phases: session.catalog.phases,
    pipelines: session.catalog.pipelines,
    workflows: session.workflowCatalog.effective
  };
}

// ---------------------------------------------------------------------------
// The import, as the surface performs it
// ---------------------------------------------------------------------------

/** The real preflight, over the session's three stored layers (FR-043). */
async function planOn(session: CatalogSession): Promise<ImportPlan> {
  const outcome = await preflightProcessDocument(
    {
      ...storedLayerReaders(session),
      logger: { sanitize: (value: string) => value, warn: () => undefined }
    },
    { bytes: new Uint8Array(Buffer.from(DOCUMENT, 'utf8')) }
  );
  expect(outcome.outcome).toBe('planned');
  if (outcome.outcome !== 'planned') throw new Error('unreachable');
  return outcome.plan;
}

/** The webview's translation of a definition back to a stored body, mirrored. */
function phaseRow(definition: PhaseDefinition): Record<string, unknown> {
  const { phaseId, ...declared } = definition;
  return { id: phaseId, ...declared };
}

function pipelineRow(definition: PipelineDefinition): Record<string, unknown> {
  const { pipelineId, phaseIds, ...declared } = definition;
  return { id: pipelineId, phases: [...phaseIds], ...declared };
}

/**
 * The request the confirmation sends: one layer per kind the plan *imports*.
 *
 * Only `import` rows (FR-037), which is also what makes FR-039a checkable — a
 * skipped row never reaches the request, so it cannot be published as a side effect
 * of publishing the layer it shares a document with.
 */
function requestFor(plan: ImportPlan): PackagePublishRequest {
  const phases: { readonly id: string; readonly body: unknown }[] = [];
  const pipelines: { readonly id: string; readonly body: unknown }[] = [];
  for (const row of plan.rows) {
    if (row.outcome !== 'import') continue;
    if (row.resourceKind === 'phase') {
      phases.push({ id: row.definition.phaseId, body: phaseRow(row.definition) });
    }
    if (row.resourceKind === 'pipeline') {
      pipelines.push({ id: row.definition.pipelineId, body: pipelineRow(row.definition) });
    }
  }

  const layers: PackagePublishRequest['layers'][number][] = [];
  if (phases.length > 0) {
    layers.push({
      kind: 'phase',
      definitions: phases,
      expectedRevision: plan.computedAgainstRevision
    });
  }
  if (pipelines.length > 0) {
    // The Pipeline catalog's own revision, never the Phase catalog's (FR-036).
    const revision = plan.computedAgainstPipelineRevision;
    expect(revision).toBeDefined();
    layers.push({ kind: 'pipeline', definitions: pipelines, expectedRevision: revision! });
  }
  return { layers };
}

/** Everything one window sees of the store at one instant. */
interface MidFlight {
  readonly states: Record<string, DefinitionState>;
  readonly surface: TriggerSurface;
  readonly rows: Record<CatalogKind, readonly unknown[]>;
  readonly ids: Record<CatalogKind, readonly string[]>;
  readonly files: readonly string[];
}

async function observe(): Promise<MidFlight> {
  const snapshot = await snapshotOf(openStore(workspaceRoot));
  return {
    states: statesOf(snapshot),
    surface: triggerSurfaceOf(await openSession()),
    rows: byKind((kind) => storedRows(snapshot, kind)),
    ids: byKind((kind) => [...storedIds(snapshot, kind)].sort()),
    files: (await treeOf(storeRootOf(workspaceRoot))).files
  };
}

/**
 * Publish the request, recording the disk as it stood just before the **first**
 * active pointer moved.
 *
 * Delegating every method rather than spreading the store: `createCatalogStore`
 * returns its own object, and a wrapper that missed a method would silently drop a
 * write instead of failing to compile.
 */
async function publishObserved(request: PackagePublishRequest): Promise<{
  readonly outcome: PackagePublishOutcome;
  readonly midFlight: MidFlight | null;
}> {
  const inner = openStore(workspaceRoot);
  let midFlight: MidFlight | null = null;
  const store: CatalogStore = {
    read: () => inner.read(),
    applyLifecycleWrite: (write) => inner.applyLifecycleWrite(write),
    saveDraftLayer: (layer) => inner.saveDraftLayer(layer),
    publishLayer: async (layer) => {
      midFlight ??= await observe();
      return await inner.publishLayer(layer);
    },
    readVersion: (kind, id, versionId) => inner.readVersion(kind, id, versionId),
    listVersions: (kind, id) => inner.listVersions(kind, id),
    listDefinitions: (kind) => inner.listDefinitions(kind)
  };
  return { outcome: await publishPackage({ store, semantics }, request), midFlight };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('the drafting pass writes drafts and moves nothing (FR-041, FR-042)', () => {
  it('has written every declared definition, all of them Draft, before anything publishes', async () => {
    const plan = await planOn(await openSession());
    expect(plan.counts).toEqual({ import: 3, skip: 0, blocked: 0, invalid: 0 });

    const { outcome, midFlight } = await publishObserved(requestFor(plan));

    expect(outcome.outcome).toBe('published');
    expect(midFlight).not.toBeNull();
    if (midFlight === null) return;
    // Written: the version records are on disk, one per declared definition.
    expect(midFlight.files).toEqual([
      'manifest.json',
      'phases/plan/v1.json',
      'phases/specify/v1.json',
      'pipelines/ship-it/v1.json'
    ]);
    // Draft: every one of them, through the projection the surfaces read.
    expect(midFlight.states).toEqual({
      'phase/specify': 'draft',
      'phase/plan': 'draft',
      'pipeline/ship-it': 'draft'
    });
  });

  it('leaves the trigger surface exactly as it found it', async () => {
    const before = triggerSurfaceOf(await openSession());
    const plan = await planOn(await openSession());

    const { midFlight } = await publishObserved(requestFor(plan));

    expect(midFlight).not.toBeNull();
    if (midFlight === null) return;
    // Deep-equal, not merely still-empty: the same assertion holds over a populated
    // catalog, and the empty case is the one this workspace happens to start from.
    expect(midFlight.surface).toEqual(before);
    // The other reading of the same fact — `storedRows` is what the three resolvers
    // consume, so an empty projection here is the claim that nothing is triggerable
    // rather than the claim that one resolver happened to skip a row.
    expect(midFlight.rows).toEqual({ phase: [], pipeline: [], workflow: [] });
  });

  it('reports every drafted id as present, which is what makes a re-import skip', async () => {
    const plan = await planOn(await openSession());

    const { midFlight } = await publishObserved(requestFor(plan));

    expect(midFlight).not.toBeNull();
    if (midFlight === null) return;
    // The two selectors disagree, and the disagreement is the requirement: presence
    // is a claim on an id at every state (FR-043), so an importer reading the store
    // at this instant sees all three ids while the effective catalog has none of
    // them. An import that resolved presence against the rows above would plan
    // straight over these drafts (FR-044).
    expect(midFlight.ids).toEqual({
      phase: ['plan', 'specify'],
      pipeline: ['ship-it'],
      workflow: []
    });
  });
});

describe('only the publication changes what runs (FR-041, FR-042)', () => {
  it('makes exactly the document\'s definitions triggerable, and only after both passes', async () => {
    const plan = await planOn(await openSession());
    const request = requestFor(plan);

    const { outcome } = await publishObserved(request);

    expect(outcome).toEqual({
      outcome: 'published',
      published: [
        { kind: 'phase', ids: ['specify', 'plan'] },
        { kind: 'pipeline', ids: ['ship-it'] }
      ],
      pruned: []
    });
    // A window opened after the fact, so this is the disk and not a cache.
    const session = await openSession();
    expect(session.catalog.phases.map((phase) => phase.id)).toEqual(['specify', 'plan']);
    expect(session.catalog.pipelines.map((pipeline) => pipeline.id)).toEqual(['ship-it']);
    // The bodies are the document's, unedited on the way through.
    const snapshot = await snapshotOf(openStore(workspaceRoot));
    expect(storedRows(snapshot, 'phase')).toEqual(
      request.layers.find((layer) => layer.kind === 'phase')?.definitions.map((one) => one.body)
    );
    expect(storedRows(snapshot, 'pipeline')).toEqual(
      request.layers.find((layer) => layer.kind === 'pipeline')?.definitions.map((one) => one.body)
    );
  });

  it('leaves no pending draft behind, the publication having consumed each one', async () => {
    const plan = await planOn(await openSession());

    await publishObserved(requestFor(plan));

    const snapshot = await snapshotOf(openStore(workspaceRoot));
    expect(statesOf(snapshot)).toEqual({
      'phase/specify': 'active',
      'phase/plan': 'active',
      'pipeline/ship-it': 'active'
    });
    // One version each: the draft pass and the publication are two pointer states
    // of one immutable record, not two records (FR-016).
    for (const definition of snapshot.definitions) {
      expect(definition.versions.map((version) => version.versionId)).toEqual(['v1']);
    }
  });
});

describe("an operator's unpublished draft is skipped and left alone (FR-043, FR-044, FR-039a)", () => {
  /** The Pipeline the operator is mid-way through authoring, under an id the document declares. */
  const OPERATOR_DRAFT = pipelineBody('ship-it', ['specify'], {
    name: 'Ship It, my way',
    version: 9
  });

  /** Save it and never publish it: draft-only, so no resolver can see it (FR-007). */
  async function seedDraft(): Promise<void> {
    const store = openStore(workspaceRoot);
    const written = await store.applyLifecycleWrite({
      op: 'save-draft',
      kind: 'pipeline',
      id: 'ship-it',
      body: OPERATOR_DRAFT,
      expectedDraftVersion: await draftTokenFor(store, 'pipeline', 'ship-it')
    });
    // `'written'` is the STORE's success arm; `'saved'` is the lifecycle service's
    // name for the same thing. This seeds through the store directly, an operator's
    // draft being a precondition here rather than the subject.
    expect(written.outcome).toBe('written');
  }

  it('plans the id as a skip, naming the draft as what holds it', async () => {
    await seedDraft();

    const plan = await planOn(await openSession());

    expect(plan.counts).toEqual({ import: 2, skip: 1, blocked: 0, invalid: 0 });
    expect(plan.rows).toContainEqual({
      outcome: 'skip',
      resourceKind: 'pipeline',
      resourceId: 'ship-it',
      name: 'Ship It',
      // Not `invalid` and not absent: the operator's draft is the strongest claim
      // there is on this id, and the plan says so in the one word that distinguishes
      // "you are already editing this" from "this is broken" (FR-043).
      presentRowStatus: 'draft'
    });
  });

  it('publishes the Phases and never the skipped Pipeline', async () => {
    await seedDraft();
    const plan = await planOn(await openSession());
    const request = requestFor(plan);
    // The skipped row is absent from the request, which is what FR-039a asks of the
    // caller; everything below is what the store then does with a request like that.
    expect(request.layers.map((layer) => layer.kind)).toEqual(['phase']);

    const { outcome } = await publishObserved(request);

    expect(outcome).toEqual({
      outcome: 'published',
      published: [{ kind: 'phase', ids: ['specify', 'plan'] }],
      pruned: []
    });
    const snapshot = await snapshotOf(openStore(workspaceRoot));
    expect(statesOf(snapshot)).toEqual({
      'pipeline/ship-it': 'draft',
      'phase/specify': 'active',
      'phase/plan': 'active'
    });
    // Still not triggerable — an import that published the Pipeline layer wholesale
    // would have made the operator's half-finished Pipeline live (FR-039b).
    expect(storedRows(snapshot, 'pipeline')).toEqual([]);
    expect((await openSession()).catalog.pipelines).toEqual([]);
  });

  it('leaves the draft byte-identical, body and history included', async () => {
    await seedDraft();
    const before = await fingerprintOf(storeRootOf(workspaceRoot));

    await publishObserved(requestFor(await planOn(await openSession())));

    const snapshot = await snapshotOf(openStore(workspaceRoot));
    const draft = snapshot.definitions.find(
      (definition) => definition.kind === 'pipeline' && definition.id === 'ship-it'
    );
    expect(draft?.draftVersionId).toBe('v1');
    expect(draft?.activeVersionId).toBeNull();
    expect(draft?.draftBody).toEqual(OPERATOR_DRAFT);
    expect(draft?.versions.map((version) => version.versionId)).toEqual(['v1']);
    // Byte-identical including mtime, which is what rules out a rewrite with the
    // same bytes — and, nothing having been removed either, rules out a delete and
    // re-create. The manifest is excluded because the Phase publication is meant to
    // change it.
    const after = await fingerprintOf(storeRootOf(workspaceRoot));
    expect(after.get('pipelines/ship-it/v1.json')).toBe(before.get('pipelines/ship-it/v1.json'));
  });
});
