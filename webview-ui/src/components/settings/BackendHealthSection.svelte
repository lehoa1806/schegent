<script lang="ts">
  import { pingBackend } from '../../lib/backend-ping-ipc';
  import type {
    BackendPingState,
    BackendRunnerKind,
    WorkflowSnapshot
  } from '../../lib/snapshot-types';
  import { hoverTextAnchor } from '../hover-text/hover-text-anchor-action';
  import { GENERAL_SETTINGS_DESCRIPTIONS } from './GeneralSettingsTab.descriptions';
  import GeneralSettingFieldRow from './general/GeneralSettingFieldRow.svelte';

  interface Props {
    snapshot: WorkflowSnapshot;
    BACKEND_FIELDS: readonly any[];
    draft: any;
    statusByKey: any;
    fieldChanged: (key: any) => boolean;
    fieldScopeLabel: (key: any) => string;
    pipelines: any;
    saveOne: (spec: any) => void;
    resetField: (key: any) => void;
    onAutoCompactInput: (ev: Event) => void;
  }
  let {
    snapshot,
    BACKEND_FIELDS,
    draft = $bindable(),
    statusByKey,
    fieldChanged,
    fieldScopeLabel,
    pipelines,
    saveOne,
    resetField,
    onAutoCompactInput
  }: Props = $props();

  const RUNNERS: readonly BackendRunnerKind[] = ['claude', 'codex', 'agy'];
  const LABELS: Record<BackendRunnerKind, string> = {
    claude: 'Claude',
    codex: 'Codex',
    agy: 'Agy'
  };
  const state = $derived<BackendPingState>(
    snapshot.backendPingState ?? { status: 'idle' }
  );
  const availableBackends = $derived(snapshot.availableBackends ?? []);
  const busy = $derived(state.status === 'running');

  function description(runner: BackendRunnerKind): string {
    if (state.status === 'idle' || state.runner !== runner) return '';
    if (state.status === 'running') return `Checking ${LABELS[runner]}…`;
    if (state.status === 'success') return `Healthy · ${state.latencyMs} ms`;
    const exit = state.exitCode === undefined ? '' : ` · exit ${state.exitCode}`;
    return `Unavailable · ${state.cause}${exit}`;
  }
</script>

<section class="backend-health" aria-labelledby="backend-health-heading">
  <div>
    <h3 id="backend-health-heading">Backend Health</h3>
    <p id="backend-health-description">Run a bounded, output-free availability check for a configured CLI.</p>
  </div>
  <div class="backend-list">
    {#each RUNNERS as runner, i}
      {@const spec = BACKEND_FIELDS[i]}
      <div class="backend-row-wrapper" data-testid={`backend-health-${runner}`}>
        <div class="identity">
          <strong>{LABELS[runner]}</strong>
          <span class:available={availableBackends.includes(runner)}>
            {availableBackends.includes(runner) ? 'Discovered' : 'Unavailable'}
          </span>
          {#if description(runner)}
            <small role="status" aria-live="polite">{description(runner)}</small>
          {/if}
        </div>
        <GeneralSettingFieldRow
          {spec}
          bind:draft
          status={statusByKey[spec.key]}
          changed={fieldChanged(spec.key)}
          scopeLabel={fieldScopeLabel(spec.key)}
          {pipelines}
          onSave={() => saveOne(spec)}
          onReset={() => resetField(spec.key)}
          {onAutoCompactInput}
        >
          {#snippet actionsAppend()}
            <button
              type="button"
              class="ping-btn"
              disabled={busy}
              aria-label={`Ping ${LABELS[runner]} backend`}
              data-testid={`ping-backend-${runner}`}
              onclick={() => pingBackend(runner)}
              use:hoverTextAnchor={{
                controlId: 'backend-ping',
                description: GENERAL_SETTINGS_DESCRIPTIONS['backend-ping']
              }}
            >{state.status === 'running' && state.runner === runner ? 'Pinging…' : 'Ping'}</button>
          {/snippet}
        </GeneralSettingFieldRow>
      </div>
    {/each}
  </div>
</section>

<style>
  .backend-health {
    display: grid;
    gap: 10px;
    padding: 14px 0 0;
    border-top: 1px solid var(--schegent-divider);
    background: transparent;
  }
  h3 { margin: 0; font-size: 1em; }
  p { margin: 3px 0 0; color: var(--schegent-muted-fg); font-size: 0.85em; }
  .backend-list { display: grid; gap: 0; margin-top: 4px; }
  .backend-row-wrapper {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .identity { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; padding-top: 10px; }
  .identity span { color: var(--vscode-notificationsWarningIcon-foreground); font-size: 0.8em; }
  .identity span.available { color: var(--vscode-testing-iconPassed); }
  small { flex-basis: 100%; color: var(--schegent-muted-fg); }
  .ping-btn {
    padding: 4px 12px;
    border: 0;
    border-radius: var(--schegent-radius);
    background: var(--schegent-button-bg);
    color: var(--schegent-button-fg);
    cursor: pointer;
  }
  .ping-btn:hover:not(:disabled) { background: var(--schegent-button-hover); }
  .ping-btn:disabled { cursor: not-allowed; opacity: 0.55; }
</style>
