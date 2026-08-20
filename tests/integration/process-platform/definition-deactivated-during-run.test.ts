// Feature 100 (FR-R3-016) T514h — a run already executing when the definitions
// it uses are taken out of service.
//
// The sibling fixture `definition-edit-during-run.test.ts` (feature 089, FR-032)
// pins the same shape for an *edit*: rewrite the catalog row, drive the run, and
// watch it walk its frozen contract anyway. Deactivation is not an edit, and the
// difference is why FR-026 needs its own fixture. An edit leaves a resolvable row
// behind; a deactivation removes the definition from the effective catalog
// entirely, so a run that consulted the catalog for its next Phase would not walk
// a *different* sequence — it would find nothing at all. That is the failure this
// asserts against, and it is a louder one.
//
// Everything here is the production path bar the queue:
//
//   - Definitions are published through `createLifecycleService` over a real
//     store on a real `mkdtemp` workspace, so the arrangement is one the
//     lifecycle would actually permit rather than a hand-placed manifest.
//   - The catalog is resolved by `CatalogSession`, so "out of the effective
//     catalog" is the store's own projection and not a fixture's opinion.
//   - The plan is frozen by `WorkflowRunFactory` and driven by the production
//     `PhaseSequencer`, whose every successor lookup reads `run.pipeline`.
//
// One ordering constraint shapes the whole file: FR-025 refuses the deactivation
// of a Phase that an **active** Pipeline still references. So the Pipeline goes
// out of service first, and only then the Phase — at which point the Pipeline's
// reference has become a draft one and FR-025a downgrades it to an advisory. The
// positive control asserts exactly that, because an ordering that got refused
// would leave every claim below testing the absence of a change.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CatalogSession } from '../../../src/activation/catalog-loading';
import { nodeDigest } from '../../../src/activation/catalog-store-wiring';
import { createLifecycleService, type CatalogStore, type LifecycleService } from '../../../src/catalog';
import { createDefinitionSemantics } from '../../../src/config/definition-semantics';
import type { PhaseRunOutput } from '../../../src/controller/phase-runner';
import { PhaseSequencer } from '../../../src/controller/phase-sequencer';
import type { CatalogKind } from '../../../src/contracts/catalog-store';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { FeatureRequest } from '../../../src/queue/feature-request';
import { WorkflowRunFactory } from '../../../src/services/workflow-run-factory';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import {
  createWorkspace,
  draftTokenFor,
  openStore,
  removeWorkspace
} from '../../fixtures/catalog-real-fs';
import { phaseBody, pipelineBody } from '../../fixtures/catalog-lifecycle-harness';
import { RecordingQueue, launch } from './run-harness';

const NOW = 1_700_000_000_000;
const ITERATION_CAP = 5;

/** The Pipeline the run is composed against, and which then goes out of service. */
const PIPELINE_ID = 'goes-out-of-service';

/**
 * A second Pipeline that stays live throughout.
 *
 * Without it the catalog would be left with no Pipelines at all and the launch
 * gate would refuse with `catalog-empty` — a true refusal for the wrong reason.
 * With it, the refusal below is `pipeline-not-found` for the one definition that
 * was deactivated, while this one still enqueues.
 */
const SPARE_PIPELINE_ID = 'stays-in-service';

const AUTHORED: readonly string[] = ['speckit-specify', 'speckit-plan', 'done'];
const SPARE: readonly string[] = ['speckit-specify', 'done'];

/** The Phase taken out of service under the run, mid-sequence rather than terminal. */
const DEACTIVATED_PHASE = 'speckit-plan';

const PHASE_IDS: readonly string[] = ['speckit-specify', 'speckit-plan', 'done'];

/** `''` for the configured default, so a deactivation reports no `configured-default`. */
const semantics = createDefinitionSemantics({ defaultPipelineId: () => '' });

/** No ports declared, so a launch that binds nothing is a complete request. */
function pipelineRow(id: string, phases: readonly string[]): unknown {
  return pipelineBody(id, phases, { inputs: [], outputs: [] });
}

function featureRequest(): FeatureRequest {
  return {
    id: 'feat-1',
    description: 'deactivate the definitions mid-run',
    enqueuedAt: NOW,
    createdAt: NOW,
    startedAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    status: 'in-flight',
    position: 0,
    runId: null,
    retryCount: 0,
    lastError: null,
    pausedReason: null
  };
}

/** A clean phase result, as the runner reports one that succeeded. */
function cleanOutput(): PhaseRunOutput {
  return {
    result: { kind: 'clean', auditEntry: { metrics: {} } as never },
    outcome: 'clean',
    terminationReason: 'token',
    stdoutSummary: '',
    stderrSummary: '',
    exitCode: 0,
    auditEntryId: null,
    warnings: []
  };
}

interface Arrangement {
  readonly store: CatalogStore;
  readonly service: LifecycleService;
  readonly session: CatalogSession;
}

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await createWorkspace('T514h');
});

afterEach(async () => {
  await removeWorkspace(workspaceRoot);
});

/**
 * Save and publish one definition through the lifecycle service.
 *
 * Two writes rather than one, and through the service rather than the store,
 * because the service is what enforces FR-017: publishing a Pipeline whose
 * Phases were not live first would be refused, so the seeding order below is
 * itself checked.
 */
async function activateThrough(
  arrangement: Pick<Arrangement, 'store' | 'service'>,
  kind: CatalogKind,
  id: string,
  body: unknown
): Promise<void> {
  const { store, service } = arrangement;
  const saved = await service.saveDraft({
    kind,
    id,
    body,
    expectedDraftVersion: await draftTokenFor(store, kind, id)
  });
  expect(saved.outcome, `${kind}/${id} should save`).toBe('saved');
  const published = await service.publish({
    kind,
    id,
    expectedDraftVersion: await draftTokenFor(store, kind, id)
  });
  expect(published.outcome, `${kind}/${id} should publish`).toBe('published');
}

/** Three Phases and two Pipelines live, with a session open over them. */
async function arrange(): Promise<Arrangement> {
  const store = openStore(workspaceRoot);
  const service = createLifecycleService({ store, semantics });
  const ports = { store, service };

  for (const id of PHASE_IDS) await activateThrough(ports, 'phase', id, phaseBody(id));
  await activateThrough(ports, 'pipeline', PIPELINE_ID, pipelineRow(PIPELINE_ID, AUTHORED));
  await activateThrough(ports, 'pipeline', SPARE_PIPELINE_ID, pipelineRow(SPARE_PIPELINE_ID, SPARE));

  const session = await CatalogSession.open({
    store,
    reader: undefined,
    digest: nodeDigest,
    logger: { debug: () => undefined }
  });
  return { store, service, session };
}

/**
 * Compose a run against the live catalog, freezing its plan.
 *
 * `getCatalog` reads the session on every call rather than capturing the catalog
 * once — so the factory would see the deactivation if it were consulted again.
 * It is not: the plan is frozen at creation, which is the premise FR-026 rests
 * on.
 */
async function inFlightRun(session: CatalogSession): Promise<WorkflowRun> {
  const factory = new WorkflowRunFactory({
    getCatalog: () => session.catalog,
    defaultRunnerKind: 'claude',
    logger: new SanitizedLogger()
  });
  return await factory.create(featureRequest(), null, PIPELINE_ID);
}

interface Deactivations {
  readonly pipeline: Awaited<ReturnType<LifecycleService['deactivate']>>;
  readonly phase: Awaited<ReturnType<LifecycleService['deactivate']>>;
}

/** The Pipeline out of service, then the Phase, then the session re-read. */
async function takeOutOfService(arrangement: Arrangement): Promise<Deactivations> {
  const { store, service, session } = arrangement;
  const pipeline = await service.deactivate({
    kind: 'pipeline',
    id: PIPELINE_ID,
    expectedDraftVersion: await draftTokenFor(store, 'pipeline', PIPELINE_ID)
  });
  const phase = await service.deactivate({
    kind: 'phase',
    id: DEACTIVATED_PHASE,
    expectedDraftVersion: await draftTokenFor(store, 'phase', DEACTIVATED_PHASE)
  });
  // The window notices, as one does on a store event. Without this the catalog
  // below would be the pre-deactivation one and the controls would pass for the
  // wrong reason.
  await session.refresh();
  return { pipeline, phase };
}

/**
 * Drive the run to termination through the production sequencer, reporting the
 * phases it visited.
 *
 * A near-twin of the loop in `definition-edit-during-run.test.ts`, kept local
 * rather than hoisted into `run-harness.ts`: sharing it would mean editing a
 * feature-089 fixture that this task does not own. Nothing in it consults the
 * catalog, which is the point — the sequencer decides from `run.pipeline` alone,
 * so the sequence it returns is the frozen plan's or it is nothing.
 */
function driveToCompletion(start: WorkflowRun): { visited: string[]; final: WorkflowRun } {
  const sequencer = new PhaseSequencer();
  const visited: string[] = [];
  let run = start;

  // Bounded so a regression that never terminates fails as a wrong sequence
  // rather than hanging the suite.
  for (let step = 0; step < PHASE_IDS.length + 2; step += 1) {
    visited.push(run.currentPhase);
    if (run.currentPhase === 'done') break;

    const decision = sequencer.decideAfterPhase({
      run,
      output: cleanOutput(),
      iteration: run.currentIteration,
      iterationCap: ITERATION_CAP,
      activePhaseDef: run.pipeline?.phases.find((def) => def.id === run.currentPhase),
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    if (decision.kind !== 'advance-or-loop' || decision.transition.kind === 'halt') break;

    run = {
      ...run,
      currentPhase: decision.transition.nextPhase,
      currentIteration: decision.transition.nextIteration,
      phasesCompleted: [...run.phasesCompleted, decision.phaseResult]
    };
  }
  return { visited, final: run };
}

describe('a definition taken out of service mid-run (T514h, FR-026, SC-006)', () => {
  it('leaves the effective catalog without either definition (positive control)', async () => {
    const arrangement = await arrange();
    const { session } = arrangement;
    expect(session.catalog.pipelinesById.has(PIPELINE_ID)).toBe(true);
    expect(session.catalog.phasesById.has(DEACTIVATED_PHASE)).toBe(true);

    const { pipeline, phase } = await takeOutOfService(arrangement);

    // The Pipeline first, with nothing referencing it and no configured default.
    expect(pipeline).toEqual({
      outcome: 'deactivated',
      state: 'draft',
      draftVersionId: 'v1',
      advisories: []
    });
    // Then the Phase, whose only referent is now that Pipeline's *draft* — an
    // advisory under FR-025a, where an active reference would have been a
    // blocker under FR-025 and refused this arrangement outright.
    expect(phase).toEqual({
      outcome: 'deactivated',
      state: 'draft',
      draftVersionId: 'v1',
      advisories: [{ advisory: 'draft-reference', kind: 'pipeline', id: PIPELINE_ID }]
    });
    expect(session.catalog.pipelinesById.get(PIPELINE_ID)).toBeUndefined();
    expect(session.catalog.phasesById.get(DEACTIVATED_PHASE)).toBeUndefined();
    // And the rest of the catalog is untouched, so the claims below are about
    // these two definitions and not about a catalog that stopped resolving.
    expect(session.catalog.pipelinesById.has(SPARE_PIPELINE_ID)).toBe(true);
    expect(session.catalog.phases.map((def) => def.id)).toEqual(['speckit-specify', 'done']);
  });

  it('leaves the in-flight plan byte-identical', async () => {
    const arrangement = await arrange();
    const run = await inFlightRun(arrangement.session);
    const before = structuredClone(run.pipeline);

    await takeOutOfService(arrangement);

    expect(run.pipeline).toEqual(before);
    expect(run.pipeline?.phases.map((def) => def.id)).toEqual(AUTHORED);
    // The Phase the store no longer serves is still in the plan, body and all.
    // A plan holding only ids would have nothing left to run here.
    expect(run.pipeline?.phases.find((def) => def.id === DEACTIVATED_PHASE)?.instruction).toBe(
      `Do ${DEACTIVATED_PHASE}.`
    );
  });

  it('completes the whole authored sequence with neither definition in the catalog', async () => {
    const arrangement = await arrange();
    const run = await inFlightRun(arrangement.session);
    await takeOutOfService(arrangement);

    const { visited, final } = driveToCompletion(run);

    // Every authored Phase, in order, ending at the terminal one — not a
    // sequence truncated at the Phase the store stopped serving.
    expect(visited).toEqual([...AUTHORED]);
    expect(visited).toContain(DEACTIVATED_PHASE);
    expect(final.currentPhase).toBe('done');
  });

  it('holds the same frozen plan at the end as at the start', async () => {
    // Completion is the window in which a retarget would hide, so the comparison
    // is taken after the run finished rather than only after the deactivation.
    const arrangement = await arrange();
    const run = await inFlightRun(arrangement.session);
    const before = structuredClone(run.pipeline);

    await takeOutOfService(arrangement);
    const { final } = driveToCompletion(run);

    expect(final.pipeline).toEqual(before);
    expect(final.pipeline).toBe(run.pipeline);
    expect(Object.isFrozen(final.pipeline)).toBe(true);
    expect(Object.isFrozen(final.pipeline?.phases)).toBe(true);
  });

  it('still refuses a run launched after the deactivation', async () => {
    // The discriminating control. If the effective catalog had kept serving the
    // deactivated Pipeline, every assertion above would hold for a reason that
    // has nothing to do with the freeze.
    const arrangement = await arrange();
    await takeOutOfService(arrangement);

    const refused = new RecordingQueue();
    const outcome = await launch(
      arrangement.session.catalog,
      refused,
      PIPELINE_ID,
      workspaceRoot,
      'run the deactivated Pipeline'
    );

    expect(outcome).toEqual({ outcome: 'rejected-definition', reason: 'pipeline-not-found' });
    expect(refused.submitted).toEqual([]);

    // And the gate is not simply closed: the Pipeline that stayed in service
    // still launches, so `pipeline-not-found` above names this definition rather
    // than a catalog that stopped working.
    const accepted = new RecordingQueue();
    const spare = await launch(
      arrangement.session.catalog,
      accepted,
      SPARE_PIPELINE_ID,
      workspaceRoot,
      'run the Pipeline that stayed'
    );

    expect(spare.outcome).toBe('enqueued');
    expect(accepted.only.runPlan?.pipeline.phases.map((def) => def.id)).toEqual([...SPARE]);
  });
});
