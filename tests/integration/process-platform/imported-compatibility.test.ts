// Feature 089 (T023, T024, US3, FR-018) — a Pipeline resolves, composes, and
// runs with no edit and no change in behavior.
//
// Feature 098 (T080) replaced the two files this one stands in for.
// `adhoc-compatibility.test.ts` covered `dev-new-feature` and
// `speckit-compatibility.test.ts` covered `speckit-new-feature` and
// `speckit-bugfix`, the three Pipelines the product compiled into itself. The
// split existed for one reason: which built-in a file was responsible for. With
// the built-in layer empty there is no such thing as a built-in Pipeline to be
// responsible for, so a two-file split covering the same fixture rows twice
// would be duplication rather than coverage, and one file drives the pair from a
// table instead.
//
// What is *not* dropped is FR-018's claim. Both files asserted three verbs, and
// each is still asserted here against the seam that performs it — only the
// definitions' provenance changed, from compiled-in to imported:
//
//   **resolve** — `loadCatalog()` over a reader holding authored rows, which is
//   the production path now that authoring into a scope is the only way a
//   definition exists at all.
//
//   **compose** — the run-request gates inside `startPipelineRun()`, reached
//   through the headless entrypoint. The fixture Pipelines declare no ports, so
//   the composed request carries no inputs and no outputs; "with no edit" is
//   exactly the claim that this still validates.
//
//   **run** — the enqueue. What lands at the queue is a frozen plan whose Phase
//   sequence is the authored one, in order.
//
// Two Pipelines rather than one, for the reason the Spec Kit file gave for
// keeping its pair: `fixture-simple-pipeline` is two Phases and carries a retry
// condition, `fixture-single-phase-pipeline` is one and carries none. A
// resolution or freeze defect that depends on sequence length or on the presence
// of an optional Phase field shows on one and not the other.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_PHASE_IDS,
  FIXTURE_PIPELINE_DEFINITION_SIMPLE,
  FIXTURE_PIPELINE_DEFINITION_SINGLE,
  FIXTURE_PIPELINE_IDS
} from '../../fixtures/process-catalog-fixture';
import {
  importedCatalog,
  launch,
  makeWorkspaceRoot,
  removeWorkspaceRoot,
  RecordingQueue
} from './run-harness';

const IMPORTED_PIPELINES = [
  ['two-phase', FIXTURE_PIPELINE_IDS.simple, FIXTURE_PIPELINE_DEFINITION_SIMPLE],
  ['single-phase', FIXTURE_PIPELINE_IDS.single, FIXTURE_PIPELINE_DEFINITION_SINGLE]
] as const;

describe('an imported Pipeline still resolves (T023, T024, FR-018)', () => {
  it('names the default the authoring scope named, and nothing when none is authored', () => {
    // Feature 098 (T027, FR-027) — the predecessor asserted that a workspace
    // which had authored nothing still named `speckit-new-feature`, on the
    // reasoning that an operator who opens a fresh workspace and hits run gets
    // that Pipeline. There is no such Pipeline to name now: a catalog assembled
    // from nothing names nothing, and the only default that exists is one an
    // operator authored.
    expect(importedCatalog().defaultPipelineId).toBe(FIXTURE_PIPELINE_IDS.single);
  });

  it.each(IMPORTED_PIPELINES)('resolves %s effective, with no errors', (_label, id) => {
    const loaded = importedCatalog();
    const record = loaded.pipelineCatalog.records.find(
      (candidate) => candidate.pipelineId === id
    );

    expect(loaded.usedFallback).toBe(false);
    expect(loaded.errors).toEqual([]);
    expect(loaded.warnings).toEqual([]);
    expect(record?.status).toBe('effective');
    expect(record?.errors).toEqual([]);
  });

  it.each(IMPORTED_PIPELINES)(
    'keeps %s identity and Phase sequence, every Phase resolvable',
    (_label, id, definition) => {
      const { catalog } = importedCatalog();
      const resolved = catalog.pipelinesById.get(id);

      expect(resolved).toBeDefined();
      expect(resolved!.id).toBe(id);
      expect(resolved!.name).toBe(definition.name);
      expect(resolved!.version).toBe(definition.version);
      expect(resolved!.phases).toEqual(definition.phaseIds);
      // A sequence that resolves is not the same as a sequence that runs: each
      // Phase has to be in the catalog too, or the run path refuses at gate 1.
      for (const phaseId of resolved!.phases) {
        expect(catalog.phasesById.get(phaseId), `Phase ${phaseId} is unresolvable`).toBeDefined();
      }
    }
  );

  it.each(IMPORTED_PIPELINES)('hydrates %s with empty port contracts', (_label, id) => {
    const resolved = importedCatalog().catalog.pipelinesById.get(id)!;

    // FR-017's guarantee, on definitions that declared no ports: a consumer
    // reading `.length` on any of these must not have to guard first.
    expect(resolved.inputs).toEqual([]);
    expect(resolved.outputs).toEqual([]);
    expect(resolved.bindings).toEqual([]);
  });

  it.each(IMPORTED_PIPELINES)('resolves %s identically twice — nothing written back', (_label, id) => {
    expect(importedCatalog().catalog.pipelinesById.get(id)).toEqual(
      importedCatalog().catalog.pipelinesById.get(id)
    );
  });

  it('preserves the retry condition the two-Phase Pipeline carries', () => {
    const { catalog } = importedCatalog();

    // The one place the two fixture Pipelines differ in kind rather than in
    // length. `retryCondition` is operator-visible behavior, and it is exactly
    // the sort of optional field a hydration change would drop.
    expect(catalog.phasesById.get(FIXTURE_PHASE_IDS.second)?.retryCondition).toBe(
      'pending_tasks > 0'
    );
  });
});

describe('an imported Pipeline still composes and runs (T023, T024, FR-018)', () => {
  let workspaceRoot: string;

  beforeAll(async () => {
    workspaceRoot = await makeWorkspaceRoot();
  });

  afterAll(async () => {
    await removeWorkspaceRoot(workspaceRoot);
  });

  it.each(IMPORTED_PIPELINES)(
    'enqueues %s from a request that supplies no inputs and no outputs',
    async (label, id, definition) => {
      const queue = new RecordingQueue();
      const instructions = `run ${label}`;
      const result = await launch(
        importedCatalog().catalog,
        queue,
        id,
        workspaceRoot,
        instructions
      );

      // No edit anywhere: the definition is the one that was authored, and the
      // request binds nothing, because there is nothing declared to bind.
      expect(result.outcome).toBe('enqueued');
      const submitted = queue.only;
      expect(submitted.pipelineId).toBe(id);
      expect(submitted.description).toBe(instructions);
      expect(submitted.runPlan?.pipeline.id).toBe(id);
      // In order, and the authored sequence — not a subset, not a reordering,
      // and not a sequence the freeze substituted for a Phase it could not
      // resolve.
      expect(submitted.runPlan?.pipeline.phases.map((phase) => phase.id)).toEqual(
        definition.phaseIds
      );
      expect(submitted.runPlan?.inputs).toEqual([]);
      expect(submitted.runPlan?.supplemental).toEqual([]);
      expect(submitted.runPlan?.outputs).toEqual([]);
    }
  );
});
