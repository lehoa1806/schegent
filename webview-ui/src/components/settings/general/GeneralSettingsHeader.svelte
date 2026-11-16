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

<!--
  The redesign's settings header: the title, then "Unsaved changes", Revert and Save on the right,
  in the mockup's order. The two whole-tab buttons stay in this tab rather than the page header,
  because only this tab drafts edits. The retention readout sits under the profile row, as the
  mockup's "Stored locally" line does.
-->
<header class="tab-header">
  <div class="titlerow">
    <h2>{GENERAL_SETTINGS_DESCRIPTIONS['tab-header'].title}</h2>
    <div class="push">
      {#if dirty}
        <span class="chip s-warn">Unsaved changes</span>
      {/if}
      <button
        type="button"
        class="btn btn-secondary"
        data-testid="general-settings-reset-all"
        disabled={!dirty}
        onclick={resetAll}
        use:hoverTextAnchor={{
          controlId: 'reset-all',
          description: GENERAL_SETTINGS_DESCRIPTIONS['reset-all']
        }}
      >Reset All</button>
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
    </div>
  </div>
  <p class="lead small muted">{GENERAL_SETTINGS_DESCRIPTIONS['tab-header'].body}</p>
  <PrivacyProfileSelector
    loggingVerbose={settings.loggingVerbose}
    rawTranscriptMode={settings.rawTranscriptMode}
    sessionRetentionMaxAgeDays={settings.sessionRetentionMaxAgeDays}
    sessionRetentionMaxBytes={settings.sessionRetentionMaxBytes}
    transportCaptureMode={settings.transportCaptureMode}
  />
  <p class:usage-warning={sessionUsageWarning} class="session-usage small muted" data-testid="session-artifact-usage">
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
  </p>
</header>

<style>
  .tab-header h2 {
    font-weight: 600;
  }

  .lead {
    margin: var(--schegent-space-0-5) 0 0;
  }

  .session-usage {
    margin: var(--schegent-space-2) 0 0;
    line-height: 1.45;
  }

  /* A failed sweep or a nearly full budget reads in the body colour behind a warning rule; the
     words carry the warning, the rule only draws the eye to them. */
  .session-usage.usage-warning {
    padding-left: var(--schegent-space-2);
    border-left: 2px solid var(--schegent-color-warning);
    color: var(--schegent-fg);
  }
</style>
