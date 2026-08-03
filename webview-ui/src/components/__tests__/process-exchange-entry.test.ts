// Feature 084 T066 — the three decisions the Phase manager makes before it can
// offer the exchange controls (FR-052, FR-053, FR-057).
//
// Each has a wrong answer that would be invisible in markup: an Export control
// that fails after the click, an import started over an unsaved edit, and a
// target layer that silently rewrites a row the import never mentioned.

import { describe, expect, it } from 'vitest';
import type {
  PhaseCatalogSourceRecord,
  PipelineCatalogSourceRecord
} from '../../lib/snapshot-types';
import {
  importDisabledReason,
  phaseExportAvailability,
  storedWritableLayers
} from '../ProcessImport/process-exchange-entry';

function record(overrides: Partial<PhaseCatalogSourceRecord> = {}): PhaseCatalogSourceRecord {
  return {
    key: 'user:specify',
    phaseId: 'specify',
    scope: 'user',
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
    key: 'user:ship-it',
    pipelineId: 'ship-it',
    scope: 'user',
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

const EMPTY_LAYERS = { phases: [], pipelines: [] };

describe('Feature 084 — which rows can be exported (T066, FR-052, FR-015)', () => {
  it('offers an effective row', () => {
    const availability = phaseExportAvailability({ sourceStatus: 'effective', persisted: true });
    expect(availability).toEqual({ resolves: true, disabledReason: '' });
  });

  it('offers a shadowed row too — export is of the effective catalog (FR-014)', () => {
    // A shadowed row's id DOES resolve; it resolves to the layer that wins.
    // Disabling here would leave no way to obtain the definition that runs.
    const availability = phaseExportAvailability({ sourceStatus: 'shadowed', persisted: true });
    expect(availability.resolves).toBe(true);
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

describe('Feature 084/085 — the layers an import appends to (T066/T048, FR-037, FR-043)', () => {
  it('carries only the addressed scope into each layer', () => {
    const layers = storedWritableLayers([
      record({ key: 'user:a', phaseId: 'a', scope: 'user', display: { id: 'a', version: 1 } }),
      record({
        key: 'workspace:b',
        phaseId: 'b',
        scope: 'workspace',
        display: { id: 'b', version: 1 }
      })
    ]);
    expect(layers.user.phases.map((row) => row.id)).toEqual(['a']);
    expect(layers.workspace.phases.map((row) => row.id)).toEqual(['b']);
  });

  it('leaves out the built-in scope, which no save can write', () => {
    const layers = storedWritableLayers(
      [record({ key: 'built-in:specify', scope: 'built-in', display: { id: 'specify', version: 1 } })],
      [pipelineRecord({ key: 'built-in:ship-it', scope: 'built-in' })]
    );
    expect(layers).toEqual({ user: EMPTY_LAYERS, workspace: EMPTY_LAYERS });
  });

  it('carries rows of every status, in catalog order — the layer is the stored array', () => {
    // Dropping a shadowed or invalid row would delete it on the next save (FR-025).
    const layers = storedWritableLayers([
      record({ key: 'user:one', phaseId: 'one', status: 'shadowed', display: { id: 'one' } }),
      record({ key: 'user:two', phaseId: 'two', status: 'invalid', display: { id: 'two' } }),
      record({ key: 'user:three', phaseId: 'three', status: 'effective', display: { id: 'three' } })
    ]);
    expect(layers.user.phases.map((row) => row.id)).toEqual(['one', 'two', 'three']);
  });

  it('passes a broken row through as authored rather than repairing it', () => {
    // The load-bearing case. Rebuilding via `sourceRecordToMutable` would read a
    // missing `name` as 'Invalid Phase' and a missing `version` as 1, so an
    // import into this layer would quietly rewrite an unrelated broken row into
    // a valid-looking one. Passed through, the host's own phase-validation gate
    // still sees the same defect and refuses the save.
    const layers = storedWritableLayers([
      record({
        key: 'user:broken',
        phaseId: 'broken',
        status: 'invalid',
        definition: null,
        display: { id: 'broken', instruction: 'Half-written.' },
        errors: [{ field: 'name', code: 'missing', message: 'name is required' }]
      })
    ]);
    expect(layers.user.phases).toHaveLength(1);
    expect(layers.user.phases[0]).toEqual({ id: 'broken', instruction: 'Half-written.' });
    expect(layers.user.phases[0]).not.toHaveProperty('name');
    expect(layers.user.phases[0]).not.toHaveProperty('version');
  });

  it('keeps the identity key under the name the row authored', () => {
    // `display` is a projection of the raw stored row, and a row may spell its
    // identity `phaseId` rather than `id`. Renaming it here would make the save
    // read as a different Phase.
    const layers = storedWritableLayers([
      record({ key: 'user:aliased', display: { phaseId: 'aliased', name: 'Aliased', version: 3 } })
    ]);
    expect(layers.user.phases[0]).toEqual({ phaseId: 'aliased', name: 'Aliased', version: 3 });
  });

  it('copies each row rather than aliasing the projection', () => {
    const source = record({ display: { id: 'specify', version: 1 } });
    const pipelineSource = pipelineRecord();
    const layers = storedWritableLayers([source], [pipelineSource]);
    expect(layers.user.phases[0]).not.toBe(source.display);
    expect(layers.user.pipelines[0]).not.toBe(pipelineSource.display);
  });

  it('yields two empty pairs for an empty catalog', () => {
    expect(storedWritableLayers([], [])).toEqual({ user: EMPTY_LAYERS, workspace: EMPTY_LAYERS });
  });

  // Feature 085 T048 — the Pipeline half. A confirmed package writes both layers,
  // and each write sends its whole layer, so the Pipeline catalog has to be read
  // exactly as the Phase catalog is: stored rows, every status, per scope.
  it('carries the stored Pipeline rows of the addressed scope, every status, in order', () => {
    const layers = storedWritableLayers(
      [],
      [
        pipelineRecord({ key: 'user:one', pipelineId: 'one', status: 'shadowed', display: { id: 'one' } }),
        pipelineRecord({ key: 'user:two', pipelineId: 'two', status: 'invalid', display: { id: 'two' } }),
        pipelineRecord({
          key: 'workspace:three',
          pipelineId: 'three',
          scope: 'workspace',
          display: { id: 'three' }
        })
      ]
    );
    expect(layers.user.pipelines.map((row) => row.id)).toEqual(['one', 'two']);
    expect(layers.workspace.pipelines.map((row) => row.id)).toEqual(['three']);
  });

  it('passes a broken Pipeline row through as authored rather than repairing it', () => {
    const layers = storedWritableLayers(
      [],
      [
        pipelineRecord({
          key: 'user:broken',
          pipelineId: 'broken',
          status: 'invalid',
          definition: null,
          display: { id: 'broken', phases: ['specify'] },
          errors: [{ field: 'name', code: 'missing', message: 'name is required' }]
        })
      ]
    );
    expect(layers.user.pipelines[0]).toEqual({ id: 'broken', phases: ['specify'] });
    expect(layers.user.pipelines[0]).not.toHaveProperty('version');
  });

  it('keeps each catalog on its own side of the pair', () => {
    // The pair is what one commit consumes; crossing them would send Phases to
    // the Pipeline save and vice versa, and each host validator would refuse a
    // row the operator never authored.
    const layers = storedWritableLayers([record()], [pipelineRecord()]);
    expect(layers.user.phases.map((row) => row.id)).toEqual(['specify']);
    expect(layers.user.pipelines.map((row) => row.id)).toEqual(['ship-it']);
  });

  it('treats an absent Pipeline catalog as an empty Pipeline layer, not an absent pair', () => {
    // A host that has not sent the Pipeline projection yet must not make the
    // Phase half unavailable — the Phase-only import still has to work.
    const layers = storedWritableLayers([record()]);
    expect(layers.user.pipelines).toEqual([]);
    expect(layers.user.phases).toHaveLength(1);
  });
});
