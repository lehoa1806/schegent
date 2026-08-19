// Feature 098 (T053, US4) — the launch surface over an empty catalog.
//
// FR-030a, FR-032, SC-010. The requirement is that the surface an operator
// launches from stays mounted and reachable with nothing imported, showing
// the same guidance the sidebar shows in place of its Pipeline choices. The
// failure it rules out is the tidy one: hiding the whole compose zone,
// leaving an operator with an empty catalog no visible route to a non-empty
// one, and leaving `RunLauncher.svelte` unreachable — which
// `tests/lint/svelte-surface-reachability.test.ts` names in
// `MUST_NOT_BE_ALLOWLISTED` for exactly that reason.
//
// The component mounted here is `RunsSurface.svelte`, not
// `RunLauncher.svelte`. The task names the launcher, and this file sits in
// the launcher's own `__tests__` directory because that is where the task
// puts it — but `RunLauncher` takes a required `pipeline: PipelineDefinition`
// prop, so on an empty catalog there is no Pipeline to mount it against. The
// "Pipeline choices" FR-030a speaks of are the picker and Compose button in
// `RunsSurface.svelte`, which is the surface that decides whether the
// launcher is reachable at all. That is the thing this pins.
//
// The guidance text is asserted against the shared source rather than
// restated as a literal here: a test carrying its own copy of the message
// would pass while the two surfaces drifted apart, which is the exact defect
// FR-030a's "one shared source" clause exists to prevent.

import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_CATALOG_GUIDANCE } from '../../../../../src/contracts/empty-catalog-guidance';
import type { PipelineDefinition, WorkflowSnapshot } from '../../../lib/snapshot-types';
import { foldLegacyRun } from '../../../lib/__tests__/queue-runtime-fixture';

vi.mock('../../../lib/workflow-run-ipc', () => ({
  continueWorkflow: vi.fn()
}));
vi.mock('../../../lib/run-launcher-ipc', () => ({
  launchPipeline: vi.fn()
}));

// Late import so the surface binds to the stubs above.
import RunsSurface from '../../RunsSurface.svelte';

afterEach(() => cleanup());

const PIPELINE: PipelineDefinition = {
  id: 'operator-flow',
  name: 'Operator Flow',
  phases: ['draft'],
  inputs: [],
  outputs: []
};

function buildSnapshot(availablePipelines: readonly PipelineDefinition[]): WorkflowSnapshot {
  return {
    schemaVersion: 4,
    isPrimary: true,
    queues: foldLegacyRun({
      status: 'idle',
      activeFeature: null,
      phases: [],
      liveActivity: null,
      workflowElapsedMs: 0
    }),
    queue: { orderedItems: [], inFlight: null, pending: [], recent: [], paused: false },
    auditTail: [],
    monitor: null,
    history: [],
    producedAt: '2026-08-19T00:00:00.000Z',
    connectedRuns: [],
    availablePipelines,
    availablePhases: [],
    availableModels: { claude: [], codex: [], agy: [] },
    availableBackends: ['claude']
  } as unknown as WorkflowSnapshot;
}

describe('Feature 098 (T053) — the launch surface stays mounted on an empty catalog', () => {
  it('keeps the compose zone rendered with nothing imported', () => {
    const { getByTestId } = render(RunsSurface, { snapshot: buildSnapshot([]) });

    // The zone itself, not merely the page around it: FR-030a forbids hiding,
    // removing, or making the launch surface unreachable.
    expect(getByTestId('runs-surface-compose-zone')).toBeTruthy();
  });

  it('shows the shared guidance in place of the Pipeline choices', () => {
    const { getByTestId, queryByTestId } = render(RunsSurface, {
      snapshot: buildSnapshot([])
    });

    const guidance = getByTestId('runs-surface-empty-catalog');
    expect(guidance.textContent).toContain(EMPTY_CATALOG_GUIDANCE.headline);
    expect(guidance.textContent).toContain(EMPTY_CATALOG_GUIDANCE.body);

    // "In place of" — the picker and Compose button are the choices being
    // replaced, and a guidance line beside a live picker over an empty
    // catalog would offer a control whose only outcome is a refusal.
    expect(queryByTestId('runs-surface-pipeline-select')).toBeNull();
    expect(queryByTestId('runs-surface-compose')).toBeNull();
  });
});

describe('Feature 098 (T053) — a non-empty catalog restores the choices', () => {
  it('renders the picker and Compose button once something is imported', () => {
    const { getByTestId } = render(RunsSurface, { snapshot: buildSnapshot([PIPELINE]) });

    expect(getByTestId('runs-surface-pipeline-select')).toBeTruthy();
    expect(getByTestId('runs-surface-compose')).toBeTruthy();
  });

  it('withholds the guidance when there is something to choose (FR-032)', () => {
    const { queryByTestId, container } = render(RunsSurface, {
      snapshot: buildSnapshot([PIPELINE])
    });

    expect(queryByTestId('runs-surface-empty-catalog')).toBeNull();
    // Asserted on the rendered text too, so guidance moved into an untagged
    // element would still be caught.
    expect(container.textContent ?? '').not.toContain(EMPTY_CATALOG_GUIDANCE.headline);
  });
});
