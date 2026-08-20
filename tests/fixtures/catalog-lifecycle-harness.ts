// Feature 100 (FR-R3-016) T514 — the lifecycle service on in-memory ports.
//
// `catalog-memory-fs.ts` doubles what the *store* stands on. This doubles nothing:
// it composes the real store on those ports with the real `DefinitionSemantics`
// adapter over the real three resolvers, and hands back the real service.
//
// The semantics adapter is deliberately not stubbed. A stub would make every
// publish-gate and referential assertion a claim about the stub, and the two
// properties those tests exist to pin — the FR-017 union carve-out and the
// active-only referential rule of FR-025 — are properties of `src/config/`'s
// resolvers rather than of the service. Wiring the real adapter is also what keeps
// the tests honest about the seam: the service reaches semantics only through the
// port, so a test that passes here passes for the host wiring too.
//
// `defaultPipelineId` is a mutable box read through the getter the port requires
// (T509c), so a suite can set the configured default *after* the service is built —
// which is the ordering the advisory of FR-059 actually has to survive.

import { createCatalogStore, createLifecycleService, type CatalogStore, type LifecycleService } from '../../src/catalog';
import { createDefinitionSemantics } from '../../src/config/definition-semantics';
import { draftTokenOf, type ExpectedDraftVersion } from '../../src/contracts/catalog-lifecycle';
import type {
  CatalogKind,
  CatalogManifest,
  CatalogManifestEntry,
  CatalogSnapshot,
  StoredDefinition
} from '../../src/contracts/catalog-store';
// `CatalogStorePorts` is a port type, not a contract: it names the filesystem, the
// clock, the digest, and the provenance reader the store stands on, none of which
// cross a wire.
import type { CatalogStorePorts, DefinitionSemantics, RunProvenance } from '../../src/catalog';
import {
  manualClock,
  MemoryCatalogFs,
  provenanceReferencing,
  testDigest,
  type ManualClock
} from './catalog-memory-fs';

const MANIFEST_KEY = 'manifest.json';

export interface LifecycleHarness {
  readonly service: LifecycleService;
  readonly store: CatalogStore;
  readonly semantics: DefinitionSemantics;
  readonly fs: MemoryCatalogFs;
  readonly clock: ManualClock;
  readonly ports: CatalogStorePorts;
  /**
   * `schegent.defaultPipelineId`, settable after construction.
   *
   * The port takes a getter for exactly this reason: the semantics object is built
   * once at activation and the setting changes under it (T509c).
   */
  setDefaultPipelineId(id: string): void;
}

export function createLifecycleHarness(
  overrides: {
    readonly fs?: MemoryCatalogFs;
    readonly clock?: ManualClock;
    readonly provenance?: RunProvenance;
    readonly defaultPipelineId?: string;
  } = {}
): LifecycleHarness {
  const fs = overrides.fs ?? new MemoryCatalogFs();
  const clock = overrides.clock ?? manualClock();
  const ports: CatalogStorePorts = {
    fs,
    clock,
    digest: testDigest,
    provenance: overrides.provenance ?? provenanceReferencing([])
  };
  const store = createCatalogStore(ports);
  let defaultPipelineId = overrides.defaultPipelineId ?? '';
  const semantics = createDefinitionSemantics({ defaultPipelineId: () => defaultPipelineId });
  return {
    service: createLifecycleService({ store, semantics }),
    store,
    semantics,
    fs,
    clock,
    ports,
    setDefaultPipelineId: (id) => {
      defaultPipelineId = id;
    }
  };
}

// ---------------------------------------------------------------------------
// Reading the store back
// ---------------------------------------------------------------------------

/** The snapshot, or a thrown assertion — a test that cannot read has nothing to say. */
export async function snapshotOf(store: CatalogStore): Promise<CatalogSnapshot> {
  const result = await store.read();
  if (result.outcome !== 'read') throw new Error(`store unreadable: ${result.fault.fault}`);
  return result.snapshot;
}

export async function definitionOf(
  store: CatalogStore,
  kind: CatalogKind,
  id: string
): Promise<StoredDefinition | undefined> {
  const snapshot = await snapshotOf(store);
  return snapshot.definitions.find(
    (definition) => definition.kind === kind && definition.id === id
  );
}

/** The durable manifest, read straight off the fake disk. */
export function manifestOf(fs: MemoryCatalogFs): CatalogManifest {
  const raw = fs.files.get(MANIFEST_KEY);
  if (raw === undefined) throw new Error('no manifest was written');
  return JSON.parse(raw) as CatalogManifest;
}

export function entryOf(
  fs: MemoryCatalogFs,
  kind: CatalogKind,
  id: string
): CatalogManifestEntry | undefined {
  return manifestOf(fs).entries.find((entry) => entry.kind === kind && entry.id === id);
}

/** The version ids one definition retains, in manifest order. */
export function versionIdsOf(fs: MemoryCatalogFs, kind: CatalogKind, id: string): readonly string[] {
  return (entryOf(fs, kind, id)?.versions ?? []).map((version) => version.versionId);
}

/** The draft token the store currently holds — what the next operation must carry. */
export async function tokenOf(
  store: CatalogStore,
  kind: CatalogKind,
  id: string
): Promise<ExpectedDraftVersion> {
  const found = await definitionOf(store, kind, id);
  return draftTokenOf(found?.draftVersionId ?? null);
}

export async function revisionOf(store: CatalogStore, kind: CatalogKind): Promise<string> {
  return (await snapshotOf(store)).revisions[kind];
}

// ---------------------------------------------------------------------------
// Arranging state through the service
// ---------------------------------------------------------------------------

/**
 * Save a draft at whatever token the store is currently at.
 *
 * Every arrangement below goes through the service rather than through the store,
 * so a suite never arranges a state the service itself cannot reach.
 */
export async function draft(
  harness: LifecycleHarness,
  kind: CatalogKind,
  id: string,
  body: unknown,
  note?: string
): Promise<string> {
  const outcome = await harness.service.saveDraft({
    kind,
    id,
    body,
    expectedDraftVersion: await tokenOf(harness.store, kind, id),
    ...(note === undefined ? {} : { note })
  });
  if (outcome.outcome !== 'saved' && outcome.outcome !== 'unchanged') {
    throw new Error(`saveDraft(${kind}/${id}) was ${outcome.outcome}`);
  }
  return outcome.draftVersionId;
}

/** Publish whatever draft is pending, returning the version that became active. */
export async function publish(
  harness: LifecycleHarness,
  kind: CatalogKind,
  id: string
): Promise<string> {
  const outcome = await harness.service.publish({
    kind,
    id,
    expectedDraftVersion: await tokenOf(harness.store, kind, id)
  });
  if (outcome.outcome !== 'published') {
    throw new Error(`publish(${kind}/${id}) was refused: ${outcome.refusal.reason}`);
  }
  return outcome.activeVersionId;
}

/** A live definition: one draft write, one publication. Returns the active version. */
export async function seedActive(
  harness: LifecycleHarness,
  kind: CatalogKind,
  id: string,
  body: unknown
): Promise<string> {
  await draft(harness, kind, id, body);
  return publish(harness, kind, id);
}

// ---------------------------------------------------------------------------
// Bodies the resolvers accept
//
// Authored shapes, as a stored body actually holds them — `phases` rather than
// `phaseIds` for a Pipeline (which is the key `definition-semantics.ts` reads for
// its referential scan), and the port lists a Workflow connection needs to be
// type-compatible against.
// ---------------------------------------------------------------------------

export function phaseBody(id: string, overrides: Record<string, unknown> = {}): unknown {
  return { id, name: `Phase ${id}`, version: 1, instruction: `Do ${id}.`, ...overrides };
}

export function pipelineBody(
  id: string,
  phaseIds: readonly string[],
  overrides: Record<string, unknown> = {}
): unknown {
  return {
    id,
    name: `Pipeline ${id}`,
    version: 1,
    phases: [...phaseIds],
    inputs: [{ portId: 'brief', label: 'Brief', type: 'text' }],
    outputs: [{ portId: 'plan', label: 'Plan', type: 'markdown' }],
    ...overrides
  };
}

/**
 * A single-node Workflow over one Pipeline.
 *
 * One node and no connections on purpose: every claim here is about the
 * *reference* a Workflow node holds, and a second node would add graph rules that
 * have their own suite.
 */
export function workflowBody(
  id: string,
  pipelineId: string,
  overrides: Record<string, unknown> = {}
): unknown {
  return {
    id,
    name: `Workflow ${id}`,
    version: 1,
    nodes: [{ nodeId: 'n1', pipelineId }],
    connections: [],
    startNodeIds: ['n1'],
    ...overrides
  };
}
