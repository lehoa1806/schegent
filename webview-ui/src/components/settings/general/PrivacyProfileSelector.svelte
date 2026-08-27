<script lang="ts">
  /**
   * FR-R3-127 (FR-003a) — the evidence posture as three named choices.
   *
   * The audit of 2026-08-27 found the tiers correctly separated and then found a
   * concentration: failed, paused and canceled Runs retain unredacted transcripts
   * by default. Nothing was missing from the mechanism; what was missing was the
   * aggregate view AS A CHOICE, so an operator had to derive a safe configuration
   * from a dozen settings and a threat-model appendix.
   *
   * EXTRACTED from `GeneralSettingsTab.svelte`, which the 500-line Svelte budget
   * refused — correctly. This is a self-contained control over four settings and it
   * reads better as one.
   *
   * The table and the detection live in `src/contracts/privacy-profiles.ts`, the
   * only host module a webview may value-import from
   * (`webview-host-import-direction.test.ts`). Applying goes through the same
   * `saveGeneralSettings` helper every other field uses, so a profile is four
   * updates in one post rather than a new command surface.
   */
  import { saveGeneralSettings } from '../../../lib/save-general-settings';
  import {
    detectPrivacyProfile,
    privacyProfiles,
    type PrivacyProfileName,
    type PrivacyProfileSettings
  } from '../../../../../src/contracts/privacy-profiles';

  interface Props {
    loggingVerbose: boolean;
    rawTranscriptMode: 'always' | 'errors-only' | 'off';
    sessionRetentionMaxAgeDays: number;
    sessionRetentionMaxBytes: number;
  }

  const props: Props = $props();

  const PROFILES = privacyProfiles();
  const detected = $derived(
    detectPrivacyProfile({
      loggingVerbose: props.loggingVerbose,
      rawTranscriptMode: props.rawTranscriptMode,
      sessionRetentionMaxAgeDays: props.sessionRetentionMaxAgeDays,
      sessionRetentionMaxBytes: props.sessionRetentionMaxBytes
    })
  );

  /**
   * Field key -> the label the operator sees, so `custom` can name what drifted.
   *
   * Keyed on `keyof PrivacyProfileSettings` rather than `string`, so it is TOTAL:
   * adding a fifth field to a profile fails to compile here instead of rendering
   * the raw key at the operator.
   */
  const FIELD_LABELS: Readonly<Record<keyof PrivacyProfileSettings, string>> = {
    loggingVerbose: 'Verbose Logging',
    rawTranscriptMode: 'Raw Transcript Mode',
    sessionRetentionMaxAgeDays: 'Session Retention (days)',
    sessionRetentionMaxBytes: 'Session Retention (bytes)'
  };

  let applying = $state<PrivacyProfileName | null>(null);
  let refusal = $state<string | null>(null);

  const DESCRIPTION_ID = 'privacy-profile-description';

  async function apply(name: PrivacyProfileName): Promise<void> {
    const profile = PROFILES.find((entry) => entry.name === name);
    if (profile === undefined) return;
    applying = name;
    try {
      const result = await saveGeneralSettings({
        'logging.verbose': profile.settings.loggingVerbose,
        'logging.rawTranscriptMode': profile.settings.rawTranscriptMode,
        'logging.sessionRetentionMaxAgeDays': profile.settings.sessionRetentionMaxAgeDays,
        'logging.sessionRetentionMaxBytes': profile.settings.sessionRetentionMaxBytes
      });
      refusal = result.status === 'accepted' ? null : result.reason;
    } finally {
      applying = null;
    }
  }
</script>

<div class="privacy-profiles" data-testid="privacy-profiles">
  <strong>Evidence privacy profile:</strong>
  <span data-testid="privacy-profile-detected">
    {#if detected.kind === 'profile'}
      {detected.name}
    {:else}
      custom &mdash; differs from {detected.nearest} in
      {detected.differs.map((field) => FIELD_LABELS[field]).join(', ')}
    {/if}
  </span>
  <span class="profile-actions">
    {#each PROFILES as profile (profile.name)}
      <button
        type="button"
        class="btn"
        data-testid="privacy-profile-apply-{profile.name}"
        aria-describedby={DESCRIPTION_ID}
        title={profile.audience}
        disabled={applying !== null}
        onclick={() => void apply(profile.name)}
      >Apply {profile.name}</button>
    {/each}
  </span>
  {#if refusal !== null}
    <p class="profile-refusal" role="alert" data-testid="privacy-profile-refusal">
      The host refused the profile: {refusal}
    </p>
  {/if}
  <p class="hint" id={DESCRIPTION_ID}>
    A profile sets four settings and states what it does not change &mdash; the checkpoint store's
    fixed 14-day bound, the retained redacted audit log, and that <code>.gitignore</code> does not
    stop backup or sync tooling. See the settings reference for each profile's audience and residual.
  </p>
</div>

<style>
  .privacy-profiles {
    margin: 8px 0;
    padding: 8px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    font-size: 0.95em;
  }

  .profile-actions {
    display: inline-flex;
    gap: 6px;
    margin-left: 8px;
  }

  .profile-refusal {
    margin: 4px 0 0;
    color: var(--vscode-errorForeground);
  }

  .hint {
    margin: 6px 0 0;
    color: var(--vscode-descriptionForeground);
  }
</style>
