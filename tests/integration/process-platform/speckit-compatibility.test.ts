// Feature 089 (T024, US3, FR-018) — the Spec Kit built-in Pipelines resolve,
// compose, and run with no edit and no change in behavior.
//
// The same three verbs as `adhoc-compatibility.test.ts`, over both Spec Kit
// built-ins, driven from a table. A table rather than two hand-written blocks
// because the claim is per-Pipeline and identical: a third Spec Kit flow added
// tomorrow joins the table and is qualified, instead of shipping unqualified
// because nobody copied a block.
//
// The two are not interchangeable, which is why both are here rather than one
// standing in for the pair. `speckit-new-feature` is nine Phases and carries the
// retry conditions; `speckit-bugfix` is five and carries none. A resolution or
// freeze defect that depends on sequence length or on the presence of an
// optional Phase field shows on one and not the other.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BUILT_IN_BUGFIX_PIPELINE,
  BUILT_IN_BUGFIX_PIPELINE_ID,
  BUILT_IN_PIPELINE,
  BUILT_IN_PIPELINE_ID,
  DEFAULT_PIPELINE_ID
} from '../../../src/config/pipeline-config';
import {
  builtInCatalog,
  launch,
  makeWorkspaceRoot,
  removeWorkspaceRoot,
  RecordingQueue
} from './built-in-run-harness';

const SPEC_KIT_PIPELINES = [
  ['speckit-new-feature', BUILT_IN_PIPELINE_ID, BUILT_IN_PIPELINE],
  ['speckit-bugfix', BUILT_IN_BUGFIX_PIPELINE_ID, BUILT_IN_BUGFIX_PIPELINE]
] as const;

describe('the Spec Kit built-in Pipelines still resolve (T024, FR-018)', () => {
  it('leaves speckit-new-feature as the default a fresh workspace runs', () => {
    // The default is part of "behavior unchanged": an operator who opens a fresh
    // workspace and hits run gets this one, and always has.
    expect(DEFAULT_PIPELINE_ID).toBe(BUILT_IN_PIPELINE_ID);
    expect(builtInCatalog().defaultPipelineId).toBe(BUILT_IN_PIPELINE_ID);
  });

  it.each(SPEC_KIT_PIPELINES)('resolves %s effective, with no errors', (_label, id) => {
    const loaded = builtInCatalog();
    const record = loaded.pipelineCatalog.records.find(
      (candidate) => candidate.pipelineId === id
    );

    expect(loaded.usedFallback).toBe(false);
    expect(loaded.errors).toEqual([]);
    expect(loaded.warnings).toEqual([]);
    expect(record?.status).toBe('effective');
    expect(record?.errors).toEqual([]);
  });

  it.each(SPEC_KIT_PIPELINES)(
    'keeps %s identity and Phase sequence, every Phase resolvable',
    (_label, id, definition) => {
      const { catalog } = builtInCatalog();
      const resolved = catalog.pipelinesById.get(id);

      expect(resolved).toBeDefined();
      expect(resolved!.id).toBe(id);
      expect(resolved!.name).toBe(definition.name);
      expect(resolved!.version).toBe(definition.version);
      expect(resolved!.phases).toEqual(definition.phases);
      for (const phaseId of resolved!.phases) {
        expect(catalog.phasesById.get(phaseId), `Phase ${phaseId} is unresolvable`).toBeDefined();
      }
    }
  );

  it.each(SPEC_KIT_PIPELINES)('hydrates %s with empty port contracts', (_label, id) => {
    const resolved = builtInCatalog().catalog.pipelinesById.get(id)!;

    expect(resolved.inputs).toEqual([]);
    expect(resolved.outputs).toEqual([]);
    expect(resolved.bindings).toEqual([]);
  });

  it.each(SPEC_KIT_PIPELINES)('resolves %s identically twice — nothing written back', (_label, id) => {
    expect(builtInCatalog().catalog.pipelinesById.get(id)).toEqual(
      builtInCatalog().catalog.pipelinesById.get(id)
    );
  });

  it('preserves the retry conditions the Spec Kit Phases carry', () => {
    const { catalog } = builtInCatalog();

    // The one place a Spec Kit flow differs from the bugfix flow in kind rather
    // than in length. `retryCondition` is operator-visible behavior, and it is
    // exactly the sort of optional field a hydration change would drop.
    expect(catalog.phasesById.get('speckit-clarify')?.retryCondition).toBe('open_questions > 0');
    expect(catalog.phasesById.get('speckit-analyze')?.retryCondition).toBe('critical_issues > 0');
    expect(catalog.phasesById.get('speckit-implement')?.retryCondition).toBe('pending_tasks > 0');
  });
});

describe('the Spec Kit built-in Pipelines still compose and run (T024, FR-018)', () => {
  let workspaceRoot: string;

  beforeAll(async () => {
    workspaceRoot = await makeWorkspaceRoot();
  });

  afterAll(async () => {
    await removeWorkspaceRoot(workspaceRoot);
  });

  it.each(SPEC_KIT_PIPELINES)(
    'enqueues %s from a request that supplies no inputs and no outputs',
    async (label, id, definition) => {
      const queue = new RecordingQueue();
      const instructions = `run ${label}`;
      const result = await launch(
        builtInCatalog().catalog,
        queue,
        id,
        workspaceRoot,
        instructions
      );

      expect(result.outcome).toBe('enqueued');
      const submitted = queue.only;
      expect(submitted.pipelineId).toBe(id);
      expect(submitted.description).toBe(instructions);
      expect(submitted.runPlan?.pipeline.id).toBe(id);
      expect(submitted.runPlan?.pipeline.phases.map((phase) => phase.id)).toEqual(
        definition.phases
      );
      expect(submitted.runPlan?.inputs).toEqual([]);
      expect(submitted.runPlan?.supplemental).toEqual([]);
      expect(submitted.runPlan?.outputs).toEqual([]);
    }
  );
});
