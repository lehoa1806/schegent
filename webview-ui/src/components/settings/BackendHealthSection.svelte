<script lang="ts">
  import { pingBackend } from '../../lib/backend-ping-ipc';
  import type {
    BackendPingState,
    BackendRunnerKind,
    WorkflowSnapshot
  } from '../../lib/snapshot-types';
  import { hoverTextAnchor } from '../hover-text/hover-text-anchor-action';
  import { GENERAL_SETTINGS_DESCRIPTIONS } from './GeneralSettingsTab.descriptions';

  interface Props { snapshot: WorkflowSnapshot }
  const { snapshot }: Props = $props();
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
    {#each RUNNERS as runner}
      <div class="backend-row" data-testid={`backend-health-${runner}`}>
        <div class="identity">
          <strong>{LABELS[runner]}</strong>
          <span class:available={availableBackends.includes(runner)}>
            {availableBackends.includes(runner) ? 'Discovered' : 'Unavailable'}
          </span>
          {#if description(runner)}
            <small role="status" aria-live="polite">{description(runner)}</small>
          {/if}
        </div>
        <button
          type="button"
          disabled={busy}
          aria-label={`Ping ${LABELS[runner]} backend`}
          data-testid={`ping-backend-${runner}`}
          onclick={() => pingBackend(runner)}
          use:hoverTextAnchor={{
            controlId: 'backend-ping',
            description: GENERAL_SETTINGS_DESCRIPTIONS['backend-ping']
          }}
        >{state.status === 'running' && state.runner === runner ? 'Pinging…' : 'Ping'}</button>
      </div>
    {/each}
  </div>
</section>

<style>
  .backend-health {
    display: grid;
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--vscode-widget-border);
    border-radius: var(--schegent-radius);
    background: var(--vscode-editor-inactiveSelectionBackground);
  }
  h3 { margin: 0; font-size: 1em; }
  p { margin: 3px 0 0; color: var(--schegent-muted-fg); font-size: 0.85em; }
  .backend-list { display: grid; gap: 6px; }
  .backend-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 10px;
    background: var(--vscode-editor-background);
  }
  .identity { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; }
  .identity span { color: var(--vscode-notificationsWarningIcon-foreground); font-size: 0.8em; }
  .identity span.available { color: var(--vscode-testing-iconPassed); }
  small { flex-basis: 100%; color: var(--schegent-muted-fg); }
  button {
    padding: 4px 12px;
    border: 0;
    border-radius: var(--schegent-radius);
    background: var(--schegent-button-bg);
    color: var(--schegent-button-fg);
    cursor: pointer;
  }
  button:hover:not(:disabled) { background: var(--schegent-button-hover); }
  button:disabled { cursor: not-allowed; opacity: 0.55; }
</style>
