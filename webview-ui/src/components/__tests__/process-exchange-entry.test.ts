// Feature 084 T066 — the three decisions the Phase manager makes before it can
// offer the exchange controls (FR-052, FR-053, FR-057).
//
// Each has a wrong answer that would be invisible in markup: an Export control
// that fails after the click, an import started over an unsaved edit, and a
// target layer that silently rewrites a row the import never mentioned.

import { describe, expect, it } from 'vitest';
import type {
  PhaseCatalogSourceRecord,
  PipelineCatalogSourceRecord,
  WorkflowCatalogSourceProjection
} from '../../lib/snapshot-types';
import {
  importDisabledReason,
  phaseExportAvailability,
  storedWritableLayers
} from '../ProcessImport/process-exchange-entry';

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

function pipelineRecord(
  overrides: Partial<PipelineCatalogSourceRecord> = {}
): PipelineCatalogSourceRecord {
  return {
    key: 'ship-it::0',
    pipelineId: 'ship-it',
    status: 'effective',
    definition: {
      pipelineId: 'ship-it',
      name: 'Ship It',
      version: 1,
      phaseIds: ['specify'],
      inputs: [],
      outputs: [],
      bindings: [],
      recommendedNext: []
    },
    display: { id: 'ship-it', name: 'Ship It', version: 1, phases: ['specify'] },
    errors: [],
    ...overrides
  };
}

/** Feature 086 T054 — a Workflow catalog record, the third stored catalog. */
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
      nodes: [{ nodeId: 'draft', pipelineId: 'ship-it' }],
      connections: [],
      startNodeIds: ['draft']
    },
    display: {
      workflowId: 'ship-it-flow',
      name: 'Ship It Flow',
      version: 1,
      nodes: [{ nodeId: 'draft', pipelineId: 'ship-it' }],
      connections: [],
      startNodeIds: ['draft']
    },
    errors: [],
    derivedInputs: [],
    derivedOutputs: [],
    ...overrides
  };
}

const EMPTY_LAYERS = { phases: [], pipelines: [], workflows: [] };

describe('Feature 084 — which rows can be exported (T066, FR-052, FR-015)', () => {
  it('offers an effective row', () => {
    const availability = phaseExportAvailability({ sourceStatus: 'effective', persisted: true });
    expect(availability).toEqual({ resolves: true, disabledReason: '' });
  });

  it('withholds Export for exactly two reasons and no third (FR-014)', () => {
    // Feature 099 (T496f, FR-040, FR-042) — a `shadowed` row was offered too,
    // because its id still resolved: it resolved to the layer that WON, and
    // disabling here would have left no way to obtain the definition that runs.
    // One layer shadows nothing and the status is gone from the union, so the
    // case survives as the shape of the rule rather than as a third status —
    // asked over the whole product of what a row can be, so a refusal added on
    // any other ground fails here.
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
    // `cmd-export-process-yaml` would answer `not-found`: no layer holds the id.
    const availability = phaseExportAvailability({ sourceStatus: 'effective', persisted: false });
    expect(availability.resolves).toBe(false);
    expect(availability.disabledReason).toBe('Save this Phase before exporting it.');
  });

  it('reports the draft, not the errors, when a draft is also invalid', () => {
    // A new row is invalid until it is filled in; "save it first" is the reason
    // the operator can act on, and the errors reason would be a dead end.
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
  const OPEN = { trusted: true, savePending: false, mutationActive: false };

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
    // The commit sends the whole PERSISTED layer, so an import started now would
    // ask the operator to confirm a write that excludes their pending edit.
    const reason = importDisabledReason({ ...OPEN, mutationActive: true });
    expect(reason).toContain('pending');
  });

  it('reports untrustedness first — it is the condition the operator cannot clear here', () => {
    const reason = importDisabledReason({
      trusted: false,
      savePending: true,
      mutationActive: true
    });
    expect(reason).toContain('not trusted');
  });
});

describe('Feature 084/085 — what an import appends to (T066/T048, FR-037, FR-043)', () => {
  it('carries every stored row into the one projection, in catalog order', () => {
    // Feature 099 (T496f, FR-042, FR-043) — two records at two scopes went to two
    // keyed projections, and this pinned that neither leaked into the other. One
    // catalog leaves one projection, and the inversion is the claim: both rows
    // have to arrive in it, because the commit REPLACES what it is handed and a
    // row missing from the projection is a row deleted by the import (FR-025).
    const layers = storedWritableLayers([
      record({ key: 'a::0', phaseId: 'a', display: { id: 'a', version: 1 } }),
      record({ key: 'b::0', phaseId: 'b', display: { id: 'b', version: 1 } })
    ]);
    expect(layers.phases.map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('leaves out no row, there being no unwritable tier to filter (T496f)', () => {
    // Feature 099 (T496f, FR-042, FR-043) — this seeded one `built-in` row per
    // kind and asserted all three projections came back empty, the read-only tier
    // being unwritable by any save. The tier is deleted and every stored row is
    // writable, so the same fixture must now come back whole.
    const layers = storedWritableLayers([record()], [pipelineRecord()], [workflowRecord()]);
    expect(layers.phases).toHaveLength(1);
    expect(layers.pipelines).toHaveLength(1);
    expect(layers.workflows).toHaveLength(1);
  });

  it('carries rows of every status, in catalog order — the layer is the stored array', () => {
    // Dropping an invalid row would delete it on the next save (FR-025).
    const layers = storedWritableLayers([
      record({ key: 'one::0', phaseId: 'one', status: 'invalid', display: { id: 'one' } }),
      record({ key: 'two::0', phaseId: 'two', status: 'effective', display: { id: 'two' } }),
      record({ key: 'three::0', phaseId: 'three', status: 'invalid', display: { id: 'three' } })
    ]);
    expect(layers.phases.map((row) => row.id)).toEqual(['one', 'two', 'three']);
  });

  it('passes a broken row through as authored rather than repairing it', () => {
    // The load-bearing case. Rebuilding via `sourceRecordToMutable` would read a
    // missing `name` as 'Invalid Phase' and a missing `version` as 1, so an
    // import into this layer would quietly rewrite an unrelated broken row into
    // a valid-looking one. Passed through, the host's own phase-validation gate
    // still sees the same defect and refuses the save.
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
    // `display` is a projection of the raw stored row, and a row may spell its
    // identity `phaseId` rather than `id`. Renaming it here would make the save
    // read as a different Phase.
    const layers = storedWritableLayers([
      record({ key: 'aliased::0', display: { phaseId: 'aliased', name: 'Aliased', version: 3 } })
    ]);
    expect(layers.phases[0]).toEqual({ phaseId: 'aliased', name: 'Aliased', version: 3 });
  });

  it('copies each row rather than aliasing the projection', () => {
    const source = record({ display: { id: 'specify', version: 1 } });
    const pipelineSource = pipelineRecord();
    const workflowSource = workflowRecord();
    const layers = storedWritableLayers([source], [pipelineSource], [workflowSource]);
    expect(layers.phases[0]).not.toBe(source.display);
    expect(layers.pipelines[0]).not.toBe(pipelineSource.display);
    expect(layers.workflows[0]).not.toBe(workflowSource.display);
  });

  // Feature 086 T054 — the Workflow layer, on the same terms as the other two.
  // The failure this guards is not a missing row but a deleted catalog: the
  // Workflow write sends its whole layer, so a projection that dropped the stored
  // rows would replace the catalog with whatever the document supplied.
  it('carries every stored Workflow row into the one projection', () => {
    const layers = storedWritableLayers(
      [],
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

  it('yields three empty layers when only the Phase catalog is supplied', () => {
    // The default arguments are what a caller that has not been updated passes.
    // They must still produce the third member, or `buildImportWrites` would read
    // `undefined` as the stored layer.
    expect(storedWritableLayers([])).toEqual(EMPTY_LAYERS);
  });

  it('yields three empty layers for an empty catalog', () => {
    expect(storedWritableLayers([], [], [])).toEqual(EMPTY_LAYERS);
  });

  // Feature 085 T048 — the Pipeline half. A confirmed package writes every layer,
  // and each write sends its whole layer, so the Pipeline catalog has to be read
  // exactly as the Phase catalog is: stored rows, every status, in catalog order.
  it('carries the stored Pipeline rows, every status, in order', () => {
    const layers = storedWritableLayers(
      [],
      [
        pipelineRecord({ key: 'one::0', pipelineId: 'one', status: 'invalid', display: { id: 'one' } }),
        pipelineRecord({ key: 'two::0', pipelineId: 'two', status: 'effective', display: { id: 'two' } }),
        pipelineRecord({ key: 'three::0', pipelineId: 'three', status: 'invalid', display: { id: 'three' } })
      ]
    );
    expect(layers.pipelines.map((row) => row.id)).toEqual(['one', 'two', 'three']);
  });

  it('passes a broken Pipeline row through as authored rather than repairing it', () => {
    const layers = storedWritableLayers(
      [],
      [
        pipelineRecord({
          key: 'broken::0',
          pipelineId: 'broken',
          status: 'invalid',
          definition: null,
          display: { id: 'broken', phases: ['specify'] },
          errors: [{ field: 'name', code: 'missing', message: 'name is required' }]
        })
      ]
    );
    expect(layers.pipelines[0]).toEqual({ id: 'broken', phases: ['specify'] });
    expect(layers.pipelines[0]).not.toHaveProperty('version');
  });

  it('keeps each catalog on its own side of the pair', () => {
    // The pair is what one commit consumes; crossing them would send Phases to
    // the Pipeline save and vice versa, and each host validator would refuse a
    // row the operator never authored.
    const layers = storedWritableLayers([record()], [pipelineRecord()]);
    expect(layers.phases.map((row) => row.id)).toEqual(['specify']);
    expect(layers.pipelines.map((row) => row.id)).toEqual(['ship-it']);
  });

  it('treats an absent Pipeline catalog as an empty Pipeline layer, not an absent pair', () => {
    // A host that has not sent the Pipeline projection yet must not make the
    // Phase half unavailable — the Phase-only import still has to work.
    const layers = storedWritableLayers([record()]);
    expect(layers.pipelines).toEqual([]);
    expect(layers.phases).toHaveLength(1);
  });
});
