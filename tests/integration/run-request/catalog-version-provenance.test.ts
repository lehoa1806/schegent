// Feature 102 (T034, US4) — which published version a run froze, end to end.
//
// Covers invariants 1, 2, 4 and 5 of contracts/catalog-version.md. Invariant 3
// (a submission may not carry one) is `tests/contract/catalog-version-not-accepted.test.ts`;
// invariant 6 (one envelope construction site) is the standing
// `tests/lint/no-envelope-reconstruction.test.ts`.
//
// Driven through the real seam — `startPipelineRun()` → `GuardedRunService` →
// `QueueManager` → `WorkspaceStateStore` — because every claim here is about
// what *reaches storage* and survives there. A faked store would pin the fake,
// and invariant 5 is specifically a claim about a round trip through it.
//
// The one thing this suite fakes is the version oracle, and it fakes it as a
// mutable world rather than a constant: the effective catalog
// (`pipelinesById: ReadonlyMap<string, PipelineDef>`) carries no version ids at
// all, so the identity has to come from the store on a narrow port, and half of
// what is under test here is what happens when that port's answer *changes*
// while a run is already accepted.
//
// ---------------------------------------------------------------------------
// Why a member run reads its version off the frozen snapshot
//
// FR-026 requires every member run of a connected run to record the version of
// the Pipeline that member executes. FR-021 requires a plan frozen from a
// caller-supplied snapshot to record none. Every member start supplies one
// (`workflow-launcher.ts` at both the launch and the continue call sites), so
// read naively the two rules cancel and no Workflow run records anything.
//
// They do not cancel, because the snapshot itself was frozen *from the effective
// catalog*, at the connected run's start. The version that describes that body is
// resolved once, there, and travels with the body. Re-resolving at each member
// start would be the genuinely wrong answer: it would stamp today's Active
// version onto a body frozen days ago, which is a version the system never
// resolved for this run — worse than recording none, in FR-021's own words.
//
// So the rule this suite pins is: **the version comes from wherever the body came
// from.** A body resolved from the catalog carries the version resolved with it;
// a body handed in by a caller carries whatever that caller froze, and nothing
// when it froze nothing.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildCatalog,
  type PhaseDef,
  type PipelineCatalog,
  type PipelineDef
} from '../../../src/config/pipeline-config';
import type { CatalogVersionRef } from '../../../src/contracts/catalog-version';
import type { FrozenRunPlan, RunRequest } from '../../../src/contracts/run-request';
import type { WorkflowDefinition } from '../../../src/contracts/workflow-definitions';
import type { QueueState } from '../../../src/queue/feature-request';
import { createConnectedRunSnapshot } from '../../../src/services/workflow-execution/connected-run-factory';
import {
  startPipelineRun,
  type NodeRunStartDeps,
  type NodeRunStartResult
} from '../../../src/services/workflow-execution/node-run-starter';
import { KEYS } from '../../../src/state/workspace-state';
import type { WorkflowRunPipeline } from '../../../src/state/workflow-run';
import { makeHarness, type Harness } from '../enqueue-start-separation.helpers';

const NOW = 1_700_000_000_000;
const SRC_DIR = resolve(__dirname, '../../../src');

// --------------------------------------------------------------------------
// A catalog whose definitions can be republished under the test's control.
// --------------------------------------------------------------------------

const PLAN: PhaseDef = { id: 'plan', name: 'Plan', version: 1, instruction: 'Plan the work.' };
const BUILD: PhaseDef = { id: 'build', name: 'Build', version: 1, instruction: 'Build the thing.' };

const RESEARCH_V4: PipelineDef = {
  id: 'research',
  name: 'Research',
  phases: ['plan'],
  inputs: [{ portId: 'topic', label: 'Topic', type: 'text', required: true }],
  outputs: []
};

const DRAFT_V2: PipelineDef = {
  id: 'draft',
  name: 'Draft',
  phases: ['build'],
  inputs: [{ portId: 'outline', label: 'Outline', type: 'text', required: true }],
  outputs: []
};

/** Two nodes, two different Pipelines, so "that member's own version" has content. */
const AB_FLOW: WorkflowDefinition = {
  workflowId: 'ab-flow',
  name: 'Research then draft',
  version: 1,
  nodes: [
    { nodeId: 'survey', pipelineId: 'research' },
    { nodeId: 'write', pipelineId: 'draft' }
  ],
  connections: [],
  startNodeIds: ['survey']
};

/**
 * The store's two answers, held together so they cannot disagree: the body that
 * is Active, and the version id that names it.
 *
 * `publish()` moves both in one call for the same reason the real store moves
 * both pointers in one expression — a world where a version id can advance
 * without its body would prove an invariant the product does not have.
 */
interface CatalogWorld {
  catalog(): PipelineCatalog;
  resolveCatalogVersion(pipelineId: string): CatalogVersionRef | undefined;
  publish(versionId: string, body: PipelineDef): void;
}

function makeWorld(): CatalogWorld {
  const bodies = new Map<string, PipelineDef>([
    [RESEARCH_V4.id, RESEARCH_V4],
    [DRAFT_V2.id, DRAFT_V2]
  ]);
  const active = new Map<string, string>([
    [RESEARCH_V4.id, 'v4'],
    [DRAFT_V2.id, 'v2']
  ]);

  return {
    catalog() {
      return buildCatalog(
        [PLAN, BUILD],
        [...bodies.values()],
        { claude: [], codex: [], agy: [] },
        RESEARCH_V4.id
      );
    },
    resolveCatalogVersion(pipelineId) {
      const versionId = active.get(pipelineId);
      // The port answers for Pipelines and names the kind itself, so no caller
      // can ask it what version a Workflow is at — which is FR-026 made
      // unreachable rather than merely untested.
      return versionId === undefined ? undefined : { kind: 'pipeline', id: pipelineId, versionId };
    },
    publish(versionId, body) {
      bodies.set(body.id, body);
      active.set(body.id, versionId);
    }
  };
}

// --------------------------------------------------------------------------
// Driving the real path
// --------------------------------------------------------------------------

/**
 * The deps `startPipelineRun` takes, with the version port attached unless the
 * case under test is precisely its absence.
 */
function depsFor(
  harness: Harness,
  world: CatalogWorld,
  options: { readonly withVersionPort?: boolean } = {}
): NodeRunStartDeps {
  return {
    guardedRun: harness.service,
    getCatalog: () => world.catalog(),
    logger: harness.logger,
    ...(options.withVersionPort === false
      ? {}
      : { resolveCatalogVersion: (pipelineId: string) => world.resolveCatalogVersion(pipelineId) })
  };
}

function requestFor(pipelineId: string): RunRequest {
  const portId = pipelineId === DRAFT_V2.id ? 'outline' : 'topic';
  return {
    pipelineId,
    inputs: [{ portId, type: 'text', value: 'the thing to do' }],
    supplemental: [],
    outputs: [],
    instructions: `run ${pipelineId}`
  };
}

async function start(
  harness: Harness,
  deps: NodeRunStartDeps,
  pipelineId: string,
  frozenPipeline?: WorkflowRunPipeline
): Promise<NodeRunStartResult> {
  return startPipelineRun(deps, {
    request: requestFor(pipelineId),
    workspaceRoot: harness.workspaceRoot,
    ...(frozenPipeline !== undefined ? { frozenPipeline } : {})
  });
}

/** The plan as the caller got it, with the refusal turned into a readable failure. */
function planOf(result: NodeRunStartResult): FrozenRunPlan {
  if (result.outcome !== 'enqueued') {
    throw new Error(`expected an enqueued run, got ${result.outcome}: ${JSON.stringify(result)}`);
  }
  return result.plan;
}

/**
 * Every plan the backing store currently holds, read back through JSON.
 *
 * The production `Memento` persists JSON, so parsing a serialization of what the
 * fake holds is the same round trip a window restart performs — which is what
 * invariant 5 is a claim about.
 */
function storedPlans(harness: Harness): readonly FrozenRunPlan[] {
  const queues = harness.memento.get<Record<string, QueueState>>(KEYS.queue) ?? {};
  const roundTripped = JSON.parse(JSON.stringify(queues)) as Record<string, QueueState>;
  return Object.values(roundTripped)
    .flatMap((queue) => queue?.requests ?? [])
    .map((request) => request.runPlan)
    .filter((plan): plan is FrozenRunPlan => plan !== undefined);
}

/** The single stored plan, when the case under test produced exactly one. */
function onlyStoredPlan(harness: Harness): FrozenRunPlan {
  const plans = storedPlans(harness);
  expect(plans).toHaveLength(1);
  return plans[0] as FrozenRunPlan;
}

async function withHarness(
  world: CatalogWorld,
  body: (harness: Harness) => Promise<void>
): Promise<void> {
  // The catalog handed to the harness is only what the guarded service checks a
  // submitted id against; ids never change in this world, so a snapshot of it is
  // as good as the live one and the service is not the thing under test.
  const harness = await makeHarness({ initialNow: NOW, catalog: world.catalog() });
  try {
    await body(harness);
  } finally {
    harness.cleanup();
  }
}

// --------------------------------------------------------------------------
// Invariant 1 — a run of a definition Active at v4 records v4
// --------------------------------------------------------------------------

describe('a run records the version it froze (invariant 1, FR-021, FR-022)', () => {
  it('names the kind, the id, and the active version', async () => {
    const world = makeWorld();
    await withHarness(world, async (harness) => {
      const plan = planOf(await start(harness, depsFor(harness, world), RESEARCH_V4.id));

      expect(plan.catalogVersion).toEqual({ kind: 'pipeline', id: 'research', versionId: 'v4' });
    });
  });

  it('carries that record into storage rather than only onto the returned plan', async () => {
    const world = makeWorld();
    await withHarness(world, async (harness) => {
      await start(harness, depsFor(harness, world), RESEARCH_V4.id);

      expect(onlyStoredPlan(harness).catalogVersion).toEqual({
        kind: 'pipeline',
        id: 'research',
        versionId: 'v4'
      });
    });
  });

  it('records the version of the definition the request named, not of the default one', async () => {
    // `buildCatalog`'s fourth argument makes `research` the default Pipeline. A
    // resolution keyed off the default rather than off the request would pass
    // every other assertion in this block.
    const world = makeWorld();
    await withHarness(world, async (harness) => {
      const plan = planOf(await start(harness, depsFor(harness, world), DRAFT_V2.id));

      expect(plan.catalogVersion).toEqual({ kind: 'pipeline', id: 'draft', versionId: 'v2' });
    });
  });
});

// --------------------------------------------------------------------------
// Invariant 2 — republishing does not reach a run already accepted
// --------------------------------------------------------------------------

describe('publishing past an accepted run leaves it where it was (invariant 2, FR-025, FR-038)', () => {
  /** v5 of `research`: a different name, and a Phase list the operator reordered. */
  const RESEARCH_V5: PipelineDef = { ...RESEARCH_V4, name: 'Research (rewritten)', phases: ['build'] };

  it('leaves the queued run recorded at the version it froze', async () => {
    const world = makeWorld();
    await withHarness(world, async (harness) => {
      await start(harness, depsFor(harness, world), RESEARCH_V4.id);

      world.publish('v5', RESEARCH_V5);

      expect(onlyStoredPlan(harness).catalogVersion?.versionId).toBe('v4');
    });
  });

  it('leaves the queued run executing the body that version named', async () => {
    // The record and the body have to move together or not at all. A plan still
    // saying `v4` while its frozen Phases were rewritten under it would satisfy
    // the assertion above and be the exact failure provenance exists to rule out.
    const world = makeWorld();
    await withHarness(world, async (harness) => {
      await start(harness, depsFor(harness, world), RESEARCH_V4.id);

      world.publish('v5', RESEARCH_V5);
      const stored = onlyStoredPlan(harness);

      expect(stored.pipeline.name).toBe('Research');
      expect(stored.pipeline.phases.map((phase) => phase.id)).toEqual(['plan']);
    });
  });

  it('offers the new version to the next trigger', async () => {
    // The other half of the invariant: standing still is only correct if the
    // catalog moved. The surface half of "Runs offers v5" is the launch
    // projection's own suite; this is the host half — a fresh freeze resolves
    // the new version and the new body.
    const world = makeWorld();
    await withHarness(world, async (harness) => {
      await start(harness, depsFor(harness, world), RESEARCH_V4.id);
      world.publish('v5', RESEARCH_V5);

      const second = planOf(await start(harness, depsFor(harness, world), RESEARCH_V4.id));

      expect(second.catalogVersion?.versionId).toBe('v5');
      expect(second.pipeline.name).toBe('Research (rewritten)');
    });
  });

  it('holds across a second republication', async () => {
    const world = makeWorld();
    await withHarness(world, async (harness) => {
      await start(harness, depsFor(harness, world), RESEARCH_V4.id);

      world.publish('v5', RESEARCH_V5);
      world.publish('v6', { ...RESEARCH_V5, name: 'Research (again)' });

      expect(onlyStoredPlan(harness).catalogVersion?.versionId).toBe('v4');
    });
  });

  it('is written at exactly one site and rewritten at none', () => {
    // Behaviour can only show the record standing still on the paths a test
    // happens to drive. FR-025 is a claim about every path, and the way to hold
    // it is that nothing in `src/` assigns the field after the freeze. The
    // permitted set is small and each entry is one of: the shape that declares
    // it, the freeze that writes it, the resolution that feeds the freeze, the
    // carriage that survives a connected run, or the housekeeping that reads it.
    const permitted = new Set([
      'contracts/run-request.ts',
      'services/run-request/run-request-validator.ts',
      'services/workflow-execution/node-run-starter.ts',
      'services/workflow-execution/connected-run-factory.ts',
      'state/workflow-run.ts',
      'activation/catalog-loading.ts',
      'extension.ts',
      'catalog/run-provenance-queue.ts'
    ]);

    // Comments are stripped first. The claim is about what the code does, and a
    // boundary that *refuses* a submitted `catalogVersion` has every reason to
    // say so in prose while never touching the field — counting that as a write
    // site would force those files onto the permitted list, which would then
    // permit them to write it for real. Stripping narrows what the scan sees to
    // exactly the thing being forbidden.
    const mentions = sourcesUnder(SRC_DIR)
      .filter((path) => withoutComments(readFileSync(path, 'utf8')).includes('catalogVersion'))
      .map((path) => relative(SRC_DIR, path).split('\\').join('/'))
      .sort();

    expect(mentions.filter((path) => !permitted.has(path))).toEqual([]);
    // Non-vacuity, in both directions: the scan reaches a real tree, and the
    // producers actually name the field, so an implementation that spelled it
    // some other way cannot pass this by mentioning it nowhere.
    expect(sourcesUnder(SRC_DIR).length).toBeGreaterThan(50);
    expect(mentions).toContain('contracts/run-request.ts');
    expect(mentions).toContain('services/run-request/run-request-validator.ts');
    expect(mentions).toContain('services/workflow-execution/node-run-starter.ts');
  });
});

// --------------------------------------------------------------------------
// Invariant 4 — a member run records its own Pipeline's version
// --------------------------------------------------------------------------

/** The connected run's frozen Pipelines, resolved through the real factory. */
function freezeGraph(world: CatalogWorld): Record<string, WorkflowRunPipeline> {
  const snapshot = createConnectedRunSnapshot({
    connectedRunId: 'connected-1',
    workflow: AB_FLOW,
    catalog: world.catalog(),
    startedAt: NOW,
    resolveCatalogVersion: (pipelineId: string) => world.resolveCatalogVersion(pipelineId)
  });
  if (snapshot.outcome !== 'created') {
    throw new Error(`expected a connected run, got ${JSON.stringify(snapshot)}`);
  }
  return snapshot.run.pipelines;
}

describe('each member records the Pipeline it executes (invariant 4, FR-026)', () => {
  it('gives each member its own definition and its own version', async () => {
    const world = makeWorld();
    const pipelines = freezeGraph(world);
    await withHarness(world, async (harness) => {
      const deps = depsFor(harness, world);

      const survey = planOf(await start(harness, deps, RESEARCH_V4.id, pipelines['research']));
      const write = planOf(await start(harness, deps, DRAFT_V2.id, pipelines['draft']));

      expect(survey.catalogVersion).toEqual({ kind: 'pipeline', id: 'research', versionId: 'v4' });
      expect(write.catalogVersion).toEqual({ kind: 'pipeline', id: 'draft', versionId: 'v2' });
    });
  });

  it('records no Workflow anywhere on a member plan', async () => {
    // FR-026's second half. The Workflow's own version is not merely unread here;
    // it is unwritten, because the record that would carry it belongs with the
    // durable run history that consumes these records.
    const world = makeWorld();
    const pipelines = freezeGraph(world);
    await withHarness(world, async (harness) => {
      const survey = planOf(
        await start(harness, depsFor(harness, world), RESEARCH_V4.id, pipelines['research'])
      );

      expect(survey.catalogVersion?.kind).toBe('pipeline');
      expect(JSON.stringify(survey)).not.toContain('workflow');
      expect(JSON.stringify(survey)).not.toContain(AB_FLOW.workflowId);
    });
  });

  it('gives a member started after a republication the version its body was frozen at', async () => {
    // The continue path starts a later node from the same snapshot, which is why
    // reading the version off the body rather than re-resolving it matters: the
    // catalog has moved, and the body this member executes has not.
    const world = makeWorld();
    const pipelines = freezeGraph(world);
    await withHarness(world, async (harness) => {
      world.publish('v9', { ...DRAFT_V2, name: 'Draft (rewritten)' });

      const write = planOf(await start(harness, depsFor(harness, world), DRAFT_V2.id, pipelines['draft']));

      expect(write.catalogVersion?.versionId).toBe('v2');
      expect(write.pipeline.name).toBe('Draft');
    });
  });

  it('freezes the version beside the body, so the two cannot be separated in storage', () => {
    const pipelines = freezeGraph(makeWorld());

    expect(pipelines['research']?.catalogVersion).toEqual({
      kind: 'pipeline',
      id: 'research',
      versionId: 'v4'
    });
    expect(pipelines['draft']?.catalogVersion).toEqual({
      kind: 'pipeline',
      id: 'draft',
      versionId: 'v2'
    });
  });
});

// --------------------------------------------------------------------------
// Invariant 5 — absence is "not recorded", and it survives storage
// --------------------------------------------------------------------------

/** Every key present anywhere in the structure, however deep. */
function keysDeep(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) keysDeep(entry, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      found.add(key);
      keysDeep(nested, found);
    }
  }
  return found;
}

describe('a plan with no version reads as "not recorded" (invariant 5, FR-021, FR-027)', () => {
  it('omits the field entirely when no version port is wired', async () => {
    // The pre-feature plan, reproduced at its cause rather than by hand-editing
    // a stored record: a host that resolves no version writes no field.
    const world = makeWorld();
    await withHarness(world, async (harness) => {
      const plan = planOf(
        await start(harness, depsFor(harness, world, { withVersionPort: false }), RESEARCH_V4.id)
      );

      expect('catalogVersion' in plan).toBe(false);
      expect(keysDeep(plan).has('catalogVersion')).toBe(false);
    });
  });

  it('omits it for a caller-supplied snapshot even when the catalog could answer', async () => {
    // FR-021's second case, and the one that has to be a deliberate omission
    // rather than an accident: the port is wired and would answer `v4`, but the
    // body did not come from the catalog, so no version describes it. A connected
    // run started before this feature reaches exactly this state on every
    // continuation.
    const world = makeWorld();
    const preFeature: WorkflowRunPipeline = {
      id: RESEARCH_V4.id,
      name: RESEARCH_V4.name,
      phases: [PLAN],
      inputs: RESEARCH_V4.inputs,
      outputs: RESEARCH_V4.outputs
    };
    await withHarness(world, async (harness) => {
      const deps = depsFor(harness, world);
      expect(world.resolveCatalogVersion(RESEARCH_V4.id)?.versionId).toBe('v4');

      const plan = planOf(await start(harness, deps, RESEARCH_V4.id, preFeature));

      expect('catalogVersion' in plan).toBe(false);
    });
  });

  it('never writes a blank identity in place of an absent one', async () => {
    const world = makeWorld();
    await withHarness(world, async (harness) => {
      const plan = planOf(
        await start(harness, depsFor(harness, world, { withVersionPort: false }), RESEARCH_V4.id)
      );

      expect(JSON.stringify(plan)).not.toContain('catalogVersion');
      expect(JSON.stringify(plan)).not.toContain('versionId');
    });
  });

  it('round-trips through storage still absent, and reading it is not an error', async () => {
    const world = makeWorld();
    await withHarness(world, async (harness) => {
      await start(harness, depsFor(harness, world, { withVersionPort: false }), RESEARCH_V4.id);

      const stored = onlyStoredPlan(harness);

      // Absent, not null, not `''` — the three states a reader would treat
      // differently, and only one of them means "not recorded".
      expect('catalogVersion' in stored).toBe(false);
      expect(stored.catalogVersion).toBeUndefined();
      expect(stored.catalogVersion?.versionId).toBeUndefined();
      // And the rest of the plan came back whole, so absence is absence and not
      // a plan that failed to store.
      expect(stored.pipeline.id).toBe(RESEARCH_V4.id);
      expect(stored.pipeline.phases).toHaveLength(1);
    });
  });

  it('round-trips a recorded version unchanged, so the absence above is caused by the case', async () => {
    const world = makeWorld();
    await withHarness(world, async (harness) => {
      await start(harness, depsFor(harness, world), RESEARCH_V4.id);

      const stored = onlyStoredPlan(harness);

      expect(stored.catalogVersion).toEqual({ kind: 'pipeline', id: 'research', versionId: 'v4' });
    });
  });
});

/**
 * Source with `//` and block comments removed.
 *
 * Deliberately crude — it does not track string literals, so a `'//'` inside a
 * string truncates that line. That direction is safe here: it can only make the
 * scan see less of a line, and the one thing it is looking for is a real
 * `catalogVersion` reference in code. Every permitted writer below is asserted
 * present after stripping, so an over-eager strip fails the suite rather than
 * quietly hiding a write.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Every `.ts` under a directory, recursively. */
function sourcesUnder(root: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...sourcesUnder(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}
