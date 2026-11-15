<script lang="ts">
  // One branch, in the inspector. What the list Builder rendered as a connection
  // row, minus the horizontal cramming — the canvas selects the arm and this panel
  // edits it. A head names the branch and the two steps it joins; the body follows
  // the mockup: where it goes, where it comes from, when it is taken, and how the
  // run hands over. It ends as the mockup's does, with Delete on a line of its own.
  // The moves above it are the product's: they move the branch within the
  // Workflow's saved list of branches, whose order breaks a tie in priority among
  // the branches from one step.
  //
  // The condition controls live in `WorkflowConditionFields`, carried over
  // unchanged in substance: every control that decides a condition's meaning is a
  // select over a closed set, so FR-021 holds by construction, and the one
  // free-text control is the literal being compared against (FR-024).
  //
  // Endpoints are selects over the nodes in this graph and the ports their
  // Pipelines declare, so an endpoint naming something that does not exist stays
  // unauthorable rather than being rejected later (FR-042).
  //
  // `Fallback` and `Priority` set the offer order the flow is laid out in, and
  // `addWorkflowBranch` seeds a fallback arm — a seeded flag with no control to
  // clear it would be a trap. `Selection` is the rule the host demands for a
  // collection output feeding a single input (`selection-rule-required`). Note that
  // the run side does not yet read `selection`: it gates the save, and that is what
  // the control is for.
  //
  // No rule lives in this markup. Arity, literal parsing, and priority parsing all
  // come from `workflow-catalog-state.ts`.
  import {
    formatConditionSummary,
    WORKFLOW_SELECTION_RULES,
    type PortablePipelineDefinition,
    type PortableWorkflowDefinition,
    type WorkflowConnection,
    type WorkflowNode,
  } from "../../lib/snapshot-types";
  import {
    parseWorkflowPriority,
    workflowPortIds,
    type WorkflowConditionPatch,
    type WorkflowDraftError,
  } from "./workflow-catalog-state";
  import { SELECTION_WORDS, stepOptionWords } from "./workflow-field-words";
  import { connectionTargetTitle, nodeTitle } from "./workflow-flow-view";
  import WorkflowConditionFields from "./WorkflowConditionFields.svelte";
  import WorkflowRowDefects from "./WorkflowRowDefects.svelte";

  interface Props {
    index: number;
    connection: WorkflowConnection;
    nodes: readonly WorkflowNode[];
    pipelines: readonly PortablePipelineDefinition[];
    workflows?: readonly PortableWorkflowDefinition[];
    defects: readonly WorkflowDraftError[];
    readonly: boolean;
    connectionCount: number;
    onretarget: (
      index: number,
      end: "from" | "to",
      patch: { nodeId?: string; portId?: string; kind?: "node" | "return" },
    ) => void;
    onpatch: (index: number, patch: Partial<WorkflowConnection>) => void;
    onconditiontoggle: (index: number, conditional: boolean) => void;
    onconditionpatch: (index: number, patch: WorkflowConditionPatch) => void;
    onconditionvalue: (index: number, valueIndex: number, text: string) => void;
    onconditionvalueadd: (index: number) => void;
    onconditionvalueremove: (index: number, valueIndex: number) => void;
    onmove: (index: number, delta: number) => void;
    onremove: (index: number) => void;
    /** Leaves the branch for the Workflow's own settings. */
    onback?: () => void;
  }

  const p: Props = $props();

  /** What a port select offers when the branch carries no data, only the turn. */
  const EXECUTION_ONLY = "(execution only)";

  const rawCondition = $derived(p.connection.condition);
  const condition = $derived(
    rawCondition !== undefined && "left" in rawCondition
      ? rawCondition
      : undefined,
  );
  const isFallback = $derived(p.connection.isDefault === true);
  const handoff = $derived(p.connection.handoff ?? "auto");
  const ruleSummary = $derived.by((): string => {
    const base = formatConditionSummary(rawCondition, isFallback);
    const details: string[] = [base];
    if (isFallback && rawCondition !== undefined) {
      details.push("fallback");
    }
    if (p.connection.priority !== undefined) {
      details.push(`priority ${p.connection.priority}`);
    }
    if (p.connection.handoff === "manual") {
      details.push("manual handoff");
    }
    return details.join(" · ");
  });
  const fromTitle = $derived(titleOf(p.connection.from.nodeId));
  const toTitle = $derived(connectionTargetTitle(p.nodes, p.connection));

  /** A step's title by identifier, or the identifier for a step the graph lacks. */
  function titleOf(nodeId: string): string {
    const node = p.nodes.find((entry) => entry.nodeId === nodeId);
    return node ? nodeTitle(node) : nodeId;
  }

  /** The declared ports of the node one end currently names, for that end's select. */
  function portsFor(
    nodeId: string,
    direction: "in" | "out",
  ): readonly string[] {
    return workflowPortIds(
      p.nodes.find((node) => node.nodeId === nodeId),
      p.pipelines,
      direction,
      p.workflows ?? [],
    );
  }

  function setSelection(value: string): void {
    p.onpatch(p.index, {
      selection: WORKFLOW_SELECTION_RULES.find((rule) => rule === value),
    });
  }
</script>

<div class="wf-ins-mode" data-testid="workflow-branch-inspector-{p.index}">
  <div class="ins-head wf-ins-head" class:wf-ins-head-back={p.onback !== undefined}>
    {#if p.onback}
      <button
        type="button"
        class="icon-btn"
        data-testid="workflow-settings-btn"
        aria-label="Back to the Workflow"
        onclick={() => p.onback?.()}
        ><svg class="i" aria-hidden="true"><use href="#i-collapse"></use></svg></button
      >
    {/if}
    <h2>
      <span class="kicon k-logic" aria-hidden="true"
        ><svg class="i" aria-hidden="true"><use href="#i-cond"></use></svg></span
      >Branch {p.index + 1}
    </h2>
    <div class="sub muted">{fromTitle} → {toTitle}</div>
  </div>

  <div class="ins-body">
    <p class="wf-branch-rule">
      <span class="wf-badge" data-testid="workflow-branch-rule-summary-{p.index}">{ruleSummary}</span>
    </p>
    <WorkflowRowDefects
      id="workflow-connection-defects-{p.index}"
      defects={p.defects}
    />

    <h3>Goes to</h3>
    <label class="field">
      <span class="sr-only">Target step</span>
      <select
        class="input"
        data-testid="workflow-connection-to-node-{p.index}"
        value={p.connection.to.nodeId}
        disabled={p.readonly}
        onchange={(event) =>
          p.onretarget(p.index, "to", { nodeId: event.currentTarget.value })}
      >
        {#each p.nodes as node (node.nodeId)}
          <option value={node.nodeId}>{stepOptionWords(node)}</option>
        {/each}
      </select>
    </label>
    <label class="field">
      <span>Input</span>
      <select
        class="input"
        data-testid="workflow-connection-to-port-{p.index}"
        value={p.connection.to.portId ?? ""}
        disabled={p.readonly}
        onchange={(event) =>
          p.onretarget(p.index, "to", { portId: event.currentTarget.value })}
      >
        {#if portsFor(p.connection.to.nodeId, "in").length === 0 || !p.connection.to.portId}
          <option value="">{EXECUTION_ONLY}</option>
        {/if}
        {#each portsFor(p.connection.to.nodeId, "in") as portId (portId)}
          <option value={portId}>{portId}</option>
        {/each}
      </select>
    </label>
    <label class="field">
      <span>Collection selection</span>
      <select
        class="input"
        data-testid="workflow-connection-selection-{p.index}"
        value={p.connection.selection ?? ""}
        disabled={p.readonly}
        onchange={(event) => setSelection(event.currentTarget.value)}
      >
        <option value="">Not set</option>
        {#each WORKFLOW_SELECTION_RULES as rule (rule)}
          <option value={rule}>{SELECTION_WORDS[rule]}</option>
        {/each}
      </select>
    </label>
    <label class="wf-check">
      <input
        type="checkbox"
        data-testid="workflow-connection-return-{p.index}"
        checked={p.connection.to.kind === "return"}
        disabled={p.readonly}
        onchange={(event) =>
          p.onretarget(p.index, "to", {
            kind: event.currentTarget.checked ? "return" : "node",
          })}
      />
      <span>Return from Workflow</span>
    </label>

    <h3>Comes from</h3>
    <label class="field">
      <span class="sr-only">Source step</span>
      <select
        class="input"
        data-testid="workflow-connection-from-node-{p.index}"
        value={p.connection.from.nodeId}
        disabled={p.readonly}
        onchange={(event) =>
          p.onretarget(p.index, "from", { nodeId: event.currentTarget.value })}
      >
        {#each p.nodes as node (node.nodeId)}
          <option value={node.nodeId}>{stepOptionWords(node)}</option>
        {/each}
      </select>
    </label>
    <label class="field">
      <span>Output</span>
      <select
        class="input"
        data-testid="workflow-connection-from-port-{p.index}"
        value={p.connection.from.portId ?? ""}
        disabled={p.readonly}
        onchange={(event) =>
          p.onretarget(p.index, "from", { portId: event.currentTarget.value })}
      >
        {#if portsFor(p.connection.from.nodeId, "out").length === 0 || !p.connection.from.portId}
          <option value="">{EXECUTION_ONLY}</option>
        {/if}
        {#each portsFor(p.connection.from.nodeId, "out") as portId (portId)}
          <option value={portId}>{portId}</option>
        {/each}
      </select>
    </label>

    <h3>Condition</h3>
    <label class="wf-check">
      <input
        type="checkbox"
        data-testid="workflow-condition-enabled-{p.index}"
        checked={rawCondition !== undefined}
        disabled={p.readonly}
        onchange={(event) =>
          p.onconditiontoggle(p.index, event.currentTarget.checked)}
      />
      <span>Only when a condition holds</span>
    </label>
    {#if condition}
      <WorkflowConditionFields
        index={p.index}
        {condition}
        nodes={p.nodes}
        readonly={p.readonly}
        onconditionpatch={p.onconditionpatch}
        onconditionvalue={p.onconditionvalue}
        onconditionvalueadd={p.onconditionvalueadd}
        onconditionvalueremove={p.onconditionvalueremove}
      />
    {:else if rawCondition === undefined && !isFallback}
      <p class="muted wf-ins-line">Always taken.</p>
    {/if}
    <!-- The offer order the canvas draws. `Fallback` is considered only when no
         explicit arm matched (FR-027), and an unset priority sorts last, so blank
         is a real value here rather than a missing one. -->
    <label class="wf-check">
      <input
        type="checkbox"
        data-testid="workflow-connection-default-{p.index}"
        checked={isFallback}
        disabled={p.readonly}
        onchange={(event) =>
          p.onpatch(p.index, {
            isDefault: event.currentTarget.checked ? true : undefined,
          })}
      />
      <span>Fallback</span>
    </label>
    {#if isFallback}
      <p class="note" data-testid="workflow-branch-fallback-note-{p.index}">
        This is the fallback: it is taken when no other branch from {fromTitle} matches. It is always
        checked last.
      </p>
    {/if}
    <label class="field">
      <span>Priority (lower is checked first)</span>
      <input
        class="input"
        type="number"
        step="1"
        data-testid="workflow-connection-priority-{p.index}"
        value={p.connection.priority ?? ""}
        readonly={p.readonly}
        placeholder="Not set (checked last)"
        oninput={(event) =>
          p.onpatch(p.index, {
            priority: parseWorkflowPriority(event.currentTarget.value),
          })}
      />
    </label>

    <h3>Handoff</h3>
    <fieldset class="wf-handoff" data-testid="workflow-connection-handoff-{p.index}">
      <legend class="sr-only">Handoff</legend>
      <label class="radio">
        <input
          type="radio"
          name="wf-handoff-{p.index}"
          data-testid="workflow-connection-handoff-auto-{p.index}"
          aria-labelledby="wf-handoff-auto-{p.index}"
          checked={handoff === "auto"}
          disabled={p.readonly}
          onchange={() => p.onpatch(p.index, { handoff: "auto" })}
        />
        <span><b id="wf-handoff-auto-{p.index}">Continue automatically</b></span>
      </label>
      <label class="radio">
        <input
          type="radio"
          name="wf-handoff-{p.index}"
          data-testid="workflow-connection-handoff-manual-{p.index}"
          aria-labelledby="wf-handoff-manual-{p.index}"
          aria-describedby="wf-handoff-manual-d-{p.index}"
          checked={handoff === "manual"}
          disabled={p.readonly}
          onchange={() => p.onpatch(p.index, { handoff: "manual" })}
        />
        <span
          ><b id="wf-handoff-manual-{p.index}">Wait for the operator</b><span
            class="d"
            id="wf-handoff-manual-d-{p.index}"
            >The run pauses here until someone chooses Continue Handoff.</span
          ></span
        >
      </label>
    </fieldset>

    {#if !p.readonly}
      <div class="wf-branch-actions">
        <button
          type="button"
          class="icon-btn"
          data-testid="workflow-connection-up-{p.index}"
          aria-label="Move branch {p.index + 1} earlier"
          disabled={p.index === 0}
          onclick={() => p.onmove(p.index, -1)}
          ><svg class="i wf-flip" aria-hidden="true"><use href="#i-chev"></use></svg></button
        >
        <button
          type="button"
          class="icon-btn"
          data-testid="workflow-connection-down-{p.index}"
          aria-label="Move branch {p.index + 1} later"
          disabled={p.index === p.connectionCount - 1}
          onclick={() => p.onmove(p.index, 1)}
          ><svg class="i" aria-hidden="true"><use href="#i-chev"></use></svg></button
        >
      </div>
      <p class="wf-branch-delete">
        <button
          type="button"
          class="btn btn-ghost wf-delete"
          data-testid="workflow-connection-remove-{p.index}"
          onclick={() => p.onremove(p.index)}
          ><svg class="i" aria-hidden="true"><use href="#i-trash"></use></svg>Delete this branch</button
        >
      </p>
    {/if}
  </div>
</div>
