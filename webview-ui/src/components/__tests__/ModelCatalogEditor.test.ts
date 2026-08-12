import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import ModelCatalogEditor from '../PipelineBuilderEditors/ModelCatalogEditor.svelte';

afterEach(() => cleanup());

describe('ModelCatalogEditor accessibility', () => {
  it('gives new and existing model inputs explicit accessible names', () => {
    const { container } = render(ModelCatalogEditor, {
      props: {
        availableModels: { claude: ['claude-sonnet'] },
        models: { claude: ['claude-sonnet'] },
        newModelInput: { claude: '' },
        onnewmodelinput: vi.fn(),
        onmodelchange: vi.fn(),
        onadd: vi.fn(),
        onremove: vi.fn(),
        onsave: vi.fn()
      }
    });

    const inputs = Array.from(container.querySelectorAll('input'));
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.getAttribute('aria-label')).toBe('New claude model name');
    expect(inputs[1]?.getAttribute('aria-label')).toBe('claude model 1');
    expect(container.querySelector('.btn-destructive')?.getAttribute('aria-label'))
      .toBe('Remove claude model claude-sonnet');
  });
});
