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
  PipelineOutputPort
} from '../../../src/contracts/pipeline-definitions';
import type {
  PhaseDefinition,
  PhaseDefinitionScope,
  PhaseSourceRecord,
  PhaseSourceStatus
} from '../../../src/contracts/process-definitions';
import {
  prospectivePhaseCatalog,
  resolvePhaseDependency,
  resolvePipelineDependencies,
  type PackageResolutionContext
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
function storedRow(
  phaseId: string,
  scope: PhaseDefinitionScope,
  status: PhaseSourceStatus
): PhaseSourceRecord {
  return Object.freeze({
    key: `${scope}::${phaseId}::0`,
    phaseId,
    scope,
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
  presentIn: PhaseDefinitionScope = 'user',
  presentRowStatus: PhaseSourceStatus = 'effective'
): ImportPlanRow {
  return Object.freeze({
    outcome: 'skip' as const,
    resourceKind: 'phase' as const,
    resourceId: phaseId,
    name: phaseId,
    presentIn,
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
      storedPhases: [storedRow('plan', 'workspace', 'invalid')]
    });

    expect(resolvePhaseDependency('specify', ctx)).toEqual({ status: 'resolved-effective' });
    expect(resolvePhaseDependency('plan', ctx)).toEqual({
      status: 'blocked',
      reason: { code: 'dependency-unresolvable', phaseId: 'plan' }
    });
  });

  it('calls an id no layer claims absent, and one claimed but not effective unresolvable', () => {
    // The distinction is the operator's next action: supply the Phase, or repair
    // the row that already claims the id (FR-030c).
    const ctx = context({ storedPhases: [storedRow('plan', 'user', 'shadowed')] });

    expect(resolvePhaseDependency('nowhere', ctx)).toEqual({
      status: 'blocked',
      reason: { code: 'dependency-absent', phaseId: 'nowhere' }
    });
    expect(resolvePhaseDependency('plan', ctx)).toEqual({
      status: 'blocked',
      reason: { code: 'dependency-unresolvable', phaseId: 'plan' }
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
      storedPhases: [storedRow('specify', 'user', 'effective')],
      plannedPhaseRows: [skippedPhaseRow('specify')]
    });

    expect(resolvePhaseDependency('specify', ctx)).toEqual({ status: 'resolved-skipped' });
  });

  it('blocks a dependency planned skip whose claiming row does not resolve (FR-030b)', () => {
    // The coherent pair, at the level it is decided: the Phase row is `skip`
    // because the id is claimed, and this same id does not resolve. Reading the
    // skip as "resolved" would import a Pipeline that fails at run time.
    const ctx = context({
      storedPhases: [storedRow('specify', 'workspace', 'shadowed')],
      plannedPhaseRows: [skippedPhaseRow('specify', 'workspace', 'shadowed')]
    });

    expect(resolvePhaseDependency('specify', ctx)).toEqual({
      status: 'blocked',
      reason: { code: 'dependency-unresolvable', phaseId: 'specify' }
    });
  });

  it('does not let an invalid resource claim its id (FR-032)', () => {
    // A malformed Phase is not a Phase. It neither satisfies the reference nor
    // makes the id look present, so the Pipeline reads `dependency-absent` and
    // the operator is told to supply the Phase rather than to look for a row.
    const ctx = context({ plannedPhaseRows: [invalidPhaseRow('specify')] });

    expect(resolvePhaseDependency('specify', ctx)).toEqual({
      status: 'blocked',
      reason: { code: 'dependency-absent', phaseId: 'specify' }
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
      reason: { code: 'dependency-absent', phaseId: 'specify' }
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
      reason: { code: 'dependency-absent', phaseId: 'plan' }
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
      reason: { code: 'dependency-absent', phaseId: 'specify' }
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
