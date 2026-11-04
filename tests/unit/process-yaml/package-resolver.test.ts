// Feature 263 (FR-R5-F04) — dependency resolution for Phase and composable Workflow packages.

import { describe, expect, it } from 'vitest';
import type {
  PhaseDefinition,
  PhaseSourceRecord,
  PhaseSourceStatus
} from '../../../src/contracts/process-definitions';
import type {
  WorkflowConnection,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowSourceRecord,
  WorkflowSourceStatus
} from '../../../src/contracts/workflow-definitions';
import {
  prospectivePhaseCatalog,
  prospectiveWorkflowCatalog,
  resolvePhaseDependency,
  resolveWorkflowDependencies,
  resolveWorkflowDependency,
  type PackageResolutionContext,
  type WorkflowResolutionContext
} from '../../../src/services/process-yaml/package-resolver';
import type { ImportPlanRow } from '../../../src/services/process-yaml/types';

function phase(phaseId: string, name = phaseId): PhaseDefinition {
  return Object.freeze({ phaseId, name, version: 1, instruction: `Do ${phaseId}.` });
}

function storedRow(phaseId: string, status: PhaseSourceStatus): PhaseSourceRecord {
  return Object.freeze({
    key: `${phaseId}::0`,
    phaseId,
    status,
    definition: null,
    display: Object.freeze({}),
    errors: Object.freeze([])
  });
}

function importedPhaseRow(definition: PhaseDefinition): ImportPlanRow {
  return Object.freeze({
    outcome: 'import' as const,
    resourceKind: 'phase' as const,
    resourceId: definition.phaseId,
    name: definition.name,
    requiresRetryConditionCapability: false,
    definition
  });
}

function skippedPhaseRow(
  phaseId: string,
  presentRowStatus: PhaseSourceStatus = 'effective'
): ImportPlanRow {
  return Object.freeze({
    outcome: 'skip' as const,
    resourceKind: 'phase' as const,
    resourceId: phaseId,
    name: phaseId,
    presentRowStatus
  });
}

function invalidPhaseRow(phaseId: string | null): ImportPlanRow {
  return Object.freeze({
    outcome: 'invalid' as const,
    resourceKind: 'phase' as const,
    resourceId: phaseId,
    defects: Object.freeze([{ field: 'version', code: 'positive-integer-required', message: 'no' }]),
    totalDefects: 1
  });
}

function context(overrides: Partial<PackageResolutionContext> = {}): PackageResolutionContext {
  return { effectivePhases: [], storedPhases: [], plannedPhaseRows: [], ...overrides };
}

function storedWorkflowRow(
  workflowId: string,
  status: WorkflowSourceStatus
): WorkflowSourceRecord {
  return Object.freeze({
    key: `${workflowId}::0`,
    workflowId,
    status,
    definition: null,
    display: Object.freeze({}),
    nodePipelineIds: Object.freeze([]),
    errors: Object.freeze([])
  });
}

function importedWorkflowRow(definition: WorkflowDefinition): ImportPlanRow {
  return Object.freeze({
    outcome: 'import' as const,
    resourceKind: 'workflow' as const,
    resourceId: definition.workflowId,
    name: definition.name,
    definition
  });
}

function skippedWorkflowRow(
  workflowId: string,
  presentRowStatus: WorkflowSourceStatus = 'effective'
): ImportPlanRow {
  return Object.freeze({
    outcome: 'skip' as const,
    resourceKind: 'workflow' as const,
    resourceId: workflowId,
    name: workflowId,
    presentRowStatus
  });
}

function blockedWorkflowRow(
  workflowId: string,
  phaseId: string,
  code: 'dependency-absent' | 'dependency-unresolvable' = 'dependency-absent'
): ImportPlanRow {
  return Object.freeze({
    outcome: 'blocked' as const,
    resourceKind: 'workflow' as const,
    resourceId: workflowId,
    name: workflowId,
    reason: Object.freeze({
      code,
      dependency: Object.freeze({ kind: 'phase' as const, resourceId: phaseId })
    })
  });
}

function invalidWorkflowRow(workflowId: string | null): ImportPlanRow {
  return Object.freeze({
    outcome: 'invalid' as const,
    resourceKind: 'workflow' as const,
    resourceId: workflowId,
    defects: Object.freeze([
      { field: 'version', code: 'positive-integer-required', message: 'no' }
    ]),
    totalDefects: 1
  });
}

function workflowContext(
  overrides: Partial<WorkflowResolutionContext> = {}
): WorkflowResolutionContext {
  return {
    ...context(),
    effectiveWorkflows: [],
    storedWorkflows: [],
    plannedWorkflowRows: [],
    invalidPhases: new Map(),
    invalidWorkflows: new Map(),
    ...overrides
  };
}

function phaseNode(nodeId: string, phaseId = nodeId): WorkflowNode {
  return Object.freeze({ nodeId, kind: 'phase' as const, phaseId });
}

function childWorkflowNode(nodeId: string, workflowId = nodeId): WorkflowNode {
  return Object.freeze({ nodeId, kind: 'workflow' as const, workflowId });
}

function workflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return Object.freeze({
    workflowId: 'ship-it-flow',
    name: 'Ship It Flow',
    version: 1,
    nodes: [childWorkflowNode('draft', 'ship-it')] as readonly WorkflowNode[],
    connections: [] as readonly WorkflowConnection[],
    startNodeIds: ['draft'] as readonly string[],
    ...overrides
  });
}

describe('resolvePhaseDependency — FR-030a, FR-030c', () => {
  it('resolves against the effective catalog, not against stored presence', () => {
    const ctx = context({
      effectivePhases: [phase('specify')],
      storedPhases: [storedRow('plan', 'invalid')]
    });

    expect(resolvePhaseDependency('specify', ctx)).toEqual({ status: 'resolved-effective' });
    expect(resolvePhaseDependency('plan', ctx)).toEqual({
      status: 'blocked',
      reason: { code: 'dependency-unresolvable', dependency: { kind: 'phase', resourceId: 'plan' } }
    });
  });

  it('calls an unclaimed id absent, and one claimed but not effective unresolvable', () => {
    const ctx = context({ storedPhases: [storedRow('plan', 'invalid')] });

    expect(resolvePhaseDependency('nowhere', ctx)).toEqual({
      status: 'blocked',
      reason: { code: 'dependency-absent', dependency: { kind: 'phase', resourceId: 'nowhere' } }
    });
    expect(resolvePhaseDependency('plan', ctx)).toEqual({
      status: 'blocked',
      reason: { code: 'dependency-unresolvable', dependency: { kind: 'phase', resourceId: 'plan' } }
    });
  });

  it('counts a dependency this same document will import as resolved (FR-035)', () => {
    const ctx = context({ plannedPhaseRows: [importedPhaseRow(phase('specify'))] });

    expect(resolvePhaseDependency('specify', ctx)).toEqual({ status: 'resolved-planned' });
  });

  it('counts a dependency planned skip as resolved when the catalog resolves it (FR-034)', () => {
    const ctx = context({
      effectivePhases: [phase('specify')],
      storedPhases: [storedRow('specify', 'effective')],
      plannedPhaseRows: [skippedPhaseRow('specify')]
    });

    expect(resolvePhaseDependency('specify', ctx)).toEqual({ status: 'resolved-skipped' });
  });

  it('blocks a dependency planned skip whose claiming row does not resolve (FR-030b)', () => {
    const ctx = context({
      storedPhases: [storedRow('specify', 'invalid')],
      plannedPhaseRows: [skippedPhaseRow('specify', 'invalid')]
    });

    expect(resolvePhaseDependency('specify', ctx)).toEqual({
      status: 'blocked',
      reason: { code: 'dependency-unresolvable', dependency: { kind: 'phase', resourceId: 'specify' } }
    });
  });

  it('does not let an invalid resource claim its id (FR-032)', () => {
    const ctx = context({ plannedPhaseRows: [invalidPhaseRow('specify')] });

    expect(resolvePhaseDependency('specify', ctx)).toEqual({
      status: 'blocked',
      reason: { code: 'dependency-absent', dependency: { kind: 'phase', resourceId: 'specify' } }
    });
  });
});

describe('prospectivePhaseCatalog', () => {
  it('adds the Phases this plan will write to the effective catalog', () => {
    const ctx = context({
      effectivePhases: [phase('finalize')],
      plannedPhaseRows: [importedPhaseRow(phase('specify')), skippedPhaseRow('plan')]
    });

    expect(prospectivePhaseCatalog(ctx).map((definition) => definition.phaseId)).toEqual([
      'finalize',
      'specify'
    ]);
  });

  it('keeps the effective definition when a planned row declares the same id', () => {
    const effective = phase('specify', 'Effective Specify');
    const ctx = context({
      effectivePhases: [effective],
      plannedPhaseRows: [importedPhaseRow(phase('specify', 'Planned Specify'))]
    });

    expect(prospectivePhaseCatalog(ctx)).toEqual([effective]);
  });

  it('ignores a Workflow row entirely', () => {
    const ctx = context({
      plannedPhaseRows: [importedWorkflowRow(workflow({ workflowId: 'other' }))]
    });

    expect(prospectivePhaseCatalog(ctx)).toEqual([]);
  });
});

describe('resolveWorkflowDependency', () => {
  it('resolves against the effective Workflow catalog, not against stored presence', () => {
    const ctx = workflowContext({
      effectiveWorkflows: [workflow({ workflowId: 'ship-it', nodes: [phaseNode('s', 'specify')] })],
      storedWorkflows: [storedWorkflowRow('deploy-it', 'invalid')]
    });

    expect(resolveWorkflowDependency('ship-it', ctx)).toEqual({ status: 'resolved-effective' });
    expect(resolveWorkflowDependency('deploy-it', ctx)).toEqual({
      status: 'blocked',
      reason: {
        code: 'dependency-unresolvable',
        dependency: { kind: 'workflow', resourceId: 'deploy-it' }
      }
    });
  });

  it('distinguishes absent from unresolvable', () => {
    const ctx = workflowContext({
      storedWorkflows: [storedWorkflowRow('deploy-it', 'invalid')]
    });

    expect(resolveWorkflowDependency('nowhere', ctx)).toEqual({
      status: 'blocked',
      reason: { code: 'dependency-absent', dependency: { kind: 'workflow', resourceId: 'nowhere' } }
    });
    expect(resolveWorkflowDependency('deploy-it', ctx)).toEqual({
      status: 'blocked',
      reason: {
        code: 'dependency-unresolvable',
        dependency: { kind: 'workflow', resourceId: 'deploy-it' }
      }
    });
  });

  it('counts a child Workflow this same document will import as resolved', () => {
    const ctx = workflowContext({
      plannedWorkflowRows: [
        importedWorkflowRow(workflow({ workflowId: 'ship-it', nodes: [phaseNode('s', 'specify')] }))
      ]
    });

    expect(resolveWorkflowDependency('ship-it', ctx)).toEqual({ status: 'resolved-planned' });
  });

  it('counts a child Workflow planned skip as resolved when the catalog resolves it', () => {
    const ctx = workflowContext({
      effectiveWorkflows: [workflow({ workflowId: 'ship-it', nodes: [phaseNode('s', 'specify')] })],
      storedWorkflows: [storedWorkflowRow('ship-it', 'effective')],
      plannedWorkflowRows: [skippedWorkflowRow('ship-it')]
    });

    expect(resolveWorkflowDependency('ship-it', ctx)).toEqual({ status: 'resolved-skipped' });
  });

  it('blocks a child Workflow planned skip whose claiming row does not resolve', () => {
    const ctx = workflowContext({
      storedWorkflows: [storedWorkflowRow('ship-it', 'invalid')],
      plannedWorkflowRows: [skippedWorkflowRow('ship-it', 'invalid')]
    });

    expect(resolveWorkflowDependency('ship-it', ctx)).toEqual({
      status: 'blocked',
      reason: {
        code: 'dependency-unresolvable',
        dependency: { kind: 'workflow', resourceId: 'ship-it' }
      }
    });
  });

  it('does not let an invalid child Workflow claim its id', () => {
    const ctx = workflowContext({ plannedWorkflowRows: [invalidWorkflowRow('ship-it')] });

    expect(resolveWorkflowDependency('ship-it', ctx)).toEqual({
      status: 'blocked',
      reason: { code: 'dependency-absent', dependency: { kind: 'workflow', resourceId: 'ship-it' } }
    });
  });

  it('propagates a blocked child Workflow with the root cause in via', () => {
    const ctx = workflowContext({
      plannedWorkflowRows: [blockedWorkflowRow('ship-it', 'specify')]
    });

    expect(resolveWorkflowDependency('ship-it', ctx)).toEqual({
      status: 'blocked',
      reason: {
        code: 'dependency-blocked',
        dependency: { kind: 'workflow', resourceId: 'ship-it' },
        via: { kind: 'phase', resourceId: 'specify' }
      }
    });
  });
});

describe('resolveWorkflowDependencies', () => {
  const CHILD_SHIP = workflow({
    workflowId: 'ship-it',
    nodes: [phaseNode('s', 'specify')],
    startNodeIds: ['s'],
    outputs: [{ portId: 'spec-document', label: 'Spec', type: 'markdown' }]
  });
  const CHILD_REVIEW = workflow({
    workflowId: 'review-it',
    nodes: [phaseNode('r', 'specify')],
    startNodeIds: ['r'],
    inputs: [{ portId: 'spec', label: 'Spec', type: 'text', required: false }]
  });

  it('resolves a self-contained package against the Phases and child Workflows it supplies', () => {
    const ctx = workflowContext({
      plannedPhaseRows: [importedPhaseRow(phase('specify'))],
      plannedWorkflowRows: [
        importedWorkflowRow(CHILD_SHIP),
        importedWorkflowRow(CHILD_REVIEW)
      ]
    });

    expect(
      resolveWorkflowDependencies(
        workflow({
          nodes: [childWorkflowNode('draft', 'ship-it'), childWorkflowNode('review', 'review-it')],
          startNodeIds: ['draft', 'review']
        }),
        ctx
      )
    ).toEqual({ outcome: 'resolved' });
  });

  it('blocks rather than invalidates a well-formed Workflow whose Phase or child Workflow fails', () => {
    expect(resolveWorkflowDependencies(workflow(), workflowContext())).toEqual({
      outcome: 'blocked',
      reason: { code: 'dependency-absent', dependency: { kind: 'workflow', resourceId: 'ship-it' } }
    });

    expect(
      resolveWorkflowDependencies(
        workflow({ nodes: [phaseNode('draft', 'specify')], startNodeIds: ['draft'] }),
        workflowContext()
      )
    ).toEqual({
      outcome: 'blocked',
      reason: { code: 'dependency-absent', dependency: { kind: 'phase', resourceId: 'specify' } }
    });
  });

  it('reports the first unresolved node in authored order', () => {
    const ctx = workflowContext({
      effectivePhases: [phase('specify')],
      effectiveWorkflows: [CHILD_SHIP]
    });

    expect(
      resolveWorkflowDependencies(
        workflow({
          nodes: [
            childWorkflowNode('draft', 'ship-it'),
            childWorkflowNode('review', 'review-it'),
            childWorkflowNode('ship', 'deploy-it')
          ],
          startNodeIds: ['draft']
        }),
        ctx
      )
    ).toEqual({
      outcome: 'blocked',
      reason: {
        code: 'dependency-absent',
        dependency: { kind: 'workflow', resourceId: 'review-it' }
      }
    });
  });

  it('blocks a Workflow whose node names a blocked child Workflow', () => {
    const ctx = workflowContext({
      plannedWorkflowRows: [blockedWorkflowRow('ship-it', 'specify')]
    });

    expect(resolveWorkflowDependencies(workflow(), ctx)).toEqual({
      outcome: 'blocked',
      reason: {
        code: 'dependency-blocked',
        dependency: { kind: 'workflow', resourceId: 'ship-it' },
        via: { kind: 'phase', resourceId: 'specify' }
      }
    });
  });

  it('makes a port defect invalid, naming the connection, rather than blocked', () => {
    const ctx = workflowContext({
      plannedPhaseRows: [importedPhaseRow(phase('specify'))],
      plannedWorkflowRows: [importedWorkflowRow(CHILD_SHIP), importedWorkflowRow(CHILD_REVIEW)]
    });
    const broken = workflow({
      nodes: [childWorkflowNode('draft', 'ship-it'), childWorkflowNode('review', 'review-it')],
      connections: [
        { from: { nodeId: 'draft', portId: 'no-such-port' }, to: { nodeId: 'review', portId: 'spec' } }
      ],
      startNodeIds: ['draft']
    });

    const result = resolveWorkflowDependencies(broken, ctx);
    expect(result.outcome).toBe('invalid');
    if (result.outcome !== 'invalid') return;
    expect(result.defects.map((defect) => defect.code)).toContain('unresolved-endpoint');
    expect(result.defects.some((defect) => defect.field.startsWith('connections[0].from'))).toBe(
      true
    );
  });

  it('reports a child workflow cycle as invalid rather than blocked', () => {
    const childA = workflow({
      workflowId: 'child-a',
      nodes: [childWorkflowNode('n', 'ship-it-flow')],
      startNodeIds: ['n']
    });
    const ctx = workflowContext({
      effectiveWorkflows: [childA]
    });
    const parent = workflow({
      workflowId: 'ship-it-flow',
      nodes: [childWorkflowNode('n', 'child-a')],
      startNodeIds: ['n']
    });

    const result = resolveWorkflowDependencies(parent, ctx);
    expect(result.outcome).toBe('invalid');
    if (result.outcome !== 'invalid') return;
    expect(result.defects.map((defect) => defect.code)).toContain('workflow-inclusion-cycle');
  });
});

describe('prospectiveWorkflowCatalog', () => {
  it('adds the Workflows this plan will write to the effective catalog', () => {
    const ctx = workflowContext({
      effectiveWorkflows: [workflow({ workflowId: 'finalize-it' })],
      plannedWorkflowRows: [
        importedWorkflowRow(workflow({ workflowId: 'ship-it' })),
        skippedWorkflowRow('review-it'),
        blockedWorkflowRow('deploy-it', 'specify')
      ]
    });

    expect(prospectiveWorkflowCatalog(ctx).map((definition) => definition.workflowId)).toEqual([
      'finalize-it',
      'ship-it'
    ]);
  });
});
