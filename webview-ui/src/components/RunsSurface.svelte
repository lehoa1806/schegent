<script lang="ts">
  // Feature 091 T018 (US2, FR-014 to FR-018) — the mount for the two composed-
  // run surfaces.
  //
  // `WorkflowRun.svelte` and `RunLauncher.svelte` shipped complete and imported
  // by nothing outside their own tests. Everything they need was already in the
  // projection — `connectedRuns`, `queue.orderedItems`, `availablePipelines` —
  // and the webview simply never read it. This file is that read, and it is
  // deliberately the thinnest thing that can be: no store, no IPC, no derived
  // state beyond what the markup branches on. Both children own their own
  // behaviour, and a wrapper that started making decisions for them would be a
  // second opinion about a surface that already has one.
  //
  // Two of those non-decisions are load-bearing:
  //
  //   * A hydrating run is passed straight through (FR-016). Filtering it would
  //     look like tidiness and would defeat the hydration gate `WorkflowRun`
  //     exists to show — the operator would see a run vanish rather than a run
  //     loading.
  //   * The composer stays closed until asked for, and the picker appears only
  //     when there is something to pick. A live compose control over an empty
  //     catalog is a control whose only outcome is a refusal.
  //
  // Operator-authored strings — Pipeline names, run and workflow identifiers —
  // are interpolated with `{}`, which escapes. Nothing here uses `{@html}`.

  import WorkflowRun from './WorkflowRun/WorkflowRun.svelte';
  import RunLauncher from './RunLauncher/RunLauncher.svelte';
  import type { WorkflowSnapshot } from '../lib/snapshot-types';

  interface Props {
    readonly snapshot: WorkflowSnapshot;
  }

  const { snapshot }: Props = $props();

  const connectedRuns = $derived(snapshot.connectedRuns ?? []);
  const pipelines = $derived(snapshot.availablePipelines ?? []);
  const queueItems = $derived(snapshot.queue?.orderedItems ?? []);

  let selectedPipelineId = $state<string | null>(null);
  let composing = $state(false);

  /**
   * The Pipeline the composer opens against, re-resolved from the catalog on
   * every projection. A Pipeline removed while the composer is open resolves to
   * nothing and closes it, rather than composing against a definition the host
   * would no longer accept.
   */
  const composePipeline = $derived(
    composing ? pipelines.find((pipeline) => pipeline.id === selectedPipelineId) : undefined
  );

  function onCompose(): void {
    if (selectedPipelineId === null) return;
    composing = true;
  }
</script>

<main class="runs-surface" data-testid="runs-surface">
  <section class="runs-zone">
    <header class="zone-title">Connected Runs</header>
    {#if connectedRuns.length > 0}
      <ul class="run-list">
        {#each connectedRuns as run (run.connectedRunId)}
          <li class="run-item">
            <WorkflowRun {run} {queueItems} {pipelines} />
          </li>
        {/each}
      </ul>
    {:else}
      <p class="empty" data-testid="runs-surface-no-connected-runs">
        No connected run is in progress.
      </p>
    {/if}
  </section>

  {#if pipelines.length > 0}
    <section class="compose-zone">
      <header class="zone-title">Start a Run</header>
      <div class="compose-controls">
        <label class="compose-label" for="runs-surface-pipeline-select">Pipeline</label>
        <select
          id="runs-surface-pipeline-select"
          class="compose-select"
          data-testid="runs-surface-pipeline-select"
          bind:value={selectedPipelineId}
        >
          <option value={null}>Choose a Pipeline…</option>
          {#each pipelines as pipeline (pipeline.id)}
            <option value={pipeline.id}>{pipeline.name}</option>
          {/each}
        </select>
        <button
          type="button"
          class="compose-button"
          data-testid="runs-surface-compose"
          disabled={selectedPipelineId === null}
          onclick={onCompose}
        >
          Compose
        </button>
      </div>

      {#if composePipeline}
        <RunLauncher pipeline={composePipeline} onClose={() => (composing = false)} />
      {/if}
    </section>
  {/if}
</main>

<style>
  .runs-surface {
    display: flex;
    flex-direction: column;
    gap: var(--schegent-gap, 12px);
    padding: 12px;
    min-height: 0;
    overflow-y: auto;
  }
  .runs-zone,
  .compose-zone {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .zone-title {
    font-size: 0.9em;
    font-weight: 600;
    color: var(--schegent-muted-fg);
    letter-spacing: 0.05em;
  }
  .run-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .run-item {
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 4px;
    min-width: 0;
  }
  .empty {
    margin: 0;
    font-size: 0.85em;
    opacity: 0.8;
  }
  .compose-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .compose-label {
    font-size: 0.85em;
    opacity: 0.9;
  }
  .compose-select {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, transparent);
    border-radius: 2px;
    padding: 3px 6px;
    font-size: 0.85em;
    min-width: 0;
  }
  .compose-button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 2px;
    padding: 4px 10px;
    font-size: 0.85em;
    cursor: pointer;
  }
  .compose-button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
