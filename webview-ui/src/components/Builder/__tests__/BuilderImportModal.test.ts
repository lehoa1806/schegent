// Feature 326 — BuilderImportModal dialog semantics, focus trap, Escape/backdrop
// dismissal (suppressed while committing), clean cancel close, and focus restoration.
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportPlan, PreflightProcessYamlResult } from '../../../lib/messages';
import type { SaveModelsImportResult } from '../../../lib/save-models';
import type { ImportTargetGate } from '../../ProcessImport/process-import-state';

const preflightSpy = vi.fn<() => Promise<PreflightProcessYamlResult>>();
vi.mock('../../../lib/process-yaml-ipc', () => ({
  preflightProcessYaml: () => preflightSpy()
}));

const saveModelsImportSpy = vi.fn<() => Promise<SaveModelsImportResult>>();
vi.mock('../../../lib/save-models', () => ({
  saveModelsImport: () => saveModelsImportSpy()
}));

vi.mock('../../../lib/catalog-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/catalog-lifecycle')>()),
  publishDefinitionPackage: vi.fn(async () => ({ status: 'accepted' as const }))
}));

import BuilderImportModal from '../BuilderImportModal.svelte';

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

const MODEL_PLAN: ImportPlan = {
  rows: [
    {
      outcome: 'import',
      resourceKind: 'modelCatalog',
      resourceId: 'claude-new',
      backend: 'claude',
      modelId: 'claude-new'
    }
  ],
  counts: { import: 1, skip: 0, blocked: 0, invalid: 0 },
  computedAgainstRevision: 'rev-1',
  computedAgainstModelsRevision: 'm-rev-1'
};

beforeEach(() => {
  preflightSpy.mockReset();
  saveModelsImportSpy.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('BuilderImportModal (Feature 326)', () => {
  it('renders an accessible modal dialog and restores focus to originatingElement on unmount', async () => {
    preflightSpy.mockResolvedValueOnce({ outcome: 'planned', plan: MODEL_PLAN });
    const trigger = document.createElement('button');
    document.body.append(trigger);
    const onclose = vi.fn();

    const { getByTestId, unmount } = render(BuilderImportModal, {
      props: {
        originatingElement: trigger,
        targetGate: OPEN_GATE,
        autoInspect: true,
        onclose
      }
    });
    await tick();
    await tick();

    const dialog = getByTestId('builder-import-modal');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('process-import-title');

    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('closes on Escape and backdrop click when idle, and wraps Tab focus inside the dialog', async () => {
    preflightSpy.mockResolvedValueOnce({ outcome: 'planned', plan: MODEL_PLAN });
    const onclose = vi.fn();
    const { getByTestId } = render(BuilderImportModal, {
      props: {
        originatingElement: null,
        targetGate: OPEN_GATE,
        autoInspect: true,
        onclose
      }
    });
    await tick();
    await tick();

    const dialog = getByTestId('builder-import-modal');
    const focusables = [
      ...dialog.querySelectorAll<HTMLElement>('button:not(:disabled)')
    ];
    expect(focusables.length).toBeGreaterThanOrEqual(2);

    // Tab wraps from last button to first button
    focusables[focusables.length - 1]!.focus();
    await fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(focusables[0]);

    // Shift+Tab wraps from first button to last button
    await fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);

    // Escape closes
    await fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onclose).toHaveBeenCalledTimes(1);

    // Backdrop click closes
    await fireEvent.click(getByTestId('builder-import-backdrop'));
    expect(onclose).toHaveBeenCalledTimes(2);
  });

  it('suppresses Escape and backdrop close while a commit is in flight', async () => {
    preflightSpy.mockResolvedValueOnce({ outcome: 'planned', plan: MODEL_PLAN });
    let resolveCommit!: (result: SaveModelsImportResult) => void;
    saveModelsImportSpy.mockImplementationOnce(
      () => new Promise((resolve) => { resolveCommit = resolve; })
    );
    const onclose = vi.fn();

    const { getByTestId } = render(BuilderImportModal, {
      props: {
        originatingElement: null,
        targetGate: OPEN_GATE,
        autoInspect: true,
        onclose
      }
    });
    await tick();
    await tick();

    await fireEvent.click(getByTestId('process-import-confirm'));
    await tick();

    // Even when focus leaves the disabled buttons to document.body, Escape & Tab stay trapped.
    document.body.focus();
    await fireEvent.keyDown(document.body, { key: 'Escape' });
    await fireEvent.click(getByTestId('builder-import-backdrop'));
    expect(onclose).not.toHaveBeenCalled();

    resolveCommit({ status: 'accepted' });
    await tick();
    await tick();

    // After commit completes and unmounts Confirm import, focus moves to the Close button.
    expect(document.activeElement).toBe(getByTestId('builder-import-close'));

    // Even if focus drops to document.body, Escape still closes the modal.
    document.body.focus();
    await fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('falls back to focusing builder-import-btn when originatingElement detached on close', async () => {
    preflightSpy.mockResolvedValueOnce({ outcome: 'planned', plan: MODEL_PLAN });
    const headerImport = document.createElement('button');
    headerImport.setAttribute('data-testid', 'builder-import-btn');
    const emptyTrigger = document.createElement('button');
    document.body.append(headerImport, emptyTrigger);

    const { unmount } = render(BuilderImportModal, {
      props: {
        originatingElement: emptyTrigger,
        targetGate: OPEN_GATE,
        autoInspect: true,
        onclose: vi.fn()
      }
    });
    await tick();
    await tick();

    // Simulate CatalogEmptyState unmounting after successful import
    emptyTrigger.remove();
    unmount();
    expect(document.activeElement).toBe(headerImport);
    headerImport.remove();
  });

  it('auto-closes cleanly when OS file picker cancels before any plan is loaded', async () => {
    preflightSpy.mockResolvedValueOnce({ outcome: 'canceled' });
    const onclose = vi.fn();

    render(BuilderImportModal, {
      props: {
        originatingElement: null,
        targetGate: OPEN_GATE,
        autoInspect: true,
        onclose
      }
    });
    await tick();
    await tick();

    expect(onclose).toHaveBeenCalledTimes(1);
  });
});

