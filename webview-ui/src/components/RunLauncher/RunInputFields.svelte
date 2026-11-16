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

<!-- Drawn as the redesign's form fields: the port's name in small muted type above its box, with
     "(required)" where the mockup writes "(optional)", and its declared type and description in a
     caption under the box, as the add-task drawer's hint sits under its box. The box names that
     caption as its description. -->
<section class="contract-section" data-testid="run-launcher-contract">
  <h4 class="section-heading">Workflow contract</h4>
  <p class="hint note">The inputs this Workflow declares. Each one is validated before the run is queued.</p>

  {#each ports as port (port.portId)}
    <div class="port-row" data-port-control>
      <label class="port-label" for={`run-input-${port.portId}`} data-testid={`run-input-label-${port.portId}`}>
        {port.label}
        {#if port.required}
          <span data-testid={`run-input-required-${port.portId}`}>(required)</span>
        {/if}
      </label>
      <input
        id={`run-input-${port.portId}`}
        data-testid={`run-input-${port.portId}`}
        class="input"
        type="text"
        aria-describedby={`run-input-hint-${port.portId}`}
        {disabled}
        value={values[port.portId] ?? ''}
        oninput={(event) => onChange(port.portId, event.currentTarget.value)}
      />
      <p class="hint port-hint" id={`run-input-hint-${port.portId}`}>
        <span class="port-type" data-testid={`run-input-type-${port.portId}`}>{port.type}</span>
        {#if port.description}
          <span>{port.description}</span>
        {/if}
      </p>
      {#if errors.has(fieldId(port.portId))}
        <p class="field-error" data-testid={`run-launcher-error-${fieldId(port.portId)}`}>
          {errors.get(fieldId(port.portId))}
        </p>
      {/if}
    </div>
  {/each}
</section>

<style>
  .section-heading {
    font-size: var(--schegent-text-secondary);
    font-weight: 600;
  }
  .note,
  .port-hint,
  .field-error {
    margin: 0;
  }
  .note {
    margin-top: var(--schegent-space-1);
  }
  .port-row {
    display: flex;
    flex-direction: column;
    gap: var(--schegent-space-1);
    margin-top: var(--schegent-space-3);
  }
  .port-label {
    font-size: var(--schegent-text-secondary);
    color: var(--schegent-muted-fg);
  }
  .port-hint {
    display: flex;
    flex-wrap: wrap;
    column-gap: var(--schegent-space-1-5);
  }
  .port-type {
    font-family: var(--schegent-mono-font);
  }
  .field-error {
    font-size: var(--schegent-text-caption);
    color: var(--schegent-error-text);
  }
</style>
