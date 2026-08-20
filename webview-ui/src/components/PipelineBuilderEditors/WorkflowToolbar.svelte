<script lang="ts">
  // Feature 083 (US5, T059) — the Library's action bar.
  //
  // Split out of WorkflowCatalogEditor so that file stays inside the
  // repository-wide 500-line Svelte budget. It holds no rules: every control is
  // enabled by a flag the editor derives, and every click calls back.
  //
  // The two destructive controls raise their handler and nothing else — the
  // confirmation lives with the mutation it authorises, in
  // `workflow-catalog-actions.ts`, so this file has no way to send a write and
  // no way to skip the prompt.
  //
  // Feature 086 T017 — Export is the one control here that owns its own rule, and
  // deliberately so. Every other control mutates, so its gate is a mutation gate
  // the editor derives from trust, readiness, and a pending save. Export writes
  // nothing this extension owns (research R2), needs neither trust nor an idle
  // save, and shares none of those flags; its single precondition is that the
  // catalog actually holds the row, which is readable from the selection itself.
  // Deriving it in the editor would mean threading a flag whose inputs live here.
  //
  // Feature 099 (T494a, FR-043) — no scope picker. A save had a destination to
  // choose while there were three layers; there is one, so the control is gone.
  //
  // Feature 100 (FR-R3-016) T509b — and Reset Catalog is gone with it. It emptied
  // the layer in one write, which the store can no longer do: definitions are
  // addressed by id and removal is one confirmed deactivation each. A button whose
  // atomicity the store does not provide is a button that lies, so it is deleted
  // rather than reimplemented as a loop behind a single prompt.
  import type { WorkflowExportInclusion } from '../../lib/messages';
  import { exportWorkflowYaml } from '../../lib/process-yaml-ipc';
  import type { MutableWorkflow } from './types';

  /**
   * Feature 086 T023 (FR-013) — the depths this control offers, each with the
   * words an operator decides by rather than the identifier the request carries.
   *
   * A list, not a boolean, because a Workflow has two levels of dependency below
   * it: "the Pipelines" and "the Pipelines and their Phases" are different
   * answers and neither is the negation of the other. The Pipeline equivalent is
   * a checkbox precisely because one level admits only two depths.
   *
   * Every arm of `WorkflowExportInclusion`, and only because each one now has a
   * host arm that produces its payload (T028). The list was deliberately shorter
   * while `included.phases` was unrendered: a control offering a depth the
   * exporter ignored would have handed back a document missing the payload it
   * named with no error to say so. An option lands with its host arm, never ahead
   * of it.
   */
  const INCLUSIONS: readonly { readonly value: WorkflowExportInclusion; readonly label: string }[] =
    [
      { value: 'references-only', label: 'References only' },
      { value: 'include-pipelines', label: 'Include Pipeline definitions' },
      { value: 'include-closure', label: 'Include Pipelines and their Phases' }
    ];

  interface Props {
    savePending: boolean;
    mutatingDisabled: boolean;
    /** The effective Pipeline catalog resolved and holds nothing (FR-045). */
    noPipelines: boolean;
    duplicateDisabled: boolean;
    removeDisabled: boolean;
    saveDisabled: boolean;
    /** The Library row in focus, or null when nothing is selected. */
    selected: MutableWorkflow | null;
    onadd: () => void;
    onduplicate: () => void;
    onremove: (event: MouseEvent) => void;
    onsave: () => void;
  }

  const {
    savePending,
    mutatingDisabled,
    noPipelines,
    duplicateDisabled,
    removeDisabled,
    saveDisabled,
    selected,
    onadd,
    onduplicate,
    onremove,
    onsave
  }: Props = $props();

  /**
   * Why the selected Workflow cannot be exported, or `null` when it can.
   *
   * An unsaved draft is the one case decided here: export reads the catalog, and
   * a draft is not in it yet, so the host would answer `not-found` for an id it
   * has never seen (US1 scenario 3). Saying so beside the control is better than
   * sending a request whose only possible answer is a refusal.
   *
   * Nothing else is pre-checked. A stored Workflow whose Pipelines are missing
   * from every layer is still exportable, graph intact (FR-016) — refusing it
   * here would break the exact case that requirement exists for. Whether a row
   * resolves is the host's decision, because only the host reads the effective
   * catalog and only it can tell a missing reference from a structural defect.
   */
  const exportDisabledReason = $derived(
    selected === null || selected.persisted
      ? null
      : 'Save this Workflow first. Export writes the definition the catalog holds, not an unsaved draft.'
  );

  /**
   * Feature 086 T023 (FR-013) — the inclusion choice, made BEFORE the document is
   * produced rather than discovered in the save dialog after it.
   *
   * A property of how this operator is handing the definition over, not of the
   * Workflow, so it survives changing the selection instead of resetting under
   * someone exporting several rows in a row. Nothing is persisted: it describes
   * one session's exports, and the default is the smallest document (FR-013).
   */
  let inclusion = $state<WorkflowExportInclusion>('references-only');

  /**
   * FR-013 / FR-015 — references only unless the operator asked for the
   * definitions. Either way `spec` is untouched: inclusion adds a section and
   * never rewrites a node's `pipelineId` into an inline body (FR-009).
   *
   * Whether every referenced Pipeline actually resolves is the host's call
   * (FR-016, FR-018): only it reads the effective catalog, and only it can tell a
   * missing reference from a structural defect. Pre-checking here would refuse
   * exports the host would have allowed and would need a second copy of the
   * resolution rule to do it.
   *
   * No location is named here and none comes back: the host opens its own save
   * dialog (FR-019, FR-057).
   */
  function onExport(): void {
    if (exportDisabledReason !== null || selected === null) return;
    exportWorkflowYaml(selected.workflowId, inclusion);
  }
</script>

<div class="toolbar">
  <button
    class="btn btn-secondary"
    data-testid="workflows-duplicate"
    disabled={duplicateDisabled}
    onclick={onduplicate}
  >
    Duplicate
  </button>
  <button
    class="btn btn-primary"
    data-testid="workflows-add"
    onclick={onadd}
    disabled={mutatingDisabled}
  >
    Add Workflow
  </button>
  <button
    class="btn btn-secondary destructive"
    data-testid="workflows-remove"
    disabled={removeDisabled}
    onclick={onremove}
  >
    Delete
  </button>
  <!-- FR-013 — the choice sits beside the control it changes, so it is made
       before the document is produced rather than after. Disabled on exactly the
       condition Export is: there is no depth to choose for a row that cannot be
       exported at all. -->
  <label class="scope-select">
    Include
    <select
      data-testid="workflows-export-inclusion"
      value={inclusion}
      disabled={selected === null || exportDisabledReason !== null}
      aria-label="Workflow export inclusion"
      title="How much of the Workflow's dependencies the document carries"
      onchange={(event) => (inclusion = event.currentTarget.value as WorkflowExportInclusion)}
    >
      {#each INCLUSIONS as depth (depth.value)}
        <option value={depth.value}>{depth.label}</option>
      {/each}
    </select>
  </label>
  <!-- Export is read-only: it needs neither trust nor an idle save, because it
       writes nothing this extension owns. -->
  <button
    class="btn btn-secondary"
    data-testid="workflows-export"
    disabled={selected === null || exportDisabledReason !== null}
    title={exportDisabledReason ?? 'Export the selected Workflow as a document'}
    aria-describedby={exportDisabledReason !== null ? 'workflows-export-reason' : undefined}
    onclick={onExport}
  >
    Export Workflow
  </button>
  <button
    class="btn btn-secondary"
    data-testid="workflows-save-all"
    style="margin-left:auto"
    onclick={onsave}
    disabled={saveDisabled}
  >
    {savePending ? 'Saving…' : 'Save Workflow'}
  </button>
</div>

<!--
  Same principle as the Save prerequisite below: the reason sits with the control
  it disables, so an operator does not have to guess why Export is dead.
-->
{#if exportDisabledReason !== null}
  <div
    class="catalog-state"
    role="status"
    aria-live="polite"
    id="workflows-export-reason"
    data-testid="workflows-export-disabled-reason"
  >
    {exportDisabledReason}
  </div>
{/if}

<!--
  The explanation sits with the control it explains: a disabled Save with no
  reason beside it is the failure FR-045 exists to prevent. Announced politely
  so a refresh that resolves the prerequisite reaches a screen reader too.
-->
{#if noPipelines}
  <div
    class="catalog-state"
    role="status"
    aria-live="polite"
    data-testid="workflows-no-pipelines"
  >
    No effective Pipeline is available. Every Workflow node runs a Pipeline, so add or restore at
    least one valid Pipeline in the Pipeline Library before saving a Workflow.
  </div>
{/if}
