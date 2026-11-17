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
   * (`webview-host-import-direction.test.ts`). A press sets the profile's five
   * settings in the tab's draft, as editing each field would, and the page Save
   * writes them with every other change through the same `saveGeneralSettings`
   * post, so a profile is five updates in one post rather than a new command
   * surface. The values shown are the draft's, so the pressed profile is the one
   * the page would save.
   */
  import type { Draft } from './field-types';
  import {
    detectPrivacyProfile,
    privacyProfiles,
    type PrivacyProfileName,
    type PrivacyProfileSettings
  } from '../../../../../src/contracts/privacy-profiles';
  import {
    DEFAULT_TRANSPORT_CAPTURE_SETTING,
    TRANSPORT_CAPTURE_SETTINGS,
    type TransportCaptureSetting
  } from '../../../../../src/contracts/transport-capture-mode';
  import { settingsSearch } from '../settings-search.svelte';

  interface Props {
    loggingVerbose: boolean;
    rawTranscriptMode: 'always' | 'errors-only' | 'off';
    sessionRetentionMaxAgeDays: number;
    sessionRetentionMaxBytes: number;
    // FR-R4-F04 (X10) — the stored value; detection compares what it resolves to. The draft
    // holds it as the string its select wrote, so it is checked rather than cast.
    transportCaptureMode: string;
    /** Sets the chosen profile's settings in the draft. */
    chooseProfile: (updates: Partial<Draft>) => void;
  }

  const props: Props = $props();

  function isCaptureSetting(value: string): value is TransportCaptureSetting {
    return (TRANSPORT_CAPTURE_SETTINGS as readonly string[]).includes(value);
  }

  const PROFILES = privacyProfiles();
  const detected = $derived(
    detectPrivacyProfile({
      loggingVerbose: props.loggingVerbose,
      rawTranscriptMode: props.rawTranscriptMode,
      sessionRetentionMaxAgeDays: props.sessionRetentionMaxAgeDays,
      sessionRetentionMaxBytes: props.sessionRetentionMaxBytes,
      transportCaptureMode: isCaptureSetting(props.transportCaptureMode)
        ? props.transportCaptureMode
        : DEFAULT_TRANSPORT_CAPTURE_SETTING
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
    loggingVerbose: 'Verbose logging',
    rawTranscriptMode: 'Keep raw transcripts',
    sessionRetentionMaxAgeDays: 'Keep run artifacts for',
    sessionRetentionMaxBytes: 'Run artifact space',
    transportCaptureMode: 'Record backend traffic'
  };

  const DESCRIPTION_ID = 'privacy-profile-description';
  const LABEL_ID = 'privacy-profile-label';
  const LABEL = 'Evidence profile';

  const { row: searchRow } = settingsSearch();
  // The page's search finds the row by its label, its note and the profile names. The note is
  // read as drawn, because it holds markup; none of its words is a value the user can edit.
  let note = $state<HTMLElement>();
  const searchText = (): readonly (string | undefined)[] => [
    LABEL,
    note?.textContent,
    ...PROFILES.map((profile) => profile.name)
  ];

  function choose(name: PrivacyProfileName): void {
    const profile = PROFILES.find((entry) => entry.name === name);
    if (profile === undefined) return;
    props.chooseProfile({ ...profile.settings });
  }
</script>

<!--
  The redesign's evidence profile row: the three profiles as one segmented control, the one the
  values on the page match pressed. The note leads with the mockup's sentence and keeps the
  residuals after it, because a profile states what it does not change (spec 163, FR-002a). A press sets that profile's settings, and Save writes them;
  "custom" presses none, and the line under the control names the fields that differ.
-->
<div class="srow privacy-profiles" data-testid="privacy-profiles" use:searchRow={searchText}>
  <div>
    <div class="lab" id={LABEL_ID}>{LABEL}</div>
    <p class="desc" id={DESCRIPTION_ID} bind:this={note}>
      Sets transcript, artifact and capture options together. Ephemeral keeps the least. A profile
      does not change the checkpoint store's fixed 14-day bound, the retained redacted audit log, or
      backend CLI session stores under your home directory (which Schegent's retention, export, and
      delete controls do not manage), and <code>.gitignore</code> does not stop backup or sync
      tooling. See the settings reference for each profile's audience and residual.
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
          onclick={() => choose(profile.name)}
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
</style>
