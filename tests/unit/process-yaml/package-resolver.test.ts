// Feature 085 T036/T038 — dependency resolution, written before the module exists.
//
// This is the second of the two oracles (research R6), and the whole point of
// separating it from presence is that the two answer different questions:
//
//   presence   — "would writing this destroy work an operator authored?"
//                reads STORED rows at every status, including broken ones
//   resolution — "will this Pipeline actually run?"
//                reads the EFFECTIVE catalog, where a broken row does not appear
//
// So these tests build the two inputs from deliberately DISAGREEING data: a
// stored row with no effective definition, an effective definition with no
// stored row. A change that quietly passes one where the other belongs cannot
// keep them green — it would have to make a shadowed row satisfy a reference, or
// make a resolvable Phase look absent.
//
// `parsePipelinePackage` is not used here. The resolver's inputs are a
// `PipelineDefinition` and the two catalogs; going through the reader would test
// the reader again and would make it impossible to state a catalog the reader
// cannot produce, which is exactly the interesting case.

import { describe, expect, it } from 'vitest';
import type {
  PhaseBinding,
  PipelineDefinition,
  PipelineInputPort,
  PipelineOutputPort,
  PipelineSourceRecord,
  PipelineSourceStatus
} from '../../../src/contracts/pipeline-definitions';
import type {
  PhaseDefinition,
  PhaseSourceRecord,
  PhaseSourceStatus
} from '../../../src/contracts/process-definitions';
import type {
  WorkflowConnection,
  WorkflowDefinition,
  WorkflowNode
} from '../../../src/contracts/workflow-definitions';
import {
  prospectivePhaseCatalog,
  prospectivePipelineCatalog,
  resolvePhaseDependency,
  resolvePipelineDependencies,
  resolvePipelineDependency,
  resolveWorkflowDependencies,
  type PackageResolutionContext,
  type WorkflowResolutionContext
} from '../../../src/services/process-yaml/package-resolver';
import type { ImportPlanRow } from '../../../src/services/process-yaml/types';

function phase(phaseId: string, name = phaseId): PhaseDefinition {
  return Object.freeze({ phaseId, name, version: 1, instruction: `Do ${phaseId}.` });
}

/**
 * A stored row with NO definition, whatever its status. Presence never depends
 * on a resolvable definition (FR-030), and building the row this way means a
 * resolver that read `record.definition` instead of the effective catalog would
 * see nothing at all rather than silently agreeing.
 */
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

// Feature 099 (T496f, FR-042) — `presentIn` went with the layer tier: a skip row
// reported WHICH layer already claimed the id, and one layer answers that before
// it is asked. The status stayed, because "claimed by what kind of row" is still
// the operator's next action.
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

function pipeline(overrides: Partial<PipelineDefinition> = {}): PipelineDefinition {
  return Object.freeze({
    pipelineId: 'ship-it',
    name: 'Ship It',
    version: 1,
    phaseIds: ['specify'],
    inputs: [] as readonly PipelineInputPort[],
    outputs: [] as readonly PipelineOutputPort[],
    bindings: [] as readonly PhaseBinding[],
    recommendedNext: [] as readonly string[],
    ...overrides
  });
}

describe('resolvePhaseDependency — FR-030a, FR-030c', () => {
  it('resolves against the effective catalog, not against stored presence', () => {
    // The two oracles disagree on purpose: `specify` resolves with no stored row
    // at all, and `plan` is stored but resolves nowhere.
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
    // The distinction is the operator's next action: supply the Phase, or repair
    // the row that already claims the id (FR-030c). Feature 099 (T496f, FR-043) —
    // `shadowed` was one way a stored row claimed an id without resolving, and it
    // is deleted with the layer tier. `invalid` is the other, and it is now the
    // only one, so the pair this test needs is unchanged.
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
    // FR-034's own reason: presence in the catalog is what resolves a reference,
    // not being written by this import. The document's copy being skipped is
    // beside the point.
    const ctx = context({
      effectivePhases: [phase('specify')],
      storedPhases: [storedRow('specify', 'effective')],
      plannedPhaseRows: [skippedPhaseRow('specify')]
    });

    expect(resolvePhaseDependency('specify', ctx)).toEqual({ status: 'resolved-skipped' });
  });

  it('blocks a dependency planned skip whose claiming row does not resolve (FR-030b)', () => {
    // The coherent pair, at the level it is decided: the Phase row is `skip`
    // because the id is claimed, and this same id does not resolve. Reading the
    // skip as "resolved" would import a Pipeline that fails at run time.
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
    // A malformed Phase is not a Phase. It neither satisfies the reference nor
    // makes the id look present, so the Pipeline reads `dependency-absent` and
    // the operator is told to supply the Phase rather than to look for a row.
    const ctx = context({ plannedPhaseRows: [invalidPhaseRow('specify')] });

    expect(resolvePhaseDependency('specify', ctx)).toEqual({
      status: 'blocked',
      reason: { code: 'dependency-absent', dependency: { kind: 'phase', resourceId: 'specify' } }
    });
  });
});

describe('resolvePipelineDependencies — FR-033, FR-035a', () => {
  it('resolves a self-contained package against the Phases it supplies', () => {
    const ctx = context({
      plannedPhaseRows: [importedPhaseRow(phase('specify')), importedPhaseRow(phase('plan'))]
    });

    expect(resolvePipelineDependencies(pipeline({ phaseIds: ['specify', 'plan'] }), ctx)).toEqual({
      outcome: 'resolved'
    });
  });

  it('blocks rather than invalidates a well-formed Pipeline whose reference fails (FR-033)', () => {
    // `invalid` is reserved for defects in the resource itself. This Pipeline has
    // none — what is missing is somewhere else — so the row must say so, because
    // only one of the two is fixed by importing something else first.
    const result = resolvePipelineDependencies(pipeline({ phaseIds: ['specify'] }), context());

    expect(result).toEqual({
      outcome: 'blocked',
      reason: { code: 'dependency-absent', dependency: { kind: 'phase', resourceId: 'specify' } }
    });
  });

  it('reports the first unresolved reference in sequence order', () => {
    // One reason per row, so which one is reported has to be deterministic
    // rather than whichever the iteration happened to reach.
    const result = resolvePipelineDependencies(
      pipeline({ phaseIds: ['specify', 'plan', 'finalize'] }),
      context({ effectivePhases: [phase('specify')] })
    );

    expect(result).toEqual({
      outcome: 'blocked',
      reason: { code: 'dependency-absent', dependency: { kind: 'phase', resourceId: 'plan' } }
    });
  });

  it('resolves a sequence that repeats a Phase', () => {
    // `phaseIds` may name the same Phase twice — that is why bindings address a
    // position rather than an id — so a repeat must not be a second lookup that
    // can disagree with the first.
    const ctx = context({ effectivePhases: [phase('specify')] });

    expect(resolvePipelineDependencies(pipeline({ phaseIds: ['specify', 'specify'] }), ctx)).toEqual(
      { outcome: 'resolved' }
    );
  });

  it('never resolves, and never blocks on, a recommended-next reference (FR-035a)', () => {
    // Advisory navigation between Pipelines. A dangling recommendation is not a
    // defect, and it is carried verbatim in both directions.
    const ctx = context({ effectivePhases: [phase('specify')] });
    const definition = pipeline({
      phaseIds: ['specify'],
      recommendedNext: ['no-such-pipeline', 'specify']
    });

    expect(resolvePipelineDependencies(definition, ctx)).toEqual({ outcome: 'resolved' });
  });

  it('resolves references before validating bindings, so a missing Phase is not also a defect', () => {
    // Both conditions hold at once here: `specify` does not resolve, and a
    // binding addresses it. Reporting the binding error would tell the operator
    // to fix a Pipeline that is not wrong.
    const definition = pipeline({
      phaseIds: ['specify'],
      outputs: [{ portId: 'report', label: 'Report', type: 'markdown' }],
      bindings: [{ kind: 'output', phaseIndex: 0, portId: 'report', outputKey: 'summary' }]
    });

    expect(resolvePipelineDependencies(definition, context())).toEqual({
      outcome: 'blocked',
      reason: { code: 'dependency-absent', dependency: { kind: 'phase', resourceId: 'specify' } }
    });
  });
});

describe('binding validation at preflight — FR-046a', () => {
  it('validates against the effective catalog union the Phases this plan will write', () => {
    // Without the union every self-contained package fails on the Phases it is
    // itself supplying, which is the headline case. The catalog here is empty:
    // the only thing that can satisfy the binding is the planned row.
    const definition = pipeline({
      phaseIds: ['specify'],
      outputs: [{ portId: 'report', label: 'Report', type: 'markdown' }],
      bindings: [{ kind: 'output', phaseIndex: 0, portId: 'report', outputKey: 'summary' }]
    });
    const ctx = context({ plannedPhaseRows: [importedPhaseRow(phase('specify'))] });

    expect(resolvePipelineDependencies(definition, ctx)).toEqual({ outcome: 'resolved' });
  });

  it('makes a binding defect invalid, naming the binding, rather than blocked (FR-046a)', () => {
    // Every reference resolves, so nothing is missing — the Pipeline itself is
    // wrong, and that is what `invalid` means. Found now rather than as a write
    // failure after the operator has already confirmed.
    const definition = pipeline({
      phaseIds: ['specify'],
      bindings: [{ kind: 'output', phaseIndex: 0, portId: 'report', outputKey: 'summary' }]
    });
    const ctx = context({ effectivePhases: [phase('specify')] });

    const result = resolvePipelineDependencies(definition, ctx);
    expect(result.outcome).toBe('invalid');
    if (result.outcome !== 'invalid') return;
    expect(result.defects).toHaveLength(1);
    expect(result.defects[0]?.field).toBe('bindings[0].portId');
    expect(result.defects[0]?.code).toBe('binding-unknown-output-port');
  });

  it('reports every binding defect, not the first (FR-027)', () => {
    const definition = pipeline({
      phaseIds: ['specify'],
      bindings: [
        { kind: 'output', phaseIndex: 0, portId: 'missing-a', outputKey: 'a' },
        { kind: 'output', phaseIndex: 0, portId: 'missing-b', outputKey: 'b' }
      ]
    });
    const ctx = context({ effectivePhases: [phase('specify')] });

    const result = resolvePipelineDependencies(definition, ctx);
    if (result.outcome !== 'invalid') throw new Error(`expected invalid, got ${result.outcome}`);
    expect(result.defects.map((defect) => defect.field)).toEqual([
      'bindings[0].portId',
      'bindings[1].portId'
    ]);
  });

  it('carries no pipelineId onto the defect, which the row already names', () => {
    const definition = pipeline({
      phaseIds: ['specify'],
      bindings: [{ kind: 'output', phaseIndex: 0, portId: 'report', outputKey: 'summary' }]
    });
    const ctx = context({ effectivePhases: [phase('specify')] });

    const result = resolvePipelineDependencies(definition, ctx);
    if (result.outcome !== 'invalid') throw new Error(`expected invalid, got ${result.outcome}`);
    expect(Object.keys(result.defects[0] ?? {}).sort()).toEqual(['code', 'field', 'message']);
  });
});

describe('prospectivePhaseCatalog — the union, named so it has a test', () => {
  it('adds the Phases this plan will write to the effective catalog', () => {
    const ctx = context({
      effectivePhases: [phase('finalize')],
      plannedPhaseRows: [importedPhaseRow(phase('specify')), skippedPhaseRow('plan')]
    });

    // The `skip` row contributes nothing: it is not written, and whatever the
    // catalog holds for that id is already in `effectivePhases` or is precisely
    // the unresolvable row FR-030b describes.
    expect(prospectivePhaseCatalog(ctx).map((definition) => definition.phaseId)).toEqual([
      'finalize',
      'specify'
    ]);
  });

  it('keeps the effective definition when a planned row declares the same id', () => {
    // Unreachable through the planner — a claimed id plans `skip`, never
    // `import` — but the union is a set operation and must be total. The
    // effective definition is what runtime resolves today, so it wins.
    const effective = phase('specify', 'Effective Specify');
    const ctx = context({
      effectivePhases: [effective],
      plannedPhaseRows: [importedPhaseRow(phase('specify', 'Planned Specify'))]
    });

    expect(prospectivePhaseCatalog(ctx)).toEqual([effective]);
  });

  it('ignores a Pipeline row entirely', () => {
    const ctx = context({
      plannedPhaseRows: [
        Object.freeze({
          outcome: 'import' as const,
          resourceKind: 'pipeline' as const,
          resourceId: 'other',
          name: 'Other',
          definition: pipeline({ pipelineId: 'other' })
        })
      ]
    });

    expect(prospectivePhaseCatalog(ctx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Feature 086 T039-T042 — the third level, written before the module has it.
//
// Pass 3 is pass 2 applied one level up, with one thing that has no analogue
// below it: a Pipeline can be blocked, so a Workflow's dependency failure is not
// always a root cause. That is the entire cost of the extra level, and it is why
// `dependency-blocked` carries `via` — the operator needs a chain from what they
// selected to what is actually wrong, not a pointer to the middle of it.
//
// Pass 2's verdicts reach pass 3 the same way pass 1's reach pass 2: through the
// PLANNED ROWS, not through a separate verdict map. A Pipeline the planner marked
// `blocked` is a `blocked` row; one it marked eligible is an `import` row. Reading
// the rows means the two passes cannot disagree about a Pipeline's fate, because
// there is only one record of it.
// ---------------------------------------------------------------------------

function storedPipelineRow(
  pipelineId: string,
  status: PipelineSourceStatus
): PipelineSourceRecord {
  // Definition-less for the same reason as `storedRow`: a resolver reading
  // `record.definition` rather than the effective catalog would see nothing here
  // instead of quietly agreeing with the right answer.
  return Object.freeze({
    key: `${pipelineId}::0`,
    pipelineId,
    status,
    definition: null,
    display: Object.freeze({}),
    errors: Object.freeze([])
  });
}

function importedPipelineRow(definition: PipelineDefinition): ImportPlanRow {
  return Object.freeze({
    outcome: 'import' as const,
    resourceKind: 'pipeline' as const,
    resourceId: definition.pipelineId,
    name: definition.name,
    definition
  });
}

function skippedPipelineRow(
  pipelineId: string,
  presentRowStatus: PipelineSourceStatus = 'effective'
): ImportPlanRow {
  return Object.freeze({
    outcome: 'skip' as const,
    resourceKind: 'pipeline' as const,
    resourceId: pipelineId,
    name: pipelineId,
    presentRowStatus
  });
}

/** A Pipeline pass 2 blocked, carrying the Phase that was the root cause. */
function blockedPipelineRow(
  pipelineId: string,
  phaseId: string,
  code: 'dependency-absent' | 'dependency-unresolvable' = 'dependency-absent'
): ImportPlanRow {
  return Object.freeze({
    outcome: 'blocked' as const,
    resourceKind: 'pipeline' as const,
    resourceId: pipelineId,
    name: pipelineId,
    reason: Object.freeze({
      code,
      dependency: Object.freeze({ kind: 'phase' as const, resourceId: phaseId })
    })
  });
}

function invalidPipelineRow(pipelineId: string | null): ImportPlanRow {
  return Object.freeze({
    outcome: 'invalid' as const,
    resourceKind: 'pipeline' as const,
    resourceId: pipelineId,
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
    effectivePipelines: [],
    storedPipelines: [],
    plannedPipelineRows: [],
    invalidPipelines: new Map(),
    ...overrides
  };
}

function node(nodeId: string, pipelineId = nodeId): WorkflowNode {
  return Object.freeze({ nodeId, pipelineId });
}

function workflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return Object.freeze({
    workflowId: 'ship-it-flow',
    name: 'Ship It Flow',
    version: 1,
    nodes: [node('draft', 'ship-it')] as readonly WorkflowNode[],
    connections: [] as readonly WorkflowConnection[],
    startNodeIds: ['draft'] as readonly string[],
    ...overrides
  });
}

describe('resolvePipelineDependency — pass 3 (FR-036, FR-037, FR-038, FR-042)', () => {
  it('resolves against the effective Pipeline catalog, not against stored presence', () => {
    // The same disagreeing-inputs construction as the Phase level: `ship-it`
    // resolves with no stored row at all, and `deploy-it` is stored but resolves
    // nowhere. A pass 3 that read stored rows could not keep both green.
    const ctx = workflowContext({
      effectivePipelines: [pipeline({ pipelineId: 'ship-it' })],
      storedPipelines: [storedPipelineRow('deploy-it', 'invalid')]
    });

    expect(resolvePipelineDependency('ship-it', ctx)).toEqual({ status: 'resolved-effective' });
    expect(resolvePipelineDependency('deploy-it', ctx)).toEqual({
      status: 'blocked',
      reason: {
        code: 'dependency-unresolvable',
        dependency: { kind: 'pipeline', resourceId: 'deploy-it' }
      }
    });
  });

  it('distinguishes absent from unresolvable (FR-038)', () => {
    const ctx = workflowContext({
      storedPipelines: [storedPipelineRow('deploy-it', 'invalid')]
    });

    expect(resolvePipelineDependency('nowhere', ctx)).toEqual({
      status: 'blocked',
      reason: { code: 'dependency-absent', dependency: { kind: 'pipeline', resourceId: 'nowhere' } }
    });
    expect(resolvePipelineDependency('deploy-it', ctx)).toEqual({
      status: 'blocked',
      reason: {
        code: 'dependency-unresolvable',
        dependency: { kind: 'pipeline', resourceId: 'deploy-it' }
      }
    });
  });

  it('counts a Pipeline this same document will import as resolved (FR-035)', () => {
    const ctx = workflowContext({
      plannedPipelineRows: [importedPipelineRow(pipeline({ pipelineId: 'ship-it' }))]
    });

    expect(resolvePipelineDependency('ship-it', ctx)).toEqual({ status: 'resolved-planned' });
  });

  it('counts a Pipeline planned skip as resolved when the catalog resolves it (FR-036)', () => {
    const ctx = workflowContext({
      effectivePipelines: [pipeline({ pipelineId: 'ship-it' })],
      storedPipelines: [storedPipelineRow('ship-it', 'effective')],
      plannedPipelineRows: [skippedPipelineRow('ship-it')]
    });

    expect(resolvePipelineDependency('ship-it', ctx)).toEqual({ status: 'resolved-skipped' });
  });

  it('blocks a Pipeline planned skip whose claiming row does not resolve', () => {
    // The FR-030b pair, one level up: the Pipeline row is `skip` because the id is
    // claimed, and the Workflow is `blocked` naming that same id because the claim
    // does not resolve. Reads like a contradiction and is not.
    const ctx = workflowContext({
      storedPipelines: [storedPipelineRow('ship-it', 'invalid')],
      plannedPipelineRows: [skippedPipelineRow('ship-it', 'invalid')]
    });

    expect(resolvePipelineDependency('ship-it', ctx)).toEqual({
      status: 'blocked',
      reason: {
        code: 'dependency-unresolvable',
        dependency: { kind: 'pipeline', resourceId: 'ship-it' }
      }
    });
  });

  it('does not let an invalid Pipeline claim its id (FR-029)', () => {
    // A malformed Pipeline is not a Pipeline: it satisfies nothing and makes no id
    // look present, so the Workflow is told to supply the Pipeline rather than to
    // go looking for a row that already holds it.
    const ctx = workflowContext({ plannedPipelineRows: [invalidPipelineRow('ship-it')] });

    expect(resolvePipelineDependency('ship-it', ctx)).toEqual({
      status: 'blocked',
      reason: { code: 'dependency-absent', dependency: { kind: 'pipeline', resourceId: 'ship-it' } }
    });
  });

  it('propagates a pass-2-blocked Pipeline with the root cause in via (FR-039, FR-040)', () => {
    // The new arm, and the only one with no analogue at the Phase level. Three
    // facts have to survive: the code says the fault is one level further down,
    // `dependency` names what this Workflow waits on, and `via` names what is
    // actually wrong. Collapsing to `dependency-absent` would tell the operator to
    // supply a Pipeline the document already contains.
    const ctx = workflowContext({
      plannedPipelineRows: [blockedPipelineRow('ship-it', 'specify')]
    });

    expect(resolvePipelineDependency('ship-it', ctx)).toEqual({
      status: 'blocked',
      reason: {
        code: 'dependency-blocked',
        dependency: { kind: 'pipeline', resourceId: 'ship-it' },
        via: { kind: 'phase', resourceId: 'specify' }
      }
    });
  });

  it('carries the root cause through an unresolvable Phase as well as an absent one', () => {
    // `via` is the pass-2 reason's own dependency, not a re-derivation, so both
    // root-cause codes reach the operator unchanged. A `via` that always read
    // "absent" would send them to supply a Phase that needs repairing.
    const ctx = workflowContext({
      plannedPipelineRows: [blockedPipelineRow('ship-it', 'specify', 'dependency-unresolvable')]
    });

    const resolution = resolvePipelineDependency('ship-it', ctx);
    expect(resolution).toEqual({
      status: 'blocked',
      reason: {
        code: 'dependency-blocked',
        dependency: { kind: 'pipeline', resourceId: 'ship-it' },
        via: { kind: 'phase', resourceId: 'specify' }
      }
    });
  });
});

describe('resolveWorkflowDependencies — FR-037, FR-039, FR-041, FR-042', () => {
  it('resolves a self-contained package against the Pipelines it supplies (FR-035)', () => {
    const ctx = workflowContext({
      plannedPipelineRows: [
        importedPipelineRow(pipeline({ pipelineId: 'ship-it' })),
        importedPipelineRow(pipeline({ pipelineId: 'review-it' }))
      ]
    });

    expect(
      resolveWorkflowDependencies(
        // Two starts rather than one plus a connection: this test is about the two
        // node Pipelines resolving, and a connection would drag port compatibility
        // into it. Both nodes must still be reachable or the graph pass reports an
        // `unreachable-node` and the outcome would be `invalid` for a reason that
        // has nothing to do with dependency resolution.
        workflow({
          nodes: [node('draft', 'ship-it'), node('review', 'review-it')],
          startNodeIds: ['draft', 'review']
        }),
        ctx
      )
    ).toEqual({ outcome: 'resolved' });
  });

  it('blocks rather than invalidates a well-formed Workflow whose node fails (FR-037)', () => {
    // FR-041's consequence, and the reason the passes are ordered: the ports a
    // connection addresses are derived from the node's Pipeline, so with the
    // Pipeline missing there is nothing to check them against. Reporting
    // `unresolved-endpoint` here would tell the operator to fix a Workflow whose
    // graph may be perfectly correct.
    expect(resolveWorkflowDependencies(workflow(), workflowContext())).toEqual({
      outcome: 'blocked',
      reason: { code: 'dependency-absent', dependency: { kind: 'pipeline', resourceId: 'ship-it' } }
    });
  });

  it('reports the first unresolved node in authored reference order', () => {
    const ctx = workflowContext({ effectivePipelines: [pipeline({ pipelineId: 'ship-it' })] });

    expect(
      resolveWorkflowDependencies(
        workflow({
          nodes: [node('draft', 'ship-it'), node('review', 'review-it'), node('ship', 'deploy-it')],
          startNodeIds: ['draft']
        }),
        ctx
      )
    ).toEqual({
      outcome: 'blocked',
      reason: {
        code: 'dependency-absent',
        dependency: { kind: 'pipeline', resourceId: 'review-it' }
      }
    });
  });

  it('resolves a Workflow that names the same Pipeline on two nodes (FR-042)', () => {
    // A sequence may repeat a Pipeline — nodes carry the identity, not the
    // Pipeline — so a repeat must not be a second lookup that can disagree.
    const ctx = workflowContext({ effectivePipelines: [pipeline({ pipelineId: 'ship-it' })] });

    expect(
      resolveWorkflowDependencies(
        workflow({
          nodes: [node('first', 'ship-it'), node('second', 'ship-it')],
          startNodeIds: ['first', 'second']
        }),
        ctx
      )
    ).toEqual({ outcome: 'resolved' });
  });

  it('never blocks on a dangling recommendedNext of a node Pipeline (FR-043)', () => {
    // Advisory navigation between Pipelines, carried verbatim in both directions.
    // It is not a dependency at either level, so it cannot block a Workflow.
    const ctx = workflowContext({
      effectivePipelines: [
        pipeline({ pipelineId: 'ship-it', recommendedNext: ['no-such-pipeline'] })
      ]
    });

    expect(resolveWorkflowDependencies(workflow(), ctx)).toEqual({ outcome: 'resolved' });
  });

  it('blocks a Workflow whose node names a pass-2-blocked Pipeline (FR-039, SC-012)', () => {
    const ctx = workflowContext({
      plannedPipelineRows: [blockedPipelineRow('ship-it', 'specify')]
    });

    expect(resolveWorkflowDependencies(workflow(), ctx)).toEqual({
      outcome: 'blocked',
      reason: {
        code: 'dependency-blocked',
        dependency: { kind: 'pipeline', resourceId: 'ship-it' },
        via: { kind: 'phase', resourceId: 'specify' }
      }
    });
  });
});

describe('graph validation at preflight — FR-035a, FR-041, SC-012b', () => {
  const AUTHORED: PipelineDefinition = pipeline({
    pipelineId: 'ship-it',
    outputs: [{ portId: 'spec-document', label: 'Spec', type: 'markdown' }]
  });
  const REVIEWER: PipelineDefinition = pipeline({
    pipelineId: 'review-it',
    name: 'Review It',
    inputs: [{ portId: 'spec', label: 'Spec', type: 'text', required: true }]
  });
  const CONNECTED = workflow({
    nodes: [node('draft', 'ship-it'), node('review', 'review-it')],
    connections: [
      {
        from: { nodeId: 'draft', portId: 'spec-document' },
        to: { nodeId: 'review', portId: 'spec' }
      }
    ],
    startNodeIds: ['draft']
  });

  it('validates against the effective catalog union the Pipelines this plan will write', () => {
    // The headline case, and the whole of the FR-035a carve-out: the effective
    // catalog is EMPTY here, so the only thing that can satisfy either endpoint is
    // a planned row. Without the union a self-contained package is reported broken
    // on the very Pipelines it supplies.
    const ctx = workflowContext({
      plannedPipelineRows: [importedPipelineRow(AUTHORED), importedPipelineRow(REVIEWER)]
    });

    expect(resolveWorkflowDependencies(CONNECTED, ctx)).toEqual({ outcome: 'resolved' });
  });

  it('makes a port defect invalid, naming the connection, rather than blocked', () => {
    // Every node resolves, so nothing is missing — the Workflow itself is wrong,
    // which is what `invalid` means. This is the `unresolved-endpoint` pair T029
    // could not assert: reachable only with the catalog in hand, and found by
    // `validateWorkflowGraph`, which stays the single endpoint detector.
    const ctx = workflowContext({
      plannedPipelineRows: [importedPipelineRow(AUTHORED), importedPipelineRow(REVIEWER)]
    });
    const broken = workflow({
      nodes: [node('draft', 'ship-it'), node('review', 'review-it')],
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

  it('reports a connection naming an undeclared node as unresolved-endpoint', () => {
    // The other half of T029's deferred pair. Also `validateWorkflowGraph`'s, for
    // the same reason: a second detector in the parser would be exactly the second
    // oracle the grammar contract forbids.
    const ctx = workflowContext({
      plannedPipelineRows: [importedPipelineRow(AUTHORED), importedPipelineRow(REVIEWER)]
    });
    const dangling = workflow({
      nodes: [node('draft', 'ship-it'), node('review', 'review-it')],
      connections: [
        {
          from: { nodeId: 'draft', portId: 'spec-document' },
          to: { nodeId: 'nowhere', portId: 'spec' }
        }
      ],
      startNodeIds: ['draft']
    });

    const result = resolveWorkflowDependencies(dangling, ctx);
    expect(result.outcome).toBe('invalid');
    if (result.outcome !== 'invalid') return;
    expect(result.defects.map((defect) => defect.code)).toContain('unresolved-endpoint');
    expect(result.defects.some((defect) => defect.field.startsWith('connections[0].to'))).toBe(true);
  });

  it('carries no workflowId onto the defect, which the row already names', () => {
    const ctx = workflowContext({
      plannedPipelineRows: [importedPipelineRow(AUTHORED), importedPipelineRow(REVIEWER)]
    });
    const broken = workflow({
      nodes: [node('draft', 'ship-it'), node('review', 'review-it')],
      connections: [
        { from: { nodeId: 'draft', portId: 'no-such-port' }, to: { nodeId: 'review', portId: 'spec' } }
      ],
      startNodeIds: ['draft']
    });

    const result = resolveWorkflowDependencies(broken, ctx);
    if (result.outcome !== 'invalid') throw new Error(`expected invalid, got ${result.outcome}`);
    for (const defect of result.defects) {
      expect(Object.keys(defect).sort()).toEqual(['code', 'field', 'message']);
    }
  });

  it('passes the invalid-Pipeline causes through rather than recomputing them', () => {
    // `validateWorkflowGraph`'s third argument, so an id that resolves to an
    // invalid record is distinguishable from an absent one and the transitive
    // cause can be named. Pass 3 cannot reach here on an unresolvable id, so the
    // map is supplied by the caller and forwarded — a second derivation inside the
    // resolver would be a second oracle for the same question.
    const ctx = workflowContext({
      effectivePipelines: [AUTHORED],
      // The stored row is what PUTS `review-it` in the causes map: an id resolves
      // to an invalid record only because a layer holds a row that failed
      // validation. Stating both keeps the two inputs consistent instead of
      // asserting a map entry no catalog could have produced.
      storedPipelines: [storedPipelineRow('review-it', 'invalid')],
      invalidPipelines: new Map([['review-it', 'Pipeline definition is invalid']])
    });

    // `review-it` is not effective and not planned, so pass 3 blocks before any
    // graph check runs — the ordering FR-041 requires. The causes map is carried
    // for the case where every node DOES resolve, which is the only time
    // `validateWorkflowGraph` is reached.
    expect(resolveWorkflowDependencies(CONNECTED, ctx)).toEqual({
      outcome: 'blocked',
      reason: {
        code: 'dependency-unresolvable',
        dependency: { kind: 'pipeline', resourceId: 'review-it' }
      }
    });
  });
});

describe('prospectivePipelineCatalog — the pass-3 union, named so it has a test', () => {
  it('adds the Pipelines this plan will write to the effective catalog', () => {
    const ctx = workflowContext({
      effectivePipelines: [pipeline({ pipelineId: 'finalize-it' })],
      plannedPipelineRows: [
        importedPipelineRow(pipeline({ pipelineId: 'ship-it' })),
        skippedPipelineRow('review-it'),
        blockedPipelineRow('deploy-it', 'specify')
      ]
    });

    // Neither the `skip` nor the `blocked` row contributes. The skip is not
    // written, and the blocked row is the one pass 3 must NOT be able to satisfy a
    // node with — admitting it would let a Workflow validate against a Pipeline
    // this write is not going to make effective.
    expect(prospectivePipelineCatalog(ctx).map((definition) => definition.pipelineId)).toEqual([
      'finalize-it',
      'ship-it'
    ]);
  });

  it('keeps the effective definition when a planned row declares the same id', () => {
    const effective = pipeline({ pipelineId: 'ship-it', name: 'Effective Ship It' });
    const ctx = workflowContext({
      effectivePipelines: [effective],
      plannedPipelineRows: [
        importedPipelineRow(pipeline({ pipelineId: 'ship-it', name: 'Planned Ship It' }))
      ]
    });

    expect(prospectivePipelineCatalog(ctx)).toEqual([effective]);
  });

  it('ignores a Phase row entirely', () => {
    const ctx = workflowContext({
      plannedPipelineRows: [importedPhaseRow(phase('specify'))]
    });

    expect(prospectivePipelineCatalog(ctx)).toEqual([]);
  });
});
