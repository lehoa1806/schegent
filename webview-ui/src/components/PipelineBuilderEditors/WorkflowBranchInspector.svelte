<script lang="ts">
  // One branch, in the inspector. What the list Builder rendered as a connection
  // row, minus the horizontal cramming — the canvas selects the arm and this panel
  // edits it.
  //
  // The condition controls are carried over unchanged in substance: every control
  // that decides a condition's meaning is a select over a closed set (the operand
  // source, the node, the comparison operator, and for a run status the value
  // itself). There is no field a free-text expression could be composed in, so
  // FR-021 holds by construction here exactly as it did there. The one free-text
  // control is the literal being compared against, which FR-024 bounds to that.
  //
  // Endpoints are selects over the nodes in this graph and the ports their
  // Pipelines declare, so an endpoint naming something that does not exist stays
  // unauthorable rather than being rejected later (FR-042).
  //
  // Three controls are NEW, and they are here because the canvas draws what they
  // decide. `Fallback` and `Priority` set the offer order the flow is laid out in,
  // and `addWorkflowBranch` seeds a fallback arm — a seeded flag with no control to
  // clear it would be a trap. `Selection` is the rule the host demands for a
  // collection output feeding a single input (`selection-rule-required`), which was
  // unfixable in the Builder before. Note that the run side does not yet read
  // `selection`: it gates the save, and that is what the control is for.
  //
  // No rule lives in this markup. Arity, literal parsing, and priority parsing all
  // come from `workflow-catalog-state.ts`.
  import {
    WORKFLOW_CONDITION_OPERATORS,
    WORKFLOW_NODE_TERMINAL_STATUSES,
    WORKFLOW_SELECTION_RULES,
    type PortablePipelineDefinition,
    type WorkflowConditionOperator,
    type WorkflowConnection,
    type WorkflowNode,
    type WorkflowSelectionRule
  } from '../../lib/snapshot-types';
  import {
    conditionRightArity,
    conditionValues,
    formatWorkflowConditionLiteral,
    parseWorkflowPriority,
    workflowPortIds,
    WORKFLOW_CONDITION_OPERAND_SOURCES,
    type WorkflowConditionOperandSource,
    type WorkflowConditionPatch,
    type WorkflowDraftError
  } from './workflow-catalog-state';
  import WorkflowRowDefects from './WorkflowRowDefects.svelte';

  interface Props {
    index: number;
    connection: WorkflowConnection;
    nodes: readonly WorkflowNode[];
    pipelines: readonly PortablePipelineDefinition[];
    defects: readonly WorkflowDraftError[];
    readonly: boolean;
    connectionCount: number;
    onretarget: (
      index: number,
      end: 'from' | 'to',
      patch: { nodeId?: string; portId?: string }
    ) => void;
    onpatch: (index: number, patch: Partial<WorkflowConnection>) => void;
    onconditiontoggle: (index: number, conditional: boolean) => void;
    onconditionpatch: (index: number, patch: WorkflowConditionPatch) => void;
    onconditionvalue: (index: number, valueIndex: number, text: string) => void;
    onconditionvalueadd: (index: number) => void;
    onconditionvalueremove: (index: number, valueIndex: number) => void;
    onmove: (index: number, delta: number) => void;
    onremove: (index: number) => void;
  }

  const p: Props = $props();

  /** What each operand source reads, in the operator's words not the contract's. */
  const SOURCE_LABELS: Record<WorkflowConditionOperandSource, string> = {
    'node-output': 'output field',
    'node-status': 'run status'
  };

  const condition = $derived(p.connection.condition);
  const values = $derived(condition ? conditionValues(condition) : []);
  const isList = $derived(condition ? conditionRightArity(condition.operator) === 'list' : false);

  /** The declared ports of the node one end currently names, for that end's select. */
  function portsFor(nodeId: string, direction: 'in' | 'out'): readonly string[] {
    return workflowPortIds(
      p.nodes.find((node) => node.nodeId === nodeId),
      p.pipelines,
      direction
    );
  }
</script>

<div class="wf-inspector-section" data-testid="workflow-branch-inspector-{p.index}">
  <h3>Branch {p.index + 1}</h3>
  <WorkflowRowDefects id="workflow-connection-defects-{p.index}" defects={p.defects} />

  <label class="wf-field">
    From
    <span class="wf-field-row">
      <select
        class="select-input"
        data-testid="workflow-connection-from-node-{p.index}"
        aria-label="Branch {p.index + 1} source node"
        value={p.connection.from.nodeId}
        disabled={p.readonly}
        onchange={(event) => p.onretarget(p.index, 'from', { nodeId: event.currentTarget.value })}
      >
        {#each p.nodes as node (node.nodeId)}
          <option value={node.nodeId}>{node.nodeId}</option>
        {/each}
      </select>
      <select
        class="select-input"
        data-testid="workflow-connection-from-port-{p.index}"
        aria-label="Branch {p.index + 1} source output"
        value={p.connection.from.portId}
        disabled={p.readonly}
        onchange={(event) => p.onretarget(p.index, 'from', { portId: event.currentTarget.value })}
      >
        {#each portsFor(p.connection.from.nodeId, 'out') as portId (portId)}
          <option value={portId}>{portId}</option>
        {/each}
      </select>
    </span>
  </label>

  <label class="wf-field">
    To
    <span class="wf-field-row">
      <select
        class="select-input"
        data-testid="workflow-connection-to-node-{p.index}"
        aria-label="Branch {p.index + 1} target node"
        value={p.connection.to.nodeId}
        disabled={p.readonly}
        onchange={(event) => p.onretarget(p.index, 'to', { nodeId: event.currentTarget.value })}
      >
        {#each p.nodes as node (node.nodeId)}
          <option value={node.nodeId}>{node.nodeId}</option>
        {/each}
      </select>
      <select
        class="select-input"
        data-testid="workflow-connection-to-port-{p.index}"
        aria-label="Branch {p.index + 1} target input"
        value={p.connection.to.portId}
        disabled={p.readonly}
        onchange={(event) => p.onretarget(p.index, 'to', { portId: event.currentTarget.value })}
      >
        {#each portsFor(p.connection.to.nodeId, 'in') as portId (portId)}
          <option value={portId}>{portId}</option>
        {/each}
      </select>
    </span>
  </label>

  <label class="checkbox-field">
    <input
      type="checkbox"
      data-testid="workflow-condition-enabled-{p.index}"
      aria-label="Branch {p.index + 1} is conditional"
      checked={condition !== undefined}
      disabled={p.readonly}
      onchange={(event) => p.onconditiontoggle(p.index, event.currentTarget.checked)}
    />
    <span class="form-label">Conditional</span>
  </label>

  {#if condition}
    <label class="wf-field">
      Reads
      <span class="wf-field-row">
        <select
          class="select-input"
          data-testid="workflow-condition-source-{p.index}"
          aria-label="Branch {p.index + 1} condition reads"
          value={condition.left.source}
          disabled={p.readonly}
          onchange={(event) =>
            p.onconditionpatch(p.index, {
              source: event.currentTarget.value as WorkflowConditionOperandSource
            })}
        >
          {#each WORKFLOW_CONDITION_OPERAND_SOURCES as source (source)}
            <option value={source}>{SOURCE_LABELS[source]}</option>
          {/each}
        </select>
        <select
          class="select-input"
          data-testid="workflow-condition-node-{p.index}"
          aria-label="Branch {p.index + 1} condition node"
          value={condition.left.nodeId}
          disabled={p.readonly}
          onchange={(event) => p.onconditionpatch(p.index, { nodeId: event.currentTarget.value })}
        >
          {#each p.nodes as node (node.nodeId)}
            <option value={node.nodeId}>{node.nodeId}</option>
          {/each}
        </select>
      </span>
    </label>

    {#if condition.left.source === 'node-output'}
      <label class="wf-field">
        Output field
        <input
          class="text-input"
          data-testid="workflow-condition-field-{p.index}"
          aria-label="Branch {p.index + 1} condition output field"
          value={condition.left.field}
          readonly={p.readonly}
          placeholder="field"
          oninput={(event) => p.onconditionpatch(p.index, { field: event.currentTarget.value })}
        />
      </label>
    {/if}

    <label class="wf-field">
      Comparison
      <select
        class="select-input"
        data-testid="workflow-condition-operator-{p.index}"
        aria-label="Branch {p.index + 1} condition comparison"
        value={condition.operator}
        disabled={p.readonly}
        onchange={(event) =>
          p.onconditionpatch(p.index, {
            operator: event.currentTarget.value as WorkflowConditionOperator
          })}
      >
        {#each WORKFLOW_CONDITION_OPERATORS as operator (operator)}
          <option value={operator}>{operator}</option>
        {/each}
      </select>
    </label>

    {#each values as value, valueIndex (valueIndex)}
      <span class="wf-field-row condition-value">
        {#if condition.left.source === 'node-status'}
          <select
            class="select-input"
            data-testid="workflow-condition-value-{p.index}-{valueIndex}"
            aria-label="Branch {p.index + 1} condition value {valueIndex + 1}"
            value={String(value)}
            disabled={p.readonly}
            onchange={(event) => p.onconditionvalue(p.index, valueIndex, event.currentTarget.value)}
          >
            {#each WORKFLOW_NODE_TERMINAL_STATUSES as status (status)}
              <option value={status}>{status}</option>
            {/each}
          </select>
        {:else}
          <input
            class="text-input"
            data-testid="workflow-condition-value-{p.index}-{valueIndex}"
            aria-label="Branch {p.index + 1} condition value {valueIndex + 1}"
            value={formatWorkflowConditionLiteral(value)}
            readonly={p.readonly}
            placeholder="value"
            oninput={(event) => p.onconditionvalue(p.index, valueIndex, event.currentTarget.value)}
          />
        {/if}
        {#if !p.readonly && isList && values.length > 1}
          <button
            class="icon-btn destructive-icon"
            data-testid="workflow-condition-remove-value-{p.index}-{valueIndex}"
            aria-label="Remove branch {p.index + 1} condition value {valueIndex + 1}"
            onclick={() => p.onconditionvalueremove(p.index, valueIndex)}>✕</button
          >
        {/if}
      </span>
    {/each}

    {#if !p.readonly && isList}
      <button
        class="btn btn-secondary"
        data-testid="workflow-condition-add-value-{p.index}"
        aria-label="Add a value to branch {p.index + 1} condition"
        onclick={() => p.onconditionvalueadd(p.index)}>Add value</button
      >
    {/if}
  {/if}

  <!-- The offer order the canvas draws. `Fallback` is considered only when no
       explicit arm matched (FR-027), and an unset priority sorts last, so blank
       is a real value here rather than a missing one. -->
  <label class="checkbox-field">
    <input
      type="checkbox"
      data-testid="workflow-connection-default-{p.index}"
      aria-label="Branch {p.index + 1} is the fallback"
      checked={p.connection.isDefault === true}
      disabled={p.readonly}
      onchange={(event) =>
        p.onpatch(p.index, { isDefault: event.currentTarget.checked ? true : undefined })}
    />
    <span class="form-label">Fallback (considered last)</span>
  </label>

  <label class="wf-field">
    Priority
    <input
      class="text-input"
      type="number"
      step="1"
      data-testid="workflow-connection-priority-{p.index}"
      aria-label="Branch {p.index + 1} priority"
      value={p.connection.priority ?? ''}
      readonly={p.readonly}
      placeholder="unset — offered last"
      oninput={(event) =>
        p.onpatch(p.index, { priority: parseWorkflowPriority(event.currentTarget.value) })}
    />
  </label>

  <label class="wf-field">
    Collection selection
    <select
      class="select-input"
      data-testid="workflow-connection-selection-{p.index}"
      aria-label="Branch {p.index + 1} collection selection rule"
      value={p.connection.selection ?? ''}
      disabled={p.readonly}
      onchange={(event) =>
        p.onpatch(p.index, {
          selection: (event.currentTarget.value || undefined) as WorkflowSelectionRule | undefined
        })}
    >
      <option value="">Not set</option>
      {#each WORKFLOW_SELECTION_RULES as rule (rule)}
        <option value={rule}>{rule}</option>
      {/each}
    </select>
  </label>

  {#if !p.readonly}
    <span class="wf-field-row">
      <button
        class="icon-btn"
        data-testid="workflow-connection-up-{p.index}"
        aria-label="Move branch {p.index + 1} earlier"
        disabled={p.index === 0}
        onclick={() => p.onmove(p.index, -1)}>↑</button
      >
      <button
        class="icon-btn"
        data-testid="workflow-connection-down-{p.index}"
        aria-label="Move branch {p.index + 1} later"
        disabled={p.index === p.connectionCount - 1}
        onclick={() => p.onmove(p.index, 1)}>↓</button
      >
      <button
        class="btn btn-destructive"
        data-testid="workflow-connection-remove-{p.index}"
        onclick={() => p.onremove(p.index)}>Delete branch</button
      >
    </span>
  {/if}
</div>
