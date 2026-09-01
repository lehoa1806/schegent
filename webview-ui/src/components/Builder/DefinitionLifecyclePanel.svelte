<script lang="ts">
  // Feature 186 (US1, T001, FR-001/FR-002/D-1) — the open definition's lifecycle
  // facts and actions, extracted verbatim from `DefinitionLifecycleRow.svelte`
  // (`:77-145` before this split).
  //
  // Mounted on the surface that shows the *open* definition — the Phase editor
  // card, and the Pipeline and Workflow inspectors — never on a list row. The row
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
  import type { CatalogKind } from '../../../../src/contracts/catalog-store';
  import type { BuilderLifecycle } from '../../lib/snapshot-types';
  import ChangedFieldSummary from './ChangedFieldSummary.svelte';
  import DefinitionActions from './DefinitionActions.svelte';
  import DefinitionHistoryPanel from './DefinitionHistoryPanel.svelte';
  import {
    deriveDefinitionRowView,
    type DefinitionDefect
  } from './definition-row-state';

  interface Props {
    /** Which catalog the definition belongs to — part of every lifecycle target. */
    kind: CatalogKind;
    /** The definition's own id — the panel's test handle, and its label's suffix. */
    definitionId: string;
    /** What the confirmations name. The id alone is not what the operator recognises. */
    definitionName: string;
    /** Absent on a host with no catalog store wired; the whole panel goes with it. */
    lifecycle?: BuilderLifecycle;
    defects: readonly DefinitionDefect[];
  }

  const { kind, definitionId, definitionName, lifecycle, defects }: Props = $props();

  const view = $derived(lifecycle ? deriveDefinitionRowView(lifecycle) : null);

  let historyOpen = $state(false);
  /** Handed to the panel so focus comes back here when it closes (FR-030b). */
  let historyToggle = $state<HTMLButtonElement | null>(null);
</script>

{#if lifecycle && view}
  <div class="definition-lifecycle-panel" data-testid="definition-lifecycle-panel-{definitionId}">
    <dl class="row-cells">
      <div class="row-cell">
        <dt class="cell-label">Created</dt>
        <dd class="cell-value" data-testid="definition-row-created-{definitionId}">
          {view.createdDisplay}
        </dd>
      </div>
      <div class="row-cell">
        <dt class="cell-label">Modified</dt>
        <dd class="cell-value" data-testid="definition-row-modified-{definitionId}">
          {view.modifiedDisplay}
        </dd>
      </div>
      <div class="row-cell">
        <dt class="cell-label">Active version</dt>
        <dd class="cell-value" data-testid="definition-row-active-version-{definitionId}">
          {view.activeVersionCell}
        </dd>
      </div>
    </dl>
    {#if defects.length > 0}
      <!-- "Available on demand", unchanged from today (FR-015): collapsed by
           default so an invalid row costs one line, and every defect at once when
           opened rather than the head one — the same reason FR-023 reports a
           refused publish all at once. -->
      <details class="row-defects" data-testid="definition-row-defects-{definitionId}">
        <summary>{defects.length} {defects.length === 1 ? 'defect' : 'defects'}</summary>
        <ul>
          {#each defects as defect (defect.field + defect.code + defect.message)}
            <li><span class="defect-field">{defect.field}</span>: {defect.message}</li>
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
        class="history-toggle"
        bind:this={historyToggle}
        data-testid="definition-history-toggle-{definitionId}"
        aria-expanded={historyOpen}
        aria-controls="definition-history-{definitionId}"
        onclick={() => (historyOpen = !historyOpen)}
        >{historyOpen ? 'Hide history' : 'History'}</button
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
  .definition-lifecycle-panel {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px;
  }

  .row-cells {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
    margin: 0;
  }

  .row-cell {
    display: flex;
    gap: 4px;
    align-items: baseline;
  }

  .cell-label {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }

  .cell-value {
    margin: 0;
    font-size: 0.85em;
  }

  .row-actions {
    align-items: flex-start;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .history-toggle {
    background: transparent;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 2px;
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 0.85em;
    padding: 1px 6px;
  }

  .history-toggle:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }

  .row-defects {
    font-size: 0.85em;
  }

  .row-defects summary {
    cursor: pointer;
    color: var(--vscode-errorForeground);
  }

  .row-defects ul {
    margin: 2px 0 0;
    padding-left: 18px;
  }

  .defect-field {
    font-weight: 600;
  }
</style>
