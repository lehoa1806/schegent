// Feature 082 (US5, T042/T044/T045) — the frozen Run contract.
//
// Modelled on `phase-catalog-run-snapshot.test.ts`, which pins the Phase half of
// the same guarantee. A Run that froze only `{ id, name, phases }` would keep its
// Phase list pinned while its ports, bindings, and execution defaults silently
// followed later catalog edits — the worst of both (FR-026, FR-027, SC-004).
//
// The freeze widens *what* is captured, never *when*: the repository hard rule
// "never mutate or retarget an in-flight `WorkflowRun.pipeline` snapshot" still
// holds, and no catalog source metadata, revision, or validation state is stored
// alongside the executable contract (FR-039).

import { describe, expect, it } from 'vitest';
import type {
  PhaseBinding,
  PipelineExecutionDefaults,
  PipelineInputPort,
  PipelineOutputPort
} from '../../src/contracts/pipeline-definitions';
import {
  buildCatalog,
  type PhaseDef,
  type PipelineCatalog,
  type PipelineDef
} from '../../src/config/pipeline-config';
import { SanitizedLogger } from '../../src/lib/logger';
import { WorkflowRunFactory } from '../../src/services/workflow-run-factory';
import type { BackendRunnerKind } from '../../src/runner/backend-runner-factory';
import type { WorkflowRunPipeline } from '../../src/state/workflow-run';
import { migrateV7ToV8 } from '../../src/state/workflow-run-migrator';

/**
 * Feature 098 (T024) — `resolvePipeline` answers with a discriminated resolution
 * now. This suite is about what a *successful* resolution freezes, so it says so
 * once here and a refusal fails loudly at the call rather than as a missing
 * property several assertions later.
 */
function resolved(
  factory: WorkflowRunFactory,
  id: string,
  runnerKind?: BackendRunnerKind
): WorkflowRunPipeline {
  const resolution = runnerKind
    ? factory.resolvePipeline(id, runnerKind)
    : factory.resolvePipeline(id);
  if (!resolution.ok) throw new Error(`expected '${id}' to resolve, got ${resolution.refusal.reason}`);
  return resolution.pipeline;
}

const SPECIFY: PhaseDef = {
  id: 'speckit-specify', name: 'Specify', version: 1, instruction: 'Write the spec.',
};
const DONE: PhaseDef = {
  id: 'done', name: 'Done', version: 1, instruction: '(no-op)'
};

const INPUTS: PipelineInputPort[] = [
  { portId: 'brief', label: 'Brief', type: 'text', required: true }
];
const OUTPUTS: PipelineOutputPort[] = [
  { portId: 'spec', label: 'Spec', type: 'markdown' }
];
const BINDINGS: PhaseBinding[] = [
  { kind: 'input', phaseIndex: 0, inputKey: 'brief', source: { from: 'pipeline-input', portId: 'brief' } },
  { kind: 'output', phaseIndex: 0, portId: 'spec', outputKey: 'spec' }
];

/**
 * The catalog row as an operator holds it — mutable all the way down, so a test
 * can make exactly the edits the freeze has to survive.
 */
interface AuthoredPipeline {
  id: string;
  name: string;
  description?: string;
  version?: number;
  phases: string[];
  inputs: PipelineInputPort[];
  outputs: PipelineOutputPort[];
  bindings: PhaseBinding[];
  executionDefaults?: PipelineExecutionDefaults;
  recommendedNext: string[];
}

/** A Pipeline authored with every contract field this feature freezes. */
function authoredPipeline(): AuthoredPipeline {
  return {
    id: 'contract-flow',
    name: 'Contract Flow',
    description: 'Before',
    version: 4,
    phases: ['speckit-specify', 'done'],
    inputs: [...INPUTS],
    outputs: [...OUTPUTS],
    bindings: [...BINDINGS],
    executionDefaults: { runner: 'claude', model: 'model-a', effort: 'high', timeoutSeconds: 30 },
    recommendedNext: ['ship-it'],
  };
}

function factoryHarness(pipeline: PipelineDef): {
  readonly factory: WorkflowRunFactory;
  removePipeline: () => void;
  catalogPipelineIds: () => readonly string[];
} {
  let catalog: PipelineCatalog = buildCatalog(
    [SPECIFY, DONE], [pipeline], { claude: [], codex: [], agy: [] }, pipeline.id
  );
  return {
    factory: new WorkflowRunFactory({
      getCatalog: () => catalog,
      defaultRunnerKind: 'codex',
      logger: new SanitizedLogger()
    }),
    removePipeline: () => {
      const fallback: PipelineDef = { id: 'other-flow', name: 'Other', phases: ['done'] };
      catalog = buildCatalog(
        [SPECIFY, DONE], [fallback], { claude: [], codex: [], agy: [] }, fallback.id
      );
    },
    catalogPipelineIds: () => catalog.pipelines.map((entry) => entry.id)
  };
}

describe('catalog edits cannot mutate queued or active Run Pipeline contracts (US5)', () => {
  it('freezes the complete resolved contract, not just id/name/phases (FR-026)', () => {
    const authored = authoredPipeline();
    const { factory } = factoryHarness(authored);

    const queued = resolved(factory, 'contract-flow');

    expect(queued).toMatchObject({
      id: 'contract-flow',
      name: 'Contract Flow',
      description: 'Before',
      version: 4,
      inputs: INPUTS,
      outputs: OUTPUTS,
      bindings: BINDINGS,
      executionDefaults: { runner: 'claude', model: 'model-a', effort: 'high', timeoutSeconds: 30 },
      recommendedNext: ['ship-it']
    });
  });

  it('deep-copies the contract so a later catalog edit cannot reach into it (SC-004)', () => {
    const authored = authoredPipeline();
    const { factory } = factoryHarness(authored);

    const queued = resolved(factory, 'contract-flow');

    // Every mutation an operator could make by editing the row afterwards,
    // including reaching through the nested arrays the freeze must not alias.
    authored.description = 'After';
    authored.version = 5;
    authored.inputs.push({ portId: 'extra', label: 'Extra', type: 'text' });
    authored.outputs.length = 0;
    authored.bindings.push({ kind: 'output', phaseIndex: 1, portId: 'x', outputKey: 'x' });
    authored.recommendedNext = ['something-else'];
    authored.executionDefaults = { runner: 'agy' };

    expect(queued.description).toBe('Before');
    expect(queued.version).toBe(4);
    expect(queued.inputs).toEqual(INPUTS);
    expect(queued.outputs).toEqual(OUTPUTS);
    expect(queued.bindings).toEqual(BINDINGS);
    expect(queued.recommendedNext).toEqual(['ship-it']);
    expect(queued.executionDefaults).toEqual({
      runner: 'claude', model: 'model-a', effort: 'high', timeoutSeconds: 30
    });
  });

  it('freezes the contract transitively so nothing can mutate it in place', () => {
    const { factory } = factoryHarness(authoredPipeline());

    const queued = resolved(factory, 'contract-flow');

    expect(Object.isFrozen(queued)).toBe(true);
    expect(Object.isFrozen(queued.inputs)).toBe(true);
    expect(Object.isFrozen(queued.outputs)).toBe(true);
    expect(Object.isFrozen(queued.bindings)).toBe(true);
    expect(Object.isFrozen(queued.recommendedNext)).toBe(true);
    expect(Object.isFrozen(queued.executionDefaults)).toBe(true);
    expect(Object.isFrozen(queued.bindings![0])).toBe(true);
  });

  it('retains the contract after the catalog Pipeline is removed entirely (FR-027)', () => {
    const { factory, removePipeline, catalogPipelineIds } = factoryHarness(authoredPipeline());

    const active = resolved(factory, 'contract-flow', 'agy');
    removePipeline();

    expect(catalogPipelineIds()).toEqual(['other-flow']);
    expect(active).toMatchObject({
      id: 'contract-flow', version: 4, inputs: INPUTS, outputs: OUTPUTS, bindings: BINDINGS
    });
    expect(active.phases.map((phase) => phase.id)).toEqual(['speckit-specify', 'done']);
  });

  // T044 (FR-039) — the executable contract is exactly that. Source scope,
  // revisions, and validation state describe where a definition came from and
  // whether it is currently repairable; a Run executing a definition captured
  // weeks ago has no use for any of it, and a workspace path in a persisted Run
  // would leak into the structured audit log the hard rules protect.
  it('stores no source metadata, revision, validation state, or workspace path', () => {
    const { factory } = factoryHarness(authoredPipeline());

    const queued = resolved(factory, 'contract-flow');

    for (const key of ['sourceScope', 'sourceKey', 'sourceStatus', 'sourceErrors', 'revision', 'revisions', 'status', 'errors', 'warnings', 'display', 'persisted']) {
      expect(queued).not.toHaveProperty(key);
    }
    const serialized = JSON.stringify(queued);
    expect(serialized).not.toMatch(/(^|")\/(Users|home|var|tmp)\//);
    expect(serialized).not.toContain(process.cwd());
  });

  // T045 — the new fields are optional precisely so no state-schema bump is
  // needed (research R8). A Run persisted before this feature must still load
  // and execute against exactly what it froze.
  it('loads a Run persisted before this feature unchanged', () => {
    const legacy = {
      id: 'run-1', featureId: 'feat-1', featureDir: '', status: 'running',
      currentPhase: 'speckit-specify', currentIteration: 0, startedAt: 1, lastTransitionAt: 1,
      phasesCompleted: [], lastError: null, rawTranscriptMode: 'always',
      pipeline: { id: 'legacy-flow', name: 'Legacy', phases: [SPECIFY, DONE] },
      defaultRunnerKind: 'claude', delayedRetryCount: 0, pendingRetryAt: null,
      pendingRetryCause: null, phaseOverrides: [], manualPauseAt: null, manualPauseCause: null,
      phaseBreakpoints: [], resumeTargetPhaseId: null
    };

    const migrated = migrateV7ToV8(structuredClone(legacy));

    expect(migrated?.pipeline).toEqual(legacy.pipeline);
    for (const key of ['version', 'inputs', 'outputs', 'bindings', 'executionDefaults', 'recommendedNext']) {
      expect(migrated?.pipeline).not.toHaveProperty(key);
    }
    expect(migrated?.currentPhase).toBe('speckit-specify');
    expect(migrated?.status).toBe('running');
  });
});
