<script lang="ts">
  // The inspector of one step: a head that names it, then its settings in four tabs.
  //
  // Step says what the step runs and where the Workflow may begin; Data says where
  // each input comes from; Control says how the step runs; Advanced holds its
  // identifier. The tabs follow the product's roving contract (FR-R4-F08, as on the
  // run detail tabs): one Tab stop, arrow keys, Home and End. Every panel stays
  // rendered and only the selected one shows, so each field keeps its test id and
  // its value whichever tab is open. The open tab carries over to the next step,
  // except Control, which a step that cannot loop leaves for Step.
  import { untrack } from 'svelte';
  import type {
    PortablePhaseDefinition,
    PortablePipelineDefinition,
    PortableWorkflowDefinition,
    WorkflowNode
  } from '../../lib/snapshot-types';
  import { workflowPortIds, type WorkflowDraftError } from './workflow-catalog-state';
  import { nodeTargetKind, nodeTitle, type WorkflowNodeTargetKind } from './workflow-flow-view';
  import { stepInputRows, stepOutputIds } from './workflow-node-data';
  import type { MutableWorkflow } from './types';
  import WorkflowNodeControlChoice from './WorkflowNodeControlChoice.svelte';
  import WorkflowNodeControlEditor from './WorkflowNodeControlEditor.svelte';
  import WorkflowRowDefects from './WorkflowRowDefects.svelte';

  interface ChildWorkflowOption {
    readonly workflowId: string;
    readonly name: string;
  }

  interface Props {
    readonly row: MutableWorkflow;
    readonly index: number;
    readonly node: WorkflowNode;
    readonly pipelines: readonly PortablePipelineDefinition[];
    readonly phases: readonly PortablePhaseDefinition[];
    readonly workflows: readonly PortableWorkflowDefinition[];
    /** The Workflows this step may run: every other Workflow, once each. */
    readonly childWorkflowOptions: readonly ChildWorkflowOption[];
    readonly childWorkflow: PortableWorkflowDefinition | null;
    readonly defects: readonly WorkflowDraftError[];
    readonly readonly: boolean;
    readonly onnodepatch: (index: number, patch: Partial<WorkflowNode>) => void;
    readonly onstarttoggle: (nodeId: string) => void;
    readonly onbranchadd: (nodeId: string) => void;
    readonly onopenworkflow?: (workflowId: string, fromNodeId: string) => void;
    readonly onopenphase?: (phaseId: string) => void;
    readonly onselectworkflow?: () => void;
  }

  const p: Props = $props();

  const STEP_TABS = ['step', 'data', 'control', 'advanced'] as const;
  type StepTab = (typeof STEP_TABS)[number];
  const TAB_WORDS: Readonly<Record<StepTab, string>> = {
    step: 'Step',
    data: 'Data',
    control: 'Control',
    advanced: 'Advanced'
  };
  const KIND_WORDS: Readonly<Record<WorkflowNodeTargetKind, string>> = {
    phase: 'Phase step',
    workflow: 'Child Workflow step',
    pipeline: 'Pipeline step'
  };
  // The kind's tile, as on the step's card: whole sprite references the sprite test can check.
  const KIND_ICONS: Readonly<Record<WorkflowNodeTargetKind, string>> = {
    phase: '#i-phase',
    workflow: '#i-workflow',
    pipeline: '#i-build'
  };
  const TARGET_KINDS: readonly WorkflowNodeTargetKind[] = ['phase', 'workflow', 'pipeline'];

  const kind = $derived(nodeTargetKind(p.node));
  const loopable = $derived(kind === 'workflow');
  const offersKinds = $derived(p.phases.length > 0 || p.childWorkflowOptions.length > 0);
  const inputRows = $derived(stepInputRows(p.row, p.index, workflowPortIds(p.node, p.pipelines, 'in', p.workflows)));
  const outputIds = $derived(stepOutputIds(p.row, p.index, workflowPortIds(p.node, p.pipelines, 'out', p.workflows)));
  const unknownPhase = $derived(
    p.node.phaseId !== undefined && !p.phases.some((entry) => entry.phaseId === p.node.phaseId)
  );
  const unknownWorkflow = $derived(
    p.node.workflowId !== undefined &&
      !p.childWorkflowOptions.some((entry) => entry.workflowId === p.node.workflowId)
  );
  const opensPhase = $derived(kind === 'phase' && !!p.node.phaseId && p.onopenphase !== undefined);
  const opensWorkflow = $derived(kind === 'workflow' && !!p.node.workflowId && p.onopenworkflow !== undefined);

  let tab = $state<StepTab>('step');
  let shownFor: string | undefined;

  $effect.pre(() => {
    const nodeId = p.node.nodeId;
    untrack(() => {
      if (nodeId === shownFor) return;
      shownFor = nodeId;
      if (tab === 'control' && !loopable) tab = 'step';
    });
  });

  function tabId(name: StepTab): string {
    return `wf-ins-tab-${name}`;
  }

  function panelId(name: StepTab): string {
    return `wf-ins-panel-${name}`;
  }

  function nextTabIndex(key: string, current: number): number | undefined {
    const last = STEP_TABS.length - 1;
    if (key === 'ArrowRight') return current === last ? 0 : current + 1;
    if (key === 'ArrowLeft') return current === 0 ? last : current - 1;
    if (key === 'Home') return 0;
    if (key === 'End') return last;
    return undefined;
  }

  function onTabKeydown(event: KeyboardEvent): void {
    const next = nextTabIndex(event.key, STEP_TABS.indexOf(tab));
    const name = next === undefined ? undefined : STEP_TABS.at(next);
    if (name === undefined) return;
    event.preventDefault();
    tab = name;
    queueMicrotask(() => document.getElementById(tabId(name))?.focus());
  }

  function switchNodeKind(next: WorkflowNodeTargetKind): void {
    if (next === 'phase') {
      p.onnodepatch(p.index, {
        kind: 'phase',
        phaseId: p.phases.at(0)?.phaseId ?? '',
        workflowId: undefined,
        pipelineId: undefined,
        control: undefined
      });
      return;
    }
    if (next === 'workflow') {
      p.onnodepatch(p.index, {
        kind: 'workflow',
        workflowId: p.childWorkflowOptions.at(0)?.workflowId ?? '',
        phaseId: undefined,
        pipelineId: undefined
      });
      return;
    }
    p.onnodepatch(p.index, {
      kind: undefined,
      pipelineId: p.pipelines.at(0)?.pipelineId ?? '',
      phaseId: undefined,
      workflowId: undefined,
      control: undefined
    });
  }

  function onKindChange(value: string): void {
    const next = TARGET_KINDS.find((entry) => entry === value);
    if (next !== undefined) switchNodeKind(next);
  }

  // Only a child Workflow's inputs are required by the host; it says which are optional.
  function isRequiredInput(portId: string): boolean {
    if (kind !== 'workflow') return false;
    return p.childWorkflow?.inputs?.find((port) => port.portId === portId)?.required !== false;
  }

  function openDefinition(): void {
    if (kind === 'phase' && p.node.phaseId) p.onopenphase?.(p.node.phaseId);
    if (kind === 'workflow' && p.node.workflowId) p.onopenworkflow?.(p.node.workflowId, p.node.nodeId);
  }
</script>

<div class="wf-ins-mode" data-testid="workflow-node-inspector-{p.index}">
  <div class="ins-head wf-ins-head" class:wf-ins-head-back={p.onselectworkflow !== undefined}>
    {#if p.onselectworkflow}
      <button
        type="button"
        class="icon-btn"
        data-testid="workflow-settings-btn"
        aria-label="Back to the Workflow"
        onclick={() => p.onselectworkflow?.()}
      >
        <svg class="i" aria-hidden="true"><use href="#i-collapse"></use></svg>
      </button>
    {/if}
    <h2>
      <span class="kicon k-{kind}" aria-hidden="true"
        ><svg class="i" aria-hidden="true"><use href={KIND_ICONS[kind]}></use></svg></span
      >{nodeTitle(p.node)}
    </h2>
    <div class="sub muted">
      {KIND_WORDS[kind]} ·
      <span class="mono" data-testid="workflow-node-inspector-id">{p.node.nodeId}</span>
    </div>
  </div>

  <div class="ins-tabs" role="tablist" aria-label="Step settings">
    {#each STEP_TABS as name (name)}
      <button
        type="button"
        role="tab"
        class="tab"
        id={tabId(name)}
        aria-selected={tab === name}
        aria-controls={panelId(name)}
        tabindex={tab === name ? 0 : -1}
        data-testid="workflow-node-tab-{name}"
        onkeydown={onTabKeydown}
        onclick={() => (tab = name)}>{TAB_WORDS[name]}</button
      >
    {/each}
  </div>

  <div class="ins-body" role="tabpanel" id={panelId('step')} aria-labelledby={tabId('step')} hidden={tab !== 'step'}>
    <h3>Runs</h3>
    {#if offersKinds}
      <label class="field">
        <span>Step type</span>
        <select
          class="input"
          data-testid="workflow-node-kind-select-{p.index}"
          value={kind}
          disabled={p.readonly}
          onchange={(event) => onKindChange(event.currentTarget.value)}
        >
          <option value="phase">Phase</option>
          <option value="workflow">Child Workflow</option>
        </select>
      </label>
    {/if}
    {#if kind === 'phase'}
      <label class="field">
        <span>Phase</span>
        <select
          class="input"
          data-testid="workflow-node-phase-select-{p.index}"
          value={p.node.phaseId ?? ''}
          disabled={p.readonly}
          onchange={(event) =>
            p.onnodepatch(p.index, {
              kind: 'phase',
              phaseId: event.currentTarget.value,
              workflowId: undefined,
              pipelineId: undefined
            })}
        >
          {#if unknownPhase}
            <option value={p.node.phaseId}>{p.node.phaseId} (not effective)</option>
          {/if}
          {#each p.phases as phase (phase.phaseId)}
            <option value={phase.phaseId}>{phase.name}</option>
          {/each}
        </select>
      </label>
    {:else if kind === 'workflow'}
      <label class="field">
        <span>Child Workflow</span>
        <select
          class="input"
          data-testid="workflow-node-workflow-select-{p.index}"
          value={p.node.workflowId ?? ''}
          disabled={p.readonly}
          onchange={(event) =>
            p.onnodepatch(p.index, {
              kind: 'workflow',
              workflowId: event.currentTarget.value,
              phaseId: undefined,
              pipelineId: undefined
            })}
        >
          {#if unknownWorkflow}
            <option value={p.node.workflowId}>{p.node.workflowId} (not effective)</option>
          {/if}
          {#each p.childWorkflowOptions as wf (wf.workflowId)}
            <option value={wf.workflowId}>{wf.name}</option>
          {/each}
        </select>
      </label>
    {:else if p.node.pipelineId}
      <dl class="kv">
        <dt>Pipeline</dt>
        <dd class="mono">{p.node.pipelineId}</dd>
      </dl>
    {/if}
    {#if offersKinds && !p.readonly}
      <p class="inh wf-runs-note">Changing what this step runs keeps its connections.</p>
    {/if}

    <label class="field">
      <span>Label on canvas</span>
      <input
        class="input"
        data-testid="workflow-node-label-{p.index}"
        value={p.node.label ?? ''}
        readonly={p.readonly}
        placeholder={p.node.nodeId}
        oninput={(event) => p.onnodepatch(p.index, { label: event.currentTarget.value })}
      />
    </label>
    <label class="wf-check">
      <input
        type="checkbox"
        data-testid="workflow-node-start-{p.index}"
        checked={p.row.startNodeIds.includes(p.node.nodeId)}
        disabled={p.readonly}
        onchange={() => p.onstarttoggle(p.node.nodeId)}
      />
      Start step (the Workflow may begin here)
    </label>
    {#if !p.readonly}
      <p class="wf-ins-action">
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          data-testid="workflow-node-branch-add-{p.index}"
          onclick={() => p.onbranchadd(p.node.nodeId)}
        >
          <svg class="i" aria-hidden="true"><use href="#i-plus"></use></svg>
          Add a branch from this step
        </button>
      </p>
    {/if}

    {#if loopable}
      <h3>Execution</h3>
      <p class="inh">Each step of the child Workflow uses its own settings.</p>
    {/if}

    {#if opensPhase || opensWorkflow}
      <h3>Definition</h3>
      <p class="wf-ins-line">
        <button
          type="button"
          class="linkbtn"
          data-testid={opensPhase ? `workflow-inspector-open-phase-${p.index}` : `workflow-inspector-open-child-${p.index}`}
          onclick={openDefinition}>{opensPhase ? 'Open Phase definition' : 'Open child Workflow definition'}</button
        >
      </p>
    {/if}

    {#if p.defects.length > 0}
      <h3>Issues</h3>
      <WorkflowRowDefects id="workflow-node-inspector-defects-{p.index}" defects={p.defects} />
    {/if}
  </div>

  <div class="ins-body" role="tabpanel" id={panelId('data')} aria-labelledby={tabId('data')} hidden={tab !== 'data'}>
    <h3>Inputs</h3>
    {#if inputRows.length > 0}
      <table class="bind">
        <thead>
          <tr><th scope="col">Input</th><th scope="col">Comes from</th></tr>
        </thead>
        <tbody>
          {#each inputRows as input (input.portId)}
            <tr data-testid="workflow-node-input-{p.index}-{input.portId}">
              <td class="mono">{input.portId}</td>
              {#if input.from !== null}
                <td>{input.from}</td>
              {:else if isRequiredInput(input.portId)}
                <td class="wf-unbound-required">Not bound</td>
              {:else}
                <td class="muted">Not bound (optional)</td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <p class="muted wf-ins-line">No inputs are declared or bound.</p>
    {/if}
    <h3>Outputs</h3>
    <div data-testid="workflow-node-ports-{p.index}">
      {#if outputIds.length > 0}
        <p class="mono wf-ins-line">{outputIds.join(', ')}</p>
      {:else}
        <p class="muted wf-ins-line">No outputs are declared.</p>
      {/if}
    </div>
    <p class="inh wf-ins-foot">Bindings are edited in the Workflow's Inputs and outputs.</p>
  </div>

  <div
    class="ins-body"
    role="tabpanel"
    id={panelId('control')}
    aria-labelledby={tabId('control')}
    hidden={tab !== 'control'}
  >
    {#key p.node.nodeId}
      <WorkflowNodeControlChoice
        index={p.index}
        node={p.node}
        childWorkflow={p.childWorkflow}
        {loopable}
        readonly={p.readonly}
        onnodepatch={p.onnodepatch}
      />
    {/key}
    {#if loopable}
      <WorkflowNodeControlEditor
        index={p.index}
        node={p.node}
        childWorkflow={p.childWorkflow}
        readonly={p.readonly}
        onnodepatch={p.onnodepatch}
      />
    {/if}
  </div>

  <div
    class="ins-body"
    role="tabpanel"
    id={panelId('advanced')}
    aria-labelledby={tabId('advanced')}
    hidden={tab !== 'advanced'}
  >
    <h3>Identity</h3>
    <dl class="kv">
      <dt>Node id</dt>
      <dd class="mono">{p.node.nodeId}</dd>
    </dl>
  </div>
</div>
