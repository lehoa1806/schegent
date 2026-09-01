// Feature 184 (FR-R3-141, T025) — the canvas Builder's header.
//
// The "not an input" assertion is what makes the `pipelines-title-{id}`
// retirement visible in the suite: that field was a second input bound to the
// same value as the inspector's Name, and nothing else in the suite would fail
// if it were quietly carried across into the new header.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import PipelineFlowTopBar from '../PipelineBuilderEditors/PipelineFlowTopBar.svelte';
import type { BuilderLifecycle } from '../../lib/snapshot-types';
import type { MutablePipeline } from '../PipelineBuilderEditors/types';
import { flowPipelineRow } from './pipeline-flow-fixtures';

afterEach(cleanup);

function mount(
  options: {
    rows?: readonly MutablePipeline[];
    selected?: MutablePipeline | null;
    selectedIndex?: number | null;
    baseline?: MutablePipeline | null;
  } = {}
) {
  // Two rows with distinct source keys: the list keys its `#each` by `sourceKey`,
  // because two catalog layers may hold the same Pipeline id.
  const rows =
    options.rows ??
    ([
      flowPipelineRow(),
      flowPipelineRow({ id: 'hotfix', name: 'Hotfix', sourceKey: 'user::hotfix' })
    ] as const);
  const selected = options.selected === undefined ? rows[0] : options.selected;
  const onselect = vi.fn();
  const { container } = render(PipelineFlowTopBar, {
    props: {
      rows,
      selected,
      selectedIndex: options.selectedIndex === undefined ? 0 : options.selectedIndex,
      baseline: options.baseline === undefined ? (selected ?? null) : options.baseline,
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

describe('PipelineFlowTopBar picker (T025)', () => {
  it('opens the picker when nothing is selected, and says so on the toggle', () => {
    const { at } = mount({ selected: null, selectedIndex: null });

    // The Library list moved in here, so the picker is now the only way to open
    // a Pipeline. Starting closed with nothing selected would leave an operator
    // looking at an empty canvas with no visible way in.
    expect(at('pipelines-picker-list')).not.toBeNull();
    expect(at('pipelines-picker-toggle')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('starts closed once a Pipeline is open, and the toggle opens it', async () => {
    const { at } = mount();
    const toggle = at('pipelines-picker-toggle') as HTMLButtonElement;

    expect(at('pipelines-picker-list')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-haspopup')).toBe('true');

    await fireEvent.click(toggle);
    expect(at('pipelines-picker-list')).not.toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('closes the picker on Escape from inside it', async () => {
    const { at } = mount({ selected: null, selectedIndex: null });

    // Fired from the list, not the toggle: a dropdown that only closes by
    // clicking its trigger again is a keyboard trap for anyone who tabbed into
    // a row first.
    await fireEvent.keyDown(at('pipelines-picker-list') as HTMLElement, { key: 'Escape' });

    expect(at('pipelines-picker-list')).toBeNull();
    expect(at('pipelines-picker-toggle')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes the picker when a row is chosen, and reports the choice', async () => {
    const { at, onselect } = mount({ selected: null, selectedIndex: null });

    await fireEvent.click(at('pipelines-list-item-hotfix') as HTMLElement);

    expect(onselect).toHaveBeenCalledWith(1);
    // Closing is the component's own business: `selected` is a prop it does not
    // control, so a picker that waited for the parent to re-render would stay
    // open over the Pipeline it just opened.
    expect(at('pipelines-picker-list')).toBeNull();
  });

  it('carries the Library rows unchanged into the popover', () => {
    const { at } = mount({ selected: null, selectedIndex: null });

    expect(at('pipelines-list-item-release-flow')).not.toBeNull();
    expect(at('pipelines-list-item-hotfix')).not.toBeNull();
  });
});

describe('PipelineFlowTopBar name (T025)', () => {
  it('renders the open Pipeline’s name as text, not as an input', () => {
    const { container, at } = mount();

    expect(at('pipelines-topbar-name')?.textContent.trim()).toBe('Release Flow');
    expect(at('pipelines-topbar-name')?.tagName).not.toBe('INPUT');
    // FR-010. `pipelines-title-{id}` was an input bound to the same value as the
    // inspector's Name field. The whole header holds no input at all now, so
    // reintroducing one anywhere in it fails here rather than passing as "the
    // name still renders".
    expect(container.querySelectorAll('input')).toHaveLength(0);
    expect(container.querySelector('[data-testid^="pipelines-title-"]')).toBeNull();
  });

  it('names no Pipeline rather than an empty one when nothing is open', () => {
    const { at } = mount({ selected: null, selectedIndex: null });

    expect(at('pipelines-topbar-name')?.textContent.trim()).toBe('No Pipeline selected');
    expect(at('pipelines-topbar-status')).toBeNull();
  });
});

describe('PipelineFlowTopBar unsaved-draft status (T025)', () => {
  it('states the source status of the open Pipeline', () => {
    const { at } = mount();
    expect(at('pipelines-topbar-status')?.textContent.trim()).toBe('effective');
  });

  it('shows the unsaved badge when the draft diverges from the stored body', () => {
    const stored = flowPipelineRow();
    const { at } = mount({
      selected: flowPipelineRow({ name: 'Release Flow (edited)' }),
      baseline: stored
    });

    expect(at('pipelines-topbar-unsaved')).not.toBeNull();
  });

  it('withholds the unsaved badge when the draft matches the stored body', () => {
    // The pair that makes the badge mean something: same row, same baseline, no
    // badge. A badge wired to `persisted` — or to nothing — passes the diverging
    // case above and fails here.
    const { at } = mount({ selected: flowPipelineRow(), baseline: flowPipelineRow() });

    expect(at('pipelines-topbar-unsaved')).toBeNull();
  });

  it('treats a row the host has never stored as unsaved', () => {
    const { at } = mount({ selected: flowPipelineRow({ persisted: false }), baseline: null });

    expect(at('pipelines-topbar-unsaved')).not.toBeNull();
  });

  it('sees an edit the sequence carries, not only one the identity carries', () => {
    // FR-013 is about the *body*, and a comparison that only watched the fields
    // the header itself renders would miss every canvas edit — which is most of
    // what this Builder is for.
    const { at } = mount({
      selected: flowPipelineRow({ phases: ['speckit-specify', 'speckit-plan', 'done'] }),
      baseline: flowPipelineRow()
    });

    expect(at('pipelines-topbar-unsaved')).not.toBeNull();
  });
});

// Feature 186 (US2, T015, FR-005, D-5) — the picker's default-open state must
// not visually cover the toolbar's own controls. jsdom computes no layout, so
// the enforceable form of "renders in normal document flow" is the CSS rule
// that took it out of flow in the first place: `.wf-picker-pop` stops being
// `position: absolute`, and `.wf-picker` stops being `position: relative` —
// dead once nothing inside it is positioned against it.
describe('the popover stops floating out of flow (T015, FR-005, D-5)', () => {
  /** Empty string when the selector carries no rule at all (D-5 may delete it). */
  function ruleBodyOf(source: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = source.match(new RegExp(`\\.pb ${escaped}\\s*\\{([^}]*)\\}`));
    return match?.[1] ?? '';
  }

  it('renders the popover in normal flow, not floated over the toolbar', () => {
    const source = readFileSync(
      resolve(__dirname, '../PipelineBuilderEditors/workflow-flow.css'),
      'utf8'
    );
    const pop = ruleBodyOf(source, '.wf-picker-pop');
    expect(pop, 'expected a rule for .wf-picker-pop').not.toBe('');
    expect(pop).not.toContain('position: absolute');
    expect(pop).not.toContain('top:');
    expect(pop).not.toContain('left:');
    expect(pop).not.toContain('z-index:');
    // A long catalog still scrolls in place rather than pushing the toolbar an
    // unbounded distance down the page.
    expect(pop).toContain('max-height: 340px');
    expect(pop).toContain('overflow-y: auto');

    // `.wf-picker` carried only `position: relative`, dead once nothing inside
    // it is positioned against it (D-5) — its rule may be gone entirely, and
    // either way it must not declare `position: relative`.
    const picker = ruleBodyOf(source, '.wf-picker');
    expect(picker).not.toContain('position: relative');
  });
});
