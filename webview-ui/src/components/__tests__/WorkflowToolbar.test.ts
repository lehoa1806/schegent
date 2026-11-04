// Feature 086 T023 (FR-013, SC-002) — the export inclusion choice, one level up.
//
// The Pipeline equivalent is a checkbox, because a Pipeline has one level of
// dependency and so exactly two depths. A Workflow has two levels, so the choice
// is a select over an enumerated set rather than a boolean: "carry the Pipelines"
// and "carry the Pipelines and their Phases" are different answers, and neither
// is the negation of the other.
//
// Mounted directly rather than through `WorkflowCatalogEditor`, as
// `WorkflowGraphEditor.test.ts` does: the export rule lives in this component
// (T017 put it here deliberately, since its inputs are the selection itself), so
// this is the surface that owns the behaviour being asserted.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutableWorkflow } from '../PipelineBuilderEditors/types';
import WorkflowToolbar from '../PipelineBuilderEditors/WorkflowToolbar.svelte';

const exportSpy = vi.fn(() => ({ status: 'accepted' as const }));

vi.mock('../../lib/process-yaml-ipc', () => ({
  exportWorkflowYaml: (...args: unknown[]) => exportSpy(...(args as [])),
  preflightProcessYaml: vi.fn()
}));

beforeEach(() => exportSpy.mockClear());
afterEach(cleanup);

function row(overrides: Partial<MutableWorkflow> = {}): MutableWorkflow {
  return {
    workflowId: 'design-then-build',
    name: 'Design then Build',
    version: 1,
    nodes: [{ nodeId: 'design', kind: 'phase', phaseId: 'design-review' }],
    connections: [],
    startNodeIds: ['design'],
    sourceKey: 'design-then-build::0',
    sourceStatus: 'effective',
    sourceErrors: [],
    persisted: true,
    derivedInputs: [],
    derivedOutputs: [],
    ...overrides
  } as MutableWorkflow;
}

const mount = (selected: MutableWorkflow | null) =>
  render(WorkflowToolbar, {
    savePending: false,
    mutatingDisabled: false,
    noPipelines: false,
    duplicateDisabled: false,
    removeDisabled: false,
    saveDisabled: false,
    selected,
    onadd: () => {},
    onduplicate: () => {},
    onremove: () => {},
    onsave: () => {}
  });

describe('WorkflowToolbar export inclusion (T023, FR-013)', () => {
  it('defaults to the smallest document (FR-013)', () => {
    const { getByTestId } = mount(row());
    const select = getByTestId('workflows-export-inclusion') as HTMLSelectElement;

    expect(select.value).toBe('references-only');
    expect(select.disabled).toBe(false);
  });

  it('sends the reference package by default, carrying no dependency payload', async () => {
    const { getByTestId } = mount(row());
    await fireEvent.click(getByTestId('workflows-export'));

    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(exportSpy).toHaveBeenCalledWith('design-then-build', 'references-only');
  });

  it('sends the operator-chosen depth and nothing else about the request changes', async () => {
    const { getByTestId } = mount(row());
    const select = getByTestId('workflows-export-inclusion') as HTMLSelectElement;

    await fireEvent.change(select, { target: { value: 'include-closure' } });
    await fireEvent.click(getByTestId('workflows-export'));

    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(exportSpy).toHaveBeenCalledWith('design-then-build', 'include-closure');
  });

  it('returns to the reference package when the choice is taken back', async () => {
    const { getByTestId } = mount(row());
    const select = getByTestId('workflows-export-inclusion') as HTMLSelectElement;

    await fireEvent.change(select, { target: { value: 'include-closure' } });
    await fireEvent.change(select, { target: { value: 'references-only' } });
    await fireEvent.click(getByTestId('workflows-export'));

    expect(exportSpy).toHaveBeenCalledWith('design-then-build', 'references-only');
  });

  it('offers only the depths the host can actually produce', () => {
    const { getByTestId } = mount(row());
    const values = Array.from(
      (getByTestId('workflows-export-inclusion') as HTMLSelectElement).options
    ).map((option) => option.value);

    expect(values).toEqual(['references-only', 'include-closure']);
  });

  it('stays available for a Workflow whose dependencies do not resolve (FR-016, FR-018)', async () => {
    const unresolved = row({
      sourceStatus: 'invalid',
      sourceErrors: [
        { field: 'nodes', code: 'unknown-phase', message: 'design-review is not defined.' }
      ] as MutableWorkflow['sourceErrors']
    });
    const { getByTestId } = mount(unresolved);

    expect((getByTestId('workflows-export-inclusion') as HTMLSelectElement).disabled).toBe(false);
    await fireEvent.change(getByTestId('workflows-export-inclusion'), {
      target: { value: 'include-closure' }
    });
    await fireEvent.click(getByTestId('workflows-export'));

    expect(exportSpy).toHaveBeenCalledWith('design-then-build', 'include-closure');
  });

  it('offers no choice on an unsaved draft, because there is nothing to export', () => {
    const { getByTestId } = mount(row({ persisted: false }));

    expect((getByTestId('workflows-export-inclusion') as HTMLSelectElement).disabled).toBe(true);
    expect((getByTestId('workflows-export') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers no choice when nothing is selected', () => {
    const { getByTestId } = mount(null);

    expect((getByTestId('workflows-export-inclusion') as HTMLSelectElement).disabled).toBe(true);
  });

  it('keeps the choice across a change of selection, because it describes the handover', async () => {
    const { getByTestId, rerender } = mount(row());
    await fireEvent.change(getByTestId('workflows-export-inclusion'), {
      target: { value: 'include-closure' }
    });

    await rerender({ selected: row({ workflowId: 'other-flow', sourceKey: 'workspace::other::1' }) });
    await fireEvent.click(getByTestId('workflows-export'));

    expect(exportSpy).toHaveBeenCalledWith('other-flow', 'include-closure');
  });
});
