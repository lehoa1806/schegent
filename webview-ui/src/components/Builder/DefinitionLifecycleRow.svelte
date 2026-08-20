<script lang="ts">
  // Feature 101 (US1, T036, FR-013) — the lifecycle chrome of one definition row.
  //
  // One component for all three lifecycle kinds. What differs between Phases,
  // Pipelines, and Workflows — the name, the id, the selection button, a Phase's
  // model-availability note, a Workflow's node count — stays with each editor.
  // What is identical is here, so the em dash and the badge wording have one
  // implementation rather than three that can drift apart one tab at a time.
  //
  // It renders *beside* the selection button rather than inside it. The button is
  // interactive and T042 hangs the lifecycle actions off this row; a control
  // nested in a button is invalid markup and unreachable by keyboard, so the
  // structure that admits those actions is the one it has.
  //
  // Feature 101 (US3, T042) — the actions arrived. They are withheld along with
  // the cells when `lifecycle` is absent, and for the same reason: a host with no
  // catalog store behind it has no draft token to quote, so every one of them
  // would be refused. An offer that cannot succeed is worse than no offer.
  //
  // Text interpolation only, never Svelte's raw-HTML directive (FR-038): version
  // ids, defect fields, and defect messages all originate in operator-authored
  // documents. The directive is not named here in full because the test that
  // enforces its absence greps this file for the token.
  // Feature 101 (US4, T057, FR-030a) — the history expands the row in place. The
  // toggle lives here rather than in `DefinitionActions` because it opens a
  // surface; it writes nothing, and the four things that do write all go through
  // that component's one dispatch path (FR-025).
  import type { CatalogKind } from '../../../../src/contracts/catalog-store';
  import type { BuilderLifecycle } from '../../lib/snapshot-types';
  import ChangedFieldSummary from './ChangedFieldSummary.svelte';
  import DefinitionActions from './DefinitionActions.svelte';
  import DefinitionHistoryPanel from './DefinitionHistoryPanel.svelte';
  import {
    deriveDefinitionRowView,
    type DefinitionDefect,
    type DefinitionValidity
  } from './definition-row-state';

  interface Props {
    /** Which catalog the definition belongs to — part of every lifecycle target. */
    kind: CatalogKind;
    /** The definition's own id — the row's test handle, and its label's suffix. */
    definitionId: string;
    /** What the confirmations name. The id alone is not what the operator recognises. */
    definitionName: string;
    /** Absent on a host with no catalog store wired; the cells go with it. */
    lifecycle?: BuilderLifecycle;
    validity: DefinitionValidity;
    defects: readonly DefinitionDefect[];
  }

  const { kind, definitionId, definitionName, lifecycle, validity, defects }: Props = $props();

  const view = $derived(lifecycle ? deriveDefinitionRowView(lifecycle) : null);

  let historyOpen = $state(false);
  /** Handed to the panel so focus comes back here when it closes (FR-030b). */
  let historyToggle = $state<HTMLButtonElement | null>(null);
</script>

<div class="definition-lifecycle-row" data-testid="definition-row-{definitionId}">
  <div class="row-badges">
    {#if lifecycle && view}
      <span
        class="status-badge state-badge state-{lifecycle.state}"
        data-testid="definition-row-state-{definitionId}">{view.stateBadge}</span
      >
    {/if}
    <!-- Feature 099 (T494a, FR-043) — no scope badge; one layer leaves it one
         value to read, which is not a badge. Validity is the badge that stayed,
         and FR-015 keeps it reading exactly as it did. -->
    <span
      class="status-badge status-{validity}"
      data-testid="definition-row-validity-{definitionId}">{validity}</span
    >
  </div>
  {#if view}
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
  {/if}
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
  {#if lifecycle?.changedFields}
    <!-- Feature 101 (US5, T061, FR-026) — beside Publish, above it rather than
         in front of it: informative, never a gate. Mounted on the presence of
         the projection, not on a state re-derived here. The host sends
         `changedFields` only for `active-with-draft`, and honouring that
         presence leaves a projection bug visible instead of papered over. -->
    <ChangedFieldSummary {definitionId} summary={lifecycle.changedFields} />
  {/if}
  {#if lifecycle}
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
  {/if}
</div>

<style>
  .definition-lifecycle-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 2px 8px 6px;
  }

  .row-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
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
