// Feature 102 (T017, US2 — FR-007, FR-008, FR-009, FR-017) — what an operator
// sees between choosing a definition and running it.
//
// The flow is four steps on purpose — select, read, Trigger, Run — and each of
// the three tests below pins one of the joints, because the failure modes are
// all collapses of the sequence rather than faults inside any one step:
//
//   * **The detail panel reads; it does not edit.** It is the last place an
//     operator confirms they picked the right thing, and a stray input there
//     would be a second, unsubmitted copy of the form's values. Asserted by
//     sweeping the panel for form controls rather than by naming the fields it
//     does not have, since the next field added would not be one this test knew
//     to look for.
//
//   * **Trigger and Run are two controls, not one.** Collapsing them turns
//     "I want to look at this" into "start it", which is exactly the accident the
//     explicit flow exists to prevent. Pinned by asserting the host is untouched
//     after Trigger and reached only after Run.
//
//   * **The ports are recomputed, never remembered.** A Workflow's ports are
//     derived from its graph and a Pipeline's from its active version; both move
//     when the definition is republished. A panel rendering a copy taken at
//     selection time shows the operator the shape of a version that is no longer
//     the one their run will freeze. Asserted by changing the projection under a
//     live selection and requiring the panel to follow without re-selecting.
//
// FR-009's requiredness marker is asserted on its text and on the port list's
// membership, never on a class or a colour — an operator who cannot distinguish
// the marker's colour must still be able to read which ports the definition
// insists on.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STATE_SNAPSHOT } from '../../../lib/messages';
import { snapshotStore } from '../../../lib/snapshot-store.svelte';
import type { BackendPosture, CapabilityNotice, Launchable } from '../../../lib/snapshot-types';
import { ANALYSIS, RESEARCH, buildSnapshot, entries, projection } from './launch-fixture';

const launchPipeline = vi.fn();
vi.mock('../../../lib/workflow-run-ipc', () => ({
  continueWorkflow: vi.fn(),
  launchWorkflow: vi.fn()
}));
vi.mock('../../../lib/run-launcher-ipc', () => ({
  launchPipeline: (...args: readonly unknown[]) => launchPipeline(...args)
}));

// Late import so the surface binds to the stubs above.
import RunsSurface from '../../RunsSurface.svelte';

afterEach(() => {
  cleanup();
  launchPipeline.mockReset();
});

async function selectPipeline() {
  const view = render(RunsSurface, { snapshot: buildSnapshot() });
  await fireEvent.click(view.getByTestId('launchable-select-pipeline-analysis-pipeline'));
  return view;
}

describe('the detail panel for a selected definition (FR-007)', () => {
  it('states the description, the input ports, and the active version', async () => {
    const { getByTestId } = await selectPipeline();
    const detail = getByTestId('launchable-detail');

    expect(getByTestId('launchable-detail-name').textContent).toContain('Analysis Pipeline');
    expect(getByTestId('launchable-detail-description').textContent).toContain(
      'Reads a corpus and writes the findings up.'
    );
    expect(getByTestId('launchable-detail-version').textContent).toContain('v3');
    expect(getByTestId('launchable-detail-port-topic').textContent).toContain('Topic');
    expect(getByTestId('launchable-detail-port-notes').textContent).toContain('Notes');
    expect(detail.textContent).toContain('Reads a corpus');
  });

  it('marks the ports the definition declares required by a readable text marker (FR-009)', async () => {
    const { getByTestId, queryByTestId } = await selectPipeline();

    expect(getByTestId('launchable-detail-required-topic').textContent?.toLowerCase()).toContain(
      'required'
    );
    expect(queryByTestId('launchable-detail-required-notes')).toBeNull();
  });

  it('offers no editable field of its own', async () => {
    const { getByTestId } = await selectPipeline();
    const detail = getByTestId('launchable-detail');

    expect(detail.querySelectorAll('input, textarea, select')).toHaveLength(0);
  });

  it('recomputes its ports from the projection rather than a copy taken at selection (FR-017)', async () => {
    // The definition is republished under the operator's live selection: same id,
    // new active version, new ports. Nothing is re-selected — the panel must
    // follow the projection, because the run will freeze what the projection now
    // offers and not what the panel happened to capture.
    const republished: Launchable = {
      ...ANALYSIS,
      activeVersionId: 'v4',
      inputs: [{ portId: 'corpus', label: 'Corpus', type: 'text', required: true }]
    };
    const { getByTestId, queryByTestId, rerender } = await selectPipeline();
    expect(getByTestId('launchable-detail-port-topic')).toBeTruthy();

    await rerender({
      snapshot: buildSnapshot({ launchables: projection(entries(republished)) })
    });

    expect(queryByTestId('launchable-detail-port-topic')).toBeNull();
    expect(getByTestId('launchable-detail-port-corpus').textContent).toContain('Corpus');
    expect(getByTestId('launchable-detail-version').textContent).toContain('v4');
  });

  it('states the same three things for a Workflow, whose ports are derived', async () => {
    // A Workflow's derived ports carry no requiredness (FR-009), and the panel
    // must not invent one: an unmarked port is "not declared required", which is
    // a different claim from "optional".
    const { getByTestId, queryByTestId } = render(RunsSurface, { snapshot: buildSnapshot() });
    await fireEvent.click(getByTestId('launchable-select-workflow-analysis-pipeline'));

    expect(getByTestId('launchable-detail-name').textContent).toContain(RESEARCH.name);
    expect(getByTestId('launchable-detail-version').textContent).toContain('v2');
    expect(getByTestId('launchable-detail-port-seed').textContent).toContain('Seed');
    expect(queryByTestId('launchable-detail-required-seed')).toBeNull();
  });
});

describe('the Builder hand-off preselects a Workflow once (FR-R5-F06)', () => {
  it('lets the operator pick something else and keeps that pick across later snapshots', async () => {
    // The host sends a fresh snapshot about once a second while a run executes, and the projection
    // is structured-cloned each time, so `launchables` is a new object on every one of them. A
    // hand-off that re-applies whenever the projection changes would put the operator's pick back
    // on the handed-off Workflow within a second of making it.
    const view = render(RunsSurface, {
      snapshot: buildSnapshot(),
      selectedWorkflowId: 'analysis-pipeline'
    });
    expect(view.getByTestId('launchable-detail-name').textContent).toContain(RESEARCH.name);

    await fireEvent.click(view.getByTestId('launchable-select-pipeline-analysis-pipeline'));
    expect(view.getByTestId('launchable-detail-name').textContent).toContain('Analysis Pipeline');

    await view.rerender({
      snapshot: buildSnapshot(),
      selectedWorkflowId: 'analysis-pipeline'
    });

    expect(view.getByTestId('launchable-detail-name').textContent).toContain('Analysis Pipeline');
  });

  it('waits for the projection to offer the Workflow, then applies the hand-off', async () => {
    const view = render(RunsSurface, {
      snapshot: buildSnapshot({ launchables: undefined }),
      selectedWorkflowId: 'analysis-pipeline'
    });
    expect(view.queryByTestId('launchable-detail')).toBeNull();

    await view.rerender({
      snapshot: buildSnapshot(),
      selectedWorkflowId: 'analysis-pipeline'
    });

    expect(view.getByTestId('launchable-detail-name').textContent).toContain(RESEARCH.name);
  });
});

describe('a window that cannot start work (FR-015)', () => {
  it('still lists and still selects, but withholds Trigger and says why', async () => {
    // Read-only is not a reduced surface. An operator in a second window is
    // usually there to look something up, and hiding the lists would answer a
    // question they did not ask. What they cannot do is start work — so the one
    // control that starts work is withheld, and the reason is on screen next to
    // it rather than left to be inferred from a control that does nothing.
    const { getByTestId, queryByTestId } = render(RunsSurface, {
      snapshot: buildSnapshot({ isPrimary: false })
    });

    await fireEvent.click(getByTestId('launchable-select-pipeline-analysis-pipeline'));

    expect(getByTestId('launchable-detail-name').textContent).toContain('Analysis Pipeline');
    expect(getByTestId('launchable-detail-port-topic')).toBeTruthy();
    expect((getByTestId('launchable-detail-trigger') as HTMLButtonElement).disabled).toBe(true);
    expect(getByTestId('launchable-detail-read-only').textContent).toContain('cannot start runs');

    await fireEvent.click(getByTestId('launchable-detail-trigger'));
    expect(queryByTestId('run-launcher')).toBeNull();
    expect(launchPipeline).not.toHaveBeenCalled();
  });

  it('states nothing about the window when it can start work', async () => {
    const { queryByTestId } = await selectPipeline();
    expect(queryByTestId('launchable-detail-read-only')).toBeNull();
  });
});

describe('Trigger and Run are distinct controls (FR-008)', () => {
  it('opens the form on Trigger without reaching the host', async () => {
    const { getByTestId, queryByTestId } = await selectPipeline();
    expect(queryByTestId('run-launcher')).toBeNull();

    await fireEvent.click(getByTestId('launchable-detail-trigger'));

    expect(getByTestId('run-launcher')).toBeTruthy();
    expect(launchPipeline).not.toHaveBeenCalled();
  });

  it('presents exactly the selected definition ports in the form, with the required one marked (FR-009)', async () => {
    const { getByTestId, queryByTestId } = await selectPipeline();
    await fireEvent.click(getByTestId('launchable-detail-trigger'));

    expect(getByTestId('run-input-topic')).toBeTruthy();
    expect(getByTestId('run-input-notes')).toBeTruthy();
    expect(queryByTestId('run-input-seed')).toBeNull();
    expect(getByTestId('run-input-required-topic').textContent?.toLowerCase()).toContain(
      'required'
    );
    expect(queryByTestId('run-input-required-notes')).toBeNull();
  });

  it('submits only on Run', async () => {
    launchPipeline.mockResolvedValue({ outcome: 'enqueued', requestId: 'request-9' });
    const { getByTestId } = await selectPipeline();
    await fireEvent.click(getByTestId('launchable-detail-trigger'));

    await fireEvent.click(getByTestId('run-launcher-submit'));

    expect(launchPipeline).toHaveBeenCalledTimes(1);
    expect(launchPipeline.mock.calls[0][0]).toMatchObject({ pipelineId: 'analysis-pipeline' });
  });
});

// FR-R4-F06 (FR-007; D4; tasks TA8) -- what the panel says about the authority a start will have.
//
// `LaunchAuthorityNotice` has its own suite, which feeds it props directly. What that suite cannot
// show is that THIS panel mounts it and hands it the right three things: the host's postures from
// the snapshot store, the backends of the entry that is SELECTED (not every backend the host knows),
// and that entry's capability notices. Each case selects a definition and reads the notice off the
// real panel. The store is the real one, so a case drives it the way the host does, with a snapshot
// message, and puts it back afterwards because it is a module singleton.
describe('what the panel says about the authority a start will have (FR-R4-F06 FR-007)', () => {
  const CLAUDE_TEXT = 'Host text: Claude runs with your local user authority.';
  const POSTURES: readonly BackendPosture[] = [
    { kind: 'claude', containment: 'none', mechanism: 'none', grant: 'granted', notice: CLAUDE_TEXT },
    {
      kind: 'codex',
      containment: 'os-enforced',
      mechanism: 'codex-sandbox-workspace-write',
      grant: 'not-required'
    }
  ];
  const CAPABILITY_NOTICES: readonly CapabilityNotice[] = [
    {
      phaseName: 'implement',
      backend: 'codex',
      outcome: 'residual',
      text: 'Host text: implement is bounded by tool access.'
    }
  ];

  afterEach(() => {
    snapshotStore.apply({ type: STATE_SNAPSHOT, payload: buildSnapshot() } as never);
  });

  /** Offers `entry` as the only Pipeline, applies the host's postures, and selects it. */
  async function selectOffered(entry: Launchable) {
    const snapshot = buildSnapshot({
      launchables: projection(entries(entry)),
      backendPostures: POSTURES
    });
    snapshotStore.apply({ type: STATE_SNAPSHOT, payload: snapshot } as never);
    const view = render(RunsSurface, { snapshot });
    await fireEvent.click(view.getByTestId('launchable-select-pipeline-analysis-pipeline'));
    return view;
  }

  it('shows the host notice for a definition that runs on a granted uncontained backend', async () => {
    const { getByTestId } = await selectOffered({ ...ANALYSIS, backends: ['claude'] });

    expect(getByTestId('launch-authority-notice-text-claude').textContent).toBe(CLAUDE_TEXT);
  });

  it('puts the notice above the control that starts the work', async () => {
    const { getByTestId } = await selectOffered({ ...ANALYSIS, backends: ['claude'] });

    const notice = getByTestId('launch-authority-notice');
    const trigger = getByTestId('launchable-detail-trigger');
    expect(notice.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows nothing for a definition that runs only on a contained backend', async () => {
    // The postures still carry Claude's notice. A panel that rendered every posture's notice, or read
    // the window default in place of the entry's own backends, would show it here.
    const { getByTestId, queryByTestId } = await selectOffered({ ...ANALYSIS, backends: ['codex'] });

    expect(getByTestId('launchable-detail-trigger')).toBeTruthy();
    expect(queryByTestId('launch-authority-notice')).toBeNull();
    expect(queryByTestId('launch-authority-notice-text-claude')).toBeNull();
  });

  it('shows the entry capability notices, even where no posture notice applies', async () => {
    const { getByTestId, queryByTestId } = await selectOffered({
      ...ANALYSIS,
      backends: ['codex'],
      capabilityNotices: CAPABILITY_NOTICES
    });

    expect(getByTestId('launch-authority-capability-0').textContent).toBe(CAPABILITY_NOTICES.at(0)?.text);
    expect(queryByTestId('launch-authority-notice-text-claude')).toBeNull();
  });

  it('shows declared output ports and resolved run settings on a composable Workflow (FR-R5-F06)', async () => {
    const composableEntry: Launchable = {
      ...RESEARCH,
      inputs: [{ portId: 'topic', label: 'Topic', type: 'text', required: true }],
      outputs: [{ portId: 'summary', label: 'Summary Report', type: 'markdown', required: true }],
      runSettings: {
        maxDurationSeconds: { value: 21_600, origin: 'workspace' },
        phases: [
          {
            phaseName: 'Draft Phase',
            backend: 'claude',
            model: { kind: 'backend-default' },
            effort: { kind: 'backend-default' },
            idleTimeoutSeconds: { value: 120, origin: 'phase' }
          }
        ]
      }
    };
    const snapshot = buildSnapshot({
      launchables: projection(entries(ANALYSIS), entries(composableEntry))
    });
    const view = render(RunsSurface, { snapshot });
    await fireEvent.click(view.getByTestId('launchable-select-workflow-analysis-pipeline'));

    expect(view.getByTestId('launchable-detail-required-topic').textContent.toLowerCase()).toContain(
      'required'
    );
    expect(view.getByTestId('launchable-detail-outputs')).toBeTruthy();
    expect(view.getByTestId('launchable-detail-output-summary').textContent).toContain(
      'Summary Report'
    );
    expect(view.getByTestId('launchable-detail-run-settings').textContent).toContain('Draft Phase');
  });

  it('lists a Phase once per occurrence when the Workflow reuses it (FR-R5-F06)', async () => {
    // `collectWorkflowLeafPhases` adds one phase id per occurrence and does not deduplicate, so a
    // Workflow that reuses a Phase (or calls one child Workflow twice) hands the panel the same
    // `phaseName` more than once. Keying the rows by that name makes Svelte throw
    // `each_key_duplicate`, which replaces the whole route.
    const reusedPhase = {
      phaseName: 'Verification check phase',
      backend: 'claude',
      model: { kind: 'backend-default' },
      effort: { kind: 'backend-default' },
      idleTimeoutSeconds: { value: 120, origin: 'phase' }
    } as const;
    const reusing: Launchable = {
      ...RESEARCH,
      // A Workflow with no declared outputs falls back to the derived ones, one per node, so a child
      // Workflow called twice contributes the same `portId` under two `nodeId`s.
      outputs: [
        { portId: 'verdict', label: 'Verdict', type: 'markdown', nodeId: 'verify-first' },
        { portId: 'verdict', label: 'Verdict', type: 'markdown', nodeId: 'verify-second' }
      ],
      runSettings: {
        maxDurationSeconds: { value: 21_600, origin: 'workspace' },
        phases: [reusedPhase, reusedPhase]
      }
    };
    const snapshot = buildSnapshot({
      launchables: projection(entries(ANALYSIS), entries(reusing))
    });
    const view = render(RunsSurface, { snapshot });

    await fireEvent.click(view.getByTestId('launchable-select-workflow-analysis-pipeline'));

    const settingRows = view.getByTestId('launchable-detail-run-settings').querySelectorAll('li');
    expect(settingRows).toHaveLength(2);
    const testIds = Array.from(settingRows, (row) => row.getAttribute('data-testid'));
    expect(new Set(testIds).size).toBe(2);
    expect(view.getByTestId('launchable-detail-outputs').querySelectorAll('li')).toHaveLength(2);
  });

  it('lists an input once per occurrence when the Workflow calls one child twice (FR-R5-F06)', async () => {
    // A parent that calls one child Workflow twice projects that child's unbound input once per
    // call, so the same `portId` arrives under two `nodeId`s. Keying the rows by `portId` makes
    // Svelte throw `each_key_duplicate`, which replaces the whole route.
    const calling: Launchable = {
      ...RESEARCH,
      inputs: [
        { portId: 'topic', label: 'Topic', type: 'text', nodeId: 'review-first' },
        { portId: 'topic', label: 'Topic', type: 'text', nodeId: 'review-second' }
      ]
    };
    const snapshot = buildSnapshot({
      launchables: projection(entries(ANALYSIS), entries(calling))
    });
    const view = render(RunsSurface, { snapshot });

    await fireEvent.click(view.getByTestId('launchable-select-workflow-analysis-pipeline'));

    expect(view.getAllByTestId('launchable-detail-port-topic')).toHaveLength(2);
  });
});
