// Feature 084 T026/T067 — the per-Phase Export control.
//
// `exportPhaseYaml` is the single call site for the exchange family (FR-058),
// so stubbing it is stubbing the whole boundary. What matters here: the request
// names a resource and never a location (FR-019), a row that cannot produce a
// document is refused before the click with a stated reason (FR-015, FR-057),
// and the reason is addressable per row rather than per Phase id. The control
// is an item of the Phase editor's "More phase actions" menu, so whether it is
// off is read through `isMenuItemOff`, never `.disabled`.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isMenuItemOff } from '../sg/__tests__/menu-item-state';

const exportSpy = vi.fn<(resourceId: string) => void>();
vi.mock('../../lib/process-yaml-ipc', () => ({
  exportPhaseYaml: (resourceId: string) => exportSpy(resourceId)
}));

// Late import so the component binds to the mocked call site above.
import ProcessExportButton from '../ProcessImport/ProcessExportButton.svelte';

beforeEach(() => exportSpy.mockReset());
afterEach(cleanup);

describe('Feature 084 T026 — exporting a Phase', () => {
  it('asks the host for the Phase by id, naming no location', async () => {
    const { getByTestId } = render(ProcessExportButton, { props: { phaseId: 'specify' } });
    await fireEvent.click(getByTestId('process-export-button'));

    // One argument, an identifier: the host opens its own save dialog, so no
    // path crosses the boundary in either direction (FR-019, FR-020a). The kind
    // is the helper's, not this control's — feature 085 split the single
    // `exportProcessYaml` into one helper per resource kind so the request shape
    // each kind carries is declared once, at the boundary.
    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(exportSpy).toHaveBeenCalledWith('specify');
  });

  it('offers no reason when the row resolves', () => {
    const { container, getByTestId } = render(ProcessExportButton, {
      props: { phaseId: 'specify' }
    });
    expect(isMenuItemOff(getByTestId('process-export-button'))).toBe(false);
    expect(container.querySelector('[data-testid="process-export-disabled-reason"]')).toBeNull();
    expect(getByTestId('process-export-button').getAttribute('aria-describedby')).toBeNull();
  });

  it('refuses a row that carries no valid definition, and says why (FR-015, FR-057)', async () => {
    const { getByTestId } = render(ProcessExportButton, {
      props: { phaseId: 'broken', resolves: false, disabledReason: 'This Phase has errors.' }
    });

    expect(isMenuItemOff(getByTestId('process-export-button'))).toBe(true);
    expect(getByTestId('process-export-disabled-reason').textContent).toContain('errors');
    // Refused before the click rather than failing after it.
    await fireEvent.click(getByTestId('process-export-button'));
    expect(exportSpy).not.toHaveBeenCalled();
  });
});

describe('Feature 084 T067 — the control names itself and its reason', () => {
  it('names the row it belongs to, since "Export YAML" repeats down the list', () => {
    const { getByTestId } = render(ProcessExportButton, { props: { phaseId: 'specify' } });
    expect(getByTestId('process-export-button').getAttribute('aria-label')).toBe(
      'Export YAML for specify'
    );
  });

  it('points its description at the reason it rendered', () => {
    const { getByTestId } = render(ProcessExportButton, {
      props: { phaseId: 'broken', resolves: false, rowKey: 'user:broken' }
    });
    const describedBy = getByTestId('process-export-button').getAttribute('aria-describedby');
    expect(describedBy).toBe('process-export-reason-user:broken');
    expect(getByTestId('process-export-disabled-reason').id).toBe(describedBy);
  });

  it('keeps the reason ids distinct when one Phase id appears in both layers', () => {
    // The same id in the user and workspace layers is the ordinary shadowing case.
    // Keyed on the Phase id alone, both rows would emit the same element id and
    // both descriptions would resolve to whichever rendered first.
    const first = render(ProcessExportButton, {
      props: { phaseId: 'specify', resolves: false, rowKey: 'user:specify' }
    });
    const second = render(ProcessExportButton, {
      props: { phaseId: 'specify', resolves: false, rowKey: 'workspace:specify' }
    });

    // Scoped to each render's own container: both are mounted in one document,
    // which is the situation the keying has to survive.
    const reasonOf = (rendered: { container: HTMLElement }): HTMLElement =>
      rendered.container.querySelector('[data-testid="process-export-disabled-reason"]')!;
    const firstId = reasonOf(first).id;
    const secondId = reasonOf(second).id;
    expect(firstId).not.toBe(secondId);
    // An attribute selector, not `#id`: the key contains a colon, which a bare
    // id selector would read as a pseudo-class.
    expect(document.querySelectorAll(`[id="${firstId}"]`)).toHaveLength(1);
    expect(document.querySelectorAll(`[id="${secondId}"]`)).toHaveLength(1);
  });

  it('sanitizes whitespace in rowKey so aria-describedby stays a single valid IDREF', () => {
    const { getByTestId } = render(ProcessExportButton, {
      props: { phaseId: 'bad', resolves: false, rowKey: 'draft::has spaces' }
    });
    const describedBy = getByTestId('process-export-button').getAttribute('aria-describedby') ?? '';
    expect(describedBy).not.toMatch(/\s/);
    expect(getByTestId('process-export-disabled-reason').id).toBe(describedBy);
  });
});

describe('the control as an item of a menu', () => {
  // The Phase editor offers Export from its "More phase actions" menu, so the
  // control renders as one of the menu's items rather than as a button of its own.
  it('is a menu item that asks the host for the Phase', async () => {
    const { getByTestId } = render(ProcessExportButton, {
      props: { phaseId: 'specify' }
    });
    const item = getByTestId('process-export-button');
    expect(item.getAttribute('role')).toBe('menuitem');
    expect(item.textContent.trim()).toBe('Export YAML…');
    expect(item.getAttribute('aria-label')).toBe('Export YAML for specify');
    expect(item.querySelector('use')?.getAttribute('href')).toBe('#i-export');

    await fireEvent.click(item);
    expect(exportSpy).toHaveBeenCalledWith('specify');
  });

  it('says why inside the item, so a closed menu leaves no reason behind', async () => {
    const { container, getByTestId } = render(ProcessExportButton, {
      props: { phaseId: 'broken', resolves: false, rowKey: 'user:broken' }
    });
    const item = getByTestId('process-export-button');
    const reason = getByTestId('process-export-disabled-reason');

    // Off, and still in reach of the arrow keys, so the reason inside it can be
    // read (decision 5 of the port review, 2026-11-14).
    expect(isMenuItemOff(item)).toBe(true);
    expect(item.contains(reason)).toBe(true);
    expect(item.getAttribute('aria-describedby')).toBe(reason.id);
    // No wrapper either: a menu's children are its items and its separators.
    expect(container.firstElementChild).toBe(item);

    // The menu refuses the click first; the item refuses it on its own as well.
    await fireEvent.click(item);
    expect(exportSpy).not.toHaveBeenCalled();
  });
});
