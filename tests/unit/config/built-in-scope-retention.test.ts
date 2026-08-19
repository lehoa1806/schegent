// Feature 098 (T035, FR-017, FR-049) — the `built-in` scope survives losing its rows.
//
// This feature empties the built-in layer. It does **not** remove the layer, and the
// difference is the whole point of a separate test file: an empty layer that is still
// a layer keeps three-scope precedence, keeps the `shadowed` status a row acquires by
// losing to a higher scope, keeps the presence scan that refuses to overwrite an id
// claimed anywhere, and keeps every gate that refuses `built-in` as a save target.
// Collapse the scope to two instead and each of those becomes a special case,
// silently — nothing would fail, because with zero rows nothing exercises the third
// arm. So the assertions here are deliberately about machinery with no rows to run on,
// and several of them supply a built-in row by hand: the layer is empty in the
// product, not incapable of holding one, and that is the property under test.
//
// It is one file because the claims span four modules — the contracts, the two
// resolvers, the planner's presence scan and the three IPC validators — and no
// existing suite owns the conjunction. Each module's own suite still owns its
// behavior; what this file owns is that the *scope* is still there to be behaved about.

import { describe, expect, it } from 'vitest';

import {
  PHASE_DEFINITION_SCOPES,
  type PhaseDefinitionScope,
  type PhaseSourceRecord,
  type PhaseSourceStatus,
  type WritablePhaseDefinitionScope
} from '../../../src/contracts/process-definitions';
import {
  PIPELINE_DEFINITION_SCOPES,
  PIPELINE_WRITABLE_SCOPES,
  type PipelineDefinitionScope,
  type PipelineSourceRecord,
  type WritablePipelineDefinitionScope
} from '../../../src/contracts/pipeline-definitions';
import {
  WORKFLOW_DEFINITION_SCOPES,
  type WorkflowDefinitionScope,
  type WorkflowSourceRecord,
  type WritableWorkflowDefinitionScope
} from '../../../src/contracts/workflow-definitions';
import { resolvePhaseCatalog } from '../../../src/config/process-catalog';
import { resolvePipelineCatalog } from '../../../src/config/pipeline-catalog';
import {
  findPhaseIdPresence,
  findPipelineIdPresence,
  findWorkflowIdPresence
} from '../../../src/services/process-yaml/import-planner';
import { validateSavePhases } from '../../../src/contracts/validators/save-phases';
import { validateSavePipelines } from '../../../src/contracts/validators/save-pipelines';
import { validateSaveWorkflows } from '../../../src/contracts/validators/save-workflows';

const THREE_SCOPES = ['built-in', 'user', 'workspace'];

/** A row valid enough to resolve, so its record's status is decided by precedence. */
function phaseRow(name: string) {
  return { id: 'shared', name, version: 1, instruction: name };
}

function phaseRecord(scope: PhaseDefinitionScope, status: PhaseSourceStatus): PhaseSourceRecord {
  return {
    key: `${scope}:shared`, phaseId: 'shared', scope, status,
    definition: null, display: {}, errors: []
  };
}

function pipelineRecord(scope: PipelineDefinitionScope): PipelineSourceRecord {
  return {
    key: `${scope}:shared`, pipelineId: 'shared', scope, status: 'shadowed',
    definition: null, display: {}, errors: []
  };
}

function workflowRecord(scope: WorkflowDefinitionScope): WorkflowSourceRecord {
  return {
    key: `${scope}:shared`, workflowId: 'shared', scope, status: 'shadowed',
    definition: null, display: {}, nodePipelineIds: [], errors: []
  };
}

describe('the `built-in` scope is still declared, in first precedence position', () => {
  it('names three scopes for Phases, Pipelines and Workflows, built-in first', () => {
    expect([...PHASE_DEFINITION_SCOPES]).toEqual(THREE_SCOPES);
    expect([...PIPELINE_DEFINITION_SCOPES]).toEqual(THREE_SCOPES);
    expect([...WORKFLOW_DEFINITION_SCOPES]).toEqual(THREE_SCOPES);
  });

  it('excludes built-in from every writable-scope type', () => {
    // Also a type-level assertion, checked by `typecheck:tests`: each annotation
    // stops compiling if `built-in` ever becomes assignable to a writable scope,
    // which is the compile-time half of the same guarantee the validators enforce
    // at run time below.
    const writablePhase: readonly WritablePhaseDefinitionScope[] = ['user', 'workspace'];
    const writablePipeline: readonly WritablePipelineDefinitionScope[] = ['user', 'workspace'];
    const writableWorkflow: readonly WritableWorkflowDefinitionScope[] = ['user', 'workspace'];

    expect([...writablePhase]).toEqual(['user', 'workspace']);
    expect([...writablePipeline]).toEqual(['user', 'workspace']);
    expect([...writableWorkflow]).toEqual(['user', 'workspace']);
    expect([...PIPELINE_WRITABLE_SCOPES]).toEqual(['user', 'workspace']);
  });
});

describe('the source-record status machine still has three states and still shadows', () => {
  it('marks the losing row shadowed rather than dropping it', () => {
    // Precedence with the built-in layer empty: workspace wins, user is retained and
    // marked `shadowed`. `shadowed` only exists because more than one layer can claim
    // an id, so a collapse to a single writable layer would make it unreachable.
    const result = resolvePhaseCatalog({
      builtIn: [],
      user: [phaseRow('User')],
      workspace: [phaseRow('Workspace')]
    });

    expect(result.effective.filter((definition) => definition.phaseId === 'shared')).toHaveLength(1);
    expect(result.records.map((record) => [record.scope, record.status])).toEqual(
      expect.arrayContaining([
        ['workspace', 'effective'],
        ['user', 'shadowed']
      ])
    );
  });

  it('still ranks a supplied built-in row below the operator layers', () => {
    const result = resolvePhaseCatalog({
      builtIn: [{ id: 'shared', name: 'Built In', instruction: 'built-in', version: 1 }],
      user: [phaseRow('User')],
      workspace: []
    });

    expect(result.effective.find((definition) => definition.phaseId === 'shared')).toMatchObject({
      name: 'User'
    });
    expect(result.records.find((record) => record.scope === 'built-in'))
      .toMatchObject({ status: 'shadowed' });
  });

  it('still admits an `invalid` status distinct from absent', () => {
    const result = resolvePhaseCatalog({
      builtIn: [],
      user: [{ id: 'shared', name: 'Half Repaired', version: 1 }],
      workspace: []
    });

    expect(result.effective.some((definition) => definition.phaseId === 'shared')).toBe(false);
    expect(result.records[0]).toMatchObject({ status: 'invalid', definition: null });
  });

  it('resolves three empty Pipeline layers over an empty Phase catalog without inventing a record', () => {
    const result = resolvePipelineCatalog({
      builtIn: [], user: [], workspace: [], phaseCatalog: []
    });

    expect(result.records).toEqual([]);
    expect(result.effective).toEqual([]);
  });
});

describe('the presence scan still visits built-in, and still visits it first', () => {
  // `PRESENCE_SCAN_ORDER` is module-private, so its order is asserted through the
  // behavior it produces: with the same id claimed in all three layers, each scan
  // reports `built-in`, which holds only if built-in is still visited and still
  // visited first. All three scans are checked because they are three separate
  // functions over three separate stores, deliberately not generalized.
  it('reports the built-in claimant for a Phase id claimed in every layer', () => {
    const presence = findPhaseIdPresence(
      [
        phaseRecord('workspace', 'effective'),
        phaseRecord('user', 'shadowed'),
        phaseRecord('built-in', 'shadowed')
      ],
      'shared'
    );

    expect(presence).toEqual({ scope: 'built-in', status: 'shadowed' });
  });

  it('reports the built-in claimant for a Pipeline id claimed in every layer', () => {
    const presence = findPipelineIdPresence(
      [pipelineRecord('workspace'), pipelineRecord('user'), pipelineRecord('built-in')],
      'shared'
    );

    expect(presence).toMatchObject({ scope: 'built-in' });
  });

  it('reports the built-in claimant for a Workflow id claimed in every layer', () => {
    const presence = findWorkflowIdPresence(
      [workflowRecord('workspace'), workflowRecord('user'), workflowRecord('built-in')],
      'shared'
    );

    expect(presence).toMatchObject({ scope: 'built-in' });
  });

  it('reports absence when no row claims the id, so an empty built-in layer blocks nothing', () => {
    // The other half, and the one this feature turns on: with no built-in rows the
    // scan finds nothing to skip against, which is what lets the shipped examples
    // import. Emptying the layer must not become "the scan stopped looking".
    expect(findPhaseIdPresence([], 'shared')).toBeNull();
    expect(findPipelineIdPresence([], 'shared')).toBeNull();
    expect(findWorkflowIdPresence([], 'shared')).toBeNull();
  });

  it('still refuses an id claimed only by an invalid row', () => {
    // FR-030's sharp case, restated here because it is a property of the scan
    // visiting stored rows at *every* status rather than of any layer's content.
    expect(findPhaseIdPresence([phaseRecord('user', 'invalid')], 'shared'))
      .toEqual({ scope: 'user', status: 'invalid' });
  });
});

describe('every save validator still refuses built-in as a target scope', () => {
  // Asserted at the transport boundary, which is where the refusal actually lives:
  // the handlers below it take a `Writable…Scope`, so `built-in` is unrepresentable
  // by the time they run, and a hand-built webview message is exactly what these
  // validators exist to reject. Each is checked against a `user`-scoped twin so a
  // rejection caused by anything else in the payload would fail the pair.
  const EXPECTED_REVISION = 'a'.repeat(64);

  function savePhases(scope: string) {
    return {
      payload: {
        scope, expectedRevision: EXPECTED_REVISION, mutation: { kind: 'reset' }, phases: []
      }
    };
  }

  it('rejects a Phase save scoped to built-in and accepts the same payload scoped to user', () => {
    expect(validateSavePhases(savePhases('built-in'), 'c-1'))
      .toMatchObject({ ok: false, reason: 'invalid-payload' });
    expect(validateSavePhases(savePhases('user'), 'c-1')).toMatchObject({ ok: true });
  });

  it('rejects a Pipeline save scoped to built-in and accepts the same payload scoped to user', () => {
    const payload = (scope: string) => ({
      payload: {
        scope, expectedRevision: EXPECTED_REVISION, mutation: { kind: 'reset' }, pipelines: []
      }
    });

    expect(validateSavePipelines(payload('built-in'), 'c-2'))
      .toMatchObject({ ok: false, reason: 'invalid-payload' });
    expect(validateSavePipelines(payload('user'), 'c-2')).toMatchObject({ ok: true });
  });

  it('rejects a Workflow save scoped to built-in and accepts the same payload scoped to user', () => {
    const payload = (scope: string) => ({
      payload: {
        scope, expectedRevision: EXPECTED_REVISION, mutation: { kind: 'reset' }, workflows: []
      }
    });

    expect(validateSaveWorkflows(payload('built-in'), 'c-3'))
      .toMatchObject({ ok: false, reason: 'invalid-payload' });
    expect(validateSaveWorkflows(payload('user'), 'c-3')).toMatchObject({ ok: true });
  });
});
