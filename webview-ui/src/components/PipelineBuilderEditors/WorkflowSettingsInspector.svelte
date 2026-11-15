<script lang="ts">
  // The inspector with nothing on the canvas in focus: the Workflow itself. A head
  // that names it, its status, what is wrong with it, then its settings in sections
  // that open and close: General opens first, and Candidate block opens whenever the
  // Workflow carries one. The mockup gives the summary and the settings a page each;
  // here they share one, so every field stays one scroll away.
  import {
    EFFORT_LEVELS,
    type BuilderLifecycle,
    type PortablePhaseDefinition
  } from '../../lib/snapshot-types';
  import type { WorkflowDraftError } from './workflow-catalog-state';
  import type { WorkflowGraphActions } from './workflow-catalog-actions';
  import type { MutableWorkflow } from './types';
  import DefinitionLifecyclePanel from '../Builder/DefinitionLifecyclePanel.svelte';
  import CandidateBlockEditor from './CandidateBlockEditor.svelte';
  import WorkflowPortsAndBindingsEditor from './WorkflowPortsAndBindingsEditor.svelte';

  interface ParentWorkflow {
    readonly workflowId: string;
    readonly name: string;
  }

  interface Props {
    readonly row: MutableWorkflow;
    readonly phases: readonly PortablePhaseDefinition[];
    /** The Workflows that run this one as a step. */
    readonly dependentParents: readonly ParentWorkflow[];
    readonly actions?: WorkflowGraphActions;
    /** The defects no step or branch owns. */
    readonly defects: readonly WorkflowDraftError[];
    readonly readonly: boolean;
    readonly lifecycle?: BuilderLifecycle;
    readonly onworkflowpatch: (patch: Partial<MutableWorkflow>) => void;
    readonly onopenworkflow?: (workflowId: string, fromNodeId: string) => void;
    readonly onopenphase?: (phaseId: string) => void;
  }

  const p: Props = $props();

  const UNTITLED_WORKFLOW = 'Untitled Workflow';
  const RUNNER_OPTIONS = ['claude', 'codex', 'agy'] as const;

  const title = $derived(p.row.name || UNTITLED_WORKFLOW);

  /** A port as the host's projection and a declared port both carry it. */
  interface NamedPort {
    readonly portId: string;
    readonly label: string;
  }

  /**
   * One side's ports by name: the host's derived ports, or the declared ones when
   * the host derived none, or `null` when there are neither.
   *
   * The derived ports are the host's projection, never recomputed here: they exist
   * on no persisted row (feature 083, FR-048), so a Workflow the host has not
   * projected says so rather than showing an empty list that would read as "none".
   * The summary moved here from the Workflow's list row, which shows only the name,
   * the id and the two badges (feature 186, FR-003).
   */
  function portNames(
    derived: readonly NamedPort[],
    declared: readonly NamedPort[] | undefined
  ): string | null {
    const ports = derived.length > 0 ? derived : (declared ?? []);
    return ports.length > 0 ? ports.map((port) => port.label || port.portId).join(', ') : null;
  }

  const inputNames = $derived(portNames(p.row.derivedInputs, p.row.inputs));
  const outputNames = $derived(portNames(p.row.derivedOutputs, p.row.outputs));
  /** What a side with no port reads: none on a saved Workflow, not yet known on a draft. */
  const noPorts = $derived(p.row.persisted ? 'none' : 'derived once saved');

  function setRunner(value: string): void {
    p.actions?.patchExecutionDefaults?.({ runner: value === '' ? undefined : value });
  }

  function setModel(value: string): void {
    const model = value.trim();
    p.actions?.patchExecutionDefaults?.({ model: model === '' ? undefined : model });
  }

  function setEffort(value: string): void {
    p.actions?.patchExecutionDefaults?.({ effort: EFFORT_LEVELS.find((level) => level === value) });
  }

  function setRecommendedNext(value: string): void {
    p.actions?.setRecommendedNext?.(
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    );
  }
</script>

<div class="wf-ins-mode" data-testid="workflow-settings-inspector">
  <div class="ins-head wf-ins-head">
    <h2>
      <span class="kicon k-workflow" aria-hidden="true"
        ><svg class="i" aria-hidden="true"><use href="#i-workflow"></use></svg></span
      >{title}
    </h2>
    <div class="sub mono muted">{p.row.workflowId}</div>
  </div>

  <div class="ins-body">
    <h3>Status</h3>
    <!-- One block, so the Status facts and the lifecycle panel's read as one list. -->
    <div class="wf-ins-status">
      <dl class="kv">
        <dt>State</dt>
        <dd><span class="status-badge status-{p.row.sourceStatus}">{p.row.sourceStatus}</span></dd>
        <dt>Steps</dt>
        <dd>{p.row.nodes.length}</dd>
        <dt>Used by</dt>
        {#if p.dependentParents.length > 0}
          <dd data-testid="workflow-dependent-parents">
            {#each p.dependentParents as parent, i (parent.workflowId)}
              {i > 0 ? ', ' : ''}
              {#if p.onopenworkflow}
                <button
                  type="button"
                  class="linkbtn"
                  data-testid="workflow-dependent-parent-{parent.workflowId}"
                  onclick={() => p.onopenworkflow?.(parent.workflowId, '')}>{parent.name || parent.workflowId}</button
                >
              {:else}
                {parent.name || parent.workflowId}
              {/if}
            {/each}
          </dd>
        {:else}
          <dd class="muted">No other Workflow</dd>
        {/if}
      </dl>
      <DefinitionLifecyclePanel
        kind="workflow"
        definitionId={p.row.workflowId}
        definitionName={title}
        lifecycle={p.lifecycle}
        defects={p.row.sourceErrors}
      />
    </div>

    {#if p.defects.length > 0}
      <h3>Issues ({p.defects.length})</h3>
      <ul class="field-errors" data-testid="workflow-field-errors" role="alert">
        <!-- Keyed by position: the host reports one `missing-required-input` per unbound port
             of a child Workflow node, all under the same field, so `field + code` repeats. -->
        {#each p.defects as defect, index (index)}
          <li>{defect.field}: {defect.message}</li>
        {/each}
      </ul>
    {/if}

    <details class="sect" open>
      <summary><h3>General</h3></summary>
      <div class="wf-sect-body">
        <label class="field">
          <span>Name</span>
          <input
            class="input"
            data-testid="workflow-field-name"
            value={p.row.name}
            readonly={p.readonly}
            oninput={(event) => p.onworkflowpatch({ name: event.currentTarget.value })}
          />
        </label>
        <label class="field">
          <span>Identifier</span>
          <input
            class="input mono"
            data-testid="workflow-field-workflowId"
            value={p.row.workflowId}
            readonly={p.row.persisted || p.readonly}
            oninput={(event) => p.onworkflowpatch({ workflowId: event.currentTarget.value })}
          />
        </label>
        <label class="field">
          <span>Description</span>
          <textarea
            class="input"
            data-testid="workflow-field-description"
            value={p.row.description ?? ''}
            readonly={p.readonly}
            oninput={(event) => p.onworkflowpatch({ description: event.currentTarget.value })}
          ></textarea>
        </label>
      </div>
    </details>

    <details class="sect">
      <summary><h3>Inputs and outputs</h3></summary>
      <div class="wf-sect-body">
        <p class="inh">What a parent Workflow passes in and gets back when it uses this one as a step.</p>
        <dl class="kv" data-testid="workflow-port-summary">
          <dt>Inputs</dt>
          <dd class:muted={inputNames === null} data-testid="workflow-port-summary-inputs">{inputNames ?? noPorts}</dd>
          <dt>Outputs</dt>
          <dd class:muted={outputNames === null} data-testid="workflow-port-summary-outputs">{outputNames ?? noPorts}</dd>
        </dl>
        {#if p.actions}
          <WorkflowPortsAndBindingsEditor workflow={p.row} readonly={p.readonly} actions={p.actions} defects={p.defects} />
        {/if}
      </div>
    </details>

    {#if p.actions}
      <details class="sect">
        <summary><h3>Execution defaults</h3></summary>
        <div class="wf-sect-body" data-testid="workflow-execution-defaults">
          <label class="field">
            <span>Runner</span>
            <select
              class="input"
              data-testid="workflow-default-runner"
              value={p.row.executionDefaults?.runner ?? ''}
              disabled={p.readonly}
              onchange={(event) => setRunner(event.currentTarget.value)}
            >
              <option value="">Inherit</option>
              {#each RUNNER_OPTIONS as runner (runner)}
                <option value={runner}>{runner}</option>
              {/each}
            </select>
          </label>
          <label class="field">
            <span>Model</span>
            <input
              class="input"
              data-testid="workflow-default-model"
              value={p.row.executionDefaults?.model ?? ''}
              readonly={p.readonly}
              oninput={(event) => setModel(event.currentTarget.value)}
            />
          </label>
          <label class="field">
            <span>Effort</span>
            <select
              class="input"
              data-testid="workflow-default-effort"
              value={p.row.executionDefaults?.effort ?? ''}
              disabled={p.readonly}
              onchange={(event) => setEffort(event.currentTarget.value)}
            >
              <option value="">Inherit</option>
              {#each EFFORT_LEVELS as effort (effort)}
                <option value={effort}>{effort}</option>
              {/each}
            </select>
          </label>
          <label class="field">
            <span>Recommended next (Workflow ids, comma-separated)</span>
            <input
              class="input mono"
              data-testid="workflow-recommended-next"
              value={(p.row.recommendedNext ?? []).join(', ')}
              readonly={p.readonly}
              oninput={(event) => setRecommendedNext(event.currentTarget.value)}
            />
          </label>
        </div>
      </details>
    {/if}

    <details class="sect" open={p.row.control !== undefined}>
      <summary><h3>Candidate block</h3></summary>
      <div class="wf-sect-body">
        <CandidateBlockEditor
          row={p.row}
          phases={p.phases}
          readonly={p.readonly}
          onedit={(edit) => p.onworkflowpatch(edit(p.row))}
          onopenphase={p.onopenphase}
        />
      </div>
    </details>
  </div>
</div>
