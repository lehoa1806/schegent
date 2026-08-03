<script lang="ts">
  // Feature 083 (US5, T055/T056, FR-036) — the Library list.
  //
  // Split out of WorkflowCatalogEditor so that file stays inside the
  // repository-wide 500-line Svelte budget. A row summarises the whole
  // definition — scope, purpose, Pipeline sequence, derived ports, validation
  // state — so an operator who did not author it can tell what it does and
  // whether it currently resolves, without selecting it first.
  //
  // The derived ports are the host's projection, never recomputed here: they
  // exist on no persisted row (FR-048), so a row the host has not projected
  // says so rather than showing an empty list that would read as "none".
  import type { MutableWorkflow } from './types';

  interface Props {
    rows: readonly MutableWorkflow[];
    selectedKey: string | null;
    onselect: (sourceKey: string) => void;
  }

  const { rows, selectedKey, onselect }: Props = $props();
</script>

<div class="phase-list">
  {#each rows as row (row.sourceKey)}
    <div class="phase-list-row">
      <button
        class="phase-list-item {selectedKey === row.sourceKey ? 'selected' : ''}"
        data-testid="workflows-list-item-{row.scope}-{row.workflowId}"
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
        <div class="phase-badges">
          <span class="scope-badge">{row.scope}</span>
          <span class="status-badge status-{row.sourceStatus}">{row.sourceStatus}</span>
          <span class="node-count">
            {row.nodes.length}
            {row.nodes.length === 1 ? 'node' : 'nodes'}
          </span>
        </div>
      </button>
    </div>
  {/each}
  {#if rows.length === 0}
    <div class="catalog-state" data-testid="workflows-empty">
      No Workflows yet. Add one to compose Pipelines into a graph.
    </div>
  {/if}
</div>
