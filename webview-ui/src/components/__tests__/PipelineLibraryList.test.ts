// Feature 184 (FR-R3-141, T014) — the Pipeline Library list inside the picker.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PipelineLibraryList from '../PipelineBuilderEditors/PipelineLibraryList.svelte';
import type { BuilderLifecycle } from '../../lib/snapshot-types';
import type { MutablePipeline } from '../PipelineBuilderEditors/types';
import { flowPipelineRow } from './pipeline-flow-fixtures';

afterEach(cleanup);

const ROWS: readonly MutablePipeline[] = [
  flowPipelineRow(),
  flowPipelineRow({
    id: 'audit-flow',
    name: 'Audit Flow',
    sourceKey: 'user::audit-flow',
    phases: ['done']
  })
];

function mount(selectedIndex: number | null = 0, rows: readonly MutablePipeline[] = ROWS) {
  const onselect = vi.fn();
  const { container } = render(PipelineLibraryList, {
    props: {
      rows,
      selectedIndex,
      lifecycleByKey: new Map<string, BuilderLifecycle | undefined>(),
      onselect
    }
  });
  return {
    container,
    onselect,
    at: (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
  };
}

describe('PipelineLibraryList (T014)', () => {
  it('renders one row per Pipeline under its id, carrying name and id', () => {
    const { container, at } = mount();

    expect(container.querySelectorAll('[data-testid^="pipelines-list-item-"]')).toHaveLength(2);
    const row = at('pipelines-list-item-release-flow') as HTMLElement;
    expect(row.textContent).toContain('Release Flow');
    expect(row.textContent).toContain('release-flow');
  });

  it('marks the selected row with aria-current and selects by index on click', async () => {
    const { at, onselect } = mount(0);

    expect(at('pipelines-list-item-release-flow')?.getAttribute('aria-current')).toBe('true');
    expect(at('pipelines-list-item-audit-flow')?.getAttribute('aria-current')).toBeNull();

    await fireEvent.click(at('pipelines-list-item-audit-flow') as HTMLElement);
    expect(onselect).toHaveBeenCalledWith(1);
  });

  it('marks no row when nothing is selected', () => {
    const { container } = mount(null);
    expect(container.querySelector('[aria-current]')).toBeNull();
  });

  it('renders the lifecycle row outside the selection button', () => {
    const { at } = mount();
    const button = at('pipelines-list-item-release-flow') as HTMLElement;
    const lifecycle = at('definition-row-release-flow') as HTMLElement;

    // Structural on purpose. The lifecycle row carries its own controls, and a
    // control nested inside a button is invalid markup and unreachable by
    // keyboard — a nesting that renders and looks correct, which is why nothing
    // but a containment assertion catches it.
    expect(button.tagName).toBe('BUTTON');
    expect(lifecycle).not.toBeNull();
    expect(button.contains(lifecycle)).toBe(false);
    expect(button.querySelector('button')).toBeNull();
  });

  it('carries only name and id in the row: no sequence summary, no port list, no count', () => {
    const { at } = mount();
    const row = at('pipelines-list-item-release-flow') as HTMLElement;

    // C7-1. The Workflow counterpart's row summarises purpose, node sequence,
    // derived ports and a node count. Enriching this row to match would be a
    // product change smuggled in as a port, so the non-enrichment is asserted
    // rather than left to the diff.
    expect(row.textContent).not.toContain('speckit-specify');
    expect(row.textContent).not.toMatch(/\bPhases?\b/);
    expect(row.textContent.replace(/\s+/g, ' ').trim()).toBe('Release Flow release-flow');
  });

  it('names an unnamed row rather than rendering an empty title', () => {
    const { at } = mount(0, [flowPipelineRow({ name: '' })]);
    expect(at('pipelines-list-item-release-flow')?.textContent).toContain('Untitled Pipeline');
  });

  it('renders the empty state with no Pipelines', () => {
    const { container, at } = mount(null, []);

    expect(at('pipelines-empty')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid^="pipelines-list-item-"]')).toHaveLength(0);
  });

  // Feature 186 (US2, T011, FR-003) — the row carries only name, id, and its two
  // badges: no lifecycle write control reaches it, even when a lifecycle is
  // projected for it. Written to pin the post-relocation state regardless of
  // whether such a control was still reachable before it.
  it('carries no lifecycle write control on any row, even with a lifecycle projected', () => {
    const onselect = vi.fn();
    const lifecycleByKey = new Map<string, BuilderLifecycle | undefined>([
      [
        'user::release-flow',
        {
          state: 'active-with-draft',
          createdAt: 0,
          updatedAt: 0,
          activeVersionId: 'v1',
          expectedDraftVersion: 'v2',
          versions: []
        }
      ]
    ]);
    const { container } = render(PipelineLibraryList, {
      props: { rows: ROWS, selectedIndex: 0, lifecycleByKey, onselect }
    });

    expect(container.querySelector('[data-testid="definition-row-created-release-flow"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="definition-row-active-version-release-flow"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="definition-history-toggle-release-flow"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="definition-action-publish-release-flow"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="definition-row-state-release-flow"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="definition-row-validity-release-flow"]')
    ).not.toBeNull();
  });
});
