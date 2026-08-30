// Feature 184 (FR-R3-141, T002/T004) — `appendPhaseId` on `PipelineCatalogStore`.
//
// The palette replaces a `<select>` + "Add Phase" button pair, and with it the
// pending value those two controls needed between them. `appendPhase()` read
// `newPhaseId`; `appendPhaseId(phaseId)` takes the id from the click, because on
// a palette the click *is* the commit and there is no pending state to hold.
//
// These are the store's only dedicated unit tests. Everything else about the
// store is driven through `PipelineBuilder.test.ts`, which mounts the component
// that owns it; that stays true. This file exists because the method being added
// has two guards whose failure mode is silent — appending to nothing, and
// appending an empty id — and a mounted-component test cannot reach either state
// through the UI, which only ever offers ids from the effective catalog while a
// row is open.

import { describe, expect, it, vi } from 'vitest';
import type { WorkflowSnapshot } from '../../lib/snapshot-types';
import { PipelineCatalogStore } from '../PipelineBuilderEditors/pipeline-catalog-store.svelte';
import type { MutablePipeline } from '../PipelineBuilderEditors/types';

const SNAPSHOT = {
  pipelineCatalog: { state: 'ready', records: [], effective: [], revisions: {}, warnings: [] }
} as unknown as WorkflowSnapshot;

function makeStore(): PipelineCatalogStore {
  return new PipelineCatalogStore({
    getSnapshot: () => SNAPSHOT,
    onSaveError: vi.fn(),
    onSaveAccepted: vi.fn()
  });
}

function row(overrides: Partial<MutablePipeline> = {}): MutablePipeline {
  return {
    id: 'custom-flow',
    name: 'Custom Flow',
    version: 1,
    phases: ['speckit-specify'],
    inputs: [],
    outputs: [],
    bindings: [],
    recommendedNext: [],
    sourceKey: 'custom-flow::0',
    sourceStatus: 'effective',
    sourceErrors: [],
    persisted: true,
    ...overrides
  } as MutablePipeline;
}

describe('PipelineCatalogStore.appendPhaseId (FR-030)', () => {
  it('appends the given Phase to the open row and records one history entry', () => {
    const store = makeStore();
    store.pipelines = [row()];
    store.selectedIndex = 0;
    store.recordHistory();
    const before = store.historyLength;

    store.appendPhaseId('done');

    expect(store.pipelines[0].phases).toEqual(['speckit-specify', 'done']);
    store.recordHistory();
    expect(store.historyLength).toBe(before + 1);
  });

  it('appends to the open row only, leaving every other row untouched', () => {
    const store = makeStore();
    store.pipelines = [row(), row({ id: 'other', sourceKey: 'other::1', phases: ['done'] })];
    store.selectedIndex = 1;

    store.appendPhaseId('speckit-specify');

    expect(store.pipelines[0].phases).toEqual(['speckit-specify']);
    expect(store.pipelines[1].phases).toEqual(['done', 'speckit-specify']);
  });

  it('is a no-op with no row open', () => {
    const store = makeStore();
    store.pipelines = [row()];
    store.selectedIndex = null;

    store.appendPhaseId('done');

    expect(store.pipelines[0].phases).toEqual(['speckit-specify']);
    expect(store.mutation).toBeNull();
  });

  it('is a no-op for an empty or whitespace id', () => {
    const store = makeStore();
    store.pipelines = [row()];
    store.selectedIndex = 0;

    store.appendPhaseId('');
    store.appendPhaseId('   ');

    expect(store.pipelines[0].phases).toEqual(['speckit-specify']);
    expect(store.mutation).toBeNull();
  });

  it('routes through update, so a persisted row declares an edit mutation', () => {
    const store = makeStore();
    store.pipelines = [row()];
    store.selectedIndex = 0;

    store.appendPhaseId('done');

    expect(store.mutation).toEqual({ kind: 'edit', pipelineId: 'custom-flow' });
    expect(store.mutationSourceKey).toBe('custom-flow::0');
  });
});
