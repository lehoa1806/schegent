// Feature 087 T051 — the composer's coverage map.
//
// Every control this suite asserts is DERIVED from the Pipeline definition it is
// handed: the contract section is a projection of the declared input ports, the
// output section a projection of the declared output ports. That is the property
// worth pinning, because the alternative — a hand-maintained form — drifts from
// the definition the run will actually resolve against, and the operator would be
// filling in a contract that no longer exists (FR-001, FR-002, FR-013).
//
// The host is stubbed at its single seam. `launchPipeline` is the one webview
// call site for this family, so replacing it replaces the whole boundary, and the
// `RunRequest` it is handed is the assertable artifact — the composer's entire
// output in one value. Nothing here re-checks a field rule: `validateRunRequest()`
// owns those, and a second oracle in the webview would disagree with the
// authoritative one the moment either moved.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchPipelineResult } from '../../../lib/messages';
import type { RunRequest } from '../../../../../src/contracts/run-request';
import type { PipelineDefinition } from '../../../lib/snapshot-types';
import type { LaunchRunSettings } from '../../../../../src/contracts/snapshot-projections';

const launchSpy = vi.fn<(request: RunRequest) => Promise<LaunchPipelineResult>>();
// FR-R4-F05 (I6, I8) — the options the component passes (its abort signal and its late-outcome
// callback) are captured so a case can answer a send whose wait ran out.
let lastWaitOptions:
  | { signal?: AbortSignal; onLateOutcome?: (result: LaunchPipelineResult) => void }
  | undefined;
vi.mock('../../../lib/run-launcher-ipc', () => ({
  launchPipeline: (
    request: RunRequest,
    _queueId?: string,
    options?: { signal?: AbortSignal; onLateOutcome?: (result: LaunchPipelineResult) => void }
  ) => {
    lastWaitOptions = options;
    return launchSpy(request);
  }
}));

// Feature 254 (FR-R4-F07, D-T1) — the launcher reads its launch entry, and the host's `runSettings` on
// it, from the snapshot. The store is replaced by a holder whose `snapshot` a case sets before render;
// null is the default, which is exactly what every earlier case in this file ran against.
const storeState = vi.hoisted(() => ({ snapshot: null as unknown }));
vi.mock('../../../lib/snapshot-store.svelte', () => ({
  snapshotStore: {
    get snapshot() {
      return storeState.snapshot;
    }
  }
}));

// The overwrite decision is the one destructive choice inside a launch, and it
// goes through the shared confirmation helper like every other one (T050).
const confirmSpy = vi.fn<() => Promise<boolean>>();
vi.mock('../../../lib/use-confirm', () => ({
  useConfirm: () => confirmSpy()
}));

// Late import so the component binds to the mocked call sites above.
import RunLauncher from '../RunLauncher.svelte';

/**
 * A Pipeline that exercises every branch of the projection at once: a required
 * port, an optional one, a phase-fed one that must NOT appear, and both an
 * ordinary and a side-effecting output.
 */
const PIPELINE: PipelineDefinition = {
  id: 'research-pipeline',
  name: 'Research Pipeline',
  phases: ['speckit-specify', 'speckit-plan'],
  inputs: [
    { portId: 'topic', label: 'Topic', type: 'text', required: true },
    { portId: 'notes', label: 'Notes', type: 'local-file' },
    // Fed by an earlier Phase, never by the operator (FR-001a).
    { portId: 'carried', label: 'Carried context', type: 'pipeline-output' }
  ],
  outputs: [
    { portId: 'report', label: 'Report', type: 'markdown' },
    { portId: 'ticket', label: 'Ticket', type: 'external-reference' }
  ],
  executionDefaults: { runner: 'claude', model: 'opus', effort: 'high' }
};

const EMPTY_CONTRACT: PipelineDefinition = {
  id: 'housekeeping',
  name: 'Housekeeping',
  phases: ['speckit-implement'],
  inputs: [],
  outputs: []
};

const ENQUEUED: LaunchPipelineResult = { outcome: 'enqueued', requestId: 'queue-item-1' };

type Query = (id: string) => HTMLElement;

function type(getByTestId: Query, testId: string, value: string): Promise<boolean> {
  return fireEvent.input(getByTestId(testId), { target: { value } });
}

async function submit(getByTestId: Query): Promise<void> {
  await fireEvent.click(getByTestId('run-launcher-submit'));
  // The submit handler awaits the (stubbed) host before it re-enables the form,
  // so let its continuation run before the assertions read the DOM.
  await tick();
  await tick();
}

/** The single request the composer put on the wire. */
function submitted(): RunRequest {
  expect(launchSpy).toHaveBeenCalledTimes(1);
  return launchSpy.mock.calls[0]![0];
}

beforeEach(() => {
  storeState.snapshot = null;
  launchSpy.mockReset();
  launchSpy.mockResolvedValue(ENQUEUED);
  confirmSpy.mockReset();
  confirmSpy.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
});

describe('contract section — one control per operator-supplied port (T052, FR-001, FR-002)', () => {
  it('derives a control for every operator-supplied port and none for a phase-fed one', () => {
    const { getByTestId, queryByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });

    expect(queryByTestId('run-launcher-contract')).not.toBeNull();
    expect(queryByTestId('run-input-topic')).not.toBeNull();
    expect(queryByTestId('run-input-notes')).not.toBeNull();
    // A `pipeline-output` port is not operator-facing: supplying one is refused
    // host-side, so offering the operator a box to supply it would be an
    // invitation to a guaranteed rejection.
    expect(queryByTestId('run-input-carried')).toBeNull();
    expect(getByTestId('run-launcher-contract').querySelectorAll('[data-port-control]')).toHaveLength(
      2
    );
  });

  it('states each port name and declared type, and marks only the required one', () => {
    const { getByTestId, queryByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });

    expect(getByTestId('run-input-label-topic').textContent).toContain('Topic');
    expect(getByTestId('run-input-type-topic').textContent).toContain('text');
    expect(getByTestId('run-input-label-notes').textContent).toContain('Notes');
    expect(getByTestId('run-input-type-notes').textContent).toContain('local-file');

    expect(queryByTestId('run-input-required-topic')).not.toBeNull();
    expect(queryByTestId('run-input-required-notes')).toBeNull();
  });

  it('carries each entered value into the request under its own port id and type', async () => {
    const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });

    await type(getByTestId, 'run-input-topic', 'run composition');
    await type(getByTestId, 'run-input-notes', 'docs/notes.md');
    await submit(getByTestId);

    expect(submitted().pipelineId).toBe('research-pipeline');
    expect(submitted().inputs).toEqual([
      { portId: 'topic', type: 'text', value: 'run composition' },
      { portId: 'notes', type: 'local-file', value: 'docs/notes.md' }
    ]);
  });

  it('states that no operator input is needed, and still allows submission (T058, US1-2)', async () => {
    const { getByTestId, queryByTestId } = render(RunLauncher, {
      props: { pipeline: EMPTY_CONTRACT }
    });

    expect(queryByTestId('run-launcher-no-contract')).not.toBeNull();
    expect(queryByTestId('run-launcher-contract')).toBeNull();
    expect((getByTestId('run-launcher-submit') as HTMLButtonElement).disabled).toBe(false);

    await submit(getByTestId);
    expect(submitted().inputs).toEqual([]);
  });
});

describe('supplemental section — separate from the contract (T053, FR-003)', () => {
  it('offers all six kinds, in a section of its own', () => {
    const { getByTestId, queryByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });

    const supplemental = getByTestId('run-launcher-supplemental');
    for (const id of [
      'run-supplemental-local-file',
      'run-supplemental-local-folder',
      'run-supplemental-url',
      'run-supplemental-text',
      'run-supplemental-instruction',
      'run-supplemental-prior-run',
      'run-supplemental-prior-output'
    ]) {
      expect(supplemental.contains(getByTestId(id)), id).toBe(true);
    }
    // Separate section, not a continuation of the contract: the contract section
    // stays a faithful projection of the declared ports and nothing else.
    expect(queryByTestId('run-launcher-contract')!.contains(supplemental)).toBe(false);
  });

  it('emits only the kinds the operator filled in, in declaration order', async () => {
    const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });

    await type(getByTestId, 'run-supplemental-url', 'https://example.test/spec');
    await type(getByTestId, 'run-supplemental-text', 'pasted excerpt');
    await submit(getByTestId);

    expect(submitted().supplemental).toEqual([
      { kind: 'url', url: 'https://example.test/spec' },
      { kind: 'text', text: 'pasted excerpt' }
    ]);
  });

  it('emits a prior-output reference only once both halves are named', async () => {
    const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });

    await type(getByTestId, 'run-supplemental-prior-run', 'run-42');
    await submit(getByTestId);
    expect(submitted().supplemental).toEqual([]);

    launchSpy.mockClear();
    await type(getByTestId, 'run-supplemental-prior-output', 'report');
    await submit(getByTestId);
    expect(submitted().supplemental).toEqual([
      { kind: 'prior-output', reference: { sourceRunId: 'run-42', outputName: 'report' } }
    ]);
  });

  it('puts the free-form instruction on the request field the host bounds', async () => {
    const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });

    await type(getByTestId, 'run-supplemental-instruction', 'focus on the migration path');
    await submit(getByTestId);

    // FR-012's length limit is checked against `instructions`, and the queue row
    // is labelled from it. Routing this control into `supplemental` instead would
    // put the operator's instruction somewhere neither rule can see it.
    expect(submitted().instructions).toBe('focus on the migration path');
    expect(submitted().supplemental).toEqual([]);
  });
});

describe('output section — one target per declared port (T054, FR-013, FR-023)', () => {
  it('derives a target field for every declared output port', () => {
    const { getByTestId, queryByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });

    expect(queryByTestId('run-output-report')).not.toBeNull();
    expect(queryByTestId('run-output-ticket')).not.toBeNull();
    expect(getByTestId('run-launcher-outputs').querySelectorAll('[data-port-control]')).toHaveLength(
      2
    );
  });

  it('offers the side-effect confirmation only for an external-reference port', () => {
    const { queryByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });

    // Knowable from the declared type alone, so it is asked up front rather than
    // after a refusal — unlike overwrite, which only the host can detect.
    expect(queryByTestId('run-output-side-effect-ticket')).not.toBeNull();
    expect(queryByTestId('run-output-side-effect-report')).toBeNull();
  });

  it('carries each named target, and the side-effect acknowledgement, into the request', async () => {
    const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });

    await type(getByTestId, 'run-output-report', 'docs/report.md');
    await type(getByTestId, 'run-output-ticket', 'tickets/ABC-1.json');
    await fireEvent.click(getByTestId('run-output-side-effect-ticket'));
    await submit(getByTestId);

    expect(submitted().outputs).toEqual([
      { portId: 'report', target: 'docs/report.md' },
      { portId: 'ticket', target: 'tickets/ABC-1.json', externalSideEffectConfirmed: true }
    ]);
  });

  it('omits an unnamed target rather than sending an empty one', async () => {
    const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });

    await type(getByTestId, 'run-output-report', 'docs/report.md');
    await submit(getByTestId);

    // The host reports the untargeted port as `output-target-missing` against the
    // port itself; a blank string would arrive as a different, less useful defect.
    expect(submitted().outputs).toEqual([{ portId: 'report', target: 'docs/report.md' }]);
  });
});

/**
 * What the host projects for `PIPELINE`'s two Phases: structured values and closed kinds, never
 * sentences. The launcher words them; it derives none of them (FR-022).
 */
const RUN_SETTINGS: LaunchRunSettings = {
  phases: [
    {
      phaseName: 'speckit-specify',
      backend: 'claude',
      model: { kind: 'backend-default' },
      effort: { kind: 'value', value: 'high' },
      idleTimeoutSeconds: { value: 5400, origin: 'default' }
    },
    {
      phaseName: 'speckit-plan',
      backend: 'codex',
      model: { kind: 'value', value: 'gpt-6-sol' },
      effort: { kind: 'backend-default' },
      idleTimeoutSeconds: { value: 600, origin: 'phase' }
    }
  ],
  maxDurationSeconds: { value: 21_600, origin: 'workspace' }
};

/** Seed the snapshot with the launch entry the host would project for `pipeline`. */
function seedLaunchEntry(pipeline: PipelineDefinition, runSettings?: LaunchRunSettings): void {
  storeState.snapshot = {
    launchables: {
      pipelines: {
        state: 'entries',
        entries: [
          {
            kind: 'pipeline',
            id: pipeline.id,
            name: pipeline.name,
            activeVersionId: 'v1',
            inputs: [],
            backends: ['claude'],
            capabilityNotices: [],
            ...(runSettings === undefined ? {} : { runSettings })
          }
        ]
      }
    },
    backendPostures: []
  };
}

describe('process preview (T055, FR-035; Feature 254 D-T1, FR-021, FR-022)', () => {
  it('shows the resolved Pipeline, its Phase order and the request', async () => {
    seedLaunchEntry(PIPELINE, RUN_SETTINGS);
    const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });

    await type(getByTestId, 'run-input-topic', 'run composition');

    expect(getByTestId('run-launcher-preview-pipeline').textContent).toContain('Research Pipeline');
    const phases = getByTestId('run-launcher-preview-phases').textContent ?? '';
    expect(phases.indexOf('speckit-specify')).toBeGreaterThanOrEqual(0);
    expect(phases.indexOf('speckit-specify')).toBeLessThan(phases.indexOf('speckit-plan'));

    // The complete request, as it will be sent — the operator reviews the thing
    // that runs, not a summary of it.
    expect(getByTestId('run-launcher-preview-request').textContent).toContain('run composition');
  });

  it('states, per Phase, the backend, model, effort and idle limit the Run will use', () => {
    seedLaunchEntry(PIPELINE, RUN_SETTINGS);
    const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });

    const settings = getByTestId('run-launcher-preview-settings').textContent;
    expect(settings).toContain('Claude · model: backend default · effort: high · idle limit 90 min');
    expect(settings).toContain('Codex · model: gpt-6-sol · effort: backend default · idle limit 10 min');
  });

  it('states the Run time limit after the Phases', () => {
    seedLaunchEntry(PIPELINE, RUN_SETTINGS);
    const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });

    const settings = getByTestId('run-launcher-preview-settings').textContent;
    expect(settings).toContain('Run time limit 6 h');
    expect(settings.indexOf('Run time limit')).toBeGreaterThan(settings.indexOf('Codex'));
  });

  it('never shows an authored default as an effective setting', () => {
    seedLaunchEntry(PIPELINE, RUN_SETTINGS);
    const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });

    // PIPELINE authors runner claude, model opus and effort high. The host resolved something else
    // for the Run, and the effective block states that; the authored values are on the advisory line.
    const settings = getByTestId('run-launcher-preview-settings').textContent;
    expect(settings).not.toContain('opus');
    expect(settings).not.toContain('Authored defaults');
  });

  it('labels the authored defaults advisory and not applied, on their own line', () => {
    seedLaunchEntry(PIPELINE, RUN_SETTINGS);
    const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });

    const advisory = getByTestId('run-launcher-preview-advisory').textContent;
    expect(advisory).toContain('Authored defaults (advisory, not applied)');
    expect(advisory).toContain('opus');
    expect(advisory).toContain('high');
  });

  it('shows no advisory line for a Pipeline that authors no defaults', () => {
    seedLaunchEntry(EMPTY_CONTRACT, undefined);
    const { queryByTestId } = render(RunLauncher, { props: { pipeline: EMPTY_CONTRACT } });

    expect(queryByTestId('run-launcher-preview-advisory')).toBeNull();
  });

  it('says the settings are resolved when the Run starts, and shows no authored value as in force, when the host sent none', () => {
    seedLaunchEntry(PIPELINE, undefined);
    const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });

    const settings = getByTestId('run-launcher-preview-settings').textContent;
    expect(settings).toContain('Settings are resolved when the Run starts');
    expect(settings).not.toContain('opus');
    expect(settings).not.toContain('Claude');
    // The authored defaults are still disclosed, as what they are.
    expect(getByTestId('run-launcher-preview-advisory').textContent).toContain('opus');
  });

  it('does not show settings that do not line up with the Phases the form lists', () => {
    seedLaunchEntry(PIPELINE, { ...RUN_SETTINGS, phases: [RUN_SETTINGS.phases[0]!] });
    const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });

    const settings = getByTestId('run-launcher-preview-settings').textContent;
    expect(settings).toContain('Settings are resolved when the Run starts');
    expect(settings).not.toContain('Claude');
  });

  it('says the same when the snapshot holds no launch entry at all', () => {
    const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });
    expect(getByTestId('run-launcher-preview-settings').textContent).toContain(
      'Settings are resolved when the Run starts'
    );
  });

  it('puts nothing the snapshot says into markup: a hostile model renders as text', () => {
    const hostile: LaunchRunSettings = {
      ...RUN_SETTINGS,
      phases: [
        {
          ...RUN_SETTINGS.phases[0]!,
          model: { kind: 'value', value: '<img src=x onerror=alert(1)>' }
        },
        RUN_SETTINGS.phases[1]!
      ]
    };
    seedLaunchEntry(PIPELINE, hostile);
    const { container, getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });

    expect(container.querySelector('img')).toBeNull();
    expect(getByTestId('run-launcher-preview-settings').textContent).toContain('<img src=x');
  });

  it('leaves the Run request byte-identical whether or not the host sent run settings (D9)', async () => {
    const requestText = async (runSettings?: LaunchRunSettings): Promise<string> => {
      cleanup();
      seedLaunchEntry(PIPELINE, runSettings);
      const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });
      await type(getByTestId, 'run-input-topic', 'run composition');
      return getByTestId('run-launcher-preview-request').textContent;
    };
    const without = await requestText(undefined);
    const withSettings = await requestText(RUN_SETTINGS);
    expect(withSettings).toBe(without);
    expect(without).not.toContain('executionDefaults');
    expect(without).not.toContain('opus');
  });
});

describe('submission (T055, T057, FR-044)', () => {
  it('sends exactly one request through the single IPC helper', async () => {
    const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });

    await type(getByTestId, 'run-input-topic', 'run composition');
    await submit(getByTestId);

    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(submitted()).toEqual({
      pipelineId: 'research-pipeline',
      inputs: [{ portId: 'topic', type: 'text', value: 'run composition' }],
      supplemental: [],
      outputs: []
    });
  });

  it('disables the submit control while the host has not answered', async () => {
    let release: ((result: LaunchPipelineResult) => void) | undefined;
    launchSpy.mockImplementation(
      () =>
        new Promise<LaunchPipelineResult>((resolve) => {
          release = resolve;
        })
    );

    const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });
    await submit(getByTestId);

    expect((getByTestId('run-launcher-submit') as HTMLButtonElement).disabled).toBe(true);

    release!(ENQUEUED);
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe('validation feedback (T056, FR-045)', () => {
  it('renders each refusal against its own control and preserves every entered value', async () => {
    launchSpy.mockResolvedValue({
      outcome: 'rejected-validation',
      errors: [
        { field: 'inputs.notes', code: 'file-not-found', message: 'This file was not found.' },
        {
          field: 'outputs.report',
          code: 'output-target-missing',
          message: 'This output needs a target.'
        }
      ]
    });

    const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });
    await type(getByTestId, 'run-input-topic', 'run composition');
    await type(getByTestId, 'run-input-notes', 'docs/missing.md');
    await submit(getByTestId);

    expect(getByTestId('run-launcher-error-inputs.notes').textContent).toContain(
      'This file was not found.'
    );
    expect(getByTestId('run-launcher-error-outputs.report').textContent).toContain(
      'This output needs a target.'
    );

    // Nothing the operator typed is cleared by a refusal — re-entering a long
    // composition to fix one field is the failure mode FR-045 exists to prevent.
    expect((getByTestId('run-input-topic') as HTMLInputElement).value).toBe('run composition');
    expect((getByTestId('run-input-notes') as HTMLInputElement).value).toBe('docs/missing.md');
    expect((getByTestId('run-launcher-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('reports a definition-family refusal against the composition as a whole', async () => {
    launchSpy.mockResolvedValue({ outcome: 'rejected-definition', reason: 'pipeline-not-found' });

    const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });
    await submit(getByTestId);

    // No field of the operator's is at fault, so the message cannot belong to one.
    expect(getByTestId('run-launcher-status').textContent).toContain('pipeline-not-found');
  });
});

// -- T060 — the three interaction cases of US8 ------------------------------

describe('double submission (T060, US8-1)', () => {
  it('sends one request no matter how many times Run is clicked before the answer', async () => {
    let release: ((result: LaunchPipelineResult) => void) | undefined;
    launchSpy.mockImplementation(
      () =>
        new Promise<LaunchPipelineResult>((resolve) => {
          release = resolve;
        })
    );

    const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });
    await fireEvent.click(getByTestId('run-launcher-submit'));
    await fireEvent.click(getByTestId('run-launcher-submit'));
    await fireEvent.click(getByTestId('run-launcher-submit'));

    // A duplicate run costs real Agent CLI time and can write the same target
    // twice, so the guard is on the handler and not only on the button's
    // `disabled` attribute.
    expect(launchSpy).toHaveBeenCalledTimes(1);

    release!(ENQUEUED);
    await tick();
    await tick();

    expect((getByTestId('run-launcher-submit') as HTMLButtonElement).disabled).toBe(false);
    expect(getByTestId('run-launcher-status').textContent).toContain('queue-item-1');
  });
});

describe('host rejection and the overwrite decision (T060, US8-1, FR-023)', () => {
  it('comes back editable with every value intact, and offers the replacement only for the refused port', async () => {
    launchSpy.mockResolvedValue({
      outcome: 'rejected-validation',
      errors: [
        {
          field: 'outputs.report',
          code: 'output-overwrite-unconfirmed',
          message: 'This target already holds content.'
        }
      ]
    });

    const { getByTestId, queryByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });
    await type(getByTestId, 'run-input-topic', 'run composition');
    await type(getByTestId, 'run-output-report', 'docs/report.md');
    await type(getByTestId, 'run-output-ticket', 'tickets/ABC-1.json');
    await submit(getByTestId);

    expect((getByTestId('run-launcher-submit') as HTMLButtonElement).disabled).toBe(false);
    expect((getByTestId('run-input-topic') as HTMLInputElement).value).toBe('run composition');
    expect((getByTestId('run-output-report') as HTMLInputElement).value).toBe('docs/report.md');
    expect(queryByTestId('run-output-overwrite-report')).not.toBeNull();
    expect(queryByTestId('run-output-overwrite-ticket')).toBeNull();
  });

  it('resubmits with the confirmation only after the operator accepts it', async () => {
    launchSpy.mockResolvedValue({
      outcome: 'rejected-validation',
      errors: [
        {
          field: 'outputs.report',
          code: 'output-overwrite-unconfirmed',
          message: 'This target already holds content.'
        }
      ]
    });

    const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });
    await type(getByTestId, 'run-output-report', 'docs/report.md');
    await submit(getByTestId);

    confirmSpy.mockResolvedValue(false);
    launchSpy.mockClear();
    await fireEvent.click(getByTestId('run-output-overwrite-report'));
    await tick();
    await tick();
    // Declining is the operator saying "do not replace it" — nothing goes out.
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(launchSpy).not.toHaveBeenCalled();

    confirmSpy.mockResolvedValue(true);
    launchSpy.mockResolvedValue(ENQUEUED);
    await fireEvent.click(getByTestId('run-output-overwrite-report'));
    await tick();
    await tick();
    await tick();

    expect(submitted().outputs).toEqual([
      { portId: 'report', target: 'docs/report.md', overwriteConfirmed: true }
    ]);
  });
});

// FR-R4-F05 (T17, T118; contract I, I5 to I8; contract O, O3, O4) — this block was "the outer bound
// on a submission": a 30 s timer in the component that restored the form and said "Nothing was
// queued", and ignored any answer after it. The timer and its message are gone. The wait is the
// ledger's 5 s, resolved here by the IPC module as `not-yet-known`; the text says the outcome is
// not yet known (the host may still queue the run), and the host's late answer replaces it once.
describe('a submission whose wait ran out (T118; FR-024, FR-026)', () => {
  const NOT_YET_KNOWN = 'The host has not answered yet, so the outcome is not yet known.';

  it('restores the editable form with the not-yet-known text, composition unchanged', async () => {
    launchSpy.mockResolvedValue({ outcome: 'not-yet-known' } as never);

    const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });
    await type(getByTestId, 'run-input-topic', 'run composition');
    await fireEvent.click(getByTestId('run-launcher-submit'));
    await tick();
    await tick();

    expect((getByTestId('run-launcher-submit') as HTMLButtonElement).disabled).toBe(false);
    expect(getByTestId('run-launcher-status').textContent).toContain(NOT_YET_KNOWN);
    expect(getByTestId('run-launcher-status').textContent).not.toContain('Nothing was queued');
    expect((getByTestId('run-input-topic') as HTMLInputElement).value).toBe('run composition');
  });

  it('starts no 30 s timer of its own', async () => {
    vi.useFakeTimers();
    try {
      launchSpy.mockImplementation(() => new Promise<LaunchPipelineResult>(() => {}));

      const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });
      await fireEvent.click(getByTestId('run-launcher-submit'));
      const before = vi.getTimerCount();
      await vi.advanceTimersByTimeAsync(30_000);

      // Nothing in the component fired: only the ledger, in the module the spy replaces, waits.
      expect(before).toBe(0);
      expect((getByTestId('run-launcher-submit') as HTMLButtonElement).disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces the not-yet-known text with the late outcome', async () => {
    launchSpy.mockResolvedValue({ outcome: 'not-yet-known' } as never);

    const { getByTestId } = render(RunLauncher, { props: { pipeline: PIPELINE } });
    await fireEvent.click(getByTestId('run-launcher-submit'));
    await tick();
    await tick();
    expect(getByTestId('run-launcher-status').textContent).toContain(NOT_YET_KNOWN);

    lastWaitOptions!.onLateOutcome!({ outcome: 'enqueued', requestId: 'req-late' } as never);
    await tick();

    const status = getByTestId('run-launcher-status').textContent;
    expect(status).toContain('Queued as req-late.');
    expect(status).not.toContain(NOT_YET_KNOWN);
  });

  it('aborts its wait when the component unmounts', async () => {
    launchSpy.mockImplementation(() => new Promise<LaunchPipelineResult>(() => {}));

    const { getByTestId, unmount } = render(RunLauncher, { props: { pipeline: PIPELINE } });
    await fireEvent.click(getByTestId('run-launcher-submit'));
    expect(lastWaitOptions!.signal!.aborted).toBe(false);

    unmount();

    expect(lastWaitOptions!.signal!.aborted).toBe(true);
  });
});
