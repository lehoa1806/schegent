<script lang="ts">
  // FR-R3-143 (T050) — the privacy profile selector and the retention readout, which fill the
  // Settings page's Privacy and evidence section. It left `GeneralSettingsTab.svelte` because that file crossed the 500-line ceiling
  // `tests/lint/svelte-component-loc-budget.test.ts` holds every component to, and this is the
  // part with no stake in the field specs — it reads the projection and reports, where everything
  // left behind describes, drafts and saves individual settings. The whole-tab Save and Reset it
  // held are the page header's Save and Revert now (`../SettingsPageHeader.svelte`).
  //
  // The field spec arrays deliberately did NOT move, even though they are the
  // larger block. Two gates parse them out of the tab by path —
  // `tests/lint/settings-field-bounds-parity.test.ts` reads the file directly,
  // and `tests/integration/settings-surface.integration.test.ts` collects
  // `ipcKey:` literals from `.svelte` files only. Moving them into a `.ts`
  // module would have emptied the second gate of every key it measures, and the
  // fix would have looked like widening what counts as a rendered control.
  import type { GeneralSettings, SessionArtifactsProjection } from '../../../lib/snapshot-types';
  import type { Draft } from './field-types';
  import { formatBytes } from './settings-draft';
  import PrivacyProfileSelector from './PrivacyProfileSelector.svelte';

  interface Props {
    /** The projection, already defaulted by the tab. */
    readonly settings: GeneralSettings;
    /** The tab's draft: the profile shows what the page would save. */
    readonly draft: Draft;
    readonly sessionArtifacts: SessionArtifactsProjection;
    /** Sets a profile's settings in the draft. */
    readonly chooseProfile: (updates: Partial<Draft>) => void;
  }
  const { settings, draft, sessionArtifacts, chooseProfile }: Props = $props();

  // The budget the sweep enforces is the saved one, so the readout measures against it.
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
  The privacy profile row, then the retention readout under it, as the mockup's "Stored locally"
  line sits under its evidence profile.
-->
<div class="profile-block">
  <PrivacyProfileSelector
    loggingVerbose={draft.loggingVerbose}
    rawTranscriptMode={draft.rawTranscriptMode}
    sessionRetentionMaxAgeDays={draft.sessionRetentionMaxAgeDays}
    sessionRetentionMaxBytes={draft.sessionRetentionMaxBytes}
    transportCaptureMode={draft.transportCaptureMode}
    {chooseProfile}
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
</div>

<style>
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
