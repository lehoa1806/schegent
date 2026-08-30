<script lang="ts">
  // Feature 082 (US1, T030) — the Pipelines tab's catalog shell.
  //
  // Rows come from the authoritative `pipelineCatalog` projection, never from
  // `snapshot.availablePipelines` — that list keeps its runtime-selection
  // meaning. Every mutating control stays unavailable until the projection
  // arrives (FR-028) and while trust, an in-flight save, or another row's
  // mutation says otherwise (FR-029). Built-in rows are read-only (FR-024) and
  // a persisted `pipelineId` is immutable — duplicating is the way to a new
  // identity (FR-007).
  //
  // Feature 099 (T494a, FR-043/FR-046) — no scope. There is one layer, so no
  // read-only `built-in` tier, no target-scope picker, and no per-capability
  // trust banner: the Pipelines tab is gated by Workspace Trust alone, and the
  // Builder reports that gate itself rather than rendering an empty list
  // (T493c, FR-052).
  //
  // Feature 184 (FR-R3-141, T032) — the split pane, the form card and the
  // `<select>` sequence editor left for `PipelineFlowBuilder`, which authors the
  // same rows on the canvas the Workflow builder already uses. What is left here
  // is the four states that are about the *catalog* rather than about a row —
  // loading, error, warnings, and a rejected save — plus the empty state and the
  // Builder itself. Those four outlive every selection, so they stay above the
  // surface that has one.
  //
  // The seam is unchanged: the same callbacks the split pane used are forwarded
  // untouched, so the authoring rules stay in `pipeline-catalog-state.ts` and in
  // the store. The one exception is `onaddphase`, which now carries the Phase id
  // — the palette's click *is* the commit, so the `newPhaseId` field the old
  // `<select>` and "Add Phase" button held between them is gone.
  import type { WorkflowSnapshot } from '../../lib/snapshot-types';
  import CatalogEmptyState from '../Builder/CatalogEmptyState.svelte';
  import PipelineFlowBuilder from './PipelineFlowBuilder.svelte';
  import type { MutablePhase, MutablePipeline } from './types';

  interface Props {
    snapshot: WorkflowSnapshot;
    pipelines: MutablePipeline[];
    phases: MutablePhase[];
    selectedIndex: number | null;
    historyIndex: number;
    historyLength: number;
    trusted: boolean;
    saveError: string | null;
    savePending: boolean;
    mutationActive: boolean;
    editableSourceKey: string | null;
    getPhaseTooltip: (phaseId: string) => string;
    onselect: (index: number | null) => void;
    onadd: () => void;
    onremove: (index: number, originatingElement?: HTMLElement | null) => void | Promise<void>;
    onreset: (index: number) => void;
    onduplicate: (index: number) => void;
    onpipelinechange: (index: number, patch: Partial<MutablePipeline>) => void;
    onphasechange: (pipelineIndex: number, phaseIndex: number, phaseId: string) => void;
    onundo: () => void;
    onredo: () => void;
    onsave: () => void;
    ondismisssaveerror: () => void;
    onaddphase: (phaseId: string) => void;
    onremovephase: (index: number) => void;
    onmovephaseup: (index: number) => void;
    onmovephasedown: (index: number) => void;
  }

  const {
    snapshot,
    pipelines,
    phases,
    selectedIndex,
    historyIndex,
    historyLength,
    trusted,
    saveError,
    savePending,
    mutationActive,
    editableSourceKey,
    getPhaseTooltip,
    onselect,
    onadd,
    onremove,
    onreset,
    onduplicate,
    onpipelinechange,
    onphasechange,
    onundo,
    onredo,
    onsave,
    ondismisssaveerror,
    onaddphase,
    onremovephase,
    onmovephaseup,
    onmovephasedown
  }: Props = $props();
</script>

{#if !snapshot.pipelineCatalog}
  <div class="catalog-state" role="status" aria-live="polite" aria-busy="true" data-testid="pipeline-catalog-loading">
    Loading authoritative Pipeline catalog…
  </div>
{:else if snapshot.pipelineCatalog.state === 'error'}
  <div class="catalog-state catalog-error" role="alert" data-testid="pipeline-catalog-error">
    {snapshot.pipelineCatalog.error?.message ?? 'The Pipeline catalog could not be loaded. Reload the view to retry.'}
  </div>
{:else}
{#if snapshot.pipelineCatalog.warnings.length > 0}
  <div class="catalog-warning" role="status" aria-live="polite" data-testid="pipeline-catalog-warnings">
    {#each snapshot.pipelineCatalog.warnings as warning (warning.code + warning.message)}
      <div>{warning.message}</div>
    {/each}
  </div>
{/if}
{#if saveError}
  <div class="save-error-banner" data-testid="save-error-banner" role="alert">
    <span class="save-error-icon">⚠</span>
    <span class="save-error-text">Save rejected: {saveError}</span>
    <button class="save-error-dismiss" aria-label="Dismiss Pipeline save error" onclick={ondismisssaveerror}>✕</button>
  </div>
{/if}
<!-- Feature 101 (US6, T065, FR-032/FR-033) — the front door, and this tab's only
     import entry: the Pipelines tab never grew a standalone preflight region.
     Ordered after the trust check by construction — PipelineBuilder gates the
     three definition tabs, so an untrusted workspace never reaches here and the
     guidance can never point at an action that cannot succeed. -->
<CatalogEmptyState kind="pipeline" count={pipelines.length} />
<PipelineFlowBuilder
  {snapshot}
  {pipelines}
  {phases}
  {selectedIndex}
  {historyIndex}
  {historyLength}
  {trusted}
  {savePending}
  {mutationActive}
  {editableSourceKey}
  {getPhaseTooltip}
  {onselect}
  {onadd}
  {onremove}
  {onreset}
  {onduplicate}
  {onpipelinechange}
  {onphasechange}
  {onundo}
  {onredo}
  {onsave}
  {onaddphase}
  {onremovephase}
  {onmovephaseup}
  {onmovephasedown}
/>
{/if}
