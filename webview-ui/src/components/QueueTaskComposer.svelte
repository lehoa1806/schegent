<script lang="ts">
  // Queue task composition reuses the validated launch forms and binds every submission
  // to the Queue being viewed. Execution monitoring lives in Queue task detail.
  //
  // Feature 285 (OD-2, FR-001): Workflows only. The Pipeline section and its RunLauncher arm
  // are retired; `pipelines` is still read for a stored Workflow whose start node names a
  // legacy Pipeline (FR-011), whose output ports and name come from that Pipeline.
  import TrustBanner from './TrustBanner.svelte';
  import LaunchableSection from './Runs/LaunchableSection.svelte';
  import LaunchableDetail from './Runs/LaunchableDetail.svelte';
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

  /**
   * Feature 285 (FR-006a) — the default Workflow is preselected once, the first time the
   * projection offers it while nothing is selected. Once it has been applied, or the operator
   * has chosen, it is not applied again: a cleared selection stays cleared. Preselection
   * opens no form and submits nothing.
   */
  let defaultApplied = false;

  $effect(() => {
    if (defaultApplied || selection !== null) return;
    const defaultId = snapshot.defaultWorkflowId;
    if (defaultId === undefined || defaultId === '') return;
    const candidate: LaunchSelection = { kind: 'workflow', id: defaultId };
    if (selectedEntry(launchables, candidate) === undefined) return;
    defaultApplied = true;
    selection = candidate;
  });

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
    defaultApplied = true;
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

  <p class="network-notice" data-testid="dashboard-network-dependence-note">
    Local-first, not offline: running this queue may contact configured backend providers.
  </p>
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
  .network-notice {
    margin: 0;
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-caption);
    line-height: 1.35;
  }
  .zone-title {
    font-size: 0.9em;
    font-weight: 600;
    color: var(--schegent-muted-fg);
    letter-spacing: 0.05em;
  }
</style>
