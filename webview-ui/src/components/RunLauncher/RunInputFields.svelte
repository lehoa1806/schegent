<script lang="ts">
  // Feature 087 T052 (FR-001, FR-002) — the Pipeline's contract, rendered.
  //
  // This section is a PROJECTION of the declared input ports and nothing else.
  // It adds no control the definition did not declare and hides none it did, so
  // what the operator fills in is exactly what the run will be validated against.
  // Anything the operator wants to add beyond the contract belongs in the
  // supplemental section, which is why that one is a separate component.
  //
  // The ports handed here are already the operator-facing ones — a `pipeline-output`
  // port is fed by an earlier Phase, and the composer filters it out before this
  // component sees it (FR-001a). The filter lives with the composer because it is
  // also what decides whether the contract is empty at all (US1-2).
  //
  // Every port-derived string — label, type, description — is interpolated as
  // text, never as markup: these come from a catalog row an operator authored, and
  // the composer is not the place to start interpreting authored content.

  import type { PipelineInputPort } from '../../lib/snapshot-types';

  interface Props {
    readonly ports: readonly PipelineInputPort[];
    readonly values: Record<string, string>;
    /** Host-reported refusals, keyed by the field id the host used. */
    readonly errors: ReadonlyMap<string, string>;
    readonly disabled: boolean;
    readonly onChange: (portId: string, value: string) => void;
  }

  const { ports, values, errors, disabled, onChange }: Props = $props();

  function fieldId(portId: string): string {
    return `inputs.${portId}`;
  }
</script>

<section class="contract-section" data-testid="run-launcher-contract">
  <h4 class="section-heading">Pipeline contract</h4>
  <p class="section-note">The inputs this Pipeline declares. Each one is validated before the run is queued.</p>

  {#each ports as port (port.portId)}
    <div class="port-row" data-port-control>
      <label class="port-label" for={`run-input-${port.portId}`} data-testid={`run-input-label-${port.portId}`}>
        {port.label}
        {#if port.required}
          <span class="required-marker" data-testid={`run-input-required-${port.portId}`}>required</span>
        {/if}
      </label>
      <span class="port-type" data-testid={`run-input-type-${port.portId}`}>{port.type}</span>
      {#if port.description}
        <p class="port-description">{port.description}</p>
      {/if}
      <input
        id={`run-input-${port.portId}`}
        data-testid={`run-input-${port.portId}`}
        class="port-input"
        type="text"
        {disabled}
        value={values[port.portId] ?? ''}
        oninput={(event) => onChange(port.portId, event.currentTarget.value)}
      />
      {#if errors.has(fieldId(port.portId))}
        <p class="field-error" data-testid={`run-launcher-error-${fieldId(port.portId)}`}>
          {errors.get(fieldId(port.portId))}
        </p>
      {/if}
    </div>
  {/each}
</section>

<style>
  .contract-section {
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
  .required-marker {
    margin-left: 6px;
    font-weight: 400;
    font-size: 0.8em;
    color: var(--vscode-descriptionForeground);
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
  .field-error {
    margin: 0;
    font-size: 0.85em;
    color: var(--schegent-error-text);
  }
</style>
