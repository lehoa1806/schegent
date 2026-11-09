<script lang="ts">
  // Feature 102 (T021, US2 — FR-007, FR-008, FR-009, FR-015) & FR-R5-F36 (F36-T01, F36-T02):
  // Compact read-only summary rendered above the Workflow start form.
  //
  // Header, description, and LaunchAuthorityNotice remain visible above the submit
  // control; port contracts and effective run policy live inside a native disclosure
  // collapsed by default so the Instructions field stays near the top of the composer.
  //
  // Operator-authored strings — names, port labels, descriptions — interpolate
  // with `{}`, which escapes. Nothing here uses `{@html}`.

  import { snapshotStore } from '../../lib/snapshot-store.svelte';
  import type { Launchable } from '../../lib/snapshot-types';
  import LaunchAuthorityNotice from './LaunchAuthorityNotice.svelte';

  interface Props {
    /** The entry the projection currently offers under the selection (FR-017). */
    entry: Launchable;
    /** The window's own answer, never a judgement about the submission (FR-015). */
    canLaunch: boolean;
  }

  const { entry, canLaunch }: Props = $props();

  // FR-R4-F06 (FR-007; D4) -- the postures are read off the snapshot on every render, like
  // the ports above, so a grant revoked while a selection is open stops being disclosed.
  const postures = $derived(snapshotStore.snapshot?.backendPostures ?? []);
</script>

<section
  class="launchable-detail"
  data-testid="launchable-detail"
  aria-labelledby="launchable-detail-heading"
>
  <header class="detail-head">
    <h4
      class="detail-name"
      id="launchable-detail-heading"
      data-testid="launchable-detail-name"
    >
      {entry.name}
    </h4>
    <span class="detail-version" data-testid="launchable-detail-version">
      Active version {entry.activeVersionId}
    </span>
  </header>

  {#if entry.description}
    <p class="detail-description" data-testid="launchable-detail-description">
      {entry.description}
    </p>
  {/if}

  <!-- FR-R4-F06 (FR-007; D4) -- what this start will run with, above the control that starts it.
       The backends are the host's per-entry answer, never the window default. -->
  <LaunchAuthorityNotice
    backends={entry.backends ?? []}
    {postures}
    capabilityNotices={entry.capabilityNotices ?? []}
  />

  <details class="detail-disclosure" data-testid="launchable-detail-disclosure">
    <summary class="disclosure-summary">Inputs, outputs &amp; run policy</summary>
    <div class="disclosure-body">
      <h5 class="ports-heading">Inputs</h5>
      {#if entry.inputs.length > 0}
        <ul class="port-list">
          <!-- Keyed by position: a parent that calls one child Workflow twice lists that child's
               unbound input once per call, so a `portId` can repeat. -->
          {#each entry.inputs as port, index (index)}
            <li class="port-row" data-testid="launchable-detail-port-{port.portId}">
              <span class="port-label">{port.label}</span>
              <span class="port-type">{port.type}</span>
              {#if port.required}
                <span class="port-required" data-testid="launchable-detail-required-{port.portId}">
                  required
                </span>
              {/if}
              {#if port.description}
                <span class="port-description">{port.description}</span>
              {/if}
            </li>
          {/each}
        </ul>
      {:else}
        <p class="detail-note" data-testid="launchable-detail-no-inputs">
          This one asks for nothing up front.
        </p>
      {/if}

      {#if entry.outputs && entry.outputs.length > 0}
        <h5 class="ports-heading">Outputs</h5>
        <ul class="port-list" data-testid="launchable-detail-outputs">
          <!-- Keyed by position: a Workflow without declared outputs lists the derived ones, one per
               node, so a child Workflow called twice repeats a `portId` and keying by it would throw. -->
          {#each entry.outputs as port, index (index)}
            <li class="port-row" data-testid="launchable-detail-output-{port.portId}">
              <span class="port-label">{port.label}</span>
              <span class="port-type">{port.type}</span>
              {#if port.description}
                <span class="port-description">{port.description}</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if entry.runSettings}
        <div class="run-settings-summary" data-testid="launchable-detail-run-settings">
          <h5 class="ports-heading">Effective Run Policy</h5>
          <p class="detail-note" data-testid="launchable-detail-max-duration">
            Max duration: {entry.runSettings.maxDurationSeconds.value}s ({entry.runSettings.maxDurationSeconds.origin})
          </p>
          <ul class="port-list">
            <!-- One row per occurrence, so a Phase a Workflow reuses repeats its name; keyed by
                 position, and the test id carries the position rather than the name. -->
            {#each entry.runSettings.phases as phase, index (index)}
              <li class="port-row" data-testid="launchable-detail-phase-setting-{index}">
                <span class="port-label">{phase.phaseName}</span>
                <span class="port-type">{phase.backend}</span>
                <span class="port-type">
                  model: {phase.model.kind === 'value' ? phase.model.value : 'backend default'}
                </span>
                <span class="port-type">
                  effort: {phase.effort.kind === 'value' ? phase.effort.value : 'backend default'}
                </span>
                <span class="port-type">
                  idle: {phase.idleTimeoutSeconds.value}s ({phase.idleTimeoutSeconds.origin})
                </span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
  </details>

  {#if !canLaunch}
    <p class="detail-note" data-testid="launchable-detail-read-only">
      This window cannot start runs. The window connected to the workspace can.
    </p>
  {/if}
</section>

<style>
  .launchable-detail {
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    padding: 8px;
  }

  .detail-head {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .detail-name {
    font-size: 1em;
    margin: 0;
  }

  .detail-version,
  .port-type {
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
  }

  .detail-description,
  .detail-note {
    font-size: 0.85em;
    margin: 0;
  }

  .detail-note {
    color: var(--vscode-descriptionForeground);
  }

  .detail-disclosure {
    margin: 0;
  }

  .disclosure-summary {
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    font-size: 0.82em;
    user-select: none;
  }

  .disclosure-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 6px;
  }

  .ports-heading {
    font-size: 0.8em;
    letter-spacing: 0.05em;
    margin: 0;
    text-transform: uppercase;
  }

  .port-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .port-row {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    font-size: 0.85em;
    gap: 6px;
  }

  /* The word carries the marker; the weight only makes it easier to find. */
  .port-required {
    font-size: 0.8em;
    font-weight: 600;
    text-transform: uppercase;
  }

  .port-description {
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
  }
</style>
