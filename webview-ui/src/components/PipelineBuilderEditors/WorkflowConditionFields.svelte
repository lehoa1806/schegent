<script lang="ts">
  // A branch's condition, as the mockup lays it out: what it reads and from which
  // step side by side, then the field and the comparison, then each value on a row
  // of its own. Every control that decides what the condition means is a select over
  // a closed set (the operand source, the step, the comparison, and for a run status
  // the value itself), so no free-text expression can be composed here (FR-021). The
  // one free-text control is the literal compared against, which FR-024 bounds.
  import { WORKFLOW_TEXT_COMPARISON_OPERATORS } from '../../../../src/contracts/workflow-definitions';
  import {
    WORKFLOW_NODE_TERMINAL_STATUSES,
    type WorkflowCondition,
    type WorkflowConditionOperator,
    type WorkflowNode
  } from '../../lib/snapshot-types';
  import {
    conditionRightArity,
    conditionValues,
    formatWorkflowConditionLiteral,
    WORKFLOW_CONDITION_OPERAND_SOURCES,
    type WorkflowConditionOperandSource,
    type WorkflowConditionPatch
  } from './workflow-catalog-state';
  import { OPERATOR_WORDS, stepOptionWords } from './workflow-field-words';

  interface Props {
    readonly index: number;
    readonly condition: WorkflowCondition;
    readonly nodes: readonly WorkflowNode[];
    readonly readonly: boolean;
    readonly onconditionpatch: (index: number, patch: WorkflowConditionPatch) => void;
    readonly onconditionvalue: (index: number, valueIndex: number, text: string) => void;
    readonly onconditionvalueadd: (index: number) => void;
    readonly onconditionvalueremove: (index: number, valueIndex: number) => void;
  }

  const p: Props = $props();

  /** What each operand source reads, in the operator's words not the contract's. */
  const SOURCE_WORDS: Readonly<Record<WorkflowConditionOperandSource, string>> = {
    'node-output': 'Output field',
    'node-status': 'Run status'
  };

  // FR-R4-F07 (FR-027; contract C, C8) -- v1 operands are text, so the picker offers the operators that
  // compare text. A condition already carrying another operator (a stored Workflow the host reports as
  // unsupported) keeps it in the list, so opening it shows what it really holds instead of silently
  // snapping to the first option; the host's defect, shown on the branch, says what to change.
  const operators = $derived.by((): readonly WorkflowConditionOperator[] => {
    const offered: readonly WorkflowConditionOperator[] = WORKFLOW_TEXT_COMPARISON_OPERATORS;
    return offered.includes(p.condition.operator) ? offered : [...offered, p.condition.operator];
  });
  const values = $derived(conditionValues(p.condition));
  const isList = $derived(conditionRightArity(p.condition.operator) === 'list');
  const readsOutput = $derived(p.condition.left.source === 'node-output');

  function setSource(value: string): void {
    const source = WORKFLOW_CONDITION_OPERAND_SOURCES.find((entry) => entry === value);
    if (source !== undefined) p.onconditionpatch(p.index, { source });
  }

  function setOperator(value: string): void {
    const operator = operators.find((entry) => entry === value);
    if (operator !== undefined) p.onconditionpatch(p.index, { operator });
  }

  function valueWords(valueIndex: number): string {
    return isList ? `Value ${valueIndex + 1}` : 'Value';
  }
</script>

<div class="cond wf-cond">
  <label class="field">
    <span>Reads</span>
    <select
      class="input"
      data-testid="workflow-condition-source-{p.index}"
      value={p.condition.left.source}
      disabled={p.readonly}
      onchange={(event) => setSource(event.currentTarget.value)}
    >
      {#each WORKFLOW_CONDITION_OPERAND_SOURCES as source (source)}
        <option value={source}>{SOURCE_WORDS[source]}</option>
      {/each}
    </select>
  </label>
  <label class="field">
    <span>Step</span>
    <select
      class="input"
      data-testid="workflow-condition-node-{p.index}"
      value={p.condition.left.nodeId}
      disabled={p.readonly}
      onchange={(event) => p.onconditionpatch(p.index, { nodeId: event.currentTarget.value })}
    >
      {#each p.nodes as node (node.nodeId)}
        <option value={node.nodeId}>{stepOptionWords(node)}</option>
      {/each}
    </select>
  </label>

  {#if p.condition.left.source === 'node-output'}
    <label class="field">
      <span>Field</span>
      <input
        class="input mono"
        data-testid="workflow-condition-field-{p.index}"
        value={p.condition.left.field}
        readonly={p.readonly}
        placeholder="field"
        oninput={(event) => p.onconditionpatch(p.index, { field: event.currentTarget.value })}
      />
    </label>
  {/if}
  <label class="field" class:full={!readsOutput}>
    <span>Comparison</span>
    <select
      class="input"
      data-testid="workflow-condition-operator-{p.index}"
      value={p.condition.operator}
      disabled={p.readonly}
      onchange={(event) => setOperator(event.currentTarget.value)}
    >
      {#each operators as operator (operator)}
        <option value={operator}>{OPERATOR_WORDS[operator]}</option>
      {/each}
    </select>
  </label>

  {#each values as value, valueIndex (valueIndex)}
    <div class="full wf-cond-value">
      <label class="field">
        <span>{valueWords(valueIndex)}</span>
        {#if p.condition.left.source === 'node-status'}
          <select
            class="input"
            data-testid="workflow-condition-value-{p.index}-{valueIndex}"
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
            class="input"
            data-testid="workflow-condition-value-{p.index}-{valueIndex}"
            value={formatWorkflowConditionLiteral(value)}
            readonly={p.readonly}
            placeholder="value"
            oninput={(event) => p.onconditionvalue(p.index, valueIndex, event.currentTarget.value)}
          />
        {/if}
      </label>
      {#if !p.readonly && isList && values.length > 1}
        <button
          type="button"
          class="icon-btn"
          data-testid="workflow-condition-remove-value-{p.index}-{valueIndex}"
          aria-label="Remove value {valueIndex + 1}"
          onclick={() => p.onconditionvalueremove(p.index, valueIndex)}
          ><svg class="i" aria-hidden="true"><use href="#i-x"></use></svg></button
        >
      {/if}
    </div>
  {/each}

  {#if !p.readonly && isList}
    <p class="full wf-cond-add">
      <button
        type="button"
        class="linkbtn"
        data-testid="workflow-condition-add-value-{p.index}"
        onclick={() => p.onconditionvalueadd(p.index)}>Add a value</button
      >
    </p>
  {/if}
</div>
