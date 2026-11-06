<script lang="ts">
  // Queue task composition reuses the validated launch forms and binds every submission
  // to the Queue being viewed. Execution monitoring lives in Queue task detail.
  import TrustBanner from './TrustBanner.svelte';
  import LaunchableSection from './Runs/LaunchableSection.svelte';
  import LaunchableDetail from './Runs/LaunchableDetail.svelte';
  import RunLauncher from './RunLauncher/RunLauncher.svelte';
  import WorkflowTriggerForm from './Runs/WorkflowTriggerForm.svelte';
  import {
    isSelected,
    reconcileSelection,
    selectedEntry,
    type LaunchSelection
  } from './Runs/launch-selection';
  import type { Launchable, WorkflowSnapshot } from '../lib/snapshot-types';

  interface Props {
    readonly snapshot: WorkflowSnapshot;
    readonly queueId?: string;
  }

  const { snapshot, queueId }: Props = $props();

  const pipelines = $derived(snapshot.availablePipelines ?? []);

  /**
   * What the Queue may admit (FR-001). Absent until the host has resolved both
   * catalogs, and passed through absent rather than defaulted: each section
   * renders its own loading arm, which is not the same thing as an empty one
   * (FR-006).
   */
  const launchables = $derived(snapshot.launchables);

  let selection = $state<LaunchSelection>(null);
  let triggered = $state(false);

  /** Read out of the projection every time, never remembered (FR-017). */
  const selected = $derived(selectedEntry(launchables, selection));

  /**
   * Whether this window may start work (FR-015). It is the window's own answer
   * and never a judgement about what the operator has typed — the surface does
   * not form those (FR-010).
   */
  const canLaunch = $derived(snapshot.isPrimary === true && snapshot.workspaceTrust !== false);

  /** FR-032 — the one reason the launch zone shows no sections at all. */
  const untrusted = $derived(snapshot.workspaceTrust === false);

  /**
   * The effective-catalog definition the form is composed against. The effective
   * catalog *is* the set of Active versions, so it and the projection name the
   * same Pipeline; resolving here rather than carrying a definition on the
   * projection keeps one source for the contract the run is validated against.
   */
  const selectedPipeline = $derived(
    selection?.kind === 'pipeline'
      ? pipelines.find((pipeline) => pipeline.id === selection?.id)
      : undefined
  );

  /**
   * The active graph behind a selected Workflow, read from the same field the
   * Builder reads.
   *
   * The launch projection says which nodes a Workflow starts from; it carries no
   * node-to-Pipeline map, because a copy of the graph beside the graph is two
   * graphs (FR-018). A launch has to name the start node's Pipeline — the host
   * refuses `pipeline-mismatch` otherwise — so the two are joined at the form.
   * Resolved here every render, never remembered (FR-017).
   */
  const selectedGraph = $derived(
    selection?.kind === 'workflow'
      ? snapshot.workflowCatalog?.effective.find(
          (definition) => definition.workflowId === selection?.id
        )
      : undefined
  );

  $effect(() => {
    // FR-013 — a selection the next projection no longer offers is let go of,
    // along with any form open over it. The predicate is absence, and the surface
    // is never told why; see `reconcileSelection`.
    if (reconcileSelection(launchables, selection) === null && selection !== null) {
      selection = null;
      triggered = false;
    }
  });

  function onSelect(entry: Launchable): void {
    selection = isSelected(entry, selection) ? null : { kind: entry.kind, id: entry.id };
    triggered = false;
  }

  function onTrigger(): void {
    // FR-015 is enforced where the state changes, not only where the control is
    // drawn. A form this window could not submit is a form that wastes the
    // operator's typing, so the disabled control and this guard state the same
    // rule twice on purpose — the second one is the one that holds.
    triggered = canLaunch;
  }
</script>

<section class="queue-task-composer" data-testid="queue-task-composer" aria-label="Add task">
  <section class="launch-zone" data-testid="queue-task-composer-launch-zone">
    <header class="zone-title">Add task</header>
    {#if untrusted}
      <TrustBanner variant="workspace-trust" />
    {:else}
      {#if launchables !== undefined && launchables.pipelines.state === 'entries'}
        <LaunchableSection
          name="Pipelines"
          kind="pipeline"
          section={launchables.pipelines}
          {selection}
          {onSelect}
        />
      {/if}
      <LaunchableSection
        name="Workflows"
        kind="workflow"
        section={launchables?.workflows}
        {selection}
        {onSelect}
      />
      {#if selected}
        <LaunchableDetail entry={selected} {canLaunch} {onTrigger} />
      {/if}
      {#if triggered && selectedPipeline}
        <RunLauncher pipeline={selectedPipeline} {queueId} onClose={() => (triggered = false)} />
      {/if}
      {#if triggered && selected?.kind === 'workflow'}
        <WorkflowTriggerForm
          entry={selected}
          graph={selectedGraph}
          {pipelines}
          {queueId}
          onClose={() => (triggered = false)}
        />
      {/if}
    {/if}
  </section>
</section>

<style>
  .queue-task-composer {
    display: flex;
    flex-direction: column;
    gap: var(--schegent-gap, 12px);
    padding: 12px;
    min-height: 0;
    overflow-y: auto;
  }
  .launch-zone {
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
</style>
