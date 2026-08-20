// Feature 098 (T053, US4) — the launch surface over an empty catalog.
//
// FR-030a, FR-032, SC-010. The requirement is that the surface an operator
// launches from stays mounted and reachable with nothing imported, showing the
// same guidance the sidebar shows in place of its choices. The failure it rules
// out is the tidy one: hiding the whole launch zone, leaving an operator with an
// empty catalog no visible route to a non-empty one, and leaving
// `RunLauncher.svelte` unreachable — which
// `tests/lint/svelte-surface-reachability.test.ts` names in
// `MUST_NOT_BE_ALLOWLISTED` for exactly that reason.
//
// The component mounted here is `RunsSurface.svelte`, not `RunLauncher.svelte`.
// The task names the launcher, and this file sits in the launcher's own
// `__tests__` directory because that is where the task puts it — but
// `RunLauncher` takes a required `pipeline: PipelineDefinition` prop, so on an
// empty catalog there is no Pipeline to mount it against. The surface is what
// decides whether the launcher is reachable at all, and that is the thing this
// pins.
//
// Feature 102 (T047) — the handles moved and the requirement did not. What
// FR-030a called "the Pipeline choices" was a `<select>` and a Compose button;
// T014 replaced them with two sections, and T045 gave each section its own empty
// reason. So "the guidance shows in place of the choices" is now asserted per
// section, and "the choices come back" is asserted by launching: the row, the
// Trigger, and the launcher that opens behind it are what the picker used to be.
//
// The guidance text is asserted against the shared source rather than restated
// as a literal here: a test carrying its own copy of the message would pass while
// the two surfaces drifted apart, which is the exact defect FR-030a's "one shared
// source" clause exists to prevent.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_CATALOG_GUIDANCE } from '../../../../../src/contracts/empty-catalog-guidance';
import type { WorkflowSnapshot } from '../../../lib/snapshot-types';
import { buildSnapshot, projection } from '../../Runs/__tests__/launch-fixture';

vi.mock('../../../lib/workflow-run-ipc', () => ({
  continueWorkflow: vi.fn(),
  launchWorkflow: vi.fn()
}));
vi.mock('../../../lib/run-launcher-ipc', () => ({
  launchPipeline: vi.fn()
}));

// Late import so the surface binds to the stubs above.
import RunsSurface from '../../RunsSurface.svelte';

afterEach(() => cleanup());

/** Nothing imported: no effective catalog, and both sections say why. */
function emptyWorkspace(): WorkflowSnapshot {
  return buildSnapshot({
    availablePipelines: [],
    launchables: projection({ state: 'no-definitions' }, { state: 'no-definitions' })
  });
}

describe('Feature 098 (T053) — the launch surface stays mounted on an empty catalog', () => {
  it('keeps the launch zone rendered with nothing imported', () => {
    const { getByTestId } = render(RunsSurface, { snapshot: emptyWorkspace() });

    // The zone itself, not merely the page around it: FR-030a forbids hiding,
    // removing, or making the launch surface unreachable.
    expect(getByTestId('runs-surface-launch-zone')).toBeTruthy();
  });

  it('shows the shared guidance in place of the choices, in both sections', () => {
    const { getByTestId, queryByTestId } = render(RunsSurface, { snapshot: emptyWorkspace() });

    for (const kind of ['pipeline', 'workflow'] as const) {
      const guidance = getByTestId(`launch-section-no-definitions-${kind}`);
      expect(guidance.textContent).toContain(EMPTY_CATALOG_GUIDANCE.headline);
      expect(guidance.textContent).toContain(EMPTY_CATALOG_GUIDANCE.body);

      // "In place of" — the list is the choice being replaced, and a live row
      // over an empty catalog would offer a control whose only outcome is a
      // refusal.
      expect(queryByTestId(`launch-section-list-${kind}`)).toBeNull();
    }
  });
});

describe('Feature 098 (T053) — a non-empty catalog restores the choices', () => {
  it('lists what is published once something is imported', () => {
    const { getByTestId } = render(RunsSurface, { snapshot: buildSnapshot() });

    expect(getByTestId('launch-section-list-pipeline')).toBeTruthy();
    expect(getByTestId('launch-section-list-workflow')).toBeTruthy();
  });

  it('reaches the launcher through the restored choices (SC-010)', async () => {
    // The reachability half, stated as the operator's path rather than as a
    // rendered handle: select, Trigger, launcher. A picker that renders and opens
    // nothing would satisfy the assertion above and none of the requirement.
    const { getByTestId } = render(RunsSurface, { snapshot: buildSnapshot() });

    await fireEvent.click(getByTestId('launchable-select-pipeline-analysis-pipeline'));
    await fireEvent.click(getByTestId('launchable-detail-trigger'));

    expect(getByTestId('run-launcher')).toBeTruthy();
  });

  it('withholds the guidance when there is something to choose (FR-032)', () => {
    const { queryByTestId, container } = render(RunsSurface, { snapshot: buildSnapshot() });

    expect(queryByTestId('launch-section-no-definitions-pipeline')).toBeNull();
    expect(queryByTestId('launch-section-no-definitions-workflow')).toBeNull();
    // Asserted on the rendered text too, so guidance moved into an untagged
    // element would still be caught.
    expect(container.textContent ?? '').not.toContain(EMPTY_CATALOG_GUIDANCE.headline);
  });
});
