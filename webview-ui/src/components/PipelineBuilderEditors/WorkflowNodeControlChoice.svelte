<script lang="ts">
  // How a step runs (FR-R5-F33 / FR-R5-F34), as one choice of three: once, Repeat
  // or For each. The two looping controls were two checkboxes, which let a step ask
  // for both; a choice says what the host accepts, one control or none.
  //
  // A step that runs once switches straight away. A step that already carries a
  // control would lose its settings, so the choice asks first: the pick shows as
  // chosen, the warning offers Switch and Keep, and nothing is patched until Switch.
  // The pick remembers which control it would replace, so an undo that changes the
  // step underneath drops the question instead of applying it to the wrong control.
  import type { PortableWorkflowDefinition, WorkflowNode } from '../../lib/snapshot-types';
  import {
    NODE_CONTROL_CHOICES,
    controlForKind,
    controlKindOf,
    controlKindWord,
    type NodeControlKind
  } from './workflow-node-control';

  interface Props {
    readonly index: number;
    readonly node: WorkflowNode;
    readonly childWorkflow: PortableWorkflowDefinition | null;
    /** Repeat and For each run a child Workflow; any other step runs once. */
    readonly loopable: boolean;
    readonly readonly: boolean;
    readonly onnodepatch: (index: number, patch: Partial<WorkflowNode>) => void;
  }

  const p: Props = $props();

  interface PendingChoice {
    readonly kind: NodeControlKind;
    readonly from: NodeControlKind;
  }

  let pick = $state<PendingChoice | null>(null);

  const carried = $derived(p.node.control?.kind);
  const current = $derived(controlKindOf(p.node));
  const pending = $derived(pick !== null && pick.from === current && pick.kind !== current ? pick.kind : null);
  const shown = $derived(pending ?? current);

  function radioId(kind: NodeControlKind): string {
    return `wf-node-control-${p.index}-${kind}`;
  }

  // The looping choices keep the test ids the two checkboxes had.
  function testIdOf(kind: NodeControlKind): string {
    if (kind === 'repeat') return 'toggle-repeat-control';
    if (kind === 'for-each') return 'toggle-foreach-control';
    return `workflow-node-control-once-${p.index}`;
  }

  function focusChoice(kind: NodeControlKind): void {
    queueMicrotask(() => document.getElementById(radioId(kind))?.focus());
  }

  function commit(kind: NodeControlKind): void {
    pick = null;
    p.onnodepatch(p.index, { control: controlForKind(kind, p.childWorkflow) });
  }

  function choose(kind: NodeControlKind): void {
    if (kind === current) {
      pick = null;
      return;
    }
    if (current === 'once') {
      commit(kind);
      return;
    }
    pick = { kind, from: current };
  }

  // The warning's buttons leave with the warning, so focus goes back to the choice.
  function confirmSwitch(): void {
    if (pending === null) return;
    const kind = pending;
    commit(kind);
    focusChoice(kind);
  }

  function keepCurrent(): void {
    pick = null;
    focusChoice(current);
  }
</script>

<fieldset class="wf-control-choice">
  <legend>How this step runs</legend>
  {#each NODE_CONTROL_CHOICES as choice (choice.kind)}
    <label class="radio">
      <input
        type="radio"
        name="wf-node-control-{p.index}"
        id={radioId(choice.kind)}
        value={choice.kind}
        data-testid={testIdOf(choice.kind)}
        aria-labelledby="{radioId(choice.kind)}-name"
        aria-describedby="{radioId(choice.kind)}-desc"
        checked={shown === choice.kind}
        disabled={p.readonly || (choice.kind !== 'once' && !p.loopable)}
        onchange={() => choose(choice.kind)}
      />
      <span>
        <b id="{radioId(choice.kind)}-name">{choice.title}</b>
        <span class="d" id="{radioId(choice.kind)}-desc">{choice.description}</span>
      </span>
    </label>
  {/each}
</fieldset>
{#if pending !== null && carried !== undefined}
  <p class="note err wf-control-confirm" role="alert">
    Switching discards the {controlKindWord(carried)} settings.
    <button
      type="button"
      class="linkbtn"
      data-testid="workflow-node-control-switch-{p.index}"
      onclick={confirmSwitch}>Switch</button
    >
    ·
    <button type="button" class="linkbtn" data-testid="workflow-node-control-keep-{p.index}" onclick={keepCurrent}
      >Keep</button
    >
  </p>
{/if}
{#if !p.loopable}
  <p class="inh">Repeat and For each apply to child Workflow steps.</p>
{/if}
