<script lang="ts">
  // FR-R5-F33 / FR-R5-F34 — Child-Workflow Repeat & ForEach Node Control Editor.
  import {
    DEFAULT_FOR_EACH_MAX_ITEMS,
    DEFAULT_FOR_EACH_ON_ITEM_ERROR,
    FOR_EACH_COLLECTION_SOURCES,
    FOR_EACH_ON_ITEM_ERROR_POLICIES,
    MAX_FOR_EACH_MAX_ITEMS,
    MAX_REPEAT_ITERATIONS,
    MIN_FOR_EACH_MAX_ITEMS,
    MIN_REPEAT_ITERATIONS,
    REPEAT_ON_EXHAUSTED_POLICIES,
    TYPED_CONDITION_OPERATORS,
    type ForEachCollectionSource,
    type ForEachControl,
    type ForEachItemErrorPolicy,
    type PortableWorkflowDefinition,
    type RepeatCarryMapping,
    type RepeatControl,
    type RepeatExhaustedPolicy,
    type TypedLeaf,
    type TypedOperator,
    type WorkflowNode,
  } from "../../lib/snapshot-types";

  interface Props {
    readonly index: number;
    readonly node: WorkflowNode;
    readonly childWorkflow: PortableWorkflowDefinition | null;
    readonly readonly: boolean;
    readonly onnodepatch: (index: number, patch: Partial<WorkflowNode>) => void;
  }

  const p: Props = $props();

  function defaultRepeatControl(): RepeatControl {
    const firstField = p.childWorkflow?.decisionResults?.fields.at(0)?.fieldId ?? "approved";
    return {
      version: 1,
      kind: "repeat",
      maxIterations: 3,
      until: {
        version: 1,
        kind: "typed",
        test: {
          left: { source: "result-field", fieldId: firstField },
          operator: "equals",
          right: true,
        },
      },
      carry: [],
      onExhausted: "pause",
    };
  }

  function defaultForEachControl(): ForEachControl {
    const firstInputPort = p.childWorkflow?.inputs?.at(0)?.portId ?? "item";
    return {
      version: 1,
      kind: "for-each",
      collection: {
        source: "workflow-input",
        portId: "itemsFile",
      },
      itemInputPortId: firstInputPort,
      maxItems: DEFAULT_FOR_EACH_MAX_ITEMS,
      onItemError: DEFAULT_FOR_EACH_ON_ITEM_ERROR,
    };
  }

  function toggleRepeatControl(): void {
    if (p.node.control?.kind === "repeat") {
      p.onnodepatch(p.index, { control: undefined });
    } else {
      p.onnodepatch(p.index, { control: defaultRepeatControl() });
    }
  }

  function toggleForEachControl(): void {
    if (p.node.control?.kind === "for-each") {
      p.onnodepatch(p.index, { control: undefined });
    } else {
      p.onnodepatch(p.index, { control: defaultForEachControl() });
    }
  }

  function patchRepeatControl(current: RepeatControl, patch: Partial<RepeatControl>): void {
    p.onnodepatch(p.index, { control: { ...current, ...patch } });
  }

  function patchForEachControl(current: ForEachControl, patch: Partial<ForEachControl>): void {
    p.onnodepatch(p.index, { control: { ...current, ...patch } });
  }

  function updateForEachCollectionSource(current: ForEachControl, source: ForEachCollectionSource["source"]): void {
    const portId = current.collection.portId || "itemsFile";
    const collection: ForEachControl["collection"] =
      source === "node-output"
        ? {
            source: "node-output",
            nodeId: current.collection.source === "node-output" ? current.collection.nodeId : "node-upstream",
            portId,
          }
        : { source: "workflow-input", portId };
    patchForEachControl(current, { collection });
  }

  function repeatUntilLeaf(ctrl: RepeatControl): TypedLeaf {
    const test = ctrl.until.test;
    if ("left" in test && "operator" in test) return test;
    return {
      left: { source: "result-field", fieldId: "approved" },
      operator: "equals",
      right: true,
    };
  }

  function parseRightLiteral(raw: string): string | number | boolean {
    const trimmed = raw.trim();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    const num = Number(trimmed);
    if (trimmed.length > 0 && Number.isFinite(num)) return num;
    return raw;
  }

  function addRepeatCarry(current: RepeatControl): void {
    const carry: RepeatCarryMapping[] = [
      ...current.carry,
      {
        fieldId: p.childWorkflow?.decisionResults?.fields.at(0)?.fieldId ?? "feedback",
        inputPortId: p.childWorkflow?.inputs?.at(0)?.portId ?? "feedback",
      },
    ];
    patchRepeatControl(current, { carry });
  }

  function updateRepeatCarry(
    current: RepeatControl,
    carryIndex: number,
    patch: Partial<RepeatCarryMapping>,
  ): void {
    const carry = current.carry.map((item, idx) =>
      idx === carryIndex ? { ...item, ...patch } : item,
    );
    patchRepeatControl(current, { carry });
  }

  function removeRepeatCarry(current: RepeatControl, carryIndex: number): void {
    const carry = current.carry.filter((_, idx) => idx !== carryIndex);
    patchRepeatControl(current, { carry });
  }
</script>

<div class="wf-inspector-section" data-testid="workflow-node-repeat-editor-{p.index}">
  <label class="checkbox-field">
    <input
      type="checkbox"
      data-testid="toggle-repeat-control"
      aria-label="Enable Repeat control on node {p.index + 1}"
      checked={p.node.control?.kind === "repeat"}
      disabled={p.readonly}
      onchange={toggleRepeatControl}
    />
    <span class="form-label">Repeat child Workflow until condition</span>
  </label>

  <label class="checkbox-field">
    <input
      type="checkbox"
      data-testid="toggle-foreach-control"
      aria-label="Enable ForEach control on node {p.index + 1}"
      checked={p.node.control?.kind === "for-each"}
      disabled={p.readonly}
      onchange={toggleForEachControl}
    />
    <span class="form-label">Sequential ForEach over bounded item collection</span>
  </label>

  {#if p.node.control?.kind === "repeat"}
    {@const repeatCtrl = p.node.control}
    {@const untilCmp = repeatUntilLeaf(repeatCtrl)}
    <label class="wf-field">
      Max Iterations ({MIN_REPEAT_ITERATIONS}–{MAX_REPEAT_ITERATIONS})
      <input
        type="number"
        class="text-input"
        data-testid="repeat-max-iterations"
        aria-label="Repeat max iterations"
        min={MIN_REPEAT_ITERATIONS}
        max={MAX_REPEAT_ITERATIONS}
        value={repeatCtrl.maxIterations}
        disabled={p.readonly}
        oninput={(event) => {
          const parsed = Number.parseInt(event.currentTarget.value, 10);
          if (Number.isFinite(parsed)) {
            patchRepeatControl(repeatCtrl, { maxIterations: parsed });
          }
        }}
      />
    </label>

    <label class="wf-field">
      On Exhausted
      <select
        class="select-input"
        data-testid="repeat-on-exhausted"
        aria-label="Repeat onExhausted policy"
        value={repeatCtrl.onExhausted ?? "pause"}
        disabled={p.readonly}
        onchange={(event) =>
          patchRepeatControl(repeatCtrl, {
            onExhausted: event.currentTarget.value as RepeatExhaustedPolicy,
          })}
      >
        {#each REPEAT_ON_EXHAUSTED_POLICIES as policy (policy)}
          <option value={policy}>{policy}</option>
        {/each}
      </select>
    </label>

    <label class="wf-field">
      Until Result Field
      <input
        type="text"
        class="text-input"
        data-testid="repeat-until-field"
        aria-label="Repeat until result field ID"
        value={untilCmp.left.source === "result-field" ? untilCmp.left.fieldId : ""}
        disabled={p.readonly}
        oninput={(event) =>
          patchRepeatControl(repeatCtrl, {
            until: {
              version: 1,
              kind: "typed",
              test: {
                ...untilCmp,
                left: { source: "result-field", fieldId: event.currentTarget.value.trim() },
              },
            },
          })}
      />
    </label>

    <label class="wf-field">
      Until Operator
      <select
        class="select-input"
        data-testid="repeat-until-operator"
        aria-label="Repeat until comparison operator"
        value={untilCmp.operator}
        disabled={p.readonly}
        onchange={(event) =>
          patchRepeatControl(repeatCtrl, {
            until: {
              version: 1,
              kind: "typed",
              test: {
                ...untilCmp,
                operator: event.currentTarget.value as TypedOperator,
              },
            },
          })}
      >
        {#each TYPED_CONDITION_OPERATORS as op (op)}
          <option value={op}>{op}</option>
        {/each}
      </select>
    </label>

    <label class="wf-field">
      Until Target Value
      <input
        type="text"
        class="text-input"
        data-testid="repeat-until-value"
        aria-label="Repeat until target value"
        value={String(untilCmp.right ?? "")}
        disabled={p.readonly}
        oninput={(event) =>
          patchRepeatControl(repeatCtrl, {
            until: {
              version: 1,
              kind: "typed",
              test: {
                ...untilCmp,
                right: parseRightLiteral(event.currentTarget.value),
              },
            },
          })}
      />
    </label>

    <div class="wf-inspector-subsection" data-testid="repeat-carry-list">
      <div class="wf-inspector-heading">Carry Mappings</div>
      {#each repeatCtrl.carry as mapping, cIdx (cIdx)}
        <div class="repeat-carry-row" data-testid="repeat-carry-row-{cIdx}">
          <label class="wf-field">
            Result Field
            <input
              type="text"
              class="text-input"
              data-testid="repeat-carry-field-{cIdx}"
              aria-label="Carry {cIdx + 1} result field ID"
              value={mapping.fieldId}
              disabled={p.readonly}
              oninput={(event) =>
                updateRepeatCarry(repeatCtrl, cIdx, {
                  fieldId: event.currentTarget.value.trim(),
                })}
            />
          </label>
          <label class="wf-field">
            Child Text Input Port
            <input
              type="text"
              class="text-input"
              data-testid="repeat-carry-port-{cIdx}"
              aria-label="Carry {cIdx + 1} child input port ID"
              value={mapping.inputPortId}
              disabled={p.readonly}
              oninput={(event) =>
                updateRepeatCarry(repeatCtrl, cIdx, {
                  inputPortId: event.currentTarget.value.trim(),
                })}
            />
          </label>
          {#if !p.readonly}
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              data-testid="remove-repeat-carry-{cIdx}"
              aria-label="Remove carry mapping {cIdx + 1}"
              onclick={() => removeRepeatCarry(repeatCtrl, cIdx)}
            >
              Remove
            </button>
          {/if}
        </div>
      {/each}
      {#if !p.readonly}
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          data-testid="add-repeat-carry"
          onclick={() => addRepeatCarry(repeatCtrl)}
        >
          Add carry mapping
        </button>
      {/if}
    </div>
  {:else if p.node.control?.kind === "for-each"}
    {@const feCtrl = p.node.control}
    <label class="wf-field">
      Collection Source
      <select
        class="select-input"
        data-testid="foreach-collection-source"
        aria-label="ForEach collection source"
        value={feCtrl.collection.source}
        disabled={p.readonly}
        onchange={(event) =>
          updateForEachCollectionSource(feCtrl, event.currentTarget.value as ForEachCollectionSource["source"])}
      >
        {#each FOR_EACH_COLLECTION_SOURCES as src (src)}
          <option value={src}>{src}</option>
        {/each}
      </select>
    </label>

    {#if feCtrl.collection.source === "node-output"}
      <label class="wf-field">
        Upstream Node ID
        <input
          type="text"
          class="text-input"
          data-testid="foreach-collection-node-id"
          aria-label="ForEach upstream collection node ID"
          value={feCtrl.collection.nodeId}
          disabled={p.readonly}
          oninput={(event) =>
            patchForEachControl(feCtrl, {
              collection: {
                source: "node-output",
                nodeId: event.currentTarget.value.trim(),
                portId: feCtrl.collection.portId,
              },
            })}
        />
      </label>
    {/if}

    <label class="wf-field">
      Collection Port ID
      <input
        type="text"
        class="text-input"
        data-testid="foreach-collection-port-id"
        aria-label="ForEach collection port ID"
        value={feCtrl.collection.portId}
        disabled={p.readonly}
        oninput={(event) => {
          const portId = event.currentTarget.value.trim();
          const collection: ForEachControl["collection"] =
            feCtrl.collection.source === "node-output"
              ? { source: "node-output", nodeId: feCtrl.collection.nodeId, portId }
              : { source: "workflow-input", portId };
          patchForEachControl(feCtrl, { collection });
        }}
      />
    </label>

    <label class="wf-field">
      Child Item Input Port ID (required text port)
      <input
        type="text"
        class="text-input"
        data-testid="foreach-item-input-port-id"
        aria-label="ForEach child item input port ID"
        value={feCtrl.itemInputPortId}
        disabled={p.readonly}
        oninput={(event) =>
          patchForEachControl(feCtrl, { itemInputPortId: event.currentTarget.value.trim() })}
      />
    </label>

    <label class="wf-field">
      Item Key Field (optional)
      <input
        type="text"
        class="text-input"
        data-testid="foreach-item-key-field"
        aria-label="ForEach item key field"
        value={feCtrl.itemKeyField ?? ""}
        disabled={p.readonly}
        oninput={(event) => {
          const trimmed = event.currentTarget.value.trim();
          patchForEachControl(feCtrl, { itemKeyField: trimmed.length > 0 ? trimmed : undefined });
        }}
      />
    </label>

    <label class="wf-field">
      Max Items ({MIN_FOR_EACH_MAX_ITEMS}–{MAX_FOR_EACH_MAX_ITEMS})
      <input
        type="number"
        class="text-input"
        data-testid="foreach-max-items"
        aria-label="ForEach max items"
        min={MIN_FOR_EACH_MAX_ITEMS}
        max={MAX_FOR_EACH_MAX_ITEMS}
        value={feCtrl.maxItems ?? DEFAULT_FOR_EACH_MAX_ITEMS}
        disabled={p.readonly}
        oninput={(event) => {
          const parsed = Number.parseInt(event.currentTarget.value, 10);
          if (Number.isFinite(parsed)) {
            patchForEachControl(feCtrl, { maxItems: parsed });
          }
        }}
      />
    </label>

    <label class="wf-field">
      On Item Error
      <select
        class="select-input"
        data-testid="foreach-on-item-error"
        aria-label="ForEach onItemError policy"
        value={feCtrl.onItemError ?? DEFAULT_FOR_EACH_ON_ITEM_ERROR}
        disabled={p.readonly}
        onchange={(event) =>
          patchForEachControl(feCtrl, {
            onItemError: event.currentTarget.value as ForEachItemErrorPolicy,
          })}
      >
        {#each FOR_EACH_ON_ITEM_ERROR_POLICIES as policy (policy)}
          <option value={policy}>{policy}</option>
        {/each}
      </select>
    </label>
  {/if}
</div>
