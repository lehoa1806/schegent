<script lang="ts">
  // Feature 102 (T021, US2 — FR-007, FR-008, FR-009, FR-015) — the step between
  // choosing a definition and starting it.
  //
  // This panel reads and nothing else. It is where an operator confirms they
  // picked the right thing, and the moment it grows a field it becomes a second
  // copy of the form's values — one that is never submitted and never refused,
  // and so never corrected. Everything an operator types lives in the form the
  // Trigger control opens, once.
  //
  // The ports come straight off `entry` on every render (FR-017). A Workflow's
  // are derived from its graph and a Pipeline's belong to its active version;
  // both move when the definition is republished under a live selection, and a
  // panel showing a remembered copy would describe a version the next run will
  // not freeze.
  //
  // Requiredness is what the definition declares and only that (FR-009). A
  // Workflow's derived ports do not carry it through, so their absence of a
  // marker means "not declared required" — which is not the same claim as
  // "optional", and the panel says neither. The marker is a word, not a colour:
  // an operator who cannot tell the two apart still has to be able to read which
  // ports the definition insists on.
  //
  // Operator-authored strings — names, port labels, descriptions — interpolate
  // with `{}`, which escapes. Nothing here uses `{@html}`.

  import type { Launchable } from '../../lib/snapshot-types';

  interface Props {
    /** The entry the projection currently offers under the selection (FR-017). */
    entry: Launchable;
    /** The window's own answer, never a judgement about the submission (FR-015). */
    canLaunch: boolean;
    /** Opens the form. Distinct from the control that submits it (FR-008). */
    onTrigger: () => void;
  }

  const { entry, canLaunch, onTrigger }: Props = $props();
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

  <h5 class="ports-heading">Inputs</h5>
  {#if entry.inputs.length > 0}
    <ul class="port-list">
      {#each entry.inputs as port (port.portId)}
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

  <button
    type="button"
    class="trigger-button"
    data-testid="launchable-detail-trigger"
    disabled={!canLaunch}
    onclick={() => onTrigger()}
  >
    Trigger
  </button>
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

  .trigger-button {
    align-self: flex-start;
    background: var(--vscode-button-background);
    border: none;
    border-radius: 2px;
    color: var(--vscode-button-foreground);
    cursor: pointer;
    padding: 4px 12px;
  }

  .trigger-button:disabled {
    cursor: default;
    opacity: 0.5;
  }
</style>
