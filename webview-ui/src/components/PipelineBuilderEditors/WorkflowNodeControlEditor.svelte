<script lang="ts">
  // FR-R5-F33 / FR-R5-F34 — the settings of a child Workflow step's Repeat or ForEach.
  //
  // Which control a step carries is chosen in `WorkflowNodeControlChoice.svelte`;
  // this edits the one it carries. Every field names its input by its visible
  // label, and every select keeps the contract value as its option value, so the
  // words a person reads (`workflow-field-words.ts`) change nothing that is saved.
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
  import {
    COLLECTION_SOURCE_WORDS,
    ON_EXHAUSTED_WORDS,
    ON_ITEM_ERROR_WORDS,
    OPERATOR_WORDS,
  } from "./workflow-field-words";

  interface Props {
    readonly index: number;
    readonly node: WorkflowNode;
    readonly childWorkflow: PortableWorkflowDefinition | null;
    readonly readonly: boolean;
    readonly onnodepatch: (index: number, patch: Partial<WorkflowNode>) => void;
  }

  const p: Props = $props();

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

<div class="wf-node-control" data-testid="workflow-node-repeat-editor-{p.index}">
  {#if p.node.control?.kind === "repeat"}
    {@const repeatCtrl = p.node.control}
    {@const untilCmp = repeatUntilLeaf(repeatCtrl)}
    <h3>Repeat</h3>
    <div class="cond">
      <label class="field full">
        <span>Until result field</span>
        <input
          type="text"
          class="input mono"
          data-testid="repeat-until-field"
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
      <label class="field">
        <span>Comparison</span>
        <select
          class="input"
          data-testid="repeat-until-operator"
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
            <option value={op}>{OPERATOR_WORDS[op]}</option>
          {/each}
        </select>
      </label>
      <label class="field">
        <span>Value</span>
        <input
          type="text"
          class="input"
          data-testid="repeat-until-value"
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
    </div>

    <label class="field">
      <span>Max iterations ({MIN_REPEAT_ITERATIONS}–{MAX_REPEAT_ITERATIONS})</span>
      <input
        type="number"
        class="input"
        data-testid="repeat-max-iterations"
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

    <label class="field">
      <span>When the iterations run out</span>
      <select
        class="input"
        data-testid="repeat-on-exhausted"
        value={repeatCtrl.onExhausted ?? "pause"}
        disabled={p.readonly}
        onchange={(event) =>
          patchRepeatControl(repeatCtrl, {
            onExhausted: event.currentTarget.value as RepeatExhaustedPolicy,
          })}
      >
        {#each REPEAT_ON_EXHAUSTED_POLICIES as policy (policy)}
          <option value={policy}>{ON_EXHAUSTED_WORDS[policy]}</option>
        {/each}
      </select>
    </label>

    <div class="wf-node-carry" data-testid="repeat-carry-list">
      <h4>Carried into the next iteration</h4>
      <!-- The row's two inputs repeat per mapping, so each name carries its row number after the visible label. -->
      {#each repeatCtrl.carry as mapping, cIdx (cIdx)}
        <div class="repeat-carry-row" data-testid="repeat-carry-row-{cIdx}">
          <label class="field">
            <span>Result field</span>
            <input
              type="text"
              class="input mono"
              data-testid="repeat-carry-field-{cIdx}"
              aria-label="Result field, carry {cIdx + 1}"
              value={mapping.fieldId}
              disabled={p.readonly}
              oninput={(event) =>
                updateRepeatCarry(repeatCtrl, cIdx, {
                  fieldId: event.currentTarget.value.trim(),
                })}
            />
          </label>
          <label class="field">
            <span>Child input</span>
            <input
              type="text"
              class="input mono"
              data-testid="repeat-carry-port-{cIdx}"
              aria-label="Child input, carry {cIdx + 1}"
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
              class="icon-btn"
              data-testid="remove-repeat-carry-{cIdx}"
              aria-label="Remove carry mapping {cIdx + 1}"
              onclick={() => removeRepeatCarry(repeatCtrl, cIdx)}
            >
              <svg class="i" aria-hidden="true"><use href="#i-x"></use></svg>
            </button>
          {/if}
        </div>
      {:else}
        <p class="inh">Nothing is carried: every iteration gets the step's own inputs.</p>
      {/each}
      {#if !p.readonly}
        <button
          type="button"
          class="linkbtn"
          data-testid="add-repeat-carry"
          onclick={() => addRepeatCarry(repeatCtrl)}
        >
          Add a carry mapping
        </button>
      {/if}
    </div>
  {:else if p.node.control?.kind === "for-each"}
    {@const feCtrl = p.node.control}
    <h3>For each</h3>
    <label class="field">
      <span>Collection from</span>
      <select
        class="input"
        data-testid="foreach-collection-source"
        value={feCtrl.collection.source}
        disabled={p.readonly}
        onchange={(event) =>
          updateForEachCollectionSource(feCtrl, event.currentTarget.value as ForEachCollectionSource["source"])}
      >
        {#each FOR_EACH_COLLECTION_SOURCES as src (src)}
          <option value={src}>{COLLECTION_SOURCE_WORDS[src]}</option>
        {/each}
      </select>
    </label>

    {#if feCtrl.collection.source === "node-output"}
      <label class="field">
        <span>Step id</span>
        <input
          type="text"
          class="input mono"
          data-testid="foreach-collection-node-id"
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

    <label class="field">
      <span>Collection port</span>
      <input
        type="text"
        class="input mono"
        data-testid="foreach-collection-port-id"
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

    <label class="field">
      <span>Child input for each item (a required text input)</span>
      <input
        type="text"
        class="input mono"
        data-testid="foreach-item-input-port-id"
        value={feCtrl.itemInputPortId}
        disabled={p.readonly}
        oninput={(event) =>
          patchForEachControl(feCtrl, { itemInputPortId: event.currentTarget.value.trim() })}
      />
    </label>

    <label class="field">
      <span>Item key field (optional)</span>
      <input
        type="text"
        class="input mono"
        data-testid="foreach-item-key-field"
        value={feCtrl.itemKeyField ?? ""}
        disabled={p.readonly}
        oninput={(event) => {
          const trimmed = event.currentTarget.value.trim();
          patchForEachControl(feCtrl, { itemKeyField: trimmed.length > 0 ? trimmed : undefined });
        }}
      />
    </label>

    <label class="field">
      <span>Max items ({MIN_FOR_EACH_MAX_ITEMS}–{MAX_FOR_EACH_MAX_ITEMS})</span>
      <input
        type="number"
        class="input"
        data-testid="foreach-max-items"
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

    <label class="field">
      <span>When an item fails</span>
      <select
        class="input"
        data-testid="foreach-on-item-error"
        value={feCtrl.onItemError ?? DEFAULT_FOR_EACH_ON_ITEM_ERROR}
        disabled={p.readonly}
        onchange={(event) =>
          patchForEachControl(feCtrl, {
            onItemError: event.currentTarget.value as ForEachItemErrorPolicy,
          })}
      >
        {#each FOR_EACH_ON_ITEM_ERROR_POLICIES as policy (policy)}
          <option value={policy}>{ON_ITEM_ERROR_WORDS[policy]}</option>
        {/each}
      </select>
    </label>
  {/if}
</div>
