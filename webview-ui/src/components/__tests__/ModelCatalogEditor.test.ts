import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';

// Feature 096 T017 — mirrors `PipelineCatalogEditor.test.ts`'s mock of the
// shared exchange helper: the spy has to be declared before the mock factory
// closes over it, and the factory runs before the component import below.
const exportSpy = vi.fn<() => void>();
vi.mock('../../lib/process-yaml-ipc', () => ({
  exportModelCatalogYaml: () => exportSpy()
}));

import ModelCatalogEditor from '../PipelineBuilderEditors/ModelCatalogEditor.svelte';

const baseProps = {
  availableModels: { claude: ['claude-sonnet'] },
  models: { claude: ['claude-sonnet'] },
  newModelInput: { claude: '' },
  onnewmodelinput: vi.fn(),
  onmodelchange: vi.fn(),
  onadd: vi.fn(),
  onremove: vi.fn(),
  onsave: vi.fn()
};

beforeEach(() => exportSpy.mockReset());
afterEach(() => cleanup());

describe('ModelCatalogEditor accessibility', () => {
  it('gives new and existing model inputs explicit accessible names', () => {
    const { container } = render(ModelCatalogEditor, { props: baseProps });

    const inputs = Array.from(container.querySelectorAll('input'));
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.getAttribute('aria-label')).toBe('New claude model name');
    expect(inputs[1]?.getAttribute('aria-label')).toBe('claude model 1');
    expect(container.querySelector('.btn-destructive')?.getAttribute('aria-label'))
      .toBe('Remove claude model claude-sonnet');
  });
});

describe('ModelCatalogEditor export (feature 096 T017)', () => {
  it('asks the host to export the Model Catalog, with no resourceId or location', async () => {
    const { getByText } = render(ModelCatalogEditor, { props: baseProps });

    await fireEvent.click(getByText('Export Model Catalog'));

    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(exportSpy).toHaveBeenCalledWith();
  });

  it('does not call export when Save All Models is clicked', async () => {
    const { getByText } = render(ModelCatalogEditor, { props: baseProps });

    await fireEvent.click(getByText('Save All Models'));

    expect(baseProps.onsave).toHaveBeenCalledTimes(1);
    expect(exportSpy).not.toHaveBeenCalled();
  });
});

// Feature 096 T027 — regression coverage for pre-existing per-backend
// grouping and removal (research.md Decision 9: no source change expected,
// confirmed by T028 via these tests passing unmodified).
describe('ModelCatalogEditor regression — per-backend grouping and removal (feature 096 T027)', () => {
  const twoBackendProps = {
    ...baseProps,
    availableModels: { claude: ['claude-sonnet'], codex: ['codex-mini'] },
    models: { claude: ['claude-model-a', 'claude-model-b'], codex: ['codex-model-a'] },
    newModelInput: { claude: '', codex: '' }
  };

  it('groups models under 2+ backends independently, with no cross-backend leakage', () => {
    const { container } = render(ModelCatalogEditor, { props: twoBackendProps });

    const sections = Array.from(container.querySelectorAll('.backend-section'));
    expect(sections).toHaveLength(2);

    const valuesIn = (section: Element) =>
      Array.from(section.querySelectorAll('.model-list-item input')).map(
        (input) => (input as HTMLInputElement).value
      );

    // `text-transform: capitalize` is a display style — `textContent` still
    // carries the raw (lowercase) backend key from `availableModels`.
    const claudeSection = sections.find((section) => section.textContent?.includes('claude Models'));
    const codexSection = sections.find((section) => section.textContent?.includes('codex Models'));

    expect(claudeSection && valuesIn(claudeSection)).toEqual(['claude-model-a', 'claude-model-b']);
    expect(codexSection && valuesIn(codexSection)).toEqual(['codex-model-a']);
  });

  it('removing a model reports its own backend and index, never the other backend', async () => {
    const onremove = vi.fn();
    const { getByLabelText } = render(ModelCatalogEditor, {
      props: { ...twoBackendProps, onremove }
    });

    await fireEvent.click(getByLabelText('Remove codex model codex-model-a'));

    expect(onremove).toHaveBeenCalledTimes(1);
    expect(onremove).toHaveBeenCalledWith('codex', 0);
  });

  it('a removal reflected in props updates only its own backend, leaving the other intact for the next save/export', () => {
    const { container, rerender } = render(ModelCatalogEditor, { props: twoBackendProps });

    // The component holds no state of its own — the parent applies the
    // removal and passes down the new `models`, exactly as `onremove`'s
    // (backend, index) pair would drive it.
    rerender({
      ...twoBackendProps,
      models: { claude: ['claude-model-b'], codex: ['codex-model-a'] }
    });

    const sections = Array.from(container.querySelectorAll('.backend-section'));
    const valuesIn = (section: Element) =>
      Array.from(section.querySelectorAll('.model-list-item input')).map(
        (input) => (input as HTMLInputElement).value
      );
    const claudeSection = sections.find((section) => section.textContent?.includes('claude Models'));
    const codexSection = sections.find((section) => section.textContent?.includes('codex Models'));

    expect(claudeSection && valuesIn(claudeSection)).toEqual(['claude-model-b']);
    expect(codexSection && valuesIn(codexSection)).toEqual(['codex-model-a']);
  });
});

// Feature 096 T029 — FR-005 changes pre-096 behavior: a duplicate add used to
// silently no-op. `onadd` is this component's only path to a catalog
// mutation (and from there to the parent's Save All Models write), so
// proving it was never called proves neither happened.
describe('ModelCatalogEditor duplicate-add guard (feature 096 T029, FR-005)', () => {
  it('surfaces a message and does not call onadd when the id already exists for the backend', async () => {
    const onadd = vi.fn();
    const { getByText } = render(ModelCatalogEditor, {
      props: { ...baseProps, newModelInput: { claude: 'claude-sonnet' }, onadd }
    });

    await fireEvent.click(getByText('Add Model'));

    expect(onadd).not.toHaveBeenCalled();
    expect(getByText(/already exists/i)).toBeTruthy();
  });

  it('does not block adding a new, non-duplicate id', async () => {
    const onadd = vi.fn();
    const { getByText, queryByText } = render(ModelCatalogEditor, {
      props: { ...baseProps, newModelInput: { claude: 'claude-new-model' }, onadd }
    });

    await fireEvent.click(getByText('Add Model'));

    expect(onadd).toHaveBeenCalledTimes(1);
    expect(onadd).toHaveBeenCalledWith('claude');
    expect(queryByText(/already exists/i)).toBeNull();
  });
});
