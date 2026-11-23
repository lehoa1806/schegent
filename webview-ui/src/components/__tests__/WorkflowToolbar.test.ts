// Feature 086 T023 (FR-013, SC-002) & Feature 326 — WorkflowToolbar overflow
// menu and shared WorkflowExportDialog inclusion choice.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutableWorkflow } from '../PipelineBuilderEditors/types';
import WorkflowToolbar from '../PipelineBuilderEditors/WorkflowToolbar.svelte';
import { isMenuItemOff } from '../sg/__tests__/menu-item-state';

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
    onduplicate: () => {},
    onremove: () => {},
    onsave: () => {}
  });

async function openExportModal(getByTestId: (id: string) => HTMLElement): Promise<void> {
  await fireEvent.click(getByTestId('workflows-export-open'));
}

describe('WorkflowToolbar export inclusion (T023, FR-013 / Feature 326)', () => {
  it('defaults to the smallest document (FR-013) inside the modal dialog', async () => {
    const { getByTestId } = mount(row());
    await openExportModal(getByTestId);
    const dialog = getByTestId('workflows-export-panel');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    const select = getByTestId('workflows-export-inclusion') as HTMLSelectElement;
    expect(select.value).toBe('references-only');
    expect(select.disabled).toBe(false);
  });

  it('sends the reference package by default, carrying no dependency payload', async () => {
    const { getByTestId } = mount(row());
    await openExportModal(getByTestId);
    await fireEvent.click(getByTestId('workflows-export'));

    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(exportSpy).toHaveBeenCalledWith('design-then-build', 'references-only');
  });

  it('sends the operator-chosen depth and nothing else about the request changes', async () => {
    const { getByTestId } = mount(row());
    await openExportModal(getByTestId);
    const select = getByTestId('workflows-export-inclusion') as HTMLSelectElement;

    await fireEvent.change(select, { target: { value: 'include-closure' } });
    await fireEvent.click(getByTestId('workflows-export'));

    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(exportSpy).toHaveBeenCalledWith('design-then-build', 'include-closure');
  });

  it('returns to the reference package when the choice is taken back', async () => {
    const { getByTestId } = mount(row());
    await openExportModal(getByTestId);
    const select = getByTestId('workflows-export-inclusion') as HTMLSelectElement;

    await fireEvent.change(select, { target: { value: 'include-closure' } });
    await fireEvent.change(select, { target: { value: 'references-only' } });
    await fireEvent.click(getByTestId('workflows-export'));

    expect(exportSpy).toHaveBeenCalledWith('design-then-build', 'references-only');
  });

  it('offers only the depths the host can actually produce', async () => {
    const { getByTestId } = mount(row());
    await openExportModal(getByTestId);
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
    await openExportModal(getByTestId);

    expect((getByTestId('workflows-export-inclusion') as HTMLSelectElement).disabled).toBe(false);
    await fireEvent.change(getByTestId('workflows-export-inclusion'), {
      target: { value: 'include-closure' }
    });
    await fireEvent.click(getByTestId('workflows-export'));

    expect(exportSpy).toHaveBeenCalledWith('design-then-build', 'include-closure');
  });

  it('disables Export YAML… with an accessible reason on an unsaved draft and never opens the modal', async () => {
    const { getByTestId, queryByTestId } = mount(row({ persisted: false }));
    const item = getByTestId('workflows-export-open');
    expect(isMenuItemOff(item)).toBe(true);
    expect(getByTestId('workflows-export-disabled-reason').textContent).toMatch(/Save this Workflow first/i);

    await fireEvent.click(item);
    expect(queryByTestId('workflows-export-panel')).toBeNull();
    expect(exportSpy).not.toHaveBeenCalled();
  });

  it('disables Export YAML… when nothing is selected', async () => {
    const { getByTestId, queryByTestId } = mount(null);
    const item = getByTestId('workflows-export-open');
    expect(isMenuItemOff(item)).toBe(true);
    await fireEvent.click(item);
    expect(queryByTestId('workflows-export-panel')).toBeNull();
  });

  it('keeps the choice across a change of selection, because it describes the handover', async () => {
    const { getByTestId, rerender } = mount(row());
    await openExportModal(getByTestId);
    await fireEvent.change(getByTestId('workflows-export-inclusion'), {
      target: { value: 'include-closure' }
    });
    await fireEvent.click(getByTestId('workflows-export-cancel'));

    await rerender({ selected: row({ workflowId: 'other-flow', sourceKey: 'workspace::other::1' }) });
    await openExportModal(getByTestId);
    await fireEvent.click(getByTestId('workflows-export'));

    expect(exportSpy).toHaveBeenCalledWith('other-flow', 'include-closure');
  });

  it('dismisses the export modal on Escape and Cancel without dispatching export', async () => {
    const { getByTestId, queryByTestId } = mount(row());
    await openExportModal(getByTestId);
    expect(queryByTestId('workflows-export-panel')).not.toBeNull();

    await fireEvent.keyDown(getByTestId('workflows-export-inclusion'), { key: 'Escape' });
    expect(queryByTestId('workflows-export-panel')).toBeNull();
    expect(exportSpy).not.toHaveBeenCalled();

    await openExportModal(getByTestId);
    await fireEvent.click(getByTestId('workflows-export-cancel'));
    expect(queryByTestId('workflows-export-panel')).toBeNull();
    expect(exportSpy).not.toHaveBeenCalled();
  });

  it('orders Duplicate, Export YAML…, Revert unsaved changes, <hr />, Deactivate… (without New workflow)', () => {
    const { container } = render(WorkflowToolbar, {
      savePending: false,
      mutatingDisabled: false,
      noPipelines: false,
      duplicateDisabled: false,
      removeDisabled: false,
      saveDisabled: false,
      canReset: true,
      selected: row(),
      onduplicate: () => {},
      onremove: () => {},
      onsave: () => {},
      onreset: () => {}
    });
    const menu = container.querySelector('[role="menu"]') as HTMLElement | null;
    expect(menu).not.toBeNull();
    const entries = [...menu!.children].map((el) =>
      el.tagName === 'HR' ? 'hr' : el.getAttribute('data-testid')
    );
    expect(entries).toEqual([
      'workflows-duplicate',
      'workflows-export-open',
      'workflows-discard',
      'hr',
      'workflows-remove'
    ]);
    const exportItem = menu!.querySelector('[data-testid="workflows-export-open"]');
    expect(exportItem?.querySelector('use')?.getAttribute('href')).toBe('#i-export');
    expect(exportItem?.textContent.trim()).toBe('Export YAML…');
    const deactivate = menu!.querySelector('[data-testid="workflows-remove"]');
    expect(deactivate?.classList.contains('danger')).toBe(true);
    expect(deactivate?.querySelector('use')?.getAttribute('href')).toBe('#i-trash');
    expect(deactivate?.textContent.trim()).toBe('Deactivate…');
  });

  it('closes WorkflowExportDialog on Escape even from document.body without leaking to document listeners, and wraps Tab', async () => {
    const parentEscape = vi.fn();
    const onDocKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) parentEscape();
    };
    document.addEventListener('keydown', onDocKeydown);
    try {
      const { getByTestId, queryByTestId } = render(WorkflowToolbar, {
        savePending: false,
        mutatingDisabled: false,
        noPipelines: false,
        duplicateDisabled: false,
        removeDisabled: false,
        saveDisabled: false,
        selected: row(),
        onduplicate: () => {},
        onremove: () => {},
        onsave: () => {}
      });

      await fireEvent.click(getByTestId('workflows-export-open'));
      expect(getByTestId('workflows-export-panel')).not.toBeNull();

      // Tab wraps from Export button back to select
      const confirmBtn = getByTestId('workflows-export') as HTMLButtonElement;
      const selectEl = getByTestId('workflows-export-inclusion') as HTMLSelectElement;
      confirmBtn.focus();
      await fireEvent.keyDown(confirmBtn, { key: 'Tab' });
      expect(document.activeElement).toBe(selectEl);

      // Escape from document.body closes dialog and stops propagation before document listener
      document.body.focus();
      await fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(queryByTestId('workflows-export-panel')).toBeNull();
      expect(parentEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onDocKeydown);
    }
  });
});

describe('WorkflowToolbar Save focus preservation (W02, FR-002)', () => {
  const renderSave = (
    overrides: Partial<{ saveDisabled: boolean; savePending: boolean; onsave: () => void }> = {}
  ) =>
    render(WorkflowToolbar, {
      savePending: false,
      mutatingDisabled: false,
      noPipelines: false,
      duplicateDisabled: false,
      removeDisabled: false,
      saveDisabled: true,
      selected: row(),
      onduplicate: () => {},
      onremove: () => {},
      onsave: () => {},
      ...overrides
    });

  it('uses aria-disabled instead of native disabled on workflows-save-all across state transitions', async () => {
    const { getByTestId, rerender } = renderSave({ saveDisabled: true, savePending: false });
    const saveBtn = getByTestId('workflows-save-all') as HTMLButtonElement;

    expect(saveBtn.hasAttribute('disabled')).toBe(false);
    expect(saveBtn.getAttribute('aria-disabled')).toBe('true');
    expect(saveBtn.textContent.trim()).toBe('Save');

    await rerender({ saveDisabled: false, savePending: false });
    expect(saveBtn.hasAttribute('disabled')).toBe(false);
    expect(saveBtn.getAttribute('aria-disabled')).toBe('false');

    await rerender({ saveDisabled: true, savePending: true });
    expect(saveBtn.hasAttribute('disabled')).toBe(false);
    expect(saveBtn.getAttribute('aria-disabled')).toBe('true');
    expect(saveBtn.textContent.trim()).toBe('Saving…');
  });

  it('keeps keyboard focus on Save when saveDisabled flips true and ignores activations while off', async () => {
    const onsave = vi.fn();
    const { getByTestId, rerender } = renderSave({
      saveDisabled: false,
      savePending: false,
      onsave
    });
    const saveBtn = getByTestId('workflows-save-all') as HTMLButtonElement;

    saveBtn.focus();
    expect(document.activeElement).toBe(saveBtn);

    await fireEvent.keyDown(saveBtn, { key: 'Enter' });
    await fireEvent.click(saveBtn);
    expect(onsave).toHaveBeenCalledTimes(1);

    await rerender({ saveDisabled: true, savePending: true });
    expect(document.activeElement).toBe(saveBtn);
    expect(saveBtn.hasAttribute('disabled')).toBe(false);
    expect(saveBtn.getAttribute('aria-disabled')).toBe('true');

    await fireEvent.keyDown(saveBtn, { key: ' ' });
    await fireEvent.click(saveBtn);
    expect(onsave).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(saveBtn);

    await rerender({ saveDisabled: true, savePending: false });
    expect(document.activeElement).toBe(saveBtn);
    await fireEvent.click(saveBtn);
    expect(onsave).toHaveBeenCalledTimes(1);

    await rerender({ saveDisabled: false, savePending: false });
    expect(saveBtn.getAttribute('aria-disabled')).toBe('false');
    await fireEvent.click(saveBtn);
    expect(onsave).toHaveBeenCalledTimes(2);
  });
});
