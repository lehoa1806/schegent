<script lang="ts">
  // The Phases tab: the list page, or the open Phase's editor page in its place.
  //
  // This component keeps what both pages share — the catalog's loading and error states, the trust
  // banners, the catalog's warnings and the save error — and decides which page shows. The pages
  // themselves are `PhaseCatalogList.svelte` and `PhaseEditorPage.svelte`; every handler reaches
  // them unchanged from PipelineBuilder.
  import type { BuilderLifecycle, WorkflowSnapshot } from '../../lib/snapshot-types';
  import { importDisabledReason, storedWritableLayers } from '../ProcessImport/process-exchange-entry';
  import TrustBanner from '../TrustBanner.svelte';
  import PhaseCatalogList from './PhaseCatalogList.svelte';
  import { phaseEditorOpen, type PhaseStatusView } from './phase-catalog-view';
  import PhaseEditorPage from './PhaseEditorPage.svelte';
  import type { MutablePhase, PhaseEditState } from './types';

  interface Props {
    snapshot: WorkflowSnapshot;
    phases: MutablePhase[];
    editStateById: Record<string, PhaseEditState>;
    selectedIndex: number | null;
    historyIndex: number;
    historyLength: number;
    trusted: boolean;
    retryConditionsTrusted: boolean;
    showTrustBanner: boolean;
    showRetryTrustBanner: boolean;
    saveError: string | null;
    savePending: boolean;
    mutationActive: boolean;
    editableSourceKey: string | null;
    onselect: (index: number | null) => void;
    onadd: () => void;
    onremove: (index: number, originatingElement?: HTMLElement | null) => void | Promise<void>;
    onreset: (index: number) => void;
    onphasechange: (index: number, patch: Partial<MutablePhase>) => void;
    onmoveup: (index: number) => void;
    onmovedown: (index: number) => void;
    onundo: () => void;
    onredo: () => void;
    onsave: () => void;
    ondismisssaveerror: () => void;
    ontoggleraw: (phaseId: string) => void;
    onrawsave: (index: number, parsed: Record<string, unknown>) => void;
    ontoggleretry: (index: number) => void;
    onretrychange: (index: number, event: { source: string; valid: boolean }) => void;
    onduplicate: (index: number) => void;
    onopenworkflow?: (workflowId: string) => void;
  }

  const {
    snapshot,
    phases,
    editStateById,
    selectedIndex,
    historyIndex,
    historyLength,
    trusted,
    retryConditionsTrusted,
    showTrustBanner,
    showRetryTrustBanner,
    saveError,
    savePending,
    mutationActive,
    editableSourceKey,
    onselect,
    onadd,
    onremove,
    onreset,
    onphasechange,
    onmoveup,
    onmovedown,
    onundo,
    onredo,
    onsave,
    ondismisssaveerror,
    ontoggleraw,
    onrawsave,
    ontoggleretry,
    onretrychange,
    onduplicate,
    onopenworkflow
  }: Props = $props();

  const selectedPhase = $derived(selectedIndex !== null ? phases[selectedIndex] : null);
  const selectedEditState = $derived(
    selectedPhase ? editStateById[selectedPhase.sourceKey] ?? { rawJsonMode: false } : null
  );

  const selectedReadOnly = $derived(
    !trusted || savePending ||
      (editableSourceKey !== null && selectedPhase?.sourceKey !== editableSourceKey)
  );

  const importLayers = $derived(
    storedWritableLayers(
      snapshot.phaseCatalog?.records ?? [],
      snapshot.workflowCatalog?.records ?? []
    )
  );
  const importUnavailable = $derived(
    importDisabledReason({ catalog: 'phase', trusted, savePending, mutationActive })
  );

  const lifecycleByKey = $derived(
    new Map<string, BuilderLifecycle | undefined>(
      (snapshot.phaseCatalog?.records ?? []).map((record) => [record.key, record.lifecycle])
    )
  );
  const allWorkflowDefinitions = $derived.by(() => {
    if (snapshot.workflowCatalog?.state !== 'ready') return [];
    const out = [...snapshot.workflowCatalog.effective];
    for (const rec of snapshot.workflowCatalog.records) {
      const def = rec.definition;
      if (def && !out.some((w) => w.workflowId === def.workflowId)) {
        out.push(def);
      }
    }
    return out;
  });
  /** Read here rather than in the snippet below: a snippet does not keep the branch's narrowing. */
  const catalogWarnings = $derived(snapshot.phaseCatalog?.warnings ?? []);

  // The list's search and filter live here, not in the list, so a Phase opened from a filtered
  // list comes back to the same filtered list.
  let query = $state('');
  let view = $state<PhaseStatusView>('all');

  // Which row takes focus when the list comes back. Read once, by the list as it mounts; nothing
  // draws it, so it is a plain variable rather than state.
  let returnFocusKey: string | null = null;

  function lifecycleOf(sourceKey: string): BuilderLifecycle | undefined {
    return lifecycleByKey.get(sourceKey);
  }

  function takeReturnFocus(): string | null {
    const key = returnFocusKey;
    returnFocusKey = null;
    return key;
  }

  function closeEditor(sourceKey: string): void {
    returnFocusKey = sourceKey;
    onselect(null);
  }

  /** Reverting may close the editor too, so the list it returns to puts focus back on the row. */
  function resetPhase(index: number): void {
    returnFocusKey = phases.at(index)?.sourceKey ?? null;
    onreset(index);
  }
</script>

{#snippet trustBanners()}
  <!--
    FR-R3-143 (T040) — the deciding step is read off the projection this editor
    already holds, not threaded down as two more props. `showTrustBanner` answers
    "is it denied"; `resolvedScope` answers "by whom", and both come from the same
    snapshot, so a separate prop pair could only ever go out of step with the flag
    beside it. `undefined` reaches the banner as `undefined` and it names no layer.
  -->
  {#if showTrustBanner}
    <TrustBanner variant="phases" decidedBy={snapshot.resolvedScope?.phases} />
  {/if}
  {#if showRetryTrustBanner}
    <TrustBanner
      variant="retry-conditions"
      decidedBy={snapshot.resolvedScope?.retryConditions}
    />
  {/if}
{/snippet}

<!-- What either page shows above its content: the trust banners, the catalog's warnings and the
     last save's refusal, each as the redesign's attention banner. -->
{#snippet notices()}
  {@render trustBanners()}
  {#if catalogWarnings.length > 0}
    <div class="attn warn" role="status" aria-live="polite">
      <svg class="i ic" aria-hidden="true"><use href="#i-warn"></use></svg>
      <div class="body">
        {#each catalogWarnings as warning}
          <div>{warning.message}</div>
        {/each}
      </div>
    </div>
  {/if}
  {#if saveError}
    <div class="attn" data-testid="save-error-banner" role="alert">
      <svg class="i ic" aria-hidden="true"><use href="#i-warn"></use></svg>
      <div class="body">Save rejected: {saveError}</div>
      <button type="button" class="icon-btn" aria-label="Dismiss Phase save error" onclick={ondismisssaveerror}><svg class="i" aria-hidden="true"><use href="#i-x"></use></svg></button>
    </div>
  {/if}
{/snippet}

{#if !snapshot.phaseCatalog}
  {@render trustBanners()}
  <div class="catalog-state" role="status" aria-live="polite" aria-busy="true" data-testid="phase-catalog-loading">
    Loading authoritative Phase catalog…
  </div>
{:else if snapshot.phaseCatalog.state === 'error'}
  {@render trustBanners()}
  <div class="catalog-state catalog-error" role="alert" data-testid="phase-catalog-error">
    {snapshot.phaseCatalog.error?.message ?? 'The Phase catalog could not be loaded. Reload the view to retry.'}
  </div>
{:else if phaseEditorOpen({ catalogState: snapshot.phaseCatalog.state, selectedIndex, phaseCount: phases.length }) && selectedPhase && selectedIndex !== null}
  {@const phase = selectedPhase}
  <PhaseEditorPage
    {snapshot}
    {phase}
    index={selectedIndex}
    phaseCount={phases.length}
    editState={selectedEditState ?? { rawJsonMode: false }}
    lifecycle={lifecycleByKey.get(phase.sourceKey)}
    workflows={allWorkflowDefinitions}
    readOnly={selectedReadOnly}
    {historyIndex}
    {historyLength}
    {trusted}
    {retryConditionsTrusted}
    {savePending}
    {mutationActive}
    {editableSourceKey}
    {notices}
    onclose={() => closeEditor(phase.sourceKey)}
    {onremove}
    onreset={resetPhase}
    {onphasechange}
    {onmoveup}
    {onmovedown}
    {onundo}
    {onredo}
    {onsave}
    {ontoggleraw}
    {onrawsave}
    {ontoggleretry}
    {onretrychange}
    {onduplicate}
    {onopenworkflow}
  />
{:else}
  <PhaseCatalogList
    {phases}
    {lifecycleOf}
    {importLayers}
    {importUnavailable}
    {historyIndex}
    {historyLength}
    {trusted}
    {savePending}
    {mutationActive}
    {editableSourceKey}
    bind:query
    bind:view
    {takeReturnFocus}
    {notices}
    {onselect}
    {onadd}
    {onmoveup}
    {onmovedown}
    {onundo}
    {onredo}
    {onsave}
  />
{/if}
