<script lang="ts">
  // Feature 083 (US4, T048; US5, T056) — the list Builder: node rows,
  // connection rows, and condition authoring.
  //
  // Split out of WorkflowCatalogEditor for the same reason PipelinePortsEditor
  // was split out of PipelineCatalogEditor: the Workflow form has to stay within
  // the repository-wide 500-line Svelte budget, and the graph rows are testable
  // on their own. Node rows live one level further down, in WorkflowNodeRows.
  //
  // Both lists are `<ol>`: their order is authored and meaningful (FR-049), and
  // an ordered list is what tells assistive technology the position and the
  // count without the row having to spell either out.
  //
  // Endpoints are selects over the nodes in this graph and the ports their
  // Pipelines declare, so an endpoint naming a node or port that does not exist
  // is unauthorable here rather than rejected later (FR-042).
  //
  // Every control that decides a condition's meaning is a select over a closed
  // set — the operand source, the node, the comparison operator, and (for a run
  // status) the value itself. There is no field a free-text expression could be
  // composed in, so FR-021 holds by construction rather than by rejection. The
  // one free-text control is the literal being compared against, which FR-024
  // bounds to exactly that.
  //
  // No rule lives in this markup: arity, coercion, and literal parsing all come
  // from `workflow-catalog-state.ts` so the Builder and its tests read one
  // source of truth.
  import {
    WORKFLOW_CONDITION_OPERATORS,
    WORKFLOW_NODE_TERMINAL_STATUSES,
    type PortablePipelineDefinition,
    type WorkflowConditionOperator,
    type WorkflowConnection,
    type WorkflowNode
  } from '../../lib/snapshot-types';
  import {
    conditionRightArity,
    conditionValues,
    formatWorkflowConditionLiteral,
    workflowPortIds,
    WORKFLOW_CONDITION_OPERAND_SOURCES,
    type WorkflowConditionOperandSource,
    type WorkflowConditionPatch,
    type WorkflowDraftError
  } from './workflow-catalog-state';
  import WorkflowNodeRows from './WorkflowNodeRows.svelte';
  import WorkflowRowDefects from './WorkflowRowDefects.svelte';

  interface Props {
    nodes: readonly WorkflowNode[];
    connections: readonly WorkflowConnection[];
    startNodeIds: readonly string[];
    pipelines: readonly PortablePipelineDefinition[];
    /** Both indexed alongside their list; see `anchorWorkflowDefects`. */
    nodeDefects: readonly (readonly WorkflowDraftError[])[];
    connectionDefects: readonly (readonly WorkflowDraftError[])[];
    readonly: boolean;
    onnodeadd: () => void;
    onnoderemove: (index: number) => void;
    onnodemove: (index: number, delta: number) => void;
    onnodepatch: (index: number, patch: Partial<WorkflowNode>) => void;
    onstarttoggle: (nodeId: string) => void;
    onconnectionadd: () => void;
    onconnectionremove: (index: number) => void;
    onconnectionmove: (index: number, delta: number) => void;
    onconnectionretarget: (
      index: number,
      end: 'from' | 'to',
      patch: { nodeId?: string; portId?: string }
    ) => void;
    onconditiontoggle: (index: number, conditional: boolean) => void;
    onconditionpatch: (index: number, patch: WorkflowConditionPatch) => void;
    /** Raw control text; the state module reads it as the literal it spells. */
    onconditionvalue: (index: number, valueIndex: number, text: string) => void;
    onconditionvalueadd: (index: number) => void;
    onconditionvalueremove: (index: number, valueIndex: number) => void;
  }

  const {
    nodes,
    connections,
    startNodeIds,
    pipelines,
    nodeDefects,
    connectionDefects,
    readonly,
    onnodeadd,
    onnoderemove,
    onnodemove,
    onnodepatch,
    onstarttoggle,
    onconnectionadd,
    onconnectionremove,
    onconnectionmove,
    onconnectionretarget,
    onconditiontoggle,
    onconditionpatch,
    onconditionvalue,
    onconditionvalueadd,
    onconditionvalueremove
  }: Props = $props();

  /** The declared ports of the node one end currently names, for that end's select. */
  function portsFor(nodeId: string, direction: 'in' | 'out'): readonly string[] {
    return workflowPortIds(
      nodes.find((node) => node.nodeId === nodeId),
      pipelines,
      direction
    );
  }

  /** What each operand source reads, in the operator's words rather than the contract's. */
  const SOURCE_LABELS: Record<WorkflowConditionOperandSource, string> = {
    'node-output': 'output field',
    'node-status': 'run status'
  };
</script>

<div class="graph-editor">
  <WorkflowNodeRows
    {nodes}
    {startNodeIds}
    {pipelines}
    {readonly}
    defects={nodeDefects}
    onadd={onnodeadd}
    onremove={onnoderemove}
    onmove={onnodemove}
    onpatch={onnodepatch}
    {onstarttoggle}
  />

  <div class="sequence-label" id="workflow-connections-label">Connections</div>
  <ol
    class="sequence-list"
    aria-labelledby="workflow-connections-label"
    data-testid="workflow-connections"
  >
    {#each connections as connection, index (index)}
      {@const rowDefects = connectionDefects[index] ?? []}
      <li
        class="sequence-item"
        data-testid="workflow-connection-{index}"
        data-invalid={rowDefects.length > 0 ? 'true' : undefined}
        aria-describedby={rowDefects.length > 0 ? `workflow-connection-defects-${index}` : undefined}
      >
        <select
          class="select-input"
          data-testid="workflow-connection-from-node-{index}"
          aria-label="Connection {index + 1} source node"
          value={connection.from.nodeId}
          disabled={readonly}
          onchange={(event) =>
            onconnectionretarget(index, 'from', { nodeId: event.currentTarget.value })}
        >
          {#each nodes as node (node.nodeId)}
            <option value={node.nodeId}>{node.nodeId}</option>
          {/each}
        </select>
        <select
          class="select-input"
          data-testid="workflow-connection-from-port-{index}"
          aria-label="Connection {index + 1} source output"
          value={connection.from.portId}
          disabled={readonly}
          onchange={(event) =>
            onconnectionretarget(index, 'from', { portId: event.currentTarget.value })}
        >
          {#each portsFor(connection.from.nodeId, 'out') as portId (portId)}
            <option value={portId}>{portId}</option>
          {/each}
        </select>
        <span class="connection-arrow" aria-hidden="true">→</span>
        <select
          class="select-input"
          data-testid="workflow-connection-to-node-{index}"
          aria-label="Connection {index + 1} target node"
          value={connection.to.nodeId}
          disabled={readonly}
          onchange={(event) =>
            onconnectionretarget(index, 'to', { nodeId: event.currentTarget.value })}
        >
          {#each nodes as node (node.nodeId)}
            <option value={node.nodeId}>{node.nodeId}</option>
          {/each}
        </select>
        <select
          class="select-input"
          data-testid="workflow-connection-to-port-{index}"
          aria-label="Connection {index + 1} target input"
          value={connection.to.portId}
          disabled={readonly}
          onchange={(event) =>
            onconnectionretarget(index, 'to', { portId: event.currentTarget.value })}
        >
          {#each portsFor(connection.to.nodeId, 'in') as portId (portId)}
            <option value={portId}>{portId}</option>
          {/each}
        </select>
        {#if !readonly}
          <button
            class="icon-btn"
            data-testid="workflow-connection-up-{index}"
            aria-label="Move connection {index + 1} earlier"
            disabled={index === 0}
            onclick={() => onconnectionmove(index, -1)}>↑</button
          >
          <button
            class="icon-btn"
            data-testid="workflow-connection-down-{index}"
            aria-label="Move connection {index + 1} later"
            disabled={index === connections.length - 1}
            onclick={() => onconnectionmove(index, 1)}>↓</button
          >
          <button
            class="icon-btn destructive-icon"
            data-testid="workflow-connection-remove-{index}"
            aria-label="Remove connection {index + 1}"
            onclick={() => onconnectionremove(index)}>✕</button
          >
        {/if}
        <label class="checkbox-field">
          <input
            type="checkbox"
            data-testid="workflow-condition-enabled-{index}"
            aria-label="Connection {index + 1} is conditional"
            checked={connection.condition !== undefined}
            disabled={readonly}
            onchange={(event) => onconditiontoggle(index, event.currentTarget.checked)}
          />
          <span class="form-label">Conditional</span>
        </label>
        {#if connection.condition}
          {@const condition = connection.condition}
          {@const values = conditionValues(condition)}
          {@const isList = conditionRightArity(condition.operator) === 'list'}
          <select
            class="select-input"
            data-testid="workflow-condition-source-{index}"
            aria-label="Connection {index + 1} condition reads"
            value={condition.left.source}
            disabled={readonly}
            onchange={(event) =>
              onconditionpatch(index, {
                source: event.currentTarget.value as WorkflowConditionOperandSource
              })}
          >
            {#each WORKFLOW_CONDITION_OPERAND_SOURCES as source (source)}
              <option value={source}>{SOURCE_LABELS[source]}</option>
            {/each}
          </select>
          <select
            class="select-input"
            data-testid="workflow-condition-node-{index}"
            aria-label="Connection {index + 1} condition node"
            value={condition.left.nodeId}
            disabled={readonly}
            onchange={(event) => onconditionpatch(index, { nodeId: event.currentTarget.value })}
          >
            {#each nodes as node (node.nodeId)}
              <option value={node.nodeId}>{node.nodeId}</option>
            {/each}
          </select>
          {#if condition.left.source === 'node-output'}
            <input
              class="text-input"
              data-testid="workflow-condition-field-{index}"
              aria-label="Connection {index + 1} condition output field"
              value={condition.left.field}
              {readonly}
              placeholder="field"
              oninput={(event) => onconditionpatch(index, { field: event.currentTarget.value })}
            />
          {/if}
          <select
            class="select-input"
            data-testid="workflow-condition-operator-{index}"
            aria-label="Connection {index + 1} condition comparison"
            value={condition.operator}
            disabled={readonly}
            onchange={(event) =>
              onconditionpatch(index, {
                operator: event.currentTarget.value as WorkflowConditionOperator
              })}
          >
            {#each WORKFLOW_CONDITION_OPERATORS as operator (operator)}
              <option value={operator}>{operator}</option>
            {/each}
          </select>
          {#each values as value, valueIndex (valueIndex)}
            <span class="condition-value">
              {#if condition.left.source === 'node-status'}
                <select
                  class="select-input"
                  data-testid="workflow-condition-value-{index}-{valueIndex}"
                  aria-label="Connection {index + 1} condition value {valueIndex + 1}"
                  value={String(value)}
                  disabled={readonly}
                  onchange={(event) =>
                    onconditionvalue(index, valueIndex, event.currentTarget.value)}
                >
                  {#each WORKFLOW_NODE_TERMINAL_STATUSES as status (status)}
                    <option value={status}>{status}</option>
                  {/each}
                </select>
              {:else}
                <input
                  class="text-input"
                  data-testid="workflow-condition-value-{index}-{valueIndex}"
                  aria-label="Connection {index + 1} condition value {valueIndex + 1}"
                  value={formatWorkflowConditionLiteral(value)}
                  {readonly}
                  placeholder="value"
                  oninput={(event) => onconditionvalue(index, valueIndex, event.currentTarget.value)}
                />
              {/if}
              {#if !readonly && isList && values.length > 1}
                <button
                  class="icon-btn destructive-icon"
                  data-testid="workflow-condition-remove-value-{index}-{valueIndex}"
                  aria-label="Remove connection {index + 1} condition value {valueIndex + 1}"
                  onclick={() => onconditionvalueremove(index, valueIndex)}>✕</button
                >
              {/if}
            </span>
          {/each}
          {#if !readonly && isList}
            <button
              class="btn btn-secondary"
              data-testid="workflow-condition-add-value-{index}"
              aria-label="Add a value to connection {index + 1} condition"
              onclick={() => onconditionvalueadd(index)}>Add value</button
            >
          {/if}
        {/if}
        <WorkflowRowDefects id="workflow-connection-defects-{index}" defects={rowDefects} />
      </li>
    {/each}
  </ol>
  <!-- Outside the `<ol>`: a list element may hold only list items, and an
       empty state is not one of the connections. -->
  {#if connections.length === 0}
    <div class="empty-selection" data-testid="workflow-connections-empty">No connections yet.</div>
  {/if}
  {#if !readonly}
    <button
      class="btn btn-secondary"
      data-testid="workflow-connection-add"
      disabled={nodes.length === 0}
      onclick={onconnectionadd}>Add connection</button
    >
  {/if}
</div>
