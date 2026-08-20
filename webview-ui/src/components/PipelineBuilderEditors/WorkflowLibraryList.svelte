<script lang="ts">
  // Feature 083 (US5, T055/T056, FR-036) — the Library list.
  //
  // Split out of WorkflowCatalogEditor so that file stays inside the
  // repository-wide 500-line Svelte budget. A row summarises the whole
  // definition — purpose, Pipeline sequence, derived ports, validation state —
  // so an operator who did not author it can tell what it does and whether it
  // currently resolves, without selecting it first.
  //
  // Feature 099 (T494a, FR-043) — the summary no longer opens on a scope. There
  // is one layer, so the badge could only ever read one value and the row key
  // could only ever carry one segment.
  //
  // The derived ports are the host's projection, never recomputed here: they
  // exist on no persisted row (FR-048), so a row the host has not projected
  // says so rather than showing an empty list that would read as "none".
  //
  // Feature 101 (US1, T037) — T037 names `WorkflowCatalogEditor.svelte`, but the
  // Workflow list rows were split out here for that file's 500-line budget, so
  // this is where its rows are. The lifecycle facts arrive as a map rather than
  // on `MutableWorkflow`: the mutable row is the editable copy every save body
  // is stripped out of, and a projected view field there is one strip away from
  // being sent back to the host (FR-010).
  import type { BuilderLifecycle } from '../../lib/snapshot-types';
  import DefinitionLifecycleRow from '../Builder/DefinitionLifecycleRow.svelte';
  import type { MutableWorkflow } from './types';

  interface Props {
    rows: readonly MutableWorkflow[];
    selectedKey: string | null;
    lifecycleByKey: ReadonlyMap<string, BuilderLifecycle | undefined>;
    onselect: (sourceKey: string) => void;
  }

  const { rows, selectedKey, lifecycleByKey, onselect }: Props = $props();
</script>

<div class="phase-list">
  {#each rows as row (row.sourceKey)}
    <div class="phase-list-row">
      <button
        class="phase-list-item {selectedKey === row.sourceKey ? 'selected' : ''}"
        data-testid="workflows-list-item-{row.workflowId}"
        aria-current={selectedKey === row.sourceKey ? 'true' : undefined}
        onclick={() => onselect(row.sourceKey)}
      >
        <div class="phase-list-title">{row.name || 'Untitled Workflow'}</div>
        <div class="phase-list-id">{row.workflowId}</div>
        <div class="phase-list-purpose">{row.description || 'No purpose recorded.'}</div>
        <div class="row-ports" data-testid="workflow-row-sequence">
          {#if row.nodes.length === 0}
            <span>No Pipelines yet</span>
          {:else}
            <!-- Authored order, never sorted: the sequence the operator wrote
                 is part of the definition's meaning (FR-049). -->
            {#each row.nodes as node, index (node.nodeId)}
              <span>{index > 0 ? '→ ' : ''}{node.pipelineId}</span>
            {/each}
          {/if}
        </div>
        <div class="row-ports" data-testid="workflow-row-inputs">
          <span>Inputs:</span>
          {#each row.derivedInputs as port (port.nodeId + port.portId)}
            <span>{port.label || port.portId}</span>
          {/each}
          {#if row.derivedInputs.length === 0}
            <span>{row.persisted ? 'none' : 'derived once saved'}</span>
          {/if}
        </div>
        <div class="row-ports" data-testid="workflow-row-outputs">
          <span>Outputs:</span>
          {#each row.derivedOutputs as port (port.nodeId + port.portId)}
            <span>{port.label || port.portId}</span>
          {/each}
          {#if row.derivedOutputs.length === 0}
            <span>{row.persisted ? 'none' : 'derived once saved'}</span>
          {/if}
        </div>
        <!-- Feature 101 (T037) — the validity badge left with the lifecycle
             chrome below. The node count is a fact about the graph, not about
             the definition's lifecycle, so it stayed. -->
        <div class="phase-badges">
          <span class="node-count">
            {row.nodes.length}
            {row.nodes.length === 1 ? 'node' : 'nodes'}
          </span>
        </div>
      </button>
      <!-- Outside the selection button, not inside it: T042 hung the lifecycle
           actions off this row, and a control nested in a button is invalid
           markup and unreachable by keyboard. -->
      <DefinitionLifecycleRow
        kind="workflow"
        definitionId={row.workflowId}
        definitionName={row.name || 'Untitled Workflow'}
        lifecycle={lifecycleByKey.get(row.sourceKey)}
        validity={row.sourceStatus}
        defects={row.sourceErrors}
      />
    </div>
  {/each}
  {#if rows.length === 0}
    <div class="catalog-state" data-testid="workflows-empty">
      No Workflows yet. Add one to compose Pipelines into a graph.
    </div>
  {/if}
</div>
