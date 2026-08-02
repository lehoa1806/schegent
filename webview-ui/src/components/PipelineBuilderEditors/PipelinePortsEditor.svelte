<script lang="ts">
  // Feature 082 (US1, T031) — input/output port declaration.
  //
  // Split out of PipelineCatalogEditor so the Pipeline form stays within the
  // repository-wide 500-line Svelte budget and the port table is testable on its
  // own. The type selects are populated from the closed unions in
  // `snapshot-types.ts` — a port type outside those unions is not authorable
  // here, matching the host validator's exact-match port typing (research R4).
  import {
    PIPELINE_INPUT_PORT_TYPES,
    PIPELINE_OUTPUT_PORT_TYPES,
    type PipelineInputPort,
    type PipelineInputPortType,
    type PipelineOutputPort,
    type PipelineOutputPortType
  } from '../../lib/snapshot-types';
  import PipelineFieldErrors from './PipelineFieldErrors.svelte';
  import type { PipelineDraftError } from './pipeline-catalog-state';
  import type { PipelinePortPatch } from './types';

  type PortKind = 'inputs' | 'outputs';

  interface Props {
    pipelineId: string;
    inputs: readonly PipelineInputPort[];
    outputs: readonly PipelineOutputPort[];
    readonly: boolean;
    /** Host- and draft-reported port errors, already narrowed to this Pipeline. */
    errors: readonly PipelineDraftError[];
    onaddport: (kind: PortKind) => void;
    onremoveport: (kind: PortKind, index: number) => void;
    onportchange: (kind: PortKind, index: number, patch: PipelinePortPatch) => void;
  }

  const {
    pipelineId,
    inputs,
    outputs,
    readonly,
    errors,
    onaddport,
    onremoveport,
    onportchange
  }: Props = $props();

  function fieldErrors(kind: PortKind, index: number): readonly PipelineDraftError[] {
    const prefix = `${kind}[${index}]`;
    return errors.filter((error) => error.field === kind || error.field.startsWith(prefix));
  }

  function regionId(kind: PortKind, index: number): string {
    return `pipeline-port-errors-${kind}-${index}`;
  }

  function errorId(kind: PortKind, index: number): string | undefined {
    return fieldErrors(kind, index).length > 0 ? regionId(kind, index) : undefined;
  }

  function invalid(kind: PortKind, index: number, field: string): 'true' | undefined {
    return fieldErrors(kind, index).some((error) => error.field.endsWith(`.${field}`))
      ? 'true'
      : undefined;
  }
</script>

<div class="ports-editor" data-testid="pipeline-ports-{pipelineId}">
  {#each [{ kind: 'inputs' as const, label: 'Input ports', ports: inputs, types: PIPELINE_INPUT_PORT_TYPES }, { kind: 'outputs' as const, label: 'Output ports', ports: outputs, types: PIPELINE_OUTPUT_PORT_TYPES }] as group (group.kind)}
    <section class="ports-group">
      <div class="sequence-label" id="pipeline-{group.kind}-label-{pipelineId}">{group.label}</div>
      <div class="sequence-list" role="list" aria-labelledby="pipeline-{group.kind}-label-{pipelineId}">
        {#if group.ports.length === 0}
          <div class="empty-selection">
            No {group.kind === 'inputs' ? 'input' : 'output'} ports declared.
          </div>
        {/if}
        {#each group.ports as port, index (index)}
          <div class="sequence-item" role="listitem">
            <div class="sequence-number">{index + 1}</div>
            <input
              class="text-input"
              data-testid="pipeline-{group.kind}-portid-{index}"
              aria-label="{group.label} {index + 1} id"
              value={port.portId}
              {readonly}
              aria-invalid={invalid(group.kind, index, 'portId')}
              aria-describedby={errorId(group.kind, index)}
              placeholder="port-id"
              oninput={(event) =>
                onportchange(group.kind, index, { portId: event.currentTarget.value })}
            />
            <input
              class="text-input flex-1"
              data-testid="pipeline-{group.kind}-label-{index}"
              aria-label="{group.label} {index + 1} label"
              value={port.label}
              {readonly}
              aria-invalid={invalid(group.kind, index, 'label')}
              aria-describedby={errorId(group.kind, index)}
              placeholder="Operator-facing label"
              oninput={(event) =>
                onportchange(group.kind, index, { label: event.currentTarget.value })}
            />
            <select
              class="select-input"
              data-testid="pipeline-{group.kind}-type-{index}"
              aria-label="{group.label} {index + 1} type"
              value={port.type}
              disabled={readonly}
              onchange={(event) =>
                onportchange(group.kind, index, {
                  type: event.currentTarget.value as PipelineInputPortType | PipelineOutputPortType
                })}
            >
              {#each group.types as portType (portType)}
                <option value={portType}>{portType}</option>
              {/each}
            </select>
            {#if group.kind === 'inputs'}
              <label class="checkbox-field">
                <input
                  type="checkbox"
                  data-testid="pipeline-inputs-required-{index}"
                  aria-label="Input port {index + 1} required"
                  checked={(port as PipelineInputPort).required === true}
                  disabled={readonly}
                  onchange={(event) =>
                    onportchange('inputs', index, { required: event.currentTarget.checked })}
                />
                <span class="form-label">Required</span>
              </label>
            {/if}
            {#if !readonly}
              <button
                class="icon-btn destructive-icon"
                data-testid="pipeline-{group.kind}-remove-{index}"
                aria-label="Remove {group.label.toLowerCase().slice(0, -1)} {port.portId || index + 1}"
                onclick={() => onremoveport(group.kind, index)}>✕</button
              >
            {/if}
            <PipelineFieldErrors
              id={regionId(group.kind, index)}
              errors={fieldErrors(group.kind, index)}
            />
          </div>
        {/each}
      </div>
      {#if !readonly}
        <div class="add-phase-row">
          <button
            class="btn btn-primary"
            data-testid="pipeline-{group.kind}-add"
            onclick={() => onaddport(group.kind)}
            >Add {group.kind === 'inputs' ? 'input' : 'output'} port</button
          >
        </div>
      {/if}
    </section>
  {/each}
</div>
