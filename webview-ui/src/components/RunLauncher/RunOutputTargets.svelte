<script lang="ts">
  // Feature 087 T054 (FR-013, FR-023, FR-024) — where each declared output goes.
  //
  // One target per declared output port, and two confirmations that are asked in
  // deliberately different ways:
  //
  //   The external side effect is knowable from the port's declared type alone,
  //   so it is asked up front, inline, as part of composing the target. Nothing
  //   has to happen first for the operator to know they are about to write
  //   somewhere outside the workspace.
  //
  //   The overwrite is NOT knowable here. The webview cannot look at the
  //   filesystem, and the host is the only party that can see whether the named
  //   target already holds content. So the flow is refuse-then-confirm: the run is
  //   submitted, the host refuses the port with `output-overwrite-unconfirmed`,
  //   and only then — with a real answer rather than a guess — is the operator
  //   asked. A pre-emptive checkbox would make them confirm a replacement that
  //   may not be happening.
  //
  // The confirmation goes through the shared `useConfirm` helper and is awaited
  // before anything is re-submitted, so no request carrying `overwriteConfirmed`
  // can exist without the operator having said yes to that exact port and target.

  import { useConfirm } from '../../lib/use-confirm';
  import type { PipelineOutputPort } from '../../lib/snapshot-types';

  /** The declared type whose targets sit outside the workspace (FR-024). */
  const EXTERNAL_SIDE_EFFECT_PORT_TYPE = 'external-reference';

  interface Props {
    readonly ports: readonly PipelineOutputPort[];
    readonly targets: Record<string, string>;
    readonly sideEffectConfirmed: Record<string, boolean>;
    readonly errors: ReadonlyMap<string, string>;
    /** Ports the host refused for want of an overwrite confirmation. */
    readonly overwriteRequested: ReadonlySet<string>;
    readonly disabled: boolean;
    readonly onTargetChange: (portId: string, value: string) => void;
    readonly onSideEffectChange: (portId: string, confirmed: boolean) => void;
    readonly onOverwriteConfirmed: (portId: string) => void;
  }

  const {
    ports,
    targets,
    sideEffectConfirmed,
    errors,
    overwriteRequested,
    disabled,
    onTargetChange,
    onSideEffectChange,
    onOverwriteConfirmed
  }: Props = $props();

  function fieldId(portId: string): string {
    return `outputs.${portId}`;
  }

  async function confirmOverwrite(port: PipelineOutputPort, element: HTMLElement): Promise<void> {
    const accepted = await useConfirm('run.overwrite-output', {
      originatingElement: element,
      context: { portName: port.label, target: targets[port.portId] ?? '' }
    });
    if (!accepted) return;
    onOverwriteConfirmed(port.portId);
  }
</script>

<section class="outputs-section" data-testid="run-launcher-outputs">
  <h4 class="section-heading">Output targets</h4>
  <p class="section-note">Where each declared output is written. Paths are workspace-relative.</p>

  {#each ports as port (port.portId)}
    <div class="port-row" data-port-control>
      <label class="port-label" for={`run-output-${port.portId}`}>{port.label}</label>
      <span class="port-type">{port.type}</span>
      {#if port.description}
        <p class="port-description">{port.description}</p>
      {/if}
      <input
        id={`run-output-${port.portId}`}
        data-testid={`run-output-${port.portId}`}
        class="port-input"
        type="text"
        {disabled}
        value={targets[port.portId] ?? ''}
        oninput={(event) => onTargetChange(port.portId, event.currentTarget.value)}
      />

      {#if port.type === EXTERNAL_SIDE_EFFECT_PORT_TYPE}
        <label class="side-effect-label">
          <input
            data-testid={`run-output-side-effect-${port.portId}`}
            type="checkbox"
            {disabled}
            checked={sideEffectConfirmed[port.portId] ?? false}
            onchange={(event) => onSideEffectChange(port.portId, event.currentTarget.checked)}
          />
          This output is written outside the workspace. I understand the effect is not undone by cancelling the run.
        </label>
      {/if}

      {#if errors.has(fieldId(port.portId))}
        <p class="field-error" data-testid={`run-launcher-error-${fieldId(port.portId)}`}>
          {errors.get(fieldId(port.portId))}
        </p>
      {/if}

      {#if overwriteRequested.has(port.portId)}
        <button
          type="button"
          class="overwrite-button"
          data-testid={`run-output-overwrite-${port.portId}`}
          {disabled}
          onclick={(event) => confirmOverwrite(port, event.currentTarget)}
        >
          Replace and run
        </button>
      {/if}
    </div>
  {/each}
</section>

<style>
  .outputs-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .section-heading {
    margin: 0;
    font-size: 0.95em;
  }
  .section-note {
    margin: 0;
    font-size: 0.85em;
    opacity: 0.8;
  }
  .port-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .port-label {
    font-weight: 600;
    font-size: 0.9em;
  }
  .port-type {
    font-size: 0.8em;
    opacity: 0.8;
  }
  .port-description {
    margin: 0;
    font-size: 0.85em;
    opacity: 0.8;
  }
  .port-input {
    padding: 4px 6px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: var(--schegent-radius);
  }
  .side-effect-label {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 0.85em;
  }
  .field-error {
    margin: 0;
    font-size: 0.85em;
    color: var(--vscode-errorForeground);
  }
  .overwrite-button {
    align-self: flex-start;
    padding: 4px 10px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: var(--schegent-radius);
    cursor: pointer;
  }
</style>
