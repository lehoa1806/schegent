// Feature 084 T066 — the three decisions the Phase manager makes before it can
// offer the exchange controls (FR-052, FR-053, FR-057).
//
// Each has a wrong answer that would be invisible in markup: an Export control
// that fails after the click, an import started over an unsaved edit, and a
// target layer that silently rewrites a row the import never mentioned.

import { describe, expect, it } from 'vitest';
import type {
  PhaseCatalogSourceRecord,
  WorkflowCatalogSourceProjection
} from '../../lib/snapshot-types';
import {
  confirmTargetBlockedReason,
  importDisabledReason,
  phaseExportAvailability,
  storedWritableLayers,
  topLevelImportDisabledReason,
  workflowExportDisabledReason,
  type ImportTargetGate
} from '../ProcessImport/process-exchange-entry';
import type { ImportPlan } from '../../lib/messages';

function record(overrides: Partial<PhaseCatalogSourceRecord> = {}): PhaseCatalogSourceRecord {
  return {
    key: 'specify::0',
    phaseId: 'specify',
    status: 'effective',
    definition: { phaseId: 'specify', name: 'Specify', version: 1 },
    display: { id: 'specify', name: 'Specify', version: 1, instruction: 'Write the spec.' },
    errors: [],
    ...overrides
  };
}

/** Feature 086 T054 — a Workflow catalog record, the second stored catalog. */
function workflowRecord(
  overrides: Partial<WorkflowCatalogSourceProjection> = {}
): WorkflowCatalogSourceProjection {
  return {
    key: 'ship-it-flow::0',
    workflowId: 'ship-it-flow',
    status: 'effective',
    definition: {
      workflowId: 'ship-it-flow',
      name: 'Ship It Flow',
      version: 1,
      nodes: [{ nodeId: 'draft', kind: 'phase', phaseId: 'specify' }],
      connections: [],
      startNodeIds: ['draft']
    },
    display: {
      workflowId: 'ship-it-flow',
      name: 'Ship It Flow',
      version: 1,
      nodes: [{ nodeId: 'draft', kind: 'phase', phaseId: 'specify' }],
      connections: [],
      startNodeIds: ['draft']
    },
    errors: [],
    derivedInputs: [],
    derivedOutputs: [],
    ...overrides
  };
}

const EMPTY_LAYERS = { phases: [], workflows: [] };

describe('Feature 084 — which rows can be exported (T066, FR-052, FR-015)', () => {
  it('offers an effective row', () => {
    const availability = phaseExportAvailability({ sourceStatus: 'effective', persisted: true });
    expect(availability).toEqual({ resolves: true, disabledReason: '' });
  });

  it('withholds Export for exactly two reasons and no third (FR-014)', () => {
    const cases = [
      { row: { sourceStatus: 'effective' as const, persisted: true }, resolves: true },
      { row: { sourceStatus: 'invalid' as const, persisted: true }, resolves: false },
      { row: { sourceStatus: 'effective' as const, persisted: false }, resolves: false },
      { row: { sourceStatus: 'invalid' as const, persisted: false }, resolves: false }
    ];
    for (const { row, resolves } of cases) {
      expect(phaseExportAvailability(row).resolves, JSON.stringify(row)).toBe(resolves);
    }
  });

  it('refuses an invalid row and says there is nothing valid to export', () => {
    const availability = phaseExportAvailability({ sourceStatus: 'invalid', persisted: true });
    expect(availability.resolves).toBe(false);
    expect(availability.disabledReason).toContain('errors');
  });

  it('refuses an unsaved draft before the click rather than after it', () => {
    const availability = phaseExportAvailability({ sourceStatus: 'effective', persisted: false });
    expect(availability.resolves).toBe(false);
    expect(availability.disabledReason).toBe('Save this Phase before exporting it.');
  });

  it('reports the draft, not the errors, when a draft is also invalid', () => {
    const availability = phaseExportAvailability({ sourceStatus: 'invalid', persisted: false });
    expect(availability.disabledReason).toBe('Save this Phase before exporting it.');
  });

  it('always states a reason when it refuses (FR-057)', () => {
    for (const row of [
      { sourceStatus: 'invalid' as const, persisted: true },
      { sourceStatus: 'effective' as const, persisted: false }
    ]) {
      expect(phaseExportAvailability(row).disabledReason.length).toBeGreaterThan(0);
    }
  });
});

describe('Feature 084 — when an import can be started (T066, FR-053, FR-057)', () => {
  const OPEN = { catalog: 'phase', trusted: true, savePending: false, mutationActive: false } as const;

  it('is available when nothing is outstanding', () => {
    expect(importDisabledReason(OPEN)).toBeNull();
  });

  it('is closed in an untrusted workspace, naming trust', () => {
    const reason = importDisabledReason({ ...OPEN, trusted: false });
    expect(reason).toContain('not trusted');
  });

  it('is closed while a save is in flight', () => {
    expect(importDisabledReason({ ...OPEN, savePending: true })).toContain('in progress');
  });

  it('is closed while a local Phase edit is outstanding', () => {
    const reason = importDisabledReason({ ...OPEN, mutationActive: true });
    expect(reason).toContain('pending');
  });

  it('reports untrustedness first — it is the condition the operator cannot clear here', () => {
    const reason = importDisabledReason({
      catalog: 'phase',
      trusted: false,
      savePending: true,
      mutationActive: true
    });
    expect(reason).toContain('not trusted');
  });

  // Finding 62 of the webview port review: the Workflows tab feeds this gate its
  // own save and its own edits, and the two sentences named the Phase catalog.
  it('names the Phase catalog on the Phases tab', () => {
    expect(importDisabledReason({ ...OPEN, savePending: true })).toBe(
      'A Phase save is still in progress.'
    );
    expect(importDisabledReason({ ...OPEN, mutationActive: true })).toBe(
      'Save or discard your pending Phase changes before importing.'
    );
  });

  it('names the Workflow catalog on the Workflows tab', () => {
    const workflows = { ...OPEN, catalog: 'workflow' } as const;
    expect(importDisabledReason({ ...workflows, savePending: true })).toBe(
      'A Workflow save is still in progress.'
    );
    expect(importDisabledReason({ ...workflows, mutationActive: true })).toBe(
      'Save or discard your pending Workflow changes before importing.'
    );
  });

  it('words trust the same on both tabs: the document is not read yet', () => {
    const phases = importDisabledReason({ ...OPEN, trusted: false });
    const workflows = importDisabledReason({ ...OPEN, catalog: 'workflow', trusted: false });
    expect(workflows).toBe(phases);
  });
});

describe('Feature 084/085 — what an import appends to (T066/T048, FR-037, FR-043)', () => {
  it('carries every stored row into the one projection, in catalog order', () => {
    const layers = storedWritableLayers([
      record({ key: 'a::0', phaseId: 'a', display: { id: 'a', version: 1 } }),
      record({ key: 'b::0', phaseId: 'b', display: { id: 'b', version: 1 } })
    ]);
    expect(layers.phases.map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('leaves out no row, there being no unwritable tier to filter (T496f)', () => {
    const layers = storedWritableLayers([record()], [workflowRecord()]);
    expect(layers.phases).toHaveLength(1);
    expect(layers.workflows).toHaveLength(1);
  });

  it('carries rows of every status, in catalog order — the layer is the stored array', () => {
    const layers = storedWritableLayers([
      record({ key: 'one::0', phaseId: 'one', status: 'invalid', display: { id: 'one' } }),
      record({ key: 'two::0', phaseId: 'two', status: 'effective', display: { id: 'two' } }),
      record({ key: 'three::0', phaseId: 'three', status: 'invalid', display: { id: 'three' } })
    ]);
    expect(layers.phases.map((row) => row.id)).toEqual(['one', 'two', 'three']);
  });

  it('passes a broken row through as authored rather than repairing it', () => {
    const layers = storedWritableLayers([
      record({
        key: 'broken::0',
        phaseId: 'broken',
        status: 'invalid',
        definition: null,
        display: { id: 'broken', instruction: 'Half-written.' },
        errors: [{ field: 'name', code: 'missing', message: 'name is required' }]
      })
    ]);
    expect(layers.phases).toHaveLength(1);
    expect(layers.phases[0]).toEqual({ id: 'broken', instruction: 'Half-written.' });
    expect(layers.phases[0]).not.toHaveProperty('name');
    expect(layers.phases[0]).not.toHaveProperty('version');
  });

  it('keeps the identity key under the name the row authored', () => {
    const layers = storedWritableLayers([
      record({ key: 'aliased::0', display: { phaseId: 'aliased', name: 'Aliased', version: 3 } })
    ]);
    expect(layers.phases[0]).toEqual({ phaseId: 'aliased', name: 'Aliased', version: 3 });
  });

  it('copies each row rather than aliasing the projection', () => {
    const source = record({ display: { id: 'specify', version: 1 } });
    const workflowSource = workflowRecord();
    const layers = storedWritableLayers([source], [workflowSource]);
    expect(layers.phases[0]).not.toBe(source.display);
    expect(layers.workflows[0]).not.toBe(workflowSource.display);
  });

  it('carries every stored Workflow row into the one projection', () => {
    const layers = storedWritableLayers(
      [],
      [
        workflowRecord({ key: 'a::0', workflowId: 'a', display: { workflowId: 'a', version: 1 } }),
        workflowRecord({ key: 'b::0', workflowId: 'b', display: { workflowId: 'b', version: 1 } })
      ]
    );
    expect(layers.workflows.map((row) => row.workflowId)).toEqual(['a', 'b']);
  });

  it('carries Workflow rows of every status, in catalog order (FR-025)', () => {
    const layers = storedWritableLayers(
      [],
      [
        workflowRecord({ key: 'one::0', status: 'invalid', display: { workflowId: 'one' } }),
        workflowRecord({ key: 'two::0', status: 'effective', display: { workflowId: 'two' } }),
        workflowRecord({ key: 'three::0', status: 'invalid', display: { workflowId: 'three' } })
      ]
    );
    expect(layers.workflows.map((row) => row.workflowId)).toEqual(['one', 'two', 'three']);
  });

  it('passes a broken Workflow row through as authored rather than repairing it', () => {
    const layers = storedWritableLayers(
      [],
      [
        workflowRecord({
          key: 'broken::0',
          workflowId: 'broken',
          status: 'invalid',
          definition: null,
          display: { workflowId: 'broken', nodes: [] },
          errors: [{ field: 'startNodeIds', code: 'missing', message: 'startNodeIds is required' }]
        })
      ]
    );
    expect(layers.workflows[0]).toEqual({ workflowId: 'broken', nodes: [] });
    expect(layers.workflows[0]).not.toHaveProperty('startNodeIds');
  });

  it('yields two empty layers when only the Phase catalog is supplied', () => {
    expect(storedWritableLayers([])).toEqual(EMPTY_LAYERS);
  });

  it('yields two empty layers for an empty catalog', () => {
    expect(storedWritableLayers([], [])).toEqual(EMPTY_LAYERS);
  });

  it('keeps each catalog on its own side of the pair', () => {
    const layers = storedWritableLayers([record()], [workflowRecord()]);
    expect(layers.phases.map((row) => row.id)).toEqual(['specify']);
    expect(layers.workflows.map((row) => row.workflowId)).toEqual(['ship-it-flow']);
  });

  it('treats an absent Workflow catalog as an empty Workflow layer, not an absent pair', () => {
    const layers = storedWritableLayers([record()]);
    expect(layers.workflows).toEqual([]);
    expect(layers.phases).toHaveLength(1);
  });
});

describe('Feature 326 — top-level Import entry, Workflow export availability, and target-kind commit gating', () => {
  const OPEN_GATE: ImportTargetGate = {
    isPrimary: true,
    workspaceTrust: true,
    trustPhases: true,
    phaseSavePending: false,
    phaseMutationActive: false,
    workflowSavePending: false,
    workflowMutationActive: false,
    modelsSavePending: false,
    modelsDirty: false
  };

  const PHASE_PLAN: ImportPlan = {
    rows: [
      {
        outcome: 'import',
        resourceKind: 'phase',
        resourceId: 'p1',
        name: 'Phase 1',
        requiresRetryConditionCapability: false,
        definition: { phaseId: 'p1', name: 'Phase 1', version: 1, instruction: 'Run.' }
      }
    ],
    counts: { import: 1, skip: 0, blocked: 0, invalid: 0 },
    computedAgainstRevision: 'rev-1'
  };

  const WORKFLOW_PLAN: ImportPlan = {
    rows: [
      {
        outcome: 'import',
        resourceKind: 'workflow',
        resourceId: 'wf1',
        name: 'Workflow 1',
        definition: {
          workflowId: 'wf1',
          name: 'Workflow 1',
          version: 1,
          nodes: [{ nodeId: 'a', kind: 'phase', phaseId: 'p1' }],
          connections: [],
          startNodeIds: ['a']
        }
      }
    ],
    counts: { import: 1, skip: 0, blocked: 0, invalid: 0 },
    computedAgainstRevision: 'rev-1',
    computedAgainstWorkflowRevision: 'wf-rev-1'
  };

  const MODEL_PLAN: ImportPlan = {
    rows: [
      {
        outcome: 'import',
        resourceKind: 'modelCatalog',
        resourceId: 'claude-x',
        backend: 'claude',
        modelId: 'claude-x'
      }
    ],
    counts: { import: 1, skip: 0, blocked: 0, invalid: 0 },
    computedAgainstRevision: 'rev-1',
    computedAgainstModelsRevision: 'm-rev-1'
  };

  it('topLevelImportDisabledReason gates only on window primacy', () => {
    expect(topLevelImportDisabledReason(true)).toBeNull();
    expect(topLevelImportDisabledReason(false)).toContain('primary window');
  });

  it('workflowExportDisabledReason refuses unsaved drafts and allows saved rows', () => {
    expect(workflowExportDisabledReason({ persisted: true })).toBeNull();
    expect(workflowExportDisabledReason({ persisted: false })).toContain('Save this Workflow first');
  });

  it('allows Model Catalog commits in an untrusted workspace while blocking Phase and Workflow commits', () => {
    const untrusted: ImportTargetGate = {
      ...OPEN_GATE,
      workspaceTrust: false,
      trustPhases: false
    };
    expect(confirmTargetBlockedReason(MODEL_PLAN, untrusted)).toBeNull();
    expect(confirmTargetBlockedReason(PHASE_PLAN, untrusted)).toContain('not trusted');
    expect(confirmTargetBlockedReason(WORKFLOW_PLAN, untrusted)).toContain('not trusted');
  });

  it('blocks only the dirty or saving target catalog, leaving unrelated catalogs importable', () => {
    const dirtyPhases = { ...OPEN_GATE, phaseMutationActive: true };
    expect(confirmTargetBlockedReason(PHASE_PLAN, dirtyPhases)).toContain('pending Phase changes');
    expect(confirmTargetBlockedReason(WORKFLOW_PLAN, dirtyPhases)).toBeNull();
    expect(confirmTargetBlockedReason(MODEL_PLAN, dirtyPhases)).toBeNull();

    const dirtyWorkflows = { ...OPEN_GATE, workflowMutationActive: true };
    expect(confirmTargetBlockedReason(WORKFLOW_PLAN, dirtyWorkflows)).toContain('pending Workflow changes');
    expect(confirmTargetBlockedReason(PHASE_PLAN, dirtyWorkflows)).toBeNull();
    expect(confirmTargetBlockedReason(MODEL_PLAN, dirtyWorkflows)).toBeNull();

    const dirtyModels = { ...OPEN_GATE, modelsDirty: true };
    expect(confirmTargetBlockedReason(MODEL_PLAN, dirtyModels)).toContain('pending Model Catalog changes');
    expect(confirmTargetBlockedReason(PHASE_PLAN, dirtyModels)).toBeNull();
    expect(confirmTargetBlockedReason(WORKFLOW_PLAN, dirtyModels)).toBeNull();

    const savingModels = { ...OPEN_GATE, modelsSavePending: true };
    expect(confirmTargetBlockedReason(MODEL_PLAN, savingModels)).toContain('in progress');
    expect(confirmTargetBlockedReason(PHASE_PLAN, savingModels)).toBeNull();
  });

  it('blocks any kind in a secondary window', () => {
    const secondary = { ...OPEN_GATE, isPrimary: false };
    for (const plan of [PHASE_PLAN, WORKFLOW_PLAN, MODEL_PLAN]) {
      expect(confirmTargetBlockedReason(plan, secondary)).toContain('primary window');
    }
  });

  it('evaluates multi-kind packages per written kind (skips ignored, trustPhases vs workspaceTrust isolated)', () => {
    const COMBINED_PLAN: ImportPlan = {
      rows: [...PHASE_PLAN.rows, ...WORKFLOW_PLAN.rows],
      counts: { import: 2, skip: 0, blocked: 0, invalid: 0 },
      computedAgainstRevision: 'rev-1',
      computedAgainstWorkflowRevision: 'wf-rev-1'
    };
    const SKIPPED_PHASE_WITH_WORKFLOW: ImportPlan = {
      rows: [
        { outcome: 'skip', resourceKind: 'phase', resourceId: 'p1', name: 'Phase 1', presentRowStatus: 'effective' },
        ...WORKFLOW_PLAN.rows
      ],
      counts: { import: 1, skip: 1, blocked: 0, invalid: 0 },
      computedAgainstRevision: 'rev-1',
      computedAgainstWorkflowRevision: 'wf-rev-1'
    };

    // workspaceTrust true + trustPhases false blocks Phase writes, allows Workflow-only writes
    const phasesUntrusted: ImportTargetGate = { ...OPEN_GATE, trustPhases: false };
    expect(confirmTargetBlockedReason(COMBINED_PLAN, phasesUntrusted)).toContain('Custom Phase changes are disabled');
    expect(confirmTargetBlockedReason(SKIPPED_PHASE_WITH_WORKFLOW, phasesUntrusted)).toBeNull();

    // Dirty Phases blocks COMBINED_PLAN (writes Phase), allows SKIPPED_PHASE_WITH_WORKFLOW (only writes Workflow)
    const dirtyPhases: ImportTargetGate = { ...OPEN_GATE, phaseMutationActive: true };
    expect(confirmTargetBlockedReason(COMBINED_PLAN, dirtyPhases)).toContain('pending Phase changes');
    expect(confirmTargetBlockedReason(SKIPPED_PHASE_WITH_WORKFLOW, dirtyPhases)).toBeNull();

    // Dirty Workflows blocks both plans because both write a Workflow
    const dirtyWorkflows: ImportTargetGate = { ...OPEN_GATE, workflowMutationActive: true };
    expect(confirmTargetBlockedReason(COMBINED_PLAN, dirtyWorkflows)).toContain('pending Workflow changes');
    expect(confirmTargetBlockedReason(SKIPPED_PHASE_WITH_WORKFLOW, dirtyWorkflows)).toContain('pending Workflow changes');
  });
});
