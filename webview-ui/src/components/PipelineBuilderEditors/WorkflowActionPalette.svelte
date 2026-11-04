<script lang="ts">
  // Feature 183 (US2, T015, FR-007) / FR-R5-F05 — the Actions palette.
  //
  // Offers atomic Phases (`kind: 'phase'`), reusable child Workflows
  // (`kind: 'workflow'`, excluding self), transitional Pipelines, and Logic (`Split`).
  import type {
    PortablePhaseDefinition,
    PortablePipelineDefinition,
    PortableWorkflowDefinition
  } from '../../lib/snapshot-types';
  import type { WorkflowNodeTarget } from './workflow-catalog-state';

  interface Props {
    pipelines: readonly PortablePipelineDefinition[];
    phases?: readonly PortablePhaseDefinition[];
    workflows?: readonly PortableWorkflowDefinition[];
    currentWorkflowId?: string;
    readonly: boolean;
    /** The node a `Split` click will branch from, or null when nothing can split. */
    splitTargetId: string | null;
    onaddnode: (target: WorkflowNodeTarget) => void;
    onaddsplit: () => void;
  }

  const {
    pipelines,
    phases = [],
    workflows = [],
    currentWorkflowId,
    readonly: readOnly,
    splitTargetId,
    onaddnode,
    onaddsplit
  }: Props = $props();

  const childWorkflows = $derived(
    workflows.filter((wf) => wf.workflowId !== currentWorkflowId)
  );
  const isEmpty = $derived(
    phases.length === 0 && childWorkflows.length === 0 && pipelines.length === 0
  );
</script>

<aside class="wf-palette" aria-label="Workflow actions" data-testid="workflow-action-palette">
  {#if phases.length > 0}
    <div class="wf-palette-group">
      <div class="wf-palette-heading">Phases</div>
      {#each phases as phase (phase.phaseId)}
        <button
          type="button"
          class="wf-palette-item"
          data-testid="workflow-palette-phase-{phase.phaseId}"
          disabled={readOnly}
          onclick={() => onaddnode({ kind: 'phase', phaseId: phase.phaseId })}
        >
          <span class="wf-palette-item-title">{phase.name}</span>
          <span class="wf-palette-item-meta">Phase · {phase.phaseId}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if childWorkflows.length > 0}
    <div class="wf-palette-group">
      <div class="wf-palette-heading">Workflows</div>
      {#each childWorkflows as wf (wf.workflowId)}
        <button
          type="button"
          class="wf-palette-item"
          data-testid="workflow-palette-workflow-{wf.workflowId}"
          disabled={readOnly}
          onclick={() => onaddnode({ kind: 'workflow', workflowId: wf.workflowId })}
        >
          <span class="wf-palette-item-title">{wf.name}</span>
          <span class="wf-palette-item-meta">
            Workflow · {wf.nodes.length} {wf.nodes.length === 1 ? 'step' : 'steps'}
          </span>
        </button>
      {/each}
    </div>
  {/if}

  {#if isEmpty}
    <p class="wf-palette-empty" data-testid="workflow-palette-empty">
      No effective Phases or Workflows
    </p>
  {/if}

  <div class="wf-palette-group">
    <div class="wf-palette-heading">Logic</div>
    <button
      type="button"
      class="wf-palette-item"
      data-testid="workflow-palette-split"
      disabled={readOnly || splitTargetId === null}
      onclick={onaddsplit}
    >
      <span class="wf-palette-item-title">Split</span>
      <span class="wf-palette-item-meta">
        {#if splitTargetId !== null}
          Add branch on {splitTargetId}
        {:else}
          Select or add a node first
        {/if}
      </span>
    </button>
  </div>
</aside>
