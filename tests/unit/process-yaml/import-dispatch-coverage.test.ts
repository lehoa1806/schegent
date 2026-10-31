// Feature 254 (FR-R4-F07, V-T1; contract V2; research R24; FR-041) — every kind with `import` rows is
// written, or the import says it was not.
//
// Hard rule 63 records the failure this closes: a kind whose rows reached the plan and were never handed to
// a write is dropped without a word, and the commit reports success for what it did write. Every reader on
// `ProcessCatalogPort` is optional and every caller defaults silently, so the compiler cannot notice an
// omitted kind; a typed map (`DISPATCH_OF_KIND`) catches the omission at compile time, and the runtime guard
// here catches the row that reaches `importProcessDocument` with a kind nothing wrote.
//
// What is asserted:
//   * a plan with one `import` row per kind is written in full: the three catalog kinds in one package
//     publish, the Model Catalog through its own save;
//   * `undispatchedKinds(plan, dispatched)` names exactly the kinds that have `import` rows and are not in
//     `dispatched`, for each kind removed in turn;
//   * a row of a kind the dispatch does not know (a fifth kind, as a forgotten one would arrive) makes the
//     import `failed` and names the kind, instead of reporting `imported` for the rest.
//
// The ports are stubs. The real publish and save are covered where the writes are
// (tests/integration/catalog-package-partial.test.ts, headless-parity.test.ts); this file is about which kinds
// are handed to them.

import { describe, expect, it } from 'vitest';

import type { PackagePublishOutcome, PackagePublishRequest } from '../../../src/contracts/catalog-lifecycle';
import {
  DISPATCH_OF_KIND,
  importProcessDocument,
  undispatchedKinds,
  type ImportWritePort
} from '../../../src/headless/process-yaml-api';
import {
  PROCESS_YAML_RESOURCE_KINDS,
  type ImportPlan,
  type ImportPlanRow,
  type ProcessYamlResourceKind
} from '../../../src/services/process-yaml/types';

const PHASE_ROW = {
  outcome: 'import',
  resourceKind: 'phase',
  resourceId: 'phase-one',
  name: 'Phase One',
  requiresRetryConditionCapability: false,
  definition: { phaseId: 'phase-one', name: 'Phase One', version: 1, instruction: 'Do the work.' }
} satisfies ImportPlanRow;

const PIPELINE_ROW = {
  outcome: 'import',
  resourceKind: 'pipeline',
  resourceId: 'flow',
  name: 'Flow',
  definition: {
    pipelineId: 'flow',
    name: 'Flow',
    version: 1,
    phaseIds: ['phase-one'],
    inputs: [],
    outputs: [],
    bindings: [],
    recommendedNext: []
  }
} satisfies ImportPlanRow;

const WORKFLOW_ROW = {
  outcome: 'import',
  resourceKind: 'workflow',
  resourceId: 'wf',
  name: 'Workflow',
  definition: {
    workflowId: 'wf',
    name: 'Workflow',
    version: 1,
    nodes: [{ nodeId: 'first', pipelineId: 'flow' }],
    connections: [],
    startNodeIds: ['first']
  }
} satisfies ImportPlanRow;

const MODEL_ROW = {
  outcome: 'import',
  resourceKind: 'modelCatalog',
  resourceId: 'sonnet',
  backend: 'claude',
  modelId: 'sonnet'
} satisfies ImportPlanRow;

const ROW_OF_KIND: Readonly<Record<ProcessYamlResourceKind, ImportPlanRow>> = {
  phase: PHASE_ROW,
  pipeline: PIPELINE_ROW,
  workflow: WORKFLOW_ROW,
  modelCatalog: MODEL_ROW
};

function planOf(rows: readonly ImportPlanRow[]): ImportPlan {
  return {
    rows,
    counts: { import: rows.length, skip: 0, blocked: 0, invalid: 0 },
    computedAgainstRevision: 'phase-revision',
    computedAgainstPipelineRevision: 'pipeline-revision',
    computedAgainstWorkflowRevision: 'workflow-revision',
    computedAgainstModelsRevision: 'models-revision'
  };
}

interface Recorder {
  readonly port: ImportWritePort;
  readonly packages: PackagePublishRequest[];
  readonly modelSaves: unknown[];
}

function recordingPort(): Recorder {
  const packages: PackagePublishRequest[] = [];
  const modelSaves: unknown[] = [];
  const port: ImportWritePort = {
    publishPackage: async (request): Promise<PackagePublishOutcome> => {
      packages.push(request);
      return {
        outcome: 'published',
        published: request.layers.map((layer) => ({
          kind: layer.kind,
          ids: layer.definitions.map((definition) => definition.id)
        })),
        pruned: []
      } as unknown as PackagePublishOutcome;
    },
    saveModels: async (payload) => {
      modelSaves.push(payload);
      return { status: 'accepted' };
    }
  };
  return { port, packages, modelSaves };
}

describe('FR-R4-F07 V-T1 — every kind with import rows is written (FR-041)', () => {
  it('writes all four kinds of a plan with one import row each', async () => {
    const recorder = recordingPort();
    const plan = planOf(PROCESS_YAML_RESOURCE_KINDS.map((kind) => ROW_OF_KIND[kind]));

    const result = await importProcessDocument(recorder.port, { plan });

    expect(recorder.packages).toHaveLength(1);
    expect(recorder.packages[0]?.layers.map((layer) => layer.kind)).toEqual(['phase', 'pipeline', 'workflow']);
    expect(recorder.modelSaves).toHaveLength(1);
    expect(recorder.modelSaves[0]).toMatchObject({ models: { claude: ['sonnet'] } });
    expect(result.outcome).toBe('imported');
    expect(result.undispatched).toBeUndefined();
  });

  it('writes each kind alone when it is the only kind in the plan', async () => {
    for (const kind of PROCESS_YAML_RESOURCE_KINDS) {
      const recorder = recordingPort();

      const result = await importProcessDocument(recorder.port, { plan: planOf([ROW_OF_KIND[kind]]) });

      expect(result.outcome, kind).toBe('imported');
      const wrote = recorder.packages.flatMap((request) => request.layers.map((layer) => layer.kind));
      if (DISPATCH_OF_KIND[kind] === 'package-layer') {
        expect(wrote, kind).toEqual([kind]);
        expect(recorder.modelSaves, kind).toHaveLength(0);
      } else {
        expect(wrote, kind).toEqual([]);
        expect(recorder.modelSaves, kind).toHaveLength(1);
      }
    }
  });

  it('maps every kind to a route (the typed map is complete at runtime too)', () => {
    expect(Object.keys(DISPATCH_OF_KIND).sort()).toEqual([...PROCESS_YAML_RESOURCE_KINDS].sort());
    for (const kind of PROCESS_YAML_RESOURCE_KINDS) {
      expect(['package-layer', 'model-settings']).toContain(DISPATCH_OF_KIND[kind]);
    }
  });
});

describe('FR-R4-F07 V-T1 — undispatchedKinds names exactly what was not written', () => {
  const plan = planOf(PROCESS_YAML_RESOURCE_KINDS.map((kind) => ROW_OF_KIND[kind]));

  it('is empty when every kind with rows was dispatched', () => {
    expect(undispatchedKinds(plan, new Set(PROCESS_YAML_RESOURCE_KINDS))).toEqual([]);
  });

  it.each(PROCESS_YAML_RESOURCE_KINDS.map((kind) => [kind] as const))(
    'names only %s when it is the one kind left out of the dispatched set',
    (omitted) => {
      const dispatched = new Set(PROCESS_YAML_RESOURCE_KINDS.filter((kind) => kind !== omitted));

      expect(undispatchedKinds(plan, dispatched)).toEqual([omitted]);
    }
  );

  it('names every kind when nothing was dispatched, and none that has no import row', () => {
    expect([...undispatchedKinds(plan, new Set())].sort()).toEqual([...PROCESS_YAML_RESOURCE_KINDS].sort());
    expect(undispatchedKinds(planOf([PHASE_ROW]), new Set())).toEqual(['phase']);
    expect(undispatchedKinds(planOf([]), new Set())).toEqual([]);
  });

  it('ignores rows that are not import rows (a skipped kind needs no write)', () => {
    const skipped = planOf([
      {
        outcome: 'skip',
        resourceKind: 'phase',
        resourceId: 'phase-one',
        name: 'Phase One',
        presentRowStatus: 'effective'
      } as ImportPlanRow
    ]);

    expect(undispatchedKinds(skipped, new Set())).toEqual([]);
  });
});

describe('FR-R4-F07 V-T1 — a kind nothing writes makes the import fail, naming it (V2)', () => {
  /** A row of a kind the dispatch has never heard of: how a forgotten sixth kind arrives. */
  const FIFTH_KIND_ROW = {
    outcome: 'import',
    resourceKind: 'prompt',
    resourceId: 'p1',
    name: 'Prompt'
  } as unknown as ImportPlanRow;

  it('returns failed and names the kind, instead of reporting the rest as imported', async () => {
    const recorder = recordingPort();

    const result = await importProcessDocument(recorder.port, { plan: planOf([PHASE_ROW, FIFTH_KIND_ROW]) });

    expect(result.outcome).toBe('failed');
    expect(result.undispatched).toEqual(['prompt']);
    // What the known kind wrote stays written (FR-042c: no compensating delete), and is reported.
    expect(recorder.packages).toHaveLength(1);
    expect(result.results.map((entry) => entry.key)).toEqual(['phases']);
  });

  it('names the kind even when it is the only row', async () => {
    const recorder = recordingPort();

    const result = await importProcessDocument(recorder.port, { plan: planOf([FIFTH_KIND_ROW]) });

    expect(result.outcome).toBe('failed');
    expect(result.undispatched).toEqual(['prompt']);
    expect(recorder.packages).toHaveLength(0);
    expect(recorder.modelSaves).toHaveLength(0);
  });
});
