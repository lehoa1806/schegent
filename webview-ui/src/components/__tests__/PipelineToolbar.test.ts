// Feature 184 (FR-R3-141, T027/T027a/T029) — the action bar.
//
// The nine controls, the disabled rule each carries at
// `PipelineCatalogEditor.svelte:243-246,310-325`, and the state the old surface
// could not reach: no Pipeline open, with the bar still on screen.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineExportInclusion } from '../../lib/messages';

// Hoisted above the component import, as `PipelineCatalogEditor.test.ts` does:
// `vi.mock` is lifted, so the reference has to stay inside a body that runs at
// click time.
const exportSpy = vi.fn<(resourceId: string, inclusion: PipelineExportInclusion) => void>();
vi.mock('../../lib/process-yaml-ipc', () => ({
  exportPipelineYaml: (resourceId: string, inclusion: PipelineExportInclusion) =>
    exportSpy(resourceId, inclusion)
}));

import PipelineToolbar from '../PipelineBuilderEditors/PipelineToolbar.svelte';
import type { MutablePipeline } from '../PipelineBuilderEditors/types';
import { flowPipelineRow } from './pipeline-flow-fixtures';

afterEach(cleanup);
beforeEach(() => exportSpy.mockClear());

interface ToolbarOptions {
  pipeline?: MutablePipeline | null;
  selectedIndex?: number | null;
  trusted?: boolean;
  savePending?: boolean;
  mutationActive?: boolean;
  noEffectivePhase?: boolean;
  readonly?: boolean;
  saveDisabled?: boolean;
  historyIndex?: number;
  historyLength?: number;
}

function mount(options: ToolbarOptions = {}) {
  const pipeline = options.pipeline === undefined ? flowPipelineRow() : options.pipeline;
  const handlers = {
    onadd: vi.fn(),
    onundo: vi.fn(),
    onredo: vi.fn(),
    onsave: vi.fn(),
    ondiscard: vi.fn(),
    onduplicate: vi.fn(),
    onremove: vi.fn()
  };
  const { container } = render(PipelineToolbar, {
    props: {
      pipeline,
      selectedIndex: options.selectedIndex === undefined ? 0 : options.selectedIndex,
      trusted: options.trusted ?? true,
      savePending: options.savePending ?? false,
      mutationActive: options.mutationActive ?? false,
      noEffectivePhase: options.noEffectivePhase ?? false,
      readonly: options.readonly ?? false,
      saveDisabled: options.saveDisabled ?? false,
      historyIndex: options.historyIndex ?? 1,
      historyLength: options.historyLength ?? 3,
      ...handlers
    }
  });
  const at = (id: string) =>
    container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
  // Undo and Redo gain no test id they did not have (mapping #2-#3), so they are
  // addressed the way an operator finds them: by their label.
  const byLabel = (label: string) =>
    Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent.trim() === label
    ) as HTMLButtonElement | undefined;
  return { container, at, byLabel, ...handlers };
}

describe('PipelineToolbar controls (T027)', () => {
  it('renders all nine controls in one bar', () => {
    const { at, byLabel } = mount();

    for (const id of [
      'pipelines-add',
      'pipelines-discard',
      'pipelines-duplicate',
      'pipelines-export-inclusion',
      'pipelines-export',
      'pipelines-save-all',
      'pipelines-remove'
    ]) {
      expect(at(id), `${id} must render`).not.toBeNull();
    }
    expect(byLabel('Undo')).toBeDefined();
    expect(byLabel('Redo')).toBeDefined();
  });

  it('renders only one Save, not the split pane’s two', () => {
    const { container } = mount();

    // Mapping #19. The card header carried a second "Save Pipeline" with the same
    // action and the same disabled rule, because the card was scrolled away from
    // the toolbar. One bar above three panes has no such distance.
    const saves = Array.from(container.querySelectorAll('button')).filter((button) =>
      button.textContent.includes('Save Pipeline')
    );
    expect(saves).toHaveLength(1);
    expect(saves[0].getAttribute('data-testid')).toBe('pipelines-save-all');
  });

  it('gates Add on trust, an idle save, no mutation and an effective Phase', () => {
    expect(mount().at('pipelines-add')?.disabled).toBe(false);
    expect(mount({ trusted: false }).at('pipelines-add')?.disabled).toBe(true);
    expect(mount({ savePending: true }).at('pipelines-add')?.disabled).toBe(true);
    expect(mount({ mutationActive: true }).at('pipelines-add')?.disabled).toBe(true);
    expect(mount({ noEffectivePhase: true }).at('pipelines-add')?.disabled).toBe(true);
  });

  it('binds Undo and Redo to the history bounds exactly as at :244-245', () => {
    // Undo is dead at the first entry, Redo at the last. The bounds are the
    // reason these two need a test at all: an off-by-one either strands the
    // operator one edit short or offers a redo that does nothing.
    const first = mount({ historyIndex: 0, historyLength: 3 });
    expect(first.byLabel('Undo')?.disabled).toBe(true);
    expect(first.byLabel('Redo')?.disabled).toBe(false);

    const last = mount({ historyIndex: 2, historyLength: 3 });
    expect(last.byLabel('Undo')?.disabled).toBe(false);
    expect(last.byLabel('Redo')?.disabled).toBe(true);

    const sole = mount({ historyIndex: 0, historyLength: 1 });
    expect(sole.byLabel('Undo')?.disabled).toBe(true);
    expect(sole.byLabel('Redo')?.disabled).toBe(true);
  });

  it('gates Undo and Redo on trust and an idle save as well as the bounds', () => {
    expect(mount({ trusted: false }).byLabel('Undo')?.disabled).toBe(true);
    expect(mount({ savePending: true }).byLabel('Redo')?.disabled).toBe(true);
  });

  it('gates Discard Draft on the row being editable', () => {
    expect(mount().at('pipelines-discard')?.disabled).toBe(false);
    expect(mount({ readonly: true }).at('pipelines-discard')?.disabled).toBe(true);
  });

  it('gates Duplicate exactly as it gates Add', () => {
    expect(mount().at('pipelines-duplicate')?.disabled).toBe(false);
    expect(mount({ mutationActive: true }).at('pipelines-duplicate')?.disabled).toBe(true);
    expect(mount({ noEffectivePhase: true }).at('pipelines-duplicate')?.disabled).toBe(true);
    expect(mount({ trusted: false }).at('pipelines-duplicate')?.disabled).toBe(true);
  });

  it('gates Save on the shell’s saveDisabled', () => {
    expect(mount().at('pipelines-save-all')?.disabled).toBe(false);
    expect(mount({ saveDisabled: true }).at('pipelines-save-all')?.disabled).toBe(true);
  });

  it('names the pending save on the Save label', () => {
    expect(mount({ savePending: true }).at('pipelines-save-all')?.textContent.trim()).toBe(
      'Saving…'
    );
    expect(mount().at('pipelines-save-all')?.textContent.trim()).toBe('Save Pipeline');
  });

  it('renders Delete disabled rather than absent when the row is read-only', () => {
    // `:325` wrapped Delete in `{#if !selectedReadOnly}`. Collapsing that into the
    // disabled expression is the same permission and a steadier bar: one that
    // loses a button whenever a save is in flight reflows the eight beside it.
    const remove = mount({ readonly: true }).at('pipelines-remove');

    expect(remove).not.toBeNull();
    expect(remove?.disabled).toBe(true);
    expect(mount().at('pipelines-remove')?.disabled).toBe(false);
    expect(mount({ savePending: true }).at('pipelines-remove')?.disabled).toBe(true);
  });

  it('carries the selected index through every control that acts on a row', async () => {
    const bar = mount({ selectedIndex: 2 });

    await fireEvent.click(bar.at('pipelines-add') as HTMLButtonElement);
    await fireEvent.click(bar.byLabel('Undo') as HTMLButtonElement);
    await fireEvent.click(bar.byLabel('Redo') as HTMLButtonElement);
    await fireEvent.click(bar.at('pipelines-save-all') as HTMLButtonElement);
    await fireEvent.click(bar.at('pipelines-discard') as HTMLButtonElement);
    await fireEvent.click(bar.at('pipelines-duplicate') as HTMLButtonElement);
    await fireEvent.click(bar.at('pipelines-remove') as HTMLButtonElement);

    expect(bar.onadd).toHaveBeenCalledTimes(1);
    expect(bar.onundo).toHaveBeenCalledTimes(1);
    expect(bar.onredo).toHaveBeenCalledTimes(1);
    expect(bar.onsave).toHaveBeenCalledTimes(1);
    expect(bar.ondiscard).toHaveBeenCalledWith(2);
    expect(bar.onduplicate).toHaveBeenCalledWith(2);
    // Delete carries its trigger so focus can be restored after the confirm.
    expect(bar.onremove).toHaveBeenCalledWith(2, bar.at('pipelines-remove'));
  });
});

describe('PipelineToolbar with no Pipeline open (T027a)', () => {
  // The state the old surface made unreachable: these five controls lived inside
  // `{#if selectedPipeline && selectedIndex !== null}`, so their expressions
  // never had to consider it. `selectedReadOnly` derives from
  // `selectedPipeline?.sourceKey` and evaluates to *editable* with nothing open,
  // which would render Delete live with nothing to delete (G-3).
  const empty = () => mount({ pipeline: null, selectedIndex: null });

  it('leaves Add enabled — it is the one control that needs no open row', () => {
    expect(empty().at('pipelines-add')?.disabled).toBe(false);
  });

  it('disables every control that acts on the open row', () => {
    const bar = empty();

    for (const id of [
      'pipelines-discard',
      'pipelines-duplicate',
      'pipelines-export-inclusion',
      'pipelines-export',
      'pipelines-save-all',
      'pipelines-remove'
    ]) {
      expect(bar.at(id), `${id} must render`).not.toBeNull();
      expect(bar.at(id)?.disabled, `${id} must be disabled with no Pipeline open`).toBe(true);
    }
  });

  it('leaves Undo and Redo on the history bounds alone — they take no index', () => {
    // The review's one finding. Undo and Redo are the two controls in this bar
    // that do not act on `selectedIndex`: `onundo`/`onredo` take no argument and
    // the store replays `pipelines` wholesale. Gating them on the selection would
    // not be a safety fix, it would delete a recovery path — `discardDraft` and an
    // adopted reprojection both set `selectedIndex = null` while leaving a history
    // that still holds the pre-discard rows, and undoing out of an accidental
    // Discard Draft is exactly the state this describes.
    const bar = empty();

    expect(bar.byLabel('Undo')?.disabled).toBe(false);
    expect(bar.byLabel('Redo')?.disabled).toBe(false);
  });

  it('still ends Undo and Redo at the history bounds with nothing open', () => {
    // The bound is the only thing that disables them here, so it has to still bite.
    const first = mount({ pipeline: null, selectedIndex: null, historyIndex: 0 });
    expect(first.byLabel('Undo')?.disabled).toBe(true);
    expect(first.byLabel('Redo')?.disabled).toBe(false);

    const last = mount({
      pipeline: null,
      selectedIndex: null,
      historyIndex: 2,
      historyLength: 3
    });
    expect(last.byLabel('Undo')?.disabled).toBe(false);
    expect(last.byLabel('Redo')?.disabled).toBe(true);
  });

  it('disables Delete even where every other input says the row is editable', () => {
    // Trusted, idle, nothing read-only, history in range, a Phase available: every
    // term of the ported rule says "go", and only the selection term says no.
    const bar = mount({
      pipeline: null,
      selectedIndex: null,
      trusted: true,
      savePending: false,
      readonly: false,
      saveDisabled: false
    });

    expect(bar.at('pipelines-remove')?.disabled).toBe(true);
    expect(bar.at('pipelines-save-all')?.disabled).toBe(true);
  });

  it('exports nothing when the export control is clicked with nothing open', async () => {
    const bar = empty();

    await fireEvent.click(bar.at('pipelines-export') as HTMLButtonElement);
    expect(exportSpy).not.toHaveBeenCalled();
  });
});

describe('PipelineToolbar export cluster (T029)', () => {
  it('keeps Export live when the row is read-only', () => {
    // FR-022. Export writes nothing this extension owns, so it needs neither
    // trust nor an idle save. Moving the control is where that would be lost:
    // the natural thing to do while porting is to give it the same `readonly`
    // term as its five neighbours.
    const bar = mount({ readonly: true, trusted: false, savePending: true });

    expect(bar.at('pipelines-export')?.disabled).toBe(false);
    expect(bar.at('pipelines-export-inclusion')?.disabled).toBe(false);
  });

  it('keeps the inclusion checkbox adjacent to Export', () => {
    const { container, at } = mount();
    const inclusion = at('pipelines-export-inclusion') as HTMLElement;
    const exportButton = at('pipelines-export') as HTMLElement;

    // Adjacent as rendered, not merely both present: FR-012 is about the choice
    // being made beside the control it changes.
    const controls = Array.from(
      container.querySelectorAll('[data-testid="pipelines-export-inclusion"], [data-testid="pipelines-export"]')
    );
    expect(controls).toHaveLength(2);
    expect(inclusion.closest('label')?.nextElementSibling).toBe(exportButton);
  });

  it('exports the open Pipeline, carrying the inclusion choice', async () => {
    const { at } = mount();

    await fireEvent.click(at('pipelines-export') as HTMLButtonElement);
    expect(exportSpy).toHaveBeenCalledWith('release-flow', 'references-only');

    await fireEvent.click(at('pipelines-export-inclusion') as HTMLInputElement);
    await fireEvent.click(at('pipelines-export') as HTMLButtonElement);
    expect(exportSpy).toHaveBeenLastCalledWith('release-flow', 'include-referenced');
  });

  it('blocks export of an unsaved draft and says why, through aria-describedby', () => {
    const { at } = mount({ pipeline: flowPipelineRow({ persisted: false }) });
    const exportButton = at('pipelines-export') as HTMLButtonElement;
    const reason = at('pipelines-export-disabled-reason') as HTMLElement;

    expect(exportButton.disabled).toBe(true);
    expect(reason).not.toBeNull();
    expect(exportButton.getAttribute('aria-describedby')).toBe(reason.getAttribute('id'));
    expect(reason.textContent).toContain('Save this Pipeline first');
  });

  it('names no reason region when export is live', () => {
    const { at } = mount();

    // A dangling `aria-describedby` is a broken reference, so the attribute has
    // to be absent rather than pointing at a region that is not rendered.
    expect(at('pipelines-export')?.getAttribute('aria-describedby')).toBeNull();
    expect(at('pipelines-export-disabled-reason')).toBeNull();
  });
});

describe('PipelineToolbar no-effective-Phase notice (T029)', () => {
  it('renders the notice directly beneath the bar', () => {
    const { container, at } = mount({ noEffectivePhase: true });
    const notice = at('pipelines-no-phases') as HTMLElement;
    const bar = at('pipelines-toolbar') as HTMLElement;

    // FR-021 / mapping #5 — adjacent to the two things it disables: Add above it
    // and the palette below. Asserted as sibling order, because "somewhere on the
    // page" is what the split pane already did.
    expect(notice).not.toBeNull();
    expect(bar.nextElementSibling).toBe(notice);
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.getAttribute('aria-live')).toBe('polite');
    expect(notice.textContent).toContain('No effective Phase is available.');
    expect(container.contains(bar)).toBe(true);
  });

  it('withholds the notice when a Phase is available', () => {
    expect(mount().at('pipelines-no-phases')).toBeNull();
  });
});
