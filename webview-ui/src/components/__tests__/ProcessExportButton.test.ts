// Feature 084 T026/T067 — the per-Phase Export control.
//
// `exportProcessYaml` is the single call site for the exchange family (FR-058),
// so stubbing it is stubbing the whole boundary. What matters here: the request
// names a resource and never a location (FR-019), a row that cannot produce a
// document is refused before the click with a stated reason (FR-015, FR-057),
// and the reason is addressable per row rather than per Phase id.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const exportSpy = vi.fn<(kind: string, resourceId: string) => void>();
vi.mock('../../lib/process-yaml-ipc', () => ({
  exportProcessYaml: (kind: string, resourceId: string) => exportSpy(kind, resourceId)
}));

// Late import so the component binds to the mocked call site above.
import ProcessExportButton from '../ProcessImport/ProcessExportButton.svelte';

beforeEach(() => exportSpy.mockReset());
afterEach(cleanup);

describe('Feature 084 T026 — exporting a Phase', () => {
  it('asks the host for the Phase by id, naming no location', async () => {
    const { getByTestId } = render(ProcessExportButton, { props: { phaseId: 'specify' } });
    await fireEvent.click(getByTestId('process-export-button'));

    // Two arguments, both identifiers: the host opens its own save dialog, so no
    // path crosses the boundary in either direction (FR-019, FR-020a).
    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(exportSpy).toHaveBeenCalledWith('phase', 'specify');
  });

  it('offers no reason when the row resolves', () => {
    const { container, getByTestId } = render(ProcessExportButton, {
      props: { phaseId: 'specify' }
    });
    expect((getByTestId('process-export-button') as HTMLButtonElement).disabled).toBe(false);
    expect(container.querySelector('[data-testid="process-export-disabled-reason"]')).toBeNull();
    expect(getByTestId('process-export-button').getAttribute('aria-describedby')).toBeNull();
  });

  it('refuses a row that carries no valid definition, and says why (FR-015, FR-057)', async () => {
    const { getByTestId } = render(ProcessExportButton, {
      props: { phaseId: 'broken', resolves: false, disabledReason: 'This Phase has errors.' }
    });

    expect((getByTestId('process-export-button') as HTMLButtonElement).disabled).toBe(true);
    expect(getByTestId('process-export-disabled-reason').textContent).toContain('errors');
    // Refused before the click rather than failing after it.
    await fireEvent.click(getByTestId('process-export-button'));
    expect(exportSpy).not.toHaveBeenCalled();
  });
});

describe('Feature 084 T067 — the control names itself and its reason', () => {
  it('names the row it belongs to, since "Export" repeats down the list', () => {
    const { getByTestId } = render(ProcessExportButton, { props: { phaseId: 'specify' } });
    expect(getByTestId('process-export-button').getAttribute('aria-label')).toBe('Export specify');
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
});
