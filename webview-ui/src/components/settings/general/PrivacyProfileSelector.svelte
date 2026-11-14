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
  import { boundaryRefusalText, isOutcomeNotYetKnown } from '../../../lib/boundary-refusal-text';
  import type { SaveResult } from '../../../lib/save-general-settings';
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
    // FR-R4-F04 (X10) — the stored value; detection compares what it resolves to.
    transportCaptureMode: 'inherit' | 'off' | 'errors-only' | 'on';
  }

  const props: Props = $props();

  const PROFILES = privacyProfiles();
  const detected = $derived(
    detectPrivacyProfile({
      loggingVerbose: props.loggingVerbose,
      rawTranscriptMode: props.rawTranscriptMode,
      sessionRetentionMaxAgeDays: props.sessionRetentionMaxAgeDays,
      sessionRetentionMaxBytes: props.sessionRetentionMaxBytes,
      transportCaptureMode: props.transportCaptureMode
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
    sessionRetentionMaxBytes: 'Session Retention (bytes)',
    transportCaptureMode: 'CLI Transport Capture'
  };

  let applying = $state<PrivacyProfileName | null>(null);
  let refusal = $state<string | null>(null);
  // FR-R4-F05 (I5) — a timeout is not "not applied": the host may still apply the profile.
  let notYetKnown = $state(false);

  // FR-R4-F05 (I6, I8, FR-024) — a late answer replaces the not-yet-known text through the same
  // path as an on-time one. Unmounting aborts the wait.
  const lifetime = new AbortController();
  $effect(() => () => lifetime.abort());
  function showResult(result: SaveResult): void {
    notYetKnown = result.status === 'rejected' && isOutcomeNotYetKnown(result.reason);
    refusal = result.status === 'accepted' ? null : boundaryRefusalText(result.reason);
  }

  const DESCRIPTION_ID = 'privacy-profile-description';
  const LABEL_ID = 'privacy-profile-label';

  async function apply(name: PrivacyProfileName): Promise<void> {
    const profile = PROFILES.find((entry) => entry.name === name);
    if (profile === undefined) return;
    applying = name;
    try {
      const result = await saveGeneralSettings(
        {
          'logging.verbose': profile.settings.loggingVerbose,
          'logging.rawTranscriptMode': profile.settings.rawTranscriptMode,
          'logging.sessionRetentionMaxAgeDays': profile.settings.sessionRetentionMaxAgeDays,
          'logging.sessionRetentionMaxBytes': profile.settings.sessionRetentionMaxBytes,
          'logging.transportCaptureMode': profile.settings.transportCaptureMode
        },
        undefined,
        { signal: lifetime.signal, onLateOutcome: showResult }
      );
      showResult(result);
    } finally {
      applying = null;
    }
  }
</script>

<!--
  The redesign's evidence profile row: the three profiles as one segmented control, the one the
  current values match pressed. A press still applies that profile at once, as these buttons always
  have; "custom" presses none, and the line under the control names the fields that differ.
-->
<div class="srow privacy-profiles" data-testid="privacy-profiles">
  <div>
    <div class="lab" id={LABEL_ID}>Evidence privacy profile</div>
    <p class="desc" id={DESCRIPTION_ID}>
      A profile sets five settings and states what it does not change &mdash; the checkpoint store's
      fixed 14-day bound, the retained redacted audit log, backend CLI session stores under your home
      directory (which Schegent's retention, export, and delete controls do not manage), and that
      <code>.gitignore</code> does not stop backup or sync tooling. See the settings reference for
      each profile's audience and residual.
    </p>
  </div>
  <div class="ctl">
    <div class="seg" role="group" aria-labelledby={LABEL_ID}>
      {#each PROFILES as profile (profile.name)}
        <button
          type="button"
          data-testid="privacy-profile-apply-{profile.name}"
          aria-pressed={detected.kind === 'profile' && detected.name === profile.name}
          aria-describedby={DESCRIPTION_ID}
          title={profile.audience}
          disabled={applying !== null}
          onclick={() => void apply(profile.name)}
        >{profile.name}</button>
      {/each}
    </div>
    <span class="hint" data-testid="privacy-profile-detected">
      {#if detected.kind === 'profile'}
        Current profile: {detected.name}
      {:else}
        Current profile: custom &mdash; differs from {detected.nearest} in
        {detected.differs.map((field) => FIELD_LABELS[field]).join(', ')}
      {/if}
    </span>
    {#if refusal !== null}
      <p class="profile-refusal" role="alert" data-testid="privacy-profile-refusal">
        {notYetKnown ? refusal : `The profile was not applied. ${refusal}`}
      </p>
    {/if}
  </div>
</div>

<style>
  .desc {
    margin: 0;
  }

  /* FR-R3-131 (T1498) — these buttons once carried a `.btn` class that no sheet reaching them
   * styled, so they drew in the user-agent `ButtonFace`/`ButtonText` pair and failed contrast in
   * all three themes. The `.sg .seg` rules style them now: a transparent ground, the inherited
   * text colour, and the theme's selection pair on the pressed profile. */
  .seg button {
    text-transform: capitalize;
  }

  .seg button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .profile-refusal {
    margin: 0;
    color: var(--vscode-errorForeground);
  }
</style>
