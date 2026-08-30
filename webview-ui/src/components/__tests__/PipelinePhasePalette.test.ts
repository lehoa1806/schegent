// Feature 184 (FR-R3-141, T010/T012/T013) — the Phases palette.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PipelinePhasePalette from '../PipelineBuilderEditors/PipelinePhasePalette.svelte';
import type { MutablePhase } from '../PipelineBuilderEditors/types';
import { FLOW_PHASES } from './pipeline-flow-fixtures';

afterEach(cleanup);

function mount(overrides: { phases?: readonly MutablePhase[]; readonly?: boolean } = {}) {
  const onaddphase = vi.fn();
  const onclose = vi.fn();
  const { container } = render(PipelinePhasePalette, {
    props: {
      phases: overrides.phases ?? FLOW_PHASES,
      readonly: overrides.readonly ?? false,
      onaddphase,
      onclose
    }
  });
  return {
    container,
    onaddphase,
    onclose,
    at: (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
  };
}

describe('PipelinePhasePalette (T010)', () => {
  it('renders one item per effective Phase, under that Phase’s id', () => {
    const { container, at } = mount();

    expect(at('pipelines-palette-phase-speckit-specify')?.textContent).toContain('Specify');
    expect(at('pipelines-palette-phase-speckit-plan')?.textContent).toContain('Plan');
    expect(at('pipelines-palette-phase-done')?.textContent).toContain('Done');
    expect(container.querySelectorAll('[data-testid^="pipelines-palette-phase-"]')).toHaveLength(3);
  });

  it('adds the Phase whose item was clicked', async () => {
    const { at, onaddphase } = mount();

    await fireEvent.click(at('pipelines-palette-phase-speckit-plan') as HTMLElement);

    expect(onaddphase).toHaveBeenCalledTimes(1);
    expect(onaddphase).toHaveBeenCalledWith('speckit-plan');
  });

  it('offers the add as native button activation, so a focused item responds to Enter', () => {
    const { at, onaddphase } = mount();
    const item = at('pipelines-palette-phase-done') as HTMLElement;

    // jsdom does not implement the key-to-activation mapping, so pressing Enter
    // here would prove nothing either way. The two facts that compose to it are
    // asserted instead: the item is a native `button` — which the HTML standard
    // activates on Enter — and activation calls the handler. That also rules out
    // the failure this task is really guarding against: a div or a drag handle
    // with a click listener, which looks identical until a keyboard reaches it.
    expect(item.tagName).toBe('BUTTON');
    item.focus();
    expect(document.activeElement).toBe(item);

    item.click();
    expect(onaddphase).toHaveBeenCalledWith('done');
  });

  it('leaves the six-dot glyph as decoration rather than a gesture', () => {
    const { at } = mount();
    const item = at('pipelines-palette-phase-done') as HTMLElement;
    const handle = item.querySelector('.wf-handle');

    // A drag is the one gesture a keyboard cannot produce (083’s FR-042), so the
    // glyph that suggests one must be hidden from assistive technology and carry
    // no listener of its own.
    expect(handle?.getAttribute('aria-hidden')).toBe('true');
    expect(item.getAttribute('draggable')).toBeNull();
  });
});

describe('PipelinePhasePalette empty and readonly (T012)', () => {
  it('renders the empty note with no effective Phase, outside the loop', () => {
    const { container, at } = mount({ phases: [] });

    // The note renders precisely when there is nothing to iterate. A note placed
    // inside `{#each}` would render zero times here, so this is the assertion
    // that distinguishes the two placements.
    expect(at('pipelines-palette-no-phases')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid^="pipelines-palette-phase-"]')).toHaveLength(0);
  });

  it('renders no empty note when the catalog has Phases', () => {
    const { at } = mount();
    expect(at('pipelines-palette-no-phases')).toBeNull();
  });

  it('keeps every item present and disabled under readonly', () => {
    const { container } = mount({ readonly: true });
    const items = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid^="pipelines-palette-phase-"]')
    );

    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.disabled, `${item.dataset.testid} must be disabled under readonly`).toBe(true);
    }
  });
});

describe('PipelinePhasePalette offers only Phases (T013)', () => {
  it('renders no Split action and no Logic group', () => {
    const { container } = mount();

    // An absence test on purpose (FR-027). A Pipeline sequence has no
    // connections, so a split has nothing to split; nothing else in the suite
    // would notice one appearing after a copy from the Workflow palette.
    expect(container.querySelector('[data-testid="workflow-palette-split"]')).toBeNull();
    expect(container.querySelector('[data-testid*="split"]')).toBeNull();
    expect(container.textContent).not.toMatch(/logic/i);
    expect(container.textContent).not.toMatch(/split/i);
  });

  it('renders exactly one group, and it is the Phase catalog', () => {
    const { container } = mount();
    const groups = Array.from(container.querySelectorAll('.wf-palette-group-label'));

    expect(groups.map((group) => group.textContent.trim())).toEqual(['Phases']);
  });
});
