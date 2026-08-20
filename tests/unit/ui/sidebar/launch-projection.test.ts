// Feature 102 (FR-R3-018) T008 — every row of the inclusion and section-state
// tables in `specs/102-runs-launch-surface/contracts/launch-projection.md`.
//
// Runs is the only place work starts, and this projection is what it offers. An
// entry that should not be there is a definition an operator can launch without
// having published it; an entry missing from it is published work the operator
// cannot reach. Both are wrong answers to the question the surface exists to
// ask, which is why these are contract tests rather than unit coverage.
//
// The fixtures are catalog *projections*, not store snapshots. That is the
// projection's actual input: it reads `pipelineCatalog` and `workflowCatalog`
// off the snapshot and re-resolves nothing (FR-017). Driving it from the store
// would test the resolvers a third time and would hide the one thing worth
// pinning here — that a record carrying a lifecycle this projection must refuse
// is in fact refused, rather than being filtered upstream by a resolver that
// happens to drop it today.

import { describe, expect, it } from 'vitest';
import { NO_DRAFT } from '../../../../src/contracts/catalog-lifecycle';
import type { DefinitionState } from '../../../../src/contracts/catalog-lifecycle';
import type {
  PipelineDefinition,
  PipelineInputPort
} from '../../../../src/contracts/pipeline-definitions';
import type {
  WorkflowDefinition,
  WorkflowDerivedPort,
  WorkflowNode
} from '../../../../src/contracts/workflow-definitions';
import { buildLaunchProjection } from '../../../../src/ui/sidebar/launch-projection';
import type {
  BuilderLifecycle,
  Launchable,
  LaunchSection,
  PipelineCatalogProjection,
  PipelineCatalogSourceProjection,
  WorkflowCatalogProjection,
  WorkflowCatalogSourceProjection
} from '../../../../src/ui/sidebar/snapshot';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A lifecycle in one state. `activeVersionId` is passed rather than derived from
 * the state so a deactivated definition — a record whose lifecycle says `active`
 * with no active version — can be built at all. That combination is the one the
 * inclusion table's rule 2 exists for.
 */
function lifecycle(state: DefinitionState, activeVersionId: string | undefined): BuilderLifecycle {
  return {
    state,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_500_000,
    ...(activeVersionId !== undefined ? { activeVersionId } : {}),
    expectedDraftVersion: state === 'active' ? NO_DRAFT : 'v-draft',
    versions: activeVersionId !== undefined
      ? [{ versionId: activeVersionId, createdAt: 1_700_000_000_000, publishedAt: 1_700_000_100_000, isActive: true, note: null }]
      : []
  };
}

function pipelineDefinition(
  pipelineId: string,
  name: string,
  inputs: readonly PipelineInputPort[] = []
): PipelineDefinition {
  return {
    pipelineId,
    name,
    version: 1,
    phaseIds: ['plan'],
    inputs,
    outputs: [],
    bindings: [],
    recommendedNext: []
  };
}

/**
 * The spec's version, defaulting only when the spec did not name the field.
 *
 * `?? 'v1'` would swallow an explicit `activeVersionId: undefined`, which is
 * precisely the deactivated case rule 2 exists for — the fixture would then
 * describe a definition that has one.
 */
function versionOf(spec: { readonly activeVersionId?: string }): string | undefined {
  return 'activeVersionId' in spec ? spec.activeVersionId : 'v1';
}

interface PipelineRecordSpec {
  readonly pipelineId: string;
  readonly name: string;
  readonly description?: string;
  readonly state?: DefinitionState;
  readonly activeVersionId?: string;
  readonly withoutLifecycle?: boolean;
  readonly inputs?: readonly PipelineInputPort[];
  readonly invalid?: boolean;
}

function pipelineRecord(spec: PipelineRecordSpec): PipelineCatalogSourceProjection {
  const definition = spec.invalid
    ? null
    : pipelineDefinition(spec.pipelineId, spec.name, spec.inputs ?? []);
  return {
    key: `${spec.pipelineId}::0`,
    pipelineId: spec.pipelineId,
    status: spec.invalid ? 'invalid' : 'effective',
    definition,
    display: {
      name: spec.name,
      ...(spec.description !== undefined ? { description: spec.description } : {})
    },
    errors: [],
    ...(spec.withoutLifecycle === true
      ? {}
      : { lifecycle: lifecycle(spec.state ?? 'active', versionOf(spec)) })
  };
}

function pipelineCatalog(
  records: readonly PipelineCatalogSourceProjection[]
): PipelineCatalogProjection {
  return {
    state: 'ready',
    records,
    // The effective catalog is the set of Active versions, which for these
    // fixtures is exactly the records that carry a definition.
    effective: records
      .map((record) => record.definition)
      .filter((definition): definition is PipelineDefinition => definition !== null),
    revision: 'rev-pipelines',
    warnings: []
  };
}

function derivedPort(nodeId: string, portId: string, label: string): WorkflowDerivedPort {
  return { nodeId, portId, label, type: 'text' };
}

function workflowDefinition(
  workflowId: string,
  name: string,
  nodes: readonly WorkflowNode[]
): WorkflowDefinition {
  return {
    workflowId,
    name,
    version: 1,
    nodes,
    connections: [],
    startNodeIds: nodes.length > 0 ? [nodes[0]!.nodeId] : []
  };
}

interface WorkflowRecordSpec {
  readonly workflowId: string;
  readonly name: string;
  readonly description?: string;
  readonly state?: DefinitionState;
  readonly activeVersionId?: string;
  readonly withoutLifecycle?: boolean;
  readonly nodes: readonly WorkflowNode[];
  readonly derivedInputs?: readonly WorkflowDerivedPort[];
  readonly invalid?: boolean;
}

function workflowRecord(spec: WorkflowRecordSpec): WorkflowCatalogSourceProjection {
  const definition = spec.invalid
    ? null
    : workflowDefinition(spec.workflowId, spec.name, spec.nodes);
  return {
    key: `${spec.workflowId}::0`,
    workflowId: spec.workflowId,
    status: spec.invalid ? 'invalid' : 'effective',
    definition,
    display: {
      name: spec.name,
      ...(spec.description !== undefined ? { description: spec.description } : {})
    },
    errors: [],
    derivedInputs: spec.derivedInputs ?? [],
    derivedOutputs: [],
    ...(spec.withoutLifecycle === true
      ? {}
      : { lifecycle: lifecycle(spec.state ?? 'active', versionOf(spec)) })
  };
}

function workflowCatalog(
  records: readonly WorkflowCatalogSourceProjection[]
): WorkflowCatalogProjection {
  return {
    state: 'ready',
    records,
    effective: records
      .map((record) => record.definition)
      .filter((definition): definition is WorkflowDefinition => definition !== null),
    revision: 'rev-workflows',
    warnings: []
  };
}

/** The entries of a section, or a failure naming the arm that turned up instead. */
function entriesOf(section: LaunchSection): readonly Launchable[] {
  if (section.state !== 'entries') {
    throw new Error(`expected an 'entries' section, got '${section.state}'`);
  }
  return section.entries;
}

/** Names a Pipeline that has a record but is not in the effective catalog. */
const NAMES_UNPUBLISHED: WorkflowNode = { nodeId: 'n1', pipelineId: 'unpublished' };

// ---------------------------------------------------------------------------
// Inclusion rules — contract §"Inclusion rules"
// ---------------------------------------------------------------------------

describe('buildLaunchProjection — inclusion (FR-002, FR-003)', () => {
  it('lists active and active-with-draft, and excludes draft and deactivated', () => {
    const projection = buildLaunchProjection(
      pipelineCatalog([
        pipelineRecord({ pipelineId: 'live', name: 'Live', state: 'active', activeVersionId: 'v3' }),
        pipelineRecord({
          pipelineId: 'live-edited',
          name: 'Live Edited',
          state: 'active-with-draft',
          activeVersionId: 'v7'
        }),
        // Never published: a draft has no active version, so there is nothing to
        // freeze and nothing to offer.
        pipelineRecord({
          pipelineId: 'unpublished',
          name: 'Unpublished',
          state: 'draft',
          activeVersionId: undefined
        }),
        // Deactivated: the state still reads `active` because the state oracle
        // derives from pointers, but the active pointer is gone. FR-002 treats
        // this and the draft as one case — "has no active version".
        pipelineRecord({
          pipelineId: 'withdrawn',
          name: 'Withdrawn',
          state: 'active',
          activeVersionId: undefined
        })
      ]),
      workflowCatalog([])
    );

    expect(projection).toBeDefined();
    expect(entriesOf(projection!.pipelines).map((entry) => entry.id)).toEqual([
      'live',
      'live-edited'
    ]);
  });

  it('carries the active version onto every entry (FR-003)', () => {
    const projection = buildLaunchProjection(
      pipelineCatalog([
        pipelineRecord({ pipelineId: 'live', name: 'Live', activeVersionId: 'v3' })
      ]),
      workflowCatalog([
        workflowRecord({
          workflowId: 'flow',
          name: 'Flow',
          activeVersionId: 'v9',
          nodes: [{ nodeId: 'n1', pipelineId: 'live' }]
        })
      ])
    );

    expect(entriesOf(projection!.pipelines)[0]!.activeVersionId).toBe('v3');
    expect(entriesOf(projection!.workflows)[0]!.activeVersionId).toBe('v9');
  });

  it('excludes a record whose version id is the empty string', () => {
    // The store never issues `''`, and `BuilderLifecycle` documents absence
    // rather than blankness. A blank one reaching here is a bug upstream, and
    // listing it would put an entry on Runs whose provenance field is a lie.
    const projection = buildLaunchProjection(
      pipelineCatalog([
        pipelineRecord({ pipelineId: 'blank', name: 'Blank', activeVersionId: '' })
      ]),
      workflowCatalog([])
    );

    expect(projection!.pipelines.state).toBe('none-active');
  });

  it('excludes a record with no lifecycle at all', () => {
    const projection = buildLaunchProjection(
      pipelineCatalog([
        pipelineRecord({ pipelineId: 'orphan', name: 'Orphan', withoutLifecycle: true })
      ]),
      workflowCatalog([])
    );

    expect(projection!.pipelines.state).toBe('none-active');
  });

  it('excludes a record with no resolved definition', () => {
    // `inputs` has no source without one, and a definition that does not parse
    // is one the host would refuse at freeze anyway.
    const projection = buildLaunchProjection(
      pipelineCatalog([
        pipelineRecord({ pipelineId: 'broken', name: 'Broken', invalid: true })
      ]),
      workflowCatalog([])
    );

    expect(projection!.pipelines.state).toBe('none-active');
  });
});

// ---------------------------------------------------------------------------
// Inclusion rule 3 — the unresolvable member (FR-005)
// ---------------------------------------------------------------------------

describe('buildLaunchProjection — unresolvable Workflow members (FR-005)', () => {
  it('excludes a Workflow naming a Pipeline outside the effective catalog', () => {
    // Both Workflows project an EMPTY derived-input list, for the two different
    // reasons. `deriveWorkflowPorts` contributes nothing for an unknown node, so
    // an implementation that inferred rule 3 from the port list would list both.
    const pipelines = pipelineCatalog([
      pipelineRecord({ pipelineId: 'resolves', name: 'Resolves' })
    ]);
    const projection = buildLaunchProjection(
      pipelines,
      workflowCatalog([
        workflowRecord({
          workflowId: 'needs-nothing',
          name: 'Needs Nothing',
          nodes: [{ nodeId: 'n1', pipelineId: 'resolves' }],
          derivedInputs: []
        }),
        workflowRecord({
          workflowId: 'dangling',
          name: 'Dangling',
          nodes: [{ nodeId: 'n1', pipelineId: 'no-such-pipeline' }],
          derivedInputs: []
        })
      ])
    );

    expect(entriesOf(projection!.workflows).map((entry) => entry.id)).toEqual(['needs-nothing']);
  });

  it('excludes a Workflow when only one of several members is unresolvable', () => {
    const projection = buildLaunchProjection(
      pipelineCatalog([pipelineRecord({ pipelineId: 'resolves', name: 'Resolves' })]),
      workflowCatalog([
        workflowRecord({
          workflowId: 'partly-dangling',
          name: 'Partly Dangling',
          nodes: [
            { nodeId: 'n1', pipelineId: 'resolves' },
            { nodeId: 'n2', pipelineId: 'no-such-pipeline' }
          ],
          derivedInputs: [derivedPort('n1', 'brief', 'Brief')]
        })
      ])
    );

    expect(projection!.workflows.state).toBe('none-active');
  });

  it('resolves members against the effective catalog, not the record list', () => {
    // `unpublished` has a record, so a check written against `records` would
    // resolve it. It contributes no definition, so it is absent from
    // `effective` — which is the set a run can actually be frozen against.
    const projection = buildLaunchProjection(
      pipelineCatalog([
        pipelineRecord({
          pipelineId: 'unpublished',
          name: 'Unpublished',
          state: 'draft',
          activeVersionId: undefined,
          invalid: true
        })
      ]),
      workflowCatalog([
        workflowRecord({ workflowId: 'flow', name: 'Flow', nodes: [NAMES_UNPUBLISHED] })
      ])
    );

    expect(projection!.workflows.state).toBe('none-active');
  });
});

// ---------------------------------------------------------------------------
// Ports — contract §"Field provenance"
// ---------------------------------------------------------------------------

describe('buildLaunchProjection — ports', () => {
  it('carries a Pipeline entry the declared input ports, requiredness included', () => {
    const projection = buildLaunchProjection(
      pipelineCatalog([
        pipelineRecord({
          pipelineId: 'live',
          name: 'Live',
          inputs: [
            { portId: 'brief', label: 'Brief', type: 'text', required: true, description: 'What to do' },
            { portId: 'notes', label: 'Notes', type: 'text' }
          ]
        })
      ]),
      workflowCatalog([])
    );

    expect(entriesOf(projection!.pipelines)[0]!.inputs).toEqual([
      { portId: 'brief', label: 'Brief', type: 'text', required: true, description: 'What to do' },
      { portId: 'notes', label: 'Notes', type: 'text' }
    ]);
  });

  it('carries a Workflow entry the derived ports, with the node id and no requiredness', () => {
    // `WorkflowDerivedPort` has no `required`. Reconstructing one here would be a
    // second derivation beside `deriveWorkflowPorts`, and the two would disagree
    // the first time either moved (FR-018).
    const projection = buildLaunchProjection(
      pipelineCatalog([pipelineRecord({ pipelineId: 'resolves', name: 'Resolves' })]),
      workflowCatalog([
        workflowRecord({
          workflowId: 'flow',
          name: 'Flow',
          nodes: [{ nodeId: 'n1', pipelineId: 'resolves' }],
          derivedInputs: [derivedPort('n1', 'brief', 'Brief')]
        })
      ])
    );

    const entry = entriesOf(projection!.workflows)[0]!;
    expect(entry.inputs).toEqual([
      { portId: 'brief', label: 'Brief', type: 'text', nodeId: 'n1' }
    ]);
    expect(entry.inputs[0]!.required).toBeUndefined();
  });

  it('carries startNodeIds on Workflows and on no Pipeline', () => {
    const projection = buildLaunchProjection(
      pipelineCatalog([pipelineRecord({ pipelineId: 'resolves', name: 'Resolves' })]),
      workflowCatalog([
        workflowRecord({
          workflowId: 'flow',
          name: 'Flow',
          nodes: [{ nodeId: 'n1', pipelineId: 'resolves' }]
        })
      ])
    );

    expect(entriesOf(projection!.workflows)[0]!.startNodeIds).toEqual(['n1']);
    expect(entriesOf(projection!.pipelines)[0]!.startNodeIds).toBeUndefined();
  });

  it('carries the description when the record has one and omits it otherwise', () => {
    const projection = buildLaunchProjection(
      pipelineCatalog([
        pipelineRecord({ pipelineId: 'described', name: 'Described', description: 'Ships it' }),
        pipelineRecord({ pipelineId: 'plain', name: 'Plain' })
      ]),
      workflowCatalog([])
    );

    const [described, plain] = entriesOf(projection!.pipelines);
    expect(described!.description).toBe('Ships it');
    expect(plain!.description).toBeUndefined();
  });

  it('names each entry by its kind as well as its id (FR-014)', () => {
    // The store permits a Pipeline and a Workflow to share an id, and one
    // selection spans both sections.
    const projection = buildLaunchProjection(
      pipelineCatalog([pipelineRecord({ pipelineId: 'ship-it', name: 'Ship It' })]),
      workflowCatalog([
        workflowRecord({
          workflowId: 'ship-it',
          name: 'Ship It',
          nodes: [{ nodeId: 'n1', pipelineId: 'ship-it' }]
        })
      ])
    );

    expect(entriesOf(projection!.pipelines)[0]!.kind).toBe('pipeline');
    expect(entriesOf(projection!.workflows)[0]!.kind).toBe('workflow');
  });
});

// ---------------------------------------------------------------------------
// Section states — contract §"Section-state rules"
// ---------------------------------------------------------------------------

describe('buildLaunchProjection — section states (FR-006)', () => {
  it('projects nothing at all while a source catalog is unresolved', () => {
    // The loading arm is the absence of the field, not a fourth arm.
    expect(buildLaunchProjection(undefined, workflowCatalog([]))).toBeUndefined();
    expect(buildLaunchProjection(pipelineCatalog([]), undefined)).toBeUndefined();
    expect(buildLaunchProjection(undefined, undefined)).toBeUndefined();
  });

  it('projects no-definitions when a source projection holds no records', () => {
    const projection = buildLaunchProjection(pipelineCatalog([]), workflowCatalog([]));

    expect(projection!.pipelines).toEqual({ state: 'no-definitions' });
    expect(projection!.workflows).toEqual({ state: 'no-definitions' });
  });

  it('projects none-active when records exist and none pass', () => {
    const projection = buildLaunchProjection(
      pipelineCatalog([
        pipelineRecord({
          pipelineId: 'unpublished',
          name: 'Unpublished',
          state: 'draft',
          activeVersionId: undefined
        })
      ]),
      workflowCatalog([])
    );

    expect(projection!.pipelines).toEqual({ state: 'none-active' });
  });

  it('distinguishes the two empty arms from one another', () => {
    // Both produce an empty list. A section that chose its arm from the length
    // could not tell them apart, which is the defect this feature fixes.
    const noDefinitions = buildLaunchProjection(pipelineCatalog([]), workflowCatalog([]));
    const noneActive = buildLaunchProjection(
      pipelineCatalog([
        pipelineRecord({ pipelineId: 'd', name: 'D', state: 'draft', activeVersionId: undefined })
      ]),
      workflowCatalog([])
    );

    expect(noDefinitions!.pipelines.state).not.toBe(noneActive!.pipelines.state);
  });

  it('gives each section its own state', () => {
    const projection = buildLaunchProjection(
      pipelineCatalog([pipelineRecord({ pipelineId: 'live', name: 'Live' })]),
      workflowCatalog([])
    );

    expect(projection!.pipelines.state).toBe('entries');
    expect(projection!.workflows.state).toBe('no-definitions');
  });
});

// ---------------------------------------------------------------------------
// Ordering — contract §"Ordering" (FR-001)
// ---------------------------------------------------------------------------

describe('buildLaunchProjection — ordering (FR-001)', () => {
  // Insertion order is deliberately the reverse of name order: a projection that
  // iterated the records and stopped would pass a weaker test and fail this one.
  const UNSORTED: readonly PipelineCatalogSourceProjection[] = [
    pipelineRecord({ pipelineId: 'z', name: 'zebra' }),
    pipelineRecord({ pipelineId: 'm', name: 'Milk' }),
    pipelineRecord({ pipelineId: 'a', name: 'apple' }),
    pipelineRecord({ pipelineId: 'b', name: 'Banana' })
  ];

  it('sorts by display name, compared case-insensitively', () => {
    const projection = buildLaunchProjection(pipelineCatalog(UNSORTED), workflowCatalog([]));

    expect(entriesOf(projection!.pipelines).map((entry) => entry.name)).toEqual([
      'apple',
      'Banana',
      'Milk',
      'zebra'
    ]);
  });

  it('breaks a name tie by definition id so the order is total', () => {
    const projection = buildLaunchProjection(
      pipelineCatalog([
        pipelineRecord({ pipelineId: 'second', name: 'Same Name' }),
        pipelineRecord({ pipelineId: 'first', name: 'Same Name' })
      ]),
      workflowCatalog([])
    );

    expect(entriesOf(projection!.pipelines).map((entry) => entry.id)).toEqual(['first', 'second']);
  });

  it('projects the same catalog identically twice', () => {
    const pipelines = pipelineCatalog(UNSORTED);
    const workflows = workflowCatalog([]);

    expect(buildLaunchProjection(pipelines, workflows)).toEqual(
      buildLaunchProjection(pipelines, workflows)
    );
  });

  it('sorts both sections the same way', () => {
    const projection = buildLaunchProjection(
      pipelineCatalog([pipelineRecord({ pipelineId: 'p', name: 'Resolves' })]),
      workflowCatalog([
        workflowRecord({ workflowId: 'z', name: 'zebra', nodes: [{ nodeId: 'n', pipelineId: 'p' }] }),
        workflowRecord({ workflowId: 'a', name: 'Apple', nodes: [{ nodeId: 'n', pipelineId: 'p' }] })
      ])
    );

    expect(entriesOf(projection!.workflows).map((entry) => entry.name)).toEqual(['Apple', 'zebra']);
  });
});
