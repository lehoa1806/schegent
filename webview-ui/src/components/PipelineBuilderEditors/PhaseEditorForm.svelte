<script lang="ts">
  // The open Phase's form: the editor page's main column, in the four sections the redesign groups
  // a Phase into — what it is called, what it does, what it runs on, and when it retries.
  //
  // Every field writes through `onphasechange` exactly as the single-card editor it replaces did;
  // only the grouping and the controls' look changed. The error list the fields point at with
  // `aria-describedby` is drawn in the page's Summary, under "Issues".
  import { DEFAULT_BACKEND } from '../../../../src/contracts/backend-kinds';
  import type { PhaseDefinition, WorkflowSnapshot } from '../../lib/snapshot-types';
  import RetryConditionEditor from '../settings/RetryConditionEditor.svelte';
  import { mergeDetectedModels } from './model-catalog-state';
  import { phaseErrorId } from './phase-catalog-view';
  import RetryCapOutcomeEditor from './RetryCapOutcomeEditor.svelte';
  import type { MutablePhase } from './types';

  const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
  const RUNNER_KINDS = ['claude', 'codex', 'agy'] as const;
  // Feature 098 T018 — runner sideEffects containment is enforced by the host save gate and runner.

  type DirectiveKind = 'instruction' | 'skill';

  /** The directive switch, in the order it shows: a Phase either carries instructions or runs a skill. */
  const DIRECTIVE_KINDS: readonly { readonly id: DirectiveKind; readonly label: string }[] = [
    { id: 'instruction', label: 'Instructions' },
    { id: 'skill', label: 'Run a skill' }
  ];

  interface Props {
    snapshot: WorkflowSnapshot;
    phase: MutablePhase;
    /** The Phase's position in the authored list, which every write addresses. */
    index: number;
    readOnly: boolean;
    retryConditionsTrusted: boolean;
    onphasechange: (index: number, patch: Partial<MutablePhase>) => void;
    ontoggleretry: (index: number) => void;
    onretrychange: (index: number, event: { source: string; valid: boolean }) => void;
  }

  const {
    snapshot,
    phase,
    index,
    readOnly,
    retryConditionsTrusted,
    onphasechange,
    ontoggleretry,
    onretrychange
  }: Props = $props();

  const directive = $derived<DirectiveKind>(typeof phase.skill === 'string' ? 'skill' : 'instruction');
  const retryEnabled = $derived(typeof phase.retryCondition === 'string');
  /**
   * The backend the Phase runs on, by the host's rule (`effectiveRunnerKindForPhase`): its own
   * backend; else, for a Phase that writes Git metadata, the built-in default (Claude) whatever
   * the setting says; else the default backend the setting selects.
   */
  const effectiveRunner = $derived(
    phase.runner || (phase.sideEffects === 'git' ? DEFAULT_BACKEND : snapshot.defaultRunnerKind) || DEFAULT_BACKEND
  );
  const models = $derived(
    mergeDetectedModels(
      snapshot.configuredModels?.[effectiveRunner] ?? [],
      snapshot.availableModels?.[effectiveRunner] ?? []
    )
  );
  const configuredModelUnavailable = $derived(!!phase.model && !models.includes(phase.model));

  function changeDirectiveKind(kind: DirectiveKind): void {
    if (kind === directive) return;
    if (kind === 'skill') {
      onphasechange(index, { instruction: undefined, skill: '' });
    } else {
      onphasechange(index, { instruction: '', skill: undefined });
    }
  }

  function effortOptionDisabled(effort: string): boolean {
    return effectiveRunner === 'agy' && (effort === 'xhigh' || effort === 'max');
  }
</script>

<section class="form-sec" aria-labelledby="phase-basics-h">
  <h2 id="phase-basics-h">Basics</h2>
  <label class="field form-field">
    <span class="form-label">Name</span>
    <input class="input" data-testid="phases-name-field-{phase.id}" value={phase.name} readonly={readOnly} aria-invalid={phase.sourceErrors.some((error) => error.field === 'name') ? 'true' : undefined} aria-describedby={phaseErrorId(phase)} oninput={(event) => onphasechange(index, { name: event.currentTarget.value })} placeholder="Phase display name" />
  </label>
  <!-- Two lines rather than the one the redesign draws: a description that already holds a line
       break keeps it, where a single-line input would drop it on the next edit. -->
  <label class="field form-field">
    <span class="form-label">Description</span>
    <textarea class="input" rows="2" value={phase.description ?? ''} readonly={readOnly} oninput={(event) => onphasechange(index, { description: event.currentTarget.value || undefined })} placeholder="Optional Phase description"></textarea>
  </label>
  <div class="grid g2">
    <label class="field form-field">
      <span class="form-label">ID</span>
      <input class="input mono" value={phase.id} readonly={phase.persisted} aria-invalid={phase.sourceErrors.some((error) => error.field === 'phaseId') ? 'true' : undefined} aria-describedby={phaseErrorId(phase)} oninput={(event) => onphasechange(index, { id: event.currentTarget.value })} placeholder="phase-id" />
    </label>
    <!-- FR-R5-F10 (NF-11) — The authored `version` is a field of the
         definition, shown read-only. It is not the catalog's version id
         (`v1`, `v2`, …), which the catalog store assigns to each record it
         writes; `catalog.revision` and `expectedDraftVersion` track draft
         edits separately. -->
    <label class="field form-field">
      <span class="form-label">Version</span>
      <input class="input" value={phase.version} readonly />
    </label>
  </div>
  {#if phase.persisted}
    <p class="hint id-hint">ID <span class="mono">{phase.id}</span> is fixed once saved. Duplicate the Phase to get a new ID.</p>
  {/if}
  <div class="checks">
    <label class="form-field checkbox-field">
      <input type="checkbox" checked={phase.loopable === true} disabled={readOnly} onchange={(event) => onphasechange(index, { loopable: event.currentTarget.checked })} />
      <span>Loopable</span>
    </label>
    <label class="form-field checkbox-field">
      <input
        type="checkbox"
        data-testid="phases-required-{phase.id}"
        checked={phase.isRequired !== false}
        disabled={readOnly}
        onchange={(event) => onphasechange(index, { isRequired: event.currentTarget.checked })}
      />
      <span>Required</span>
    </label>
  </div>
</section>

<section class="form-sec" aria-labelledby="phase-directive-h">
  <h2 id="phase-directive-h">What it does</h2>
  <div class="seg directive-seg" role="group" aria-label="Directive type">
    {#each DIRECTIVE_KINDS as kind (kind.id)}
      <button type="button" aria-pressed={directive === kind.id} disabled={readOnly} data-testid="phases-directive-{kind.id}" onclick={() => changeDirectiveKind(kind.id)}>{kind.label}</button>
    {/each}
  </div>
  {#if directive === 'instruction'}
    <label class="field form-field">
      <span class="form-label">Instructions</span>
      <textarea class="input" rows="6" value={phase.instruction ?? ''} readonly={readOnly} aria-invalid={phase.sourceErrors.some((error) => error.field === 'instruction' || error.field === 'directive') ? 'true' : undefined} aria-describedby={phaseErrorId(phase)} oninput={(event) => onphasechange(index, { instruction: event.currentTarget.value })} placeholder="Phase instructions..."></textarea>
    </label>
  {:else}
    <label class="field form-field">
      <span class="form-label">Skill</span>
      <input class="input mono" value={phase.skill ?? ''} readonly={readOnly} aria-invalid={phase.sourceErrors.some((error) => error.field === 'skill' || error.field === 'directive') ? 'true' : undefined} aria-describedby={phaseErrorId(phase)} oninput={(event) => onphasechange(index, { skill: event.currentTarget.value })} placeholder="skill-name" />
    </label>
  {/if}
</section>

<section class="form-sec" aria-labelledby="phase-runs-on-h">
  <h2 id="phase-runs-on-h">Runs on</h2>
  <div class="grid g4">
    <label class="field form-field">
      <!-- Feature 099 (T488, FR-041) — no precedence badge. It named the
           layer whose `runner` won; precedence is the answer to "which
           layer won", and one layer answers it by existing. -->
      <span class="form-label">Backend</span>
      <select class="input" data-testid="phases-runner-{phase.id}" value={phase.runner ?? ''} disabled={readOnly} onchange={(event) => { const value = event.currentTarget.value; onphasechange(index, { runner: value ? (value as PhaseDefinition['runner']) : undefined }); }}>
        <!-- Not the mockup's "Workflow default": no run applies a Workflow's execution defaults.
             The host runs a Phase that sets no backend on the default backend, the one the Backend
             setting selects, or on Claude when the Phase writes Git metadata. -->
        <option value="">Default backend</option>
        {#each RUNNER_KINDS as runner}
          <option value={runner}>{runner}{!snapshot.availableBackends.includes(runner) ? ' (Unavailable)' : ''}</option>
        {/each}
      </select>
    </label>
    <label class="field form-field">
      <span class="form-label">Model</span>
      <select class="input" data-testid="phases-model-{phase.id}" value={phase.model ?? ''} disabled={readOnly} onchange={(event) => onphasechange(index, { model: event.currentTarget.value || undefined })}>
        <option value="">Backend default</option>
        {#if configuredModelUnavailable}
          <option value={phase.model}>{phase.model} (Unavailable)</option>
        {/if}
        {#each models as model}
          <option value={model}>{model}</option>
        {/each}
      </select>
    </label>
    <label class="field form-field">
      <span class="form-label">Effort</span>
      <select class="input" data-testid="phases-effort-{phase.id}" value={phase.effort ?? ''} disabled={readOnly} onchange={(event) => { const value = event.currentTarget.value; onphasechange(index, { effort: value ? (value as PhaseDefinition['effort']) : undefined }); }}>
        <!-- Not the mockup's "Inherit": a Phase that sets no effort passes the backend none, as
             with an unset model, so the backend's own default applies and nothing is inherited. -->
        <option value="">Backend default</option>
        {#each EFFORT_LEVELS as effort}
          <option value={effort} disabled={effortOptionDisabled(effort)}>{effort}</option>
        {/each}
      </select>
    </label>
    <label class="field form-field">
      <span class="form-label">Time limit</span>
      <span class="unit">
        <input class="input" type="number" min="1" max="3600" value={phase.timeoutSeconds ?? ''} readonly={readOnly} oninput={(event) => onphasechange(index, { timeoutSeconds: event.currentTarget.value === '' ? undefined : Number(event.currentTarget.value) })} />
        <span class="muted">seconds</span>
      </span>
    </label>
  </div>
</section>

<section class="form-sec" aria-labelledby="phase-retries-h">
  <h2 id="phase-retries-h">Retries</h2>
  <label class="form-field checkbox-field retry-toggle">
    <input type="checkbox" data-testid="phases-retry-toggle" checked={retryEnabled} onchange={() => ontoggleretry(index)} disabled={!retryConditionsTrusted || readOnly} />
    <span>Retry this Phase while a condition holds</span>
  </label>
  {#if retryEnabled}
    <RetryConditionEditor
      source={phase.retryCondition ?? ''}
      instruction={phase.instruction ?? ''}
      onchange={(event) => onretrychange(index, event)}
      readonly={!retryConditionsTrusted || readOnly}
    />
    <RetryCapOutcomeEditor
      {phase}
      workspaceDefault={snapshot.generalSettings?.retryForceContinueOnCap}
      readonly={!retryConditionsTrusted || readOnly}
      onchange={(outcome) => onphasechange(index, { onRetryCap: outcome })}
    />
  {/if}
</section>

<style>
  /* The redesign's form: sg-builder's `.form-sec` boxes each section, sg-core's `.field` stacks a
     label over its control, and these place what the redesign sets inline. */
  .id-hint {
    margin: 0 0 var(--schegent-space-3);
  }

  .checks {
    display: flex;
    flex-wrap: wrap;
    gap: var(--schegent-space-4);
  }

  .directive-seg {
    margin-bottom: var(--schegent-space-2-5);
  }

  .directive-seg button:disabled {
    cursor: default;
    opacity: 0.4;
  }

  .retry-toggle {
    margin-bottom: var(--schegent-space-2-5);
  }
</style>
