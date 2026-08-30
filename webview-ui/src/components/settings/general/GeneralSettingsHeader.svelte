<script lang="ts">
  // FR-R3-143 (T050) — the General tab's chrome: the retention readout, the
  // privacy profile selector, and the two whole-tab buttons. It left
  // `GeneralSettingsTab.svelte` because that file crossed the 500-line ceiling
  // `tests/lint/svelte-component-loc-budget.test.ts` holds every component to,
  // and this is the part with no stake in the field specs — it reads the
  // projection and reports, where everything left behind describes, drafts and
  // saves individual settings.
  //
  // The field spec arrays deliberately did NOT move, even though they are the
  // larger block. Two gates parse them out of the tab by path —
  // `tests/lint/settings-field-bounds-parity.test.ts` reads the file directly,
  // and `tests/integration/settings-surface.integration.test.ts` collects
  // `ipcKey:` literals from `.svelte` files only. Moving them into a `.ts`
  // module would have emptied the second gate of every key it measures, and the
  // fix would have looked like widening what counts as a rendered control.
  import type { GeneralSettings, SessionArtifactsProjection } from '../../../lib/snapshot-types';
  import { GENERAL_SETTINGS_DESCRIPTIONS } from '../GeneralSettingsTab.descriptions';
  import { formatBytes } from './settings-draft';
  import { hoverTextAnchor } from '../../hover-text/hover-text-anchor-action';
  import PrivacyProfileSelector from './PrivacyProfileSelector.svelte';

  interface Props {
    /** The projection, already defaulted by the tab. */
    readonly settings: GeneralSettings;
    readonly sessionArtifacts: SessionArtifactsProjection;
    /** True when any field's draft diverges from the projection. */
    readonly dirty: boolean;
    readonly saveAll: () => Promise<void>;
    readonly resetAll: () => void;
  }
  const { settings, sessionArtifacts, dirty, saveAll, resetAll }: Props = $props();

  const sessionBudgetPercent = $derived(
    settings.sessionRetentionMaxBytes > 0
      ? Math.round((sessionArtifacts.totalBytes / settings.sessionRetentionMaxBytes) * 100)
      : 0
  );
  const sessionUsageWarning = $derived(
    sessionArtifacts.lastSweepFailures > 0 || sessionBudgetPercent >= 80
  );
</script>

<header class="tab-header">
  <h2>{GENERAL_SETTINGS_DESCRIPTIONS['tab-header'].title}</h2>
  <p class="hint">{GENERAL_SETTINGS_DESCRIPTIONS['tab-header'].body}</p>
  <div class:usage-warning={sessionUsageWarning} class="session-usage" data-testid="session-artifact-usage">
    <strong>Unredacted local session artifacts:</strong>
    {sessionArtifacts.artifactCount} run{sessionArtifacts.artifactCount === 1 ? '' : 's'},
    {formatBytes(sessionArtifacts.totalBytes)} retained.
    {#if sessionArtifacts.lastSweepAt}
      Last swept {new Date(sessionArtifacts.lastSweepAt).toLocaleString()}.
    {:else}
      Waiting for the activation sweep.
    {/if}
    {#if sessionArtifacts.lastSweepFailures > 0}
      {sessionArtifacts.lastSweepFailures} retention operation{sessionArtifacts.lastSweepFailures === 1 ? '' : 's'} failed; inspect the sanitized runtime log.
    {/if}
    {#if sessionBudgetPercent >= 80}
      Usage is {sessionBudgetPercent}% of the configured byte budget.
    {/if}
  </div>
  <PrivacyProfileSelector
    loggingVerbose={settings.loggingVerbose}
    rawTranscriptMode={settings.rawTranscriptMode}
    sessionRetentionMaxAgeDays={settings.sessionRetentionMaxAgeDays}
    sessionRetentionMaxBytes={settings.sessionRetentionMaxBytes}
  />
  <div class="toolbar">
    <button
      type="button"
      class="btn btn-primary"
      data-testid="general-settings-save-all"
      disabled={!dirty}
      onclick={saveAll}
      use:hoverTextAnchor={{
        controlId: 'save-all',
        description: GENERAL_SETTINGS_DESCRIPTIONS['save-all']
      }}
    >Save All Changes</button>
    <button
      type="button"
      class="btn btn-ghost"
      data-testid="general-settings-reset-all"
      disabled={!dirty}
      onclick={resetAll}
      use:hoverTextAnchor={{
        controlId: 'reset-all',
        description: GENERAL_SETTINGS_DESCRIPTIONS['reset-all']
      }}
    >Reset All</button>
  </div>
</header>

<style>
  .tab-header h2 {
    margin: 0 0 4px 0;
    font-size: 1.1em;
    font-weight: 600;
  }
  .hint {
    margin: 0 0 12px 0;
    color: var(--schegent-muted-fg);
    font-size: 0.9em;
  }
  .session-usage {
    margin: 0 0 12px 0;
    padding: 8px 10px;
    border: 1px solid var(--vscode-notificationsInfoIcon-foreground);
    border-radius: var(--schegent-radius);
    background: var(--vscode-textBlockQuote-background);
    color: var(--schegent-muted-fg);
    font-size: 0.85em;
    line-height: 1.45;
  }
  .usage-warning {
    border-color: var(--vscode-notificationsWarningIcon-foreground);
    color: var(--vscode-foreground);
  }
  .toolbar {
    display: flex;
    gap: 8px;
    margin-bottom: 8px;
  }
  .btn {
    min-height: var(--schegent-control-height-compact);
    padding: 3px 10px;
    border-radius: var(--schegent-radius-sm);
    font-size: 0.9em;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: var(--schegent-button-bg); color: var(--schegent-button-fg); }
  .btn-primary:hover:not(:disabled) { background: var(--schegent-button-hover); }
  .btn-ghost { background: transparent; color: var(--schegent-muted-fg); }
  .btn-ghost:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); }
</style>
