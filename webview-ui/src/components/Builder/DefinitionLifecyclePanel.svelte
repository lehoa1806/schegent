<script lang="ts">
  // Feature 186 (US1, T001, FR-001/FR-002/D-1) — the open definition's lifecycle
  // facts and actions, extracted verbatim from `DefinitionLifecycleRow.svelte`
  // (`:77-145` before this split).
  //
  // Mounted on the surface that shows the *open* definition — the Phase editor
  // page and the Workflow settings inspector — never on a list row. The row
  // keeps only its two badges (`DefinitionLifecycleRow.svelte`); everything else
  // that used to render beside them lives here now: Created, Modified, Active
  // version, the collapsed defect list, `ChangedFieldSummary`, the four lifecycle
  // actions (`DefinitionActions` at `surface="row"`), and the History toggle with
  // its inline expansion.
  //
  // Every element here is withheld when `lifecycle` is absent, unchanged from the
  // row's own reason: a host with no catalog store behind it has no draft token
  // to quote, so every one of these would be refused. An offer that cannot
  // succeed is worse than no offer.
  //
  // Text interpolation only, never Svelte's raw-HTML directive (FR-038): version
  // ids, defect fields, and defect messages all originate in operator-authored
  // documents.
  import type { CatalogKind } from "../../../../src/contracts/catalog-store";
  import type { BuilderLifecycle } from "../../lib/snapshot-types";
  import ChangedFieldSummary from "./ChangedFieldSummary.svelte";
  import DefinitionActions from "./DefinitionActions.svelte";
  import DefinitionHistoryPanel from "./DefinitionHistoryPanel.svelte";
  import {
    deriveDefinitionRowView,
    type DefinitionDefect,
  } from "./definition-row-state";

  interface Props {
    /** Which catalog the definition belongs to — part of every lifecycle target. */
    kind: CatalogKind | "pipeline";
    /** The definition's own id — the panel's test handle, and its label's suffix. */
    definitionId: string;
    /** What the confirmations name. The id alone is not what the operator recognises. */
    definitionName: string;
    /** Absent on a host with no catalog store wired; the whole panel goes with it. */
    lifecycle?: BuilderLifecycle;
    defects: readonly DefinitionDefect[];
  }

  const { kind, definitionId, definitionName, lifecycle, defects }: Props =
    $props();

  const view = $derived(lifecycle ? deriveDefinitionRowView(lifecycle) : null);

  let historyOpen = $state(false);
  /** Handed to the panel so focus comes back here when it closes (FR-030b). */
  let historyToggle = $state<HTMLButtonElement | null>(null);
</script>

{#if lifecycle && view}
  <div
    class="definition-lifecycle-panel"
    data-testid="definition-lifecycle-panel-{definitionId}"
  >
    <!-- sg-core's key and value list, the one the redesign's Summary card draws
         its facts with. The pairs are the list's own children, so its grid sets
         every key in one column. -->
    <dl class="kv">
      <dt>Created</dt>
      <dd data-testid="definition-row-created-{definitionId}">
        {view.createdDisplay}
      </dd>
      <dt>Modified</dt>
      <dd data-testid="definition-row-modified-{definitionId}">
        {view.modifiedDisplay}
      </dd>
      <dt>Active version</dt>
      <dd data-testid="definition-row-active-version-{definitionId}">
        {view.activeVersionCell}
      </dd>
    </dl>
    {#if defects.length > 0}
      <!-- "Available on demand", unchanged from today (FR-015): collapsed by
           default so an invalid row costs one line, and every defect at once when
           opened rather than the head one — the same reason FR-023 reports a
           refused publish all at once. Not `row-defects`: the Workflows list's
           sheet styles that name for its own rows. -->
      <details
        class="panel-defects"
        data-testid="definition-row-defects-{definitionId}"
      >
        <summary
          >{defects.length}
          {defects.length === 1 ? "defect" : "defects"}</summary
        >
        <ul>
          {#each defects as defect (defect.field + defect.code + defect.message)}
            <li>
              <span class="defect-field">{defect.field}</span>: {defect.message}
            </li>
          {/each}
        </ul>
      </details>
    {/if}
    {#if lifecycle.changedFields}
      <!-- Feature 101 (US5, T061, FR-026) — beside Publish, above it rather than
           in front of it: informative, never a gate. Mounted on the presence of
           the projection, not on a state re-derived here. The host sends
           `changedFields` only for `active-with-draft`, and honouring that
           presence leaves a projection bug visible instead of papered over. -->
      <ChangedFieldSummary {definitionId} summary={lifecycle.changedFields} />
    {/if}
    <div class="row-actions">
      <DefinitionActions {kind} {definitionId} {definitionName} {lifecycle} />
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        bind:this={historyToggle}
        data-testid="definition-history-toggle-{definitionId}"
        aria-expanded={historyOpen}
        aria-controls="definition-history-{definitionId}"
        onclick={() => (historyOpen = !historyOpen)}
        >{historyOpen ? "Hide history" : "History"}</button
      >
    </div>
    {#if historyOpen}
      <DefinitionHistoryPanel
        {kind}
        {definitionId}
        {definitionName}
        {lifecycle}
        opener={historyToggle}
        onclose={() => (historyOpen = false)}
      />
    {/if}
  </div>
{/if}

<style>
  /* No frame of its own: the panel sits in a card (the Phase page's Summary, a
     Workflow's inspector), and its facts continue that card's list. sg-core's
     `.kv` sets the facts and `.btn` the buttons. A row gap only, so a host that
     sets the panel on its own grid keeps that grid's column gap. */
  .definition-lifecycle-panel {
    display: flex;
    flex-direction: column;
    row-gap: var(--schegent-space-3);
  }

  .row-actions {
    align-items: flex-start;
    display: flex;
    flex-wrap: wrap;
    gap: var(--schegent-space-1-5);
  }

  .panel-defects {
    font-size: var(--schegent-text-secondary);
  }

  .panel-defects summary {
    color: var(--schegent-error-text);
  }

  .panel-defects ul {
    margin: var(--schegent-space-1) 0 0;
    padding-left: 18px;
  }

  .defect-field {
    font-weight: 600;
  }
</style>
