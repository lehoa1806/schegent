<script lang="ts">
  // FR-R5-F05-T04 — Workflow public ports (`inputs`, `outputs`) and data `bindings` editor.
  import {
    PIPELINE_INPUT_PORT_TYPES,
    PIPELINE_OUTPUT_PORT_TYPES,
    type PipelineInputPortType,
    type PipelineOutputPortType,
    type WorkflowBinding,
    type WorkflowInputPort,
    type WorkflowOutputPort
  } from '../../lib/snapshot-types';
  import type { MutableWorkflow } from './types';
  import type { WorkflowGraphActions } from './workflow-catalog-actions';
  import type { WorkflowDraftError } from './workflow-catalog-state';
  import WorkflowRowDefects from './WorkflowRowDefects.svelte';

  interface Props {
    workflow: MutableWorkflow;
    readonly: boolean;
    actions: WorkflowGraphActions;
    defects: readonly WorkflowDraftError[];
  }

  const { workflow, readonly: readOnly, actions, defects }: Props = $props();

  const inputs = $derived(workflow.inputs ?? []);
  const outputs = $derived(workflow.outputs ?? []);
  const bindings = $derived(workflow.bindings ?? []);

  const portAndBindingDefects = $derived(
    defects.filter(
      (err) =>
        err.field.startsWith('inputs') ||
        err.field.startsWith('outputs') ||
        err.field.startsWith('bindings')
    )
  );

  function addDefaultInputBinding(): void {
    const firstNodeId = workflow.nodes[0]?.nodeId ?? '';
    const firstInputPortId = inputs[0]?.portId ?? 'input';
    actions.addBinding?.({
      kind: 'input',
      nodeId: firstNodeId,
      inputKey: firstInputPortId,
      source: { from: 'workflow-input', portId: firstInputPortId }
    });
  }

  function addDefaultOutputBinding(): void {
    const lastNodeId = workflow.nodes[workflow.nodes.length - 1]?.nodeId ?? '';
    const firstOutputPortId = outputs[0]?.portId ?? 'output';
    actions.addBinding?.({
      kind: 'output',
      nodeId: lastNodeId,
      portId: firstOutputPortId,
      outputKey: firstOutputPortId
    });
  }

  function changeBindingSourceKind(
    index: number,
    binding: Extract<WorkflowBinding, { kind: 'input' }>,
    from: 'workflow-input' | 'node-output'
  ): void {
    if (from === 'workflow-input') {
      actions.updateBinding?.(index, {
        ...binding,
        source: { from: 'workflow-input', portId: binding.source.portId }
      });
    } else {
      const upstreamNodeId =
        workflow.nodes.find((n) => n.nodeId !== binding.nodeId)?.nodeId ??
        workflow.nodes[0]?.nodeId ??
        '';
      actions.updateBinding?.(index, {
        ...binding,
        source: {
          from: 'node-output',
          nodeId: upstreamNodeId,
          portId: binding.source.portId
        }
      });
    }
  }
</script>

<div class="wf-inspector-section" data-testid="workflow-ports-bindings-editor">
  <div class="wf-inspector-heading">Public Input Ports</div>
  {#each inputs as port, index (index)}
    <div class="wf-port-row" data-testid="workflow-input-port-row-{index}">
      <label class="form-field">
        <span class="form-label">Port ID</span>
        <input
          class="text-input"
          data-testid="workflow-input-port-id-{index}"
          value={port.portId}
          readonly={readOnly}
          oninput={(event) =>
            actions.updateInputPort?.(index, { portId: event.currentTarget.value })}
        />
      </label>
      <label class="form-field">
        <span class="form-label">Label</span>
        <input
          class="text-input"
          data-testid="workflow-input-label-{index}"
          value={port.label}
          readonly={readOnly}
          oninput={(event) =>
            actions.updateInputPort?.(index, { label: event.currentTarget.value })}
        />
      </label>
      <label class="form-field">
        <span class="form-label">Type</span>
        <select
          class="select-input"
          data-testid="workflow-input-type-{index}"
          value={port.type}
          disabled={readOnly}
          onchange={(event) =>
            actions.updateInputPort?.(index, {
              type: event.currentTarget.value as PipelineInputPortType
            })}
        >
          {#each PIPELINE_INPUT_PORT_TYPES as portType (portType)}
            <option value={portType}>{portType}</option>
          {/each}
        </select>
      </label>
      <label class="form-field checkbox-field">
        <input
          type="checkbox"
          data-testid="workflow-input-required-{index}"
          checked={port.required !== false}
          disabled={readOnly}
          onchange={(event) =>
            actions.updateInputPort?.(index, { required: event.currentTarget.checked })}
        />
        <span class="form-label">Required</span>
      </label>
      {#if !readOnly}
        <button
          type="button"
          class="btn btn-ghost"
          data-testid="workflow-input-remove-{index}"
          onclick={() => actions.removeInputPort?.(index)}
        >
          Remove Input
        </button>
      {/if}
    </div>
  {/each}
  {#if !readOnly}
    <button
      type="button"
      class="btn btn-secondary"
      data-testid="workflow-inputs-add"
      onclick={() => actions.addInputPort?.()}
    >
      Add Input Port
    </button>
  {/if}

  <div class="wf-inspector-heading">Public Output Ports</div>
  {#each outputs as port, index (index)}
    <div class="wf-port-row" data-testid="workflow-output-port-row-{index}">
      <label class="form-field">
        <span class="form-label">Port ID</span>
        <input
          class="text-input"
          data-testid="workflow-output-port-id-{index}"
          value={port.portId}
          readonly={readOnly}
          oninput={(event) =>
            actions.updateOutputPort?.(index, { portId: event.currentTarget.value })}
        />
      </label>
      <label class="form-field">
        <span class="form-label">Label</span>
        <input
          class="text-input"
          data-testid="workflow-output-label-{index}"
          value={port.label}
          readonly={readOnly}
          oninput={(event) =>
            actions.updateOutputPort?.(index, { label: event.currentTarget.value })}
        />
      </label>
      <label class="form-field">
        <span class="form-label">Type</span>
        <select
          class="select-input"
          data-testid="workflow-output-type-{index}"
          value={port.type}
          disabled={readOnly}
          onchange={(event) =>
            actions.updateOutputPort?.(index, {
              type: event.currentTarget.value as PipelineOutputPortType
            })}
        >
          {#each PIPELINE_OUTPUT_PORT_TYPES as portType (portType)}
            <option value={portType}>{portType}</option>
          {/each}
        </select>
      </label>
      <label class="form-field checkbox-field">
        <input
          type="checkbox"
          data-testid="workflow-output-required-{index}"
          checked={port.required !== false}
          disabled={readOnly}
          onchange={(event) =>
            actions.updateOutputPort?.(index, { required: event.currentTarget.checked })}
        />
        <span class="form-label">Required</span>
      </label>
      {#if !readOnly}
        <button
          type="button"
          class="btn btn-ghost"
          data-testid="workflow-output-remove-{index}"
          onclick={() => actions.removeOutputPort?.(index)}
        >
          Remove Output
        </button>
      {/if}
    </div>
  {/each}
  {#if !readOnly}
    <button
      type="button"
      class="btn btn-secondary"
      data-testid="workflow-outputs-add"
      onclick={() => actions.addOutputPort?.()}
    >
      Add Output Port
    </button>
  {/if}

  <div class="wf-inspector-heading">Port & Step Bindings</div>
  {#each bindings as binding, index (index)}
    <div class="wf-binding-row" data-testid="workflow-binding-row-{index}">
      {#if binding.kind === 'input'}
        <label class="form-field">
          <span class="form-label">Target Node</span>
          <select
            class="select-input"
            data-testid="workflow-binding-node-{index}"
            value={binding.nodeId}
            disabled={readOnly}
            onchange={(event) =>
              actions.updateBinding?.(index, { ...binding, nodeId: event.currentTarget.value })}
          >
            {#each workflow.nodes as node (node.nodeId)}
              <option value={node.nodeId}>{node.label || node.nodeId}</option>
            {/each}
          </select>
        </label>
        <label class="form-field">
          <span class="form-label">Input Key / Port</span>
          <input
            class="text-input"
            data-testid="workflow-binding-input-key-{index}"
            value={binding.inputKey}
            readonly={readOnly}
            oninput={(event) =>
              actions.updateBinding?.(index, { ...binding, inputKey: event.currentTarget.value })}
          />
        </label>
        <label class="form-field">
          <span class="form-label">Source Kind</span>
          <select
            class="select-input"
            data-testid="workflow-binding-source-kind-{index}"
            value={binding.source.from}
            disabled={readOnly}
            onchange={(event) =>
              changeBindingSourceKind(
                index,
                binding,
                event.currentTarget.value as 'workflow-input' | 'node-output'
              )}
          >
            <option value="workflow-input">Workflow Input</option>
            <option value="node-output">Upstream Node Output</option>
          </select>
        </label>
        {#if binding.source.from === 'node-output'}
          {@const nodeOutputSource = binding.source}
          <label class="form-field">
            <span class="form-label">Source Node</span>
            <select
              class="select-input"
              data-testid="workflow-binding-source-node-{index}"
              value={nodeOutputSource.nodeId}
              disabled={readOnly}
              onchange={(event) =>
                actions.updateBinding?.(index, {
                  ...binding,
                  source: { ...nodeOutputSource, nodeId: event.currentTarget.value }
                })}
            >
              {#each workflow.nodes as node (node.nodeId)}
                <option value={node.nodeId}>{node.label || node.nodeId}</option>
              {/each}
            </select>
          </label>
        {/if}
        <label class="form-field">
          <span class="form-label">Source Port / Key</span>
          <input
            class="text-input"
            data-testid="workflow-binding-source-port-{index}"
            value={binding.source.portId}
            readonly={readOnly}
            oninput={(event) =>
              actions.updateBinding?.(index, {
                ...binding,
                source: { ...binding.source, portId: event.currentTarget.value }
              })}
          />
        </label>
      {:else}
        <label class="form-field">
          <span class="form-label">Workflow Output Port</span>
          <input
            class="text-input"
            data-testid="workflow-binding-output-port-{index}"
            value={binding.portId}
            readonly={readOnly}
            oninput={(event) =>
              actions.updateBinding?.(index, { ...binding, portId: event.currentTarget.value })}
          />
        </label>
        <label class="form-field">
          <span class="form-label">Source Node</span>
          <select
            class="select-input"
            data-testid="workflow-binding-node-{index}"
            value={binding.nodeId}
            disabled={readOnly}
            onchange={(event) =>
              actions.updateBinding?.(index, { ...binding, nodeId: event.currentTarget.value })}
          >
            {#each workflow.nodes as node (node.nodeId)}
              <option value={node.nodeId}>{node.label || node.nodeId}</option>
            {/each}
          </select>
        </label>
        <label class="form-field">
          <span class="form-label">Node Output Key / Port</span>
          <input
            class="text-input"
            data-testid="workflow-binding-source-port-{index}"
            value={binding.sourcePortId ?? binding.outputKey ?? binding.portId}
            readonly={readOnly}
            oninput={(event) =>
              actions.updateBinding?.(index, {
                ...binding,
                outputKey: event.currentTarget.value,
                sourcePortId: event.currentTarget.value
              })}
          />
        </label>
      {/if}
      {#if !readOnly}
        <button
          type="button"
          class="btn btn-ghost"
          data-testid="workflow-binding-remove-{index}"
          onclick={() => actions.removeBinding?.(index)}
        >
          Remove Binding
        </button>
      {/if}
    </div>
  {/each}
  {#if !readOnly}
    <div class="wf-binding-actions">
      <button
        type="button"
        class="btn btn-secondary"
        data-testid="workflow-bindings-add-input"
        disabled={workflow.nodes.length === 0}
        onclick={addDefaultInputBinding}
      >
        Add Input Binding
      </button>
      <button
        type="button"
        class="btn btn-secondary"
        data-testid="workflow-bindings-add-output"
        disabled={workflow.nodes.length === 0}
        onclick={addDefaultOutputBinding}
      >
        Add Output Binding
      </button>
    </div>
  {/if}

  <WorkflowRowDefects id="workflow-ports-bindings-errors" defects={portAndBindingDefects} />
</div>

