// Feature 089 (T023, US3, FR-018) — the non-Spec-Kit built-in Pipeline resolves,
// composes, and runs with no edit and no change in behavior.
//
// **A naming reconciliation, recorded rather than papered over.** The spec calls
// this "the Ad-hoc Pipeline". No Pipeline by that name exists, and none ever
// did: the built-in catalog ships exactly three — `speckit-new-feature`,
// `speckit-bugfix`, and `dev-new-feature` — of which `dev-new-feature` is the one
// that is not a Spec Kit flow. So FR-018's "Ad-hoc" is `dev-new-feature`, this
// file covers it, and `speckit-compatibility.test.ts` covers the other two.
// Inventing an Ad-hoc Pipeline to match the wording would have shipped a fourth
// built-in nobody asked for; testing nothing would have left a stated
// requirement unqualified. The membership assertion below is what keeps the
// reconciliation honest — add a fourth built-in, under any name, and this fails
// until someone decides which file covers it.
//
// FR-018 names three verbs, and each is asserted against the seam that performs
// it rather than a re-implementation:
//
//   **resolve** — `loadCatalog()` with no reader, which is the production path
//   for a workspace that has authored nothing.
//
//   **compose** — the run-request gates inside `startPipelineRun()`, reached
//   through the headless entrypoint. A built-in declares no ports, so the
//   composed request carries no inputs and no outputs; "with no edit" is exactly
//   the claim that this still validates.
//
//   **run** — the enqueue. What lands at the queue is a frozen plan whose Phase
//   sequence is the built-in's own, in order.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BUILT_IN_DEV_NEW_FEATURE_PIPELINE,
  BUILT_IN_DEV_NEW_FEATURE_PIPELINE_ID,
  BUILT_IN_PIPELINES
} from '../../../src/config/pipeline-config';
import {
  builtInCatalog,
  launch,
  makeWorkspaceRoot,
  removeWorkspaceRoot,
  RecordingQueue
} from './built-in-run-harness';

const PIPELINE_ID = BUILT_IN_DEV_NEW_FEATURE_PIPELINE_ID;
const PHASE_IDS = BUILT_IN_DEV_NEW_FEATURE_PIPELINE.phases;
const INSTRUCTIONS = 'ship the dev new feature';

describe('the built-in Dev New Feature Pipeline still resolves (T023, FR-018)', () => {
  it('is the one non-Spec-Kit built-in, and the catalog holds exactly three', () => {
    // The reconciliation, asserted. A future "Ad-hoc" addition surfaces here.
    expect(BUILT_IN_PIPELINES.map((pipeline) => pipeline.id)).toEqual([
      'speckit-new-feature',
      'speckit-bugfix',
      'dev-new-feature'
    ]);
  });

  it('resolves effective with no errors and no warnings', () => {
    const loaded = builtInCatalog();
    const record = loaded.pipelineCatalog.records.find(
      (candidate) => candidate.pipelineId === PIPELINE_ID
    );

    expect(loaded.usedFallback).toBe(false);
    expect(loaded.errors).toEqual([]);
    expect(loaded.warnings).toEqual([]);
    expect(record?.status).toBe('effective');
    expect(record?.errors).toEqual([]);
  });

  it('keeps its identity and its Phase sequence, every Phase resolvable', () => {
    const { catalog } = builtInCatalog();
    const resolved = catalog.pipelinesById.get(PIPELINE_ID);

    expect(resolved).toBeDefined();
    expect(resolved!.id).toBe(PIPELINE_ID);
    expect(resolved!.name).toBe(BUILT_IN_DEV_NEW_FEATURE_PIPELINE.name);
    expect(resolved!.version).toBe(BUILT_IN_DEV_NEW_FEATURE_PIPELINE.version);
    expect(resolved!.phases).toEqual(PHASE_IDS);
    // A sequence that resolves is not the same as a sequence that runs: each
    // Phase has to be in the catalog too, or the run path refuses at gate 1.
    for (const phaseId of resolved!.phases) {
      expect(catalog.phasesById.get(phaseId), `Phase ${phaseId} is unresolvable`).toBeDefined();
    }
  });

  it('hydrates empty port contracts rather than absent ones', () => {
    const resolved = builtInCatalog().catalog.pipelinesById.get(PIPELINE_ID)!;

    // FR-017's guarantee, on the definitions that ship with the build: a
    // consumer reading `.length` on any of these must not have to guard first.
    expect(resolved.inputs).toEqual([]);
    expect(resolved.outputs).toEqual([]);
    expect(resolved.bindings).toEqual([]);
  });

  it('resolves identically when read twice — nothing is written back', () => {
    const first = builtInCatalog().catalog.pipelinesById.get(PIPELINE_ID);
    const second = builtInCatalog().catalog.pipelinesById.get(PIPELINE_ID);

    expect(second).toEqual(first);
  });
});

describe('the built-in Dev New Feature Pipeline still composes and runs (T023, FR-018)', () => {
  let workspaceRoot: string;

  beforeAll(async () => {
    workspaceRoot = await makeWorkspaceRoot();
  });

  afterAll(async () => {
    await removeWorkspaceRoot(workspaceRoot);
  });

  it('enqueues from a request that supplies no inputs and no outputs', async () => {
    const queue = new RecordingQueue();
    const result = await launch(
      builtInCatalog().catalog,
      queue,
      PIPELINE_ID,
      workspaceRoot,
      INSTRUCTIONS
    );

    // No edit anywhere: the definition is the one that ships, and the request
    // binds nothing, because there is nothing declared to bind.
    expect(result.outcome).toBe('enqueued');
    expect(queue.submitted).toHaveLength(1);
  });

  it('freezes the built-in Phase sequence into the plan that reaches the queue', async () => {
    const queue = new RecordingQueue();
    await launch(builtInCatalog().catalog, queue, PIPELINE_ID, workspaceRoot, INSTRUCTIONS);
    const submitted = queue.only;

    expect(submitted.pipelineId).toBe(PIPELINE_ID);
    expect(submitted.description).toBe(INSTRUCTIONS);
    expect(submitted.runPlan?.pipeline.id).toBe(PIPELINE_ID);
    // In order, and the built-in's own — not a subset, not a reordering, and not
    // a sequence the freeze substituted for a Phase it could not resolve.
    expect(submitted.runPlan?.pipeline.phases.map((phase) => phase.id)).toEqual(PHASE_IDS);
    expect(submitted.runPlan?.inputs).toEqual([]);
    expect(submitted.runPlan?.supplemental).toEqual([]);
    expect(submitted.runPlan?.outputs).toEqual([]);
  });
});
