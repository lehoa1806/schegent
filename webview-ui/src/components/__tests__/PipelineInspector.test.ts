// Feature 184 (FR-R3-141, T019/T021/T023) — the inspector pane.
//
// Errors are anchored through `pipelineAnchoredErrors` rather than hand-sliced,
// so each assertion also proves the anchoring rule routes that field to that
// control. A hand-built `{kind:'field', field:'name'}` would only prove the
// inspector renders what it is handed.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PipelineInspector from '../PipelineBuilderEditors/PipelineInspector.svelte';
import {
  pipelineAnchoredErrors,
  type AnchoredPipelineError,
  type KeyedPipelineDraftError
} from '../PipelineBuilderEditors/pipeline-catalog-state';
import type { PipelineFlowSelection } from '../PipelineBuilderEditors/pipeline-flow-view';
import type { MutablePipeline } from '../PipelineBuilderEditors/types';
import { FLOW_PHASES, flowPipelineRow } from './pipeline-flow-fixtures';

afterEach(cleanup);

function anchored(pipeline: MutablePipeline, fields: readonly [string, string][]): readonly AnchoredPipelineError[] {
  const errors: KeyedPipelineDraftError[] = fields.map(([field, message]) => ({
    field,
    code: 'invalid',
    message,
    sourceKey: pipeline.sourceKey
  }));
  return pipelineAnchoredErrors(pipeline, errors);
}

function mount(
  options: {
    pipeline?: MutablePipeline;
    selection?: PipelineFlowSelection | null;
    readonly?: boolean;
    anchoredErrors?: readonly AnchoredPipelineError[];
    consumingWorkflows?: readonly string[];
  } = {}
) {
  const pipeline = options.pipeline ?? flowPipelineRow();
  const onpipelinechange = vi.fn();
  const onphasechange = vi.fn();
  const { container } = render(PipelineInspector, {
    props: {
      pipeline,
      phases: FLOW_PHASES,
      selection: options.selection ?? { kind: 'pipeline' },
      readonly: options.readonly ?? false,
      anchoredErrors: options.anchoredErrors ?? [],
      consumingWorkflows: options.consumingWorkflows ?? [],
      onpipelinechange,
      onphasechange,
      onaddport: vi.fn(),
      onremoveport: vi.fn(),
      onportchange: vi.fn()
    }
  });
  return {
    container,
    pipeline,
    onpipelinechange,
    onphasechange,
    at: (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
  };
}

describe('PipelineInspector identity block (T019)', () => {
  it('renders the four identity controls under their existing test ids', () => {
    const { at } = mount();

    expect((at('pipelines-name-field-release-flow') as HTMLInputElement).value).toBe(
      'Release Flow'
    );
    expect((at('pipelines-id-field-release-flow') as HTMLInputElement).value).toBe('release-flow');
    expect((at('pipelines-version-release-flow') as HTMLInputElement).value).toBe('1');
    expect((at('pipelines-description-release-flow') as HTMLTextAreaElement).value).toBe('');
  });

  it('routes each field error to its own control and error region', () => {
    const pipeline = flowPipelineRow();
    const { container, at } = mount({
      pipeline,
      anchoredErrors: anchored(pipeline, [
        ['name', 'Name is required.'],
        ['pipelineId', 'ID must be kebab-case.'],
        ['description', 'Description is too long.']
      ])
    });

    for (const [testId, region, text] of [
      ['pipelines-name-field-release-flow', 'name', 'Name is required.'],
      ['pipelines-id-field-release-flow', 'pipelineId', 'ID must be kebab-case.'],
      ['pipelines-description-release-flow', 'description', 'Description is too long.']
    ] as const) {
      const control = at(testId) as HTMLElement;
      const id = `pipeline-errors-release-flow-${region}`;
      expect(control.getAttribute('aria-invalid')).toBe('true');
      expect(control.getAttribute('aria-describedby')).toBe(id);
      expect(container.querySelector(`#${id}`)?.textContent).toContain(text);
    }
    // Version has no error, so it names no region rather than an empty one.
    expect(at('pipelines-version-release-flow')?.getAttribute('aria-describedby')).toBeNull();
  });

  it('makes the ID read-only when the row is persisted, with its help text', () => {
    const { container, at } = mount();

    expect((at('pipelines-id-field-release-flow') as HTMLInputElement).readOnly).toBe(true);
    expect(container.textContent).toContain('Duplicate this Pipeline to create a new identity.');
  });

  it('leaves the ID editable on a draft that has never been persisted', () => {
    const { container, at } = mount({ pipeline: flowPipelineRow({ persisted: false }) });

    expect((at('pipelines-id-field-release-flow') as HTMLInputElement).readOnly).toBe(false);
    expect(container.textContent).not.toContain('Duplicate this Pipeline');
  });

  it('gates the ID on persisted and nothing else, while readonly gates the rest', () => {
    // A-2. `persisted` and `readonly` are different claims, and a surface that
    // conflated them would pass any test that only ever set them together.
    // Here a never-persisted row is readonly: the ID stays editable, everything
    // else does not.
    const { at } = mount({ pipeline: flowPipelineRow({ persisted: false }), readonly: true });

    expect((at('pipelines-id-field-release-flow') as HTMLInputElement).readOnly).toBe(false);
    expect((at('pipelines-name-field-release-flow') as HTMLInputElement).readOnly).toBe(true);
    expect((at('pipelines-description-release-flow') as HTMLTextAreaElement).readOnly).toBe(true);
  });

  it('keeps Version read-only whatever state the row is in', () => {
    const editable = mount({ pipeline: flowPipelineRow({ persisted: false }) });
    expect((editable.at('pipelines-version-release-flow') as HTMLInputElement).readOnly).toBe(true);
  });

  it('edits the Pipeline through onpipelinechange', async () => {
    const { at, onpipelinechange } = mount();

    await fireEvent.input(at('pipelines-name-field-release-flow') as HTMLInputElement, {
      target: { value: 'Renamed' }
    });
    expect(onpipelinechange).toHaveBeenCalledWith({ name: 'Renamed' });
  });
});

describe('PipelineInspector per-position select (T021)', () => {
  it('renders no phase select while the Pipeline itself is selected', () => {
    const { container, at } = mount({ selection: { kind: 'pipeline' } });

    expect(container.querySelectorAll('[data-testid^="pipelines-phase-select-"]')).toHaveLength(0);
    // The identity block is the resting state, not a thing selection replaces.
    expect(at('pipelines-inspector-identity')).not.toBeNull();
  });

  it('renders exactly the selected position’s select, keeping its id and aria wiring', () => {
    const pipeline = flowPipelineRow();
    const { container, at } = mount({
      pipeline,
      selection: { kind: 'phase', position: 1 },
      anchoredErrors: anchored(pipeline, [['phaseIds[1]', 'Phase "done" is not effective.']])
    });
    const select = at('pipelines-phase-select-1') as HTMLSelectElement;

    expect(container.querySelectorAll('[data-testid^="pipelines-phase-select-"]')).toHaveLength(1);
    expect(select.getAttribute('aria-label')).toBe('Phase 2 of Release Flow');
    expect(select.getAttribute('aria-describedby')).toBe('pipeline-errors-release-flow-phase-1');
    expect(select.value).toBe('done');
    // FR-046 — additionally, not instead of.
    expect(at('pipelines-inspector-identity')).not.toBeNull();
  });

  it('changes only the selected position', async () => {
    const { at, onphasechange } = mount({ selection: { kind: 'phase', position: 0 } });

    await fireEvent.change(at('pipelines-phase-select-0') as HTMLSelectElement, {
      target: { value: 'speckit-plan' }
    });
    expect(onphasechange).toHaveBeenCalledWith(0, 'speckit-plan');
  });

  it('keeps an unresolved Phase selectable rather than silently rewriting it', () => {
    const { at } = mount({
      pipeline: flowPipelineRow({ phases: ['ghost-phase'] }),
      selection: { kind: 'phase', position: 0 }
    });
    const select = at('pipelines-phase-select-0') as HTMLSelectElement;

    // Without the fallback option the browser reports the first option instead,
    // and the next save would quietly replace the operator's authored id.
    expect(select.value).toBe('ghost-phase');
    expect(Array.from(select.options).map((option) => option.value)).toContain('ghost-phase');
  });

  it('disables the select under readonly', () => {
    const { at } = mount({ selection: { kind: 'phase', position: 0 }, readonly: true });
    expect((at('pipelines-phase-select-0') as HTMLSelectElement).disabled).toBe(true);
  });
});

describe('PipelineInspector ports, consumers and unanchored errors (T023)', () => {
  it('renders the ports editor, the consumers list and the foot region', () => {
    const { at } = mount({ consumingWorkflows: ['release-workflow'] });

    expect(at('pipeline-ports-release-flow')).not.toBeNull();
    expect(at('pipeline-inputs-add')).not.toBeNull();
    expect(at('pipelines-consuming-workflows-release-flow')?.textContent).toContain(
      'release-workflow'
    );
  });

  it('routes a port-anchored error into the ports editor, beside the port it names', () => {
    const pipeline = flowPipelineRow({
      inputs: [{ portId: 'brief', label: 'Brief', type: 'text' }]
    });
    const { container } = mount({
      pipeline,
      anchoredErrors: anchored(pipeline, [['inputs[0].portId', 'Port id must be unique.']])
    });
    const region = container.querySelector('#pipeline-port-errors-inputs-0');

    expect(region?.textContent).toContain('Port id must be unique.');
    // The ports editor narrows by field prefix, so the message lands on the row
    // it names rather than at the top of the group.
    expect(container.querySelector('[data-testid="pipelines-pipeline-errors"]')).toBeNull();
  });

  it('shows an error that names no rendered control at the foot, with its field', () => {
    const pipeline = flowPipelineRow();
    const { at } = mount({
      pipeline,
      anchoredErrors: anchored(pipeline, [['executionDefaults.model', 'Model is unavailable.']])
    });
    const foot = at('pipelines-pipeline-errors') as HTMLElement;

    // `pipeline` is the anchor of last resort, so the message has to name its
    // own field: nothing beside it says what the message is about.
    expect(foot).not.toBeNull();
    expect(foot.textContent).toContain('executionDefaults.model');
    expect(foot.textContent).toContain('Model is unavailable.');
  });

  it('renders no foot region when every error found a control', () => {
    const pipeline = flowPipelineRow();
    const { at } = mount({ pipeline, anchoredErrors: anchored(pipeline, [['name', 'Required.']]) });

    expect(at('pipelines-pipeline-errors')).toBeNull();
  });

  it('renders an empty consumers list rather than claiming there are none', () => {
    const { at } = mount({ consumingWorkflows: [] });
    const consumers = at('pipelines-consuming-workflows-release-flow') as HTMLElement;

    expect(consumers).not.toBeNull();
    expect(consumers.querySelectorAll('li')).toHaveLength(0);
  });
});
