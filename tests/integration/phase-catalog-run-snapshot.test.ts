import { describe, expect, it } from 'vitest';
import { buildCatalog, type PhaseDef, type PipelineCatalog } from '../../src/config/pipeline-config';
import { snapshotPhaseDef } from '../../src/config/pipeline-snapshot';
import { SanitizedLogger } from '../../src/lib/logger';
import { WorkflowRunFactory } from '../../src/services/workflow-run-factory';
import type { BackendRunnerKind } from '../../src/runner/backend-runner-factory';
import type { WorkflowRunPipeline } from '../../src/state/workflow-run';

/**
 * Feature 098 (T024) — `resolvePipeline` answers with a discriminated resolution
 * now. This suite is about a successful resolution's frozen Phases, so a refusal
 * fails here rather than as `undefined.phases` at the assertion.
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

function factoryHarness(source: PhaseDef): {
  readonly factory: WorkflowRunFactory;
  removeCustomSource: () => void;
  catalogPhaseIds: () => readonly string[];
} {
  const done: PhaseDef = {
    id: 'done', name: 'Done', version: 1, instruction: '(no-op)', sourceScope: 'built-in'
  };
  const pipeline = { id: 'custom-pipeline', name: 'Custom', phases: ['custom', 'done'] };
  let catalog: PipelineCatalog = buildCatalog(
    [source, done], [pipeline], { claude: [], codex: [], agy: [] }, pipeline.id
  );
  return {
    factory: new WorkflowRunFactory({
      getCatalog: () => catalog,
      defaultRunnerKind: 'codex',
      logger: new SanitizedLogger()
    }),
    removeCustomSource: () => {
      catalog = buildCatalog(
        [done], [pipeline], { claude: [], codex: [], agy: [] }, pipeline.id
      );
    },
    catalogPhaseIds: () => catalog.phases.map((phase) => phase.id)
  };
}

describe('catalog edits cannot mutate queued or active Run Phase snapshots', () => {
  it('freezes the complete queued Phase definition', () => {
    const authored = {
      id: 'custom', name: 'Custom', description: 'Before', version: 2,
      skill: 'skill-a', model: 'model-a', effort: 'high' as const,
      timeoutSeconds: 20, loopable: true, sourceScope: 'workspace' as const
    };
    const { factory } = factoryHarness(authored);
    const queued = resolved(factory, 'custom-pipeline').phases[0];
    authored.description = 'After';
    authored.version = 3;
    expect(queued).toMatchObject({ description: 'Before', version: 2, skill: 'skill-a', runner: 'codex' });
    expect(Object.isFrozen(queued)).toBe(true);
  });

  it('retains an active snapshot after the catalog source is removed', () => {
    const source: PhaseDef = {
      id: 'custom', name: 'Custom', version: 1, instruction: 'Original',
      sourceScope: 'user' as const
    };
    const { factory, removeCustomSource, catalogPhaseIds } = factoryHarness(source);
    const active = resolved(factory, 'custom-pipeline', 'agy').phases[0];
    removeCustomSource();
    expect(catalogPhaseIds()).toEqual(['done']);
    expect(active).toMatchObject({
      id: 'custom', instruction: 'Original', version: 1, runner: 'agy'
    });
  });

  it('does not apply built-in runner pinning to a custom shadow', () => {
    const custom = snapshotPhaseDef({
      id: 'finalize', name: 'Custom finalize', version: 1,
      instruction: 'Custom.', sourceScope: 'workspace'
    }, 'codex');
    expect(custom.runner).toBe('codex');
    expect(custom.promptVersion).toBe('custom-v1');
  });
});
