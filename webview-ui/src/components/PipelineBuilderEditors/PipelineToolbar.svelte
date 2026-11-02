<script lang="ts">
  // Feature 184 (FR-R3-141, T028) — the action bar, and the notice directly
  // beneath it.
  //
  // Nine controls that used to sit in two places: four in the toolbar above the
  // split pane, five in the selected row's card header. One bar above three panes
  // has no distance between them, so the second "Save Pipeline" (`:324`) is gone
  // — it was the same action as `pipelines-save-all` with the same disabled rule,
  // duplicated only because the card was scrolled away from the toolbar.
  //
  // FR-020a is the whole reason this is not a copy. Discard, Duplicate, Export,
  // Save and Delete lived inside `{#if selectedPipeline && selectedIndex !== null}`,
  // so their disabled expressions never had to consider "nothing is open". In an
  // always-rendered bar they do, and the old expressions get it wrong in the
  // dangerous direction: `selectedReadOnly` evaluates to *editable* with nothing
  // selected, which would render Delete live with nothing to delete. Every control
  // that acts on `selectedIndex` therefore carries an explicit `noSelection` term.
  //
  // Add, Undo and Redo do NOT, and the exclusion is the point rather than an
  // oversight. `onundo`/`onredo` take no index — the store replays `pipelines`
  // wholesale — so `noSelection` would guard nothing there and would delete a
  // recovery path instead: `discardDraft()` and an adopted reprojection both set
  // `selectedIndex = null` while leaving a history that still holds the rows from
  // before, and undoing out of an accidental Discard Draft is exactly that state.
  // Their bounds are therefore the ones at `:244-245`, unchanged.
  //
  // Delete renders always and is disabled in place, rather than being wrapped in
  // `{#if !selectedReadOnly}` as it was at `:325`. Collapsing that condition into
  // the disabled expression is exactly equivalent for the operator's permissions
  // and strictly better for the layout: a bar that loses a button whenever a save
  // is in flight reflows the eight beside it mid-click.
  import type { MutablePipeline } from './types';

  interface Props {
    /** The open Pipeline, or null when the picker has produced no selection. */
    pipeline: MutablePipeline | null;
    selectedIndex: number | null;
    trusted: boolean;
    savePending: boolean;
    mutationActive: boolean;
    noEffectivePhase: boolean;
    /** The shell's `selectedReadOnly`: it needs `editableSourceKey`, which is catalog state. */
    readonly: boolean;
    /** The shell's `saveDisabled`: it needs the catalog-wide draft errors. */
    saveDisabled: boolean;
    historyIndex: number;
    historyLength: number;
    onadd: () => void;
    onundo: () => void;
    onredo: () => void;
    onsave: () => void;
    ondiscard: (index: number) => void;
    onduplicate: (index: number) => void;
    onremove: (index: number, trigger: HTMLElement) => void;
  }

  const {
    pipeline,
    selectedIndex,
    trusted,
    savePending,
    mutationActive,
    noEffectivePhase,
    readonly,
    saveDisabled,
    historyIndex,
    historyLength,
    onadd,
    onundo,
    onredo,
    onsave,
    ondiscard,
    onduplicate,
    onremove
  }: Props = $props();

  const noSelection = $derived(pipeline === null || selectedIndex === null);
</script>

<div class="toolbar" data-testid="pipelines-toolbar">
  <button
    class="btn btn-primary"
    data-testid="pipelines-add"
    onclick={onadd}
    disabled={!trusted || savePending || mutationActive || noEffectivePhase}>Add Pipeline</button
  >
  <!-- Undo and Redo keep their bounds from `:244-245` and gain no test id they
       did not have; the suite addresses them by their accessible name. -->
  <button class="btn" disabled={!trusted || savePending || historyIndex <= 0} onclick={onundo}
    >Undo</button
  >
  <button
    class="btn"
    disabled={!trusted || savePending || historyIndex >= historyLength - 1}
    onclick={onredo}>Redo</button
  >
  <button
    class="btn btn-ghost"
    data-testid="pipelines-discard"
    disabled={noSelection || readonly}
    onclick={() => selectedIndex !== null && ondiscard(selectedIndex)}>Discard Draft</button
  >
  <button
    class="btn btn-ghost"
    data-testid="pipelines-duplicate"
    disabled={noSelection || !trusted || savePending || mutationActive || noEffectivePhase}
    onclick={() => selectedIndex !== null && onduplicate(selectedIndex)}>Duplicate Pipeline</button
  >

  <button
    class="btn btn-secondary push-right"
    data-testid="pipelines-save-all"
    onclick={onsave}
    disabled={noSelection || saveDisabled}>{savePending ? 'Saving…' : 'Save Pipeline'}</button
  >
  <button
    class="btn btn-destructive"
    data-testid="pipelines-remove"
    disabled={noSelection || readonly || !trusted || savePending}
    onclick={(event) => selectedIndex !== null && onremove(selectedIndex, event.currentTarget)}
    >Delete Pipeline</button
  >
</div>

<!-- FR-021 / mapping #5 — directly beneath the bar, so it is adjacent to the two
     things it disables: Add above it and the palette below. -->
{#if noEffectivePhase}
  <div class="catalog-state" role="status" aria-live="polite" data-testid="pipelines-no-phases">
    No effective Phase is available. A Pipeline is an ordered sequence of Phases, so add or restore
    at least one Phase in the Phase Library before creating or saving a Pipeline.
  </div>
{/if}
