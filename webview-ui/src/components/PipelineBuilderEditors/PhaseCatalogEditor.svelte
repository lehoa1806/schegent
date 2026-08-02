<script lang="ts">
  import type { PhaseDefinition, WorkflowSnapshot } from '../../lib/snapshot-types';
  import RawJsonPhaseEditor from '../settings/RawJsonPhaseEditor.svelte';
  import RetryConditionEditor from '../settings/RetryConditionEditor.svelte';
  import TrustBanner from '../TrustBanner.svelte';
  import type { MutablePhase, PhaseEditState } from './types';

  const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
  const RUNNER_KINDS = ['claude', 'codex', 'agy'] as const;
  const GIT_METADATA_WRITE_PHASE_IDS = new Set([
    'speckit-specify',
    'specify-brainstorm',
    'superpowers-implement',
    'finalize',
    'superpowers-review-close'
  ]);

  interface Props {
    snapshot: WorkflowSnapshot;
    phases: MutablePhase[];
    editStateById: Record<string, PhaseEditState>;
    selectedIndex: number | null;
    historyIndex: number;
    historyLength: number;
    trusted: boolean;
    retryConditionsTrusted: boolean;
    showTrustBanner: boolean;
    showRetryTrustBanner: boolean;
    saveError: string | null;
    onselect: (index: number | null) => void;
    onadd: () => void;
    onremove: (index: number) => void;
    onreset: (index: number) => void;
    onphasechange: (index: number, patch: Partial<MutablePhase>) => void;
    onmoveup: (index: number) => void;
    onmovedown: (index: number) => void;
    onundo: () => void;
    onredo: () => void;
    onsave: () => void;
    ondismisssaveerror: () => void;
    ontoggleraw: (phaseId: string) => void;
    onrawsave: (index: number, parsed: Record<string, unknown>) => void;
    ontoggleretry: (index: number) => void;
    onretrychange: (index: number, event: { source: string; valid: boolean }) => void;
    onduplicate: (index: number) => void;
  }

  const {
    snapshot,
    phases,
    editStateById,
    selectedIndex,
    historyIndex,
    historyLength,
    trusted,
    retryConditionsTrusted,
    showTrustBanner,
    showRetryTrustBanner,
    saveError,
    onselect,
    onadd,
    onremove,
    onreset,
    onphasechange,
    onmoveup,
    onmovedown,
    onundo,
    onredo,
    onsave,
    ondismisssaveerror,
    ontoggleraw,
    onrawsave,
    ontoggleretry,
    onretrychange,
    onduplicate
  }: Props = $props();

  const selectedPhase = $derived(selectedIndex !== null ? phases[selectedIndex] : null);
  const selectedEditState = $derived(
    selectedPhase ? editStateById[selectedPhase.id] ?? { rawJsonMode: false } : null
  );

  function isRetryEnabled(phase: MutablePhase): boolean {
    return typeof phase.retryCondition === 'string';
  }

  function phasePrecedenceLabel(phase: MutablePhase): string | null {
    if (!phase.runner) return null;
    const layer = snapshot.phasePrecedence?.[`${phase.id}::runner`];
    if (!layer || layer === 'unset') return null;
    if (layer === 'built-in') return 'Built-in';
    if (layer === 'workspace') return 'Workspace';
    return 'User';
  }

  function runnerOptionDisabled(phaseId: string, runner: string): boolean {
    return GIT_METADATA_WRITE_PHASE_IDS.has(phaseId) &&
      (runner === '' || runner === 'codex');
  }

  function modelsFor(phase: MutablePhase): readonly string[] {
    const runner = phase.runner || snapshot.defaultRunnerKind || 'claude';
    return snapshot.availableModels?.[runner] ?? [];
  }

  function configuredModelUnavailable(phase: MutablePhase): boolean {
    return !!phase.model && !modelsFor(phase).includes(phase.model);
  }

  function effortOptionDisabled(phase: MutablePhase, effort: string): boolean {
    const runner = phase.runner || snapshot.defaultRunnerKind || 'claude';
    return runner === 'agy' && (effort === 'xhigh' || effort === 'max');
  }
</script>

{#if showTrustBanner}
  <TrustBanner variant="phases" />
{/if}
{#if showRetryTrustBanner}
  <TrustBanner variant="retry-conditions" />
{/if}
<div class="toolbar">
  <button class="btn btn-primary" data-testid="phases-add" onclick={onadd} disabled={!trusted}>Add Phase</button>
  <button class="btn" disabled={historyIndex <= 0} onclick={onundo}>Undo</button>
  <button class="btn" disabled={historyIndex >= historyLength - 1} onclick={onredo}>Redo</button>
  <button class="btn btn-secondary" data-testid="phases-save-all" style="margin-left:auto" onclick={onsave} disabled={!trusted}>Save Phases</button>
</div>
{#if saveError}
  <div class="save-error-banner" data-testid="save-error-banner" role="alert">
    <span class="save-error-icon">⚠</span>
    <span class="save-error-text">Save rejected: {saveError}</span>
    <button class="save-error-dismiss" onclick={ondismisssaveerror}>✕</button>
  </div>
{/if}
<div class="split-pane">
  <div class="pane-left">
    <div class="phase-list">
      {#each phases as phase, index (phase.id + '-' + index)}
        <div class="phase-list-row">
          <button class="phase-list-item {selectedIndex === index ? 'selected' : ''}" data-testid="phases-list-item-{phase.id}" onclick={() => onselect(index)}>
            <div class="phase-list-title">{phase.name || 'Untitled Phase'}</div>
            <div class="phase-list-id">{phase.id}</div>
          </button>
          <div class="phase-list-actions">
            <button class="icon-btn" data-testid="phases-move-up-{phase.id}" disabled={index === 0} onclick={() => onmoveup(index)}>↑</button>
            <button class="icon-btn" data-testid="phases-move-down-{phase.id}" disabled={index === phases.length - 1} onclick={() => onmovedown(index)}>↓</button>
          </div>
        </div>
      {/each}
    </div>
  </div>
  <div class="pane-right">
    {#if selectedPhase && selectedIndex !== null && selectedEditState}
      {@const phase = selectedPhase}
      {@const index = selectedIndex}
      <div class="editor-card full-height" data-testid="phases-editor-{phase.id}">
        <div class="card-header-complex">
          <input class="title-input" data-testid="phases-name-{phase.id}" value={phase.name} oninput={(event) => onphasechange(index, { name: event.currentTarget.value })} placeholder="Phase Name" />
          <div class="header-actions">
            <button class="btn btn-ghost" data-testid="phases-raw-json-toggle" onclick={() => ontoggleraw(phase.id)}>
              {selectedEditState.rawJsonMode ? 'Form view' : 'Edit as Raw JSON'}
            </button>
            <button class="btn btn-ghost" onclick={() => onselect(null)}>Cancel</button>
            <button class="btn btn-ghost" onclick={() => onreset(index)}>Reset to Default</button>
            <button class="btn btn-ghost" data-testid="phases-duplicate" onclick={() => onduplicate(index)}>Duplicate Phase</button>
            <button class="btn btn-secondary" onclick={onsave}>Save Phase</button>
            <button class="btn btn-destructive" data-testid="phases-remove" onclick={() => onremove(index)}>Delete Phase</button>
          </div>
        </div>

        {#if selectedEditState.rawJsonMode}
          <RawJsonPhaseEditor
            phase={phase as unknown as Record<string, unknown>}
            onsave={(parsed) => onrawsave(index, parsed as Record<string, unknown>)}
          />
        {:else}
          <div class="form-grid">
            <label class="form-field">
              <span class="form-label">Name</span>
              <input class="text-input" data-testid="phases-name-field-{phase.id}" value={phase.name} oninput={(event) => onphasechange(index, { name: event.currentTarget.value })} placeholder="Phase display name" />
            </label>
            <label class="form-field">
              <span class="form-label">ID</span>
              <input class="text-input" value={phase.id} oninput={(event) => onphasechange(index, { id: event.currentTarget.value })} placeholder="phase-id" />
            </label>
            <label class="form-field full-width">
              <span class="form-label">Instruction</span>
              <textarea class="text-area" rows="6" value={phase.instruction} oninput={(event) => onphasechange(index, { instruction: event.currentTarget.value })} placeholder="Phase instructions..."></textarea>
            </label>
            <label class="form-field" style="flex: 1">
              <span class="form-label">Model</span>
              <select class="select-input" data-testid="phases-model-{phase.id}" value={phase.model ?? ''} onchange={(event) => onphasechange(index, { model: event.currentTarget.value || undefined })}>
                <option value="">[Inherit / Default Backend Model]</option>
                {#if configuredModelUnavailable(phase)}
                  <option value={phase.model}>{phase.model} (Unavailable)</option>
                {/if}
                {#each modelsFor(phase) as model}
                  <option value={model}>{model}</option>
                {/each}
              </select>
            </label>
            <label class="form-field" style="flex: 1">
              <span class="form-label">Effort</span>
              <select class="select-input" data-testid="phases-effort-{phase.id}" value={phase.effort ?? ''} onchange={(event) => { const value = event.currentTarget.value; onphasechange(index, { effort: value ? (value as PhaseDefinition['effort']) : undefined }); }}>
                <option value="">[Inherit]</option>
                {#each EFFORT_LEVELS as effort}
                  <option value={effort} disabled={effortOptionDisabled(phase, effort)}>{effort}</option>
                {/each}
              </select>
            </label>
            <label class="form-field" style="flex: 1">
              <span class="form-label">
                Runner
                {#if phasePrecedenceLabel(phase)}
                  <span class="precedence-badge" data-testid="phases-runner-precedence-{phase.id}">{phasePrecedenceLabel(phase)}</span>
                {/if}
              </span>
              <select class="select-input" data-testid="phases-runner-{phase.id}" value={phase.runner ?? ''} onchange={(event) => { const value = event.currentTarget.value; onphasechange(index, { runner: value ? (value as PhaseDefinition['runner']) : undefined }); }}>
                <option value="" disabled={runnerOptionDisabled(phase.id, '')}>[Inherit / Default]</option>
                {#each RUNNER_KINDS as runner}
                  <option value={runner} disabled={runnerOptionDisabled(phase.id, runner)}>{runner}{!snapshot.availableBackends.includes(runner) ? ' (Unavailable)' : ''}</option>
                {/each}
              </select>
            </label>
            <label class="form-field checkbox-field">
              <input
                type="checkbox"
                data-testid="phases-required-{phase.id}"
                checked={phase.isRequired !== false}
                onchange={(event) => onphasechange(index, { isRequired: event.currentTarget.checked })}
              />
              <span class="form-label">Required</span>
            </label>
            <label class="form-field checkbox-field">
              <input type="checkbox" data-testid="phases-retry-toggle" checked={isRetryEnabled(phase)} onchange={() => ontoggleretry(index)} disabled={!retryConditionsTrusted} />
              <span class="form-label">Retry Condition</span>
            </label>
            {#if isRetryEnabled(phase)}
              <div class="form-field full-width retry-condition-row">
                <RetryConditionEditor
                  source={phase.retryCondition ?? ''}
                  instruction={phase.instruction}
                  onchange={(event) => onretrychange(index, event)}
                  readonly={!retryConditionsTrusted}
                />
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {:else}
      <div class="empty-selection">Select a phase to edit or add a new one.</div>
    {/if}
  </div>
</div>
