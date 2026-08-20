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
  // Feature 098 (T057, FR-030a) revises the second of those in one direction
  // and leaves it standing in the other. The picker still appears only when
  // there is something to pick — but the zone around it now stays mounted with
  // nothing imported, showing the guidance in place of the choices. Hiding the
  // whole zone was right when an empty catalog was a transient state of a
  // product that shipped Pipelines; it is wrong now that it is the state every
  // install starts in, because it leaves the operator no visible route from an
  // empty catalog to a non-empty one and leaves `RunLauncher.svelte` reachable
  // from nowhere.
  //
  // Operator-authored strings — Pipeline names, run and workflow identifiers —
  // are interpolated with `{}`, which escapes. Nothing here uses `{@html}`.
  //
  // Feature 102 (US1, T014, FR-020) — the compose controls are gone and the two
  // launch sections stand in their place. The `<select>` offered the *effective
  // Pipeline catalog* and nothing else: no Workflows, no version, and no way to
  // tell a definition that is published from one that merely exists. What
  // replaces it is a projection built host-side, which is where the answer to
  // "what is published" already lives.
  //
  // The connected-runs zone above is untouched (FR-020). It answers a different
  // question — what is already under way — and the restructure is about what can
  // be started.
  //
  // The FR-030a guidance moved with the choices it replaced. It belonged beside
  // the picker because the picker was the thing an empty catalog left useless;
  // now each section knows its own empty reason, and one guidance line above two
  // sections that each state their own would be the surface saying it twice.
  //
  // Feature 102 (T046, US5 — FR-032) — with one exception, which is why this
  // surface still owns a decision about emptiness at all. An untrusted workspace
  // activates no catalog (099 FR-051), so both sections would resolve to
  // "no definitions" and both would tell the operator to import something. That is
  // a true reading of an empty catalog and a false account of why it is empty:
  // importing cannot succeed here, and neither can publishing. The trust
  // explanation replaces the whole launch zone rather than sitting above it,
  // because a section left rendering beneath the banner would still be offering
  // its own wrong remedy.
  //
  // Read as `=== false`, never as falsy. `workspaceTrust` is optional on the
  // projection for hosts that predate feature 059, and an absent field means "this
  // host does not report trust", not "untrusted" — treating it as the latter would
  // hide the launch surface from every one of them. Fail-closed belongs on the
  // host gate that actually refuses a launch, not on an explanatory banner.

  // Feature 102 (T022 to T024, US2 — FR-013 to FR-015) — the surface holds the
  // selection, and it is the only thing on Runs that holds any state at all.
  //
  // It lives here rather than in either section because there is exactly one of
  // it: two sections each keeping their own would have to be told when the other
  // changed, and "selected in both" would be reachable by forgetting to tell.
  // Held here, it is unrepresentable.
  //
  // Selecting is a toggle. The row reports `aria-pressed`, and a control that
  // announces itself as pressed and cannot be un-pressed is lying about what a
  // second press does. Any change to the selection — to another definition or to
  // none — closes an open form, because the values in it were composed against
  // the definition being left behind.

  // Feature 102 (T028, US3 — FR-016, FR-017, FR-043) — the Workflow half of the
  // Trigger action mounts here, beside `RunLauncher`, rather than inside
  // `LaunchableDetail` as the task text reads.
  //
  // The detail panel reads and does not edit — T017 sweeps it for form controls
  // and requires none — so a form mounted inside it would fail the rule the panel
  // exists to keep. The Pipeline form is already a sibling for that reason, and
  // putting the two composers on different sides of the same boundary would make
  // "where does the form live" a question with two answers.
  //
  // The two arms are exclusive by construction: they branch on `selection.kind`,
  // which holds one value.

  import WorkflowRun from './WorkflowRun/WorkflowRun.svelte';
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
  }

  const { snapshot }: Props = $props();

  const connectedRuns = $derived(snapshot.connectedRuns ?? []);
  const pipelines = $derived(snapshot.availablePipelines ?? []);
  const queueItems = $derived(snapshot.queue?.orderedItems ?? []);

  /**
   * What Runs may start (FR-001). Absent until the host has resolved both
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
  const canLaunch = $derived(snapshot.isPrimary === true);

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

  <section class="launch-zone" data-testid="runs-surface-launch-zone">
    <header class="zone-title">Start a Run</header>
    {#if untrusted}
      <TrustBanner variant="workspace-trust" />
    {:else}
      <LaunchableSection
        name="Pipelines"
        kind="pipeline"
        section={launchables?.pipelines}
        {selection}
        {onSelect}
      />
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
        <RunLauncher pipeline={selectedPipeline} onClose={() => (triggered = false)} />
      {/if}
      {#if triggered && selected?.kind === 'workflow'}
        <WorkflowTriggerForm
          entry={selected}
          graph={selectedGraph}
          {pipelines}
          onClose={() => (triggered = false)}
        />
      {/if}
    {/if}
  </section>
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
</style>
