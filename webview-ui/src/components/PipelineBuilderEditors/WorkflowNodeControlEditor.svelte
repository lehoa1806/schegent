<script lang="ts">
  // FR-R5-F33 / FR-R5-F34 — Child-Workflow Repeat & ForEach Node Control Editor.
  import {
    MAX_REPEAT_ITERATIONS,
    MIN_REPEAT_ITERATIONS,
    REPEAT_ON_EXHAUSTED_POLICIES,
    TYPED_CONDITION_OPERATORS,
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

  function toggleRepeatControl(): void {
    if (p.node.control?.kind === "repeat") {
      p.onnodepatch(p.index, { control: undefined });
    } else {
      p.onnodepatch(p.index, { control: defaultRepeatControl() });
    }
  }

  function patchRepeatControl(current: RepeatControl, patch: Partial<RepeatControl>): void {
    p.onnodepatch(p.index, { control: { ...current, ...patch } });
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
  {/if}
</div>

