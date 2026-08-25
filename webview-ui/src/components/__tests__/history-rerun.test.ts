// Feature 103 (T058, T064, T066-T069 — US5) — what the re-run panel says before
// the operator touches it, and what it sends when they do.
//
// The panel is deliberately thin: it states the three things a re-run silently
// changes (version, queue, and that a Workflow member repeats alone), and then
// mounts the SAME `RunLauncher` the launch surface mounts. That reuse is the
// requirement, not an economy — FR-038 says a re-run passes exactly the gates
// any other launch passes, and the cheapest way to be sure of that is for there
// to be one form and one submit path rather than two that agree today.
//
// Stubbed at the one seam the composer has. `launchPipeline` is the single
// webview call site for this family, so replacing it replaces the whole
// boundary, and the arguments it is handed are the assertable artifact.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchPipelineResult } from '../../lib/messages';
import type { RunRequest } from '../../../../src/contracts/run-request';
import type { HistoryRow } from '../../lib/history-rows';
import type { RerunTarget } from '../../lib/history-rerun';
import type { PipelineDefinition } from '../../lib/snapshot-types';
import type { ResolveHistoryDescriptionResult } from '../../lib/history-description-ipc';

const launchSpy = vi.fn<(request: RunRequest, queueId?: string) => Promise<LaunchPipelineResult>>();
vi.mock('../../lib/run-launcher-ipc', () => ({
  launchPipeline: (request: RunRequest, queueId?: string) => launchSpy(request, queueId)
}));

vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true)
}));

// FR-R3-071 (feature 152) — the panel asks the host for the FULL stored
// description on open, because the projection carries only the preview. Mocked
// at the single call site, and defaulted to `missing` so every case written
// before this feature still exercises the preview-plus-extent path it was
// written for; the resolved path is asserted explicitly below.
const resolveDescriptionSpy =
  vi.fn<(runId: string) => Promise<ResolveHistoryDescriptionResult>>();
vi.mock('../../lib/history-description-ipc', () => ({
  resolveHistoryDescription: (runId: string) => resolveDescriptionSpy(runId)
}));

// Late import so the component binds to the mocked call site above.
import HistoryRerunPanel from '../HistoryRerunPanel.svelte';

const PIPELINE: PipelineDefinition = {
  id: 'pipe-a',
  name: 'Pipeline A',
  phases: ['speckit-specify'],
  inputs: [{ portId: 'topic', label: 'Topic', type: 'text', required: true }],
  outputs: []
};

function row(overrides: Partial<HistoryRow> = {}): HistoryRow {
  const base: HistoryRow = {
    runId: 'run-1',
    queueId: 'default',
    queueName: 'Default',
    source: 'recorded',
    status: 'completed',
    definitionId: 'pipe-a',
    catalogVersion: { kind: 'pipeline', id: 'pipe-a', versionId: 'v1' },
    origin: { kind: 'standalone' },
    descriptionPreview: 'ship the thing',
    descriptionLength: 14,
    orderingKey: '2026-05-10T12:00:42.000Z',
    startedAt: '2026-05-10T12:00:00.000Z',
    completedAt: '2026-05-10T12:00:42.000Z',
    durationMs: 42_000
  };
  return Object.freeze({ ...base, ...overrides });
}

function readyTarget(overrides: Partial<Extract<RerunTarget, { state: 'ready' }>> = {}): RerunTarget {
  return {
    state: 'ready',
    launchable: {
      kind: 'pipeline',
      id: 'pipe-a',
      name: 'Pipeline A',
      activeVersionId: 'v1',
      inputs: []
    },
    supersededVersionId: null,
    workflowMemberOf: null,
    queue: { queueId: 'default', name: 'Default', substituted: false },
    ...overrides
  };
}

/** `null` is "the definition has not loaded", which the panel must not default away. */
function mount(
  target: RerunTarget,
  historyRow: HistoryRow = row(),
  pipeline: PipelineDefinition | null = PIPELINE
) {
  return render(HistoryRerunPanel, {
    props: { row: historyRow, target, pipeline: pipeline ?? undefined, onClose: () => {} }
  });
}

beforeEach(() => {
  launchSpy.mockReset();
  launchSpy.mockResolvedValue({ outcome: 'enqueued', requestId: 'q-1' });
  resolveDescriptionSpy.mockReset();
  resolveDescriptionSpy.mockResolvedValue({ outcome: 'missing', runId: 'run-1' });
});
afterEach(() => cleanup());

describe('HistoryRerunPanel — opening it (FR-033, FR-039)', () => {
  it('opens the trigger form and submits nothing', async () => {
    const { getByTestId } = mount(readyTarget());
    await tick();

    // The same composer Runs mounts, not a second form that agrees with it.
    expect(getByTestId('run-launcher')).not.toBeNull();
    // FR-039's first sentence, and the reason this assertion is the first one:
    // a panel that pre-filled and fired would repeat a run against a version
    // the operator never saw named.
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it('pre-fills the run’s description as the instruction, leaving it editable', async () => {
    const { getByTestId } = mount(readyTarget());
    await tick();

    const instruction = getByTestId('run-supplemental-instruction') as HTMLTextAreaElement;
    expect(instruction.value).toBe('ship the thing');
    expect(instruction.disabled).toBe(false);
  });

  it('states that the recorded inputs were not retained, rather than showing a blank form', async () => {
    // History keeps no input port values — only the description. An empty
    // contract section with nothing said about it reads as "this Pipeline needs
    // nothing", which is the same unstated substitution FR-059 names for queues.
    const { getByTestId } = mount(readyTarget());
    await tick();

    expect(getByTestId('history-rerun-prefill-note').textContent).toMatch(/not recorded|were not/i);
  });

  it('states that the pre-filled description is a truncation when it is one', async () => {
    const { getByTestId } = mount(
      readyTarget(),
      row({ descriptionPreview: 'ship the', descriptionLength: 400 })
    );
    await tick();

    expect(getByTestId('history-rerun-prefill-extent').textContent).toContain('400');
  });

  it('says nothing about extent when the whole description was retained', async () => {
    const { queryByTestId } = mount(readyTarget());
    await tick();
    expect(queryByTestId('history-rerun-prefill-extent')).toBeNull();
  });
});

describe('HistoryRerunPanel — the version it will run (FR-035, FR-036)', () => {
  it('states the difference, naming both versions, before anything is submitted', async () => {
    const { getByTestId } = mount(readyTarget({ supersededVersionId: 'v1', launchable: {
      kind: 'pipeline', id: 'pipe-a', name: 'Pipeline A', activeVersionId: 'v7', inputs: []
    } }));
    await tick();

    const notice = getByTestId('history-rerun-version-notice').textContent ?? '';
    expect(notice).toContain('v1');
    expect(notice).toContain('v7');
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it('shows no version notice when the historical version is still Active', async () => {
    const { queryByTestId } = mount(readyTarget());
    await tick();
    expect(queryByTestId('history-rerun-version-notice')).toBeNull();
  });
});

describe('HistoryRerunPanel — when it is unavailable (FR-037)', () => {
  it('states the reason and offers no form', async () => {
    const { getByTestId, queryByTestId } = mount({
      state: 'unavailable',
      reason: 'definition-not-published'
    });
    await tick();

    expect(getByTestId('history-rerun-panel').getAttribute('data-state')).toBe('unavailable');
    expect(getByTestId('history-rerun-unavailable').textContent).toMatch(/published/i);
    // Not silently absent, and not a form that fails on submit either.
    expect(queryByTestId('run-launcher')).toBeNull();
  });

  it('states a reason rather than an empty form when the definition has not loaded', async () => {
    const { getByTestId, queryByTestId } = mount(readyTarget(), row(), null);
    await tick();

    expect(getByTestId('history-rerun-panel').getAttribute('data-state')).toBe('definition-unloaded');
    expect(queryByTestId('run-launcher')).toBeNull();
  });
});

describe('HistoryRerunPanel — a Workflow member (FR-055)', () => {
  it('states that it repeats the Pipeline alone and does not reconstruct the graph', async () => {
    const { getByTestId } = mount(readyTarget({ workflowMemberOf: 'wf-9' }));
    await tick();

    const notice = getByTestId('history-rerun-workflow-notice').textContent ?? '';
    expect(notice).toContain('wf-9');
    expect(notice).toMatch(/alone|on its own|not.*workflow/i);
  });

  it('says nothing about a Workflow for a standalone run', async () => {
    const { queryByTestId } = mount(readyTarget());
    await tick();
    expect(queryByTestId('history-rerun-workflow-notice')).toBeNull();
  });
});

describe('HistoryRerunPanel — the queue (FR-059)', () => {
  it('names the historical queue when it still exists', async () => {
    const { getByTestId } = mount(
      readyTarget({ queue: { queueId: 'q-nightly', name: 'Nightly', substituted: false } })
    );
    await tick();

    const notice = getByTestId('history-rerun-queue-notice');
    expect(notice.getAttribute('data-substituted')).toBe('false');
    expect(notice.textContent).toContain('Nightly');
  });

  it('names the substitution when the historical queue is gone', async () => {
    const { getByTestId } = mount(
      readyTarget({ queue: { queueId: 'default', name: 'Default', substituted: true } })
    );
    await tick();

    const notice = getByTestId('history-rerun-queue-notice');
    expect(notice.getAttribute('data-substituted')).toBe('true');
    // Stated either way — a queue swap the operator is not told about is the
    // failure FR-059 exists to name.
    expect(notice.textContent).toMatch(/no longer exists|has been removed|default/i);
  });
});

describe('HistoryRerunPanel — submitting (FR-038, FR-059)', () => {
  it('goes through the ordinary launch path, carrying the resolved queue', async () => {
    const { getByTestId } = mount(
      readyTarget({ queue: { queueId: 'q-nightly', name: 'Nightly', substituted: false } })
    );
    await tick();

    await fireEvent.click(getByTestId('run-launcher-submit'));
    await tick();

    expect(launchSpy).toHaveBeenCalledTimes(1);
    const [request, queueId] = launchSpy.mock.calls[0]!;
    expect(queueId).toBe('q-nightly');
    expect(request.pipelineId).toBe('pipe-a');
  });

  it('asserts no provenance of its own — no catalogVersion leaves the webview', async () => {
    const { getByTestId } = mount(
      readyTarget({ supersededVersionId: 'v1', launchable: {
        kind: 'pipeline', id: 'pipe-a', name: 'Pipeline A', activeVersionId: 'v7', inputs: []
      } })
    );
    await tick();

    await fireEvent.click(getByTestId('run-launcher-submit'));
    await tick();

    const [request] = launchSpy.mock.calls[0]!;
    // FR-038 — the version a run freezes is resolved host-side inside
    // `validateRunRequest()`. The five ingress boundaries REFUSE a payload
    // carrying `catalogVersion` rather than stripping it, so a panel that sent
    // the Active version it just displayed would have every re-run rejected.
    expect(JSON.stringify(request)).not.toContain('catalogVersion');
    expect(JSON.stringify(request)).not.toContain('v7');
  });
});


describe('HistoryRerunPanel — the description it repeats (FR-R3-071)', () => {
  it('seeds the full stored description, not the preview, when the host resolves it', async () => {
    // The defect this closes: the panel is the surface an operator uses to
    // repeat a run, and it submitted an 80-char truncation of their own text.
    const full = 'ship the thing, and all the detail that did not fit in the preview';
    resolveDescriptionSpy.mockResolvedValue({
      outcome: 'resolved',
      runId: 'run-1',
      description: full
    });
    const { getByTestId, queryByTestId } = mount(
      readyTarget(),
      row({ descriptionPreview: 'ship the', descriptionLength: full.length })
    );
    await tick();
    await tick();
    expect(resolveDescriptionSpy).toHaveBeenCalledWith('run-1');
    const instruction = getByTestId('run-supplemental-instruction') as HTMLTextAreaElement;
    expect(instruction.value).toBe(full);
    // Nothing was truncated, so the extent note has nothing to say.
    expect(queryByTestId('history-rerun-prefill-extent')).toBeNull();
  });

  it('seeds a legacy entry the same way — it is the authored text too', async () => {
    resolveDescriptionSpy.mockResolvedValue({
      outcome: 'legacy',
      runId: 'run-1',
      description: 'pre-sidecar text'
    });
    const { getByTestId } = mount(readyTarget(), row({ descriptionPreview: 'pre-side' }));
    await tick();
    await tick();
    const instruction = getByTestId('run-supplemental-instruction') as HTMLTextAreaElement;
    expect(instruction.value).toBe('pre-sidecar text');
  });

  it('keeps the preview and its extent note when the sidecar cannot be read', async () => {
    // `missing` / `unreadable` are answers, not errors: the pre-152 behaviour
    // is already honest and stays, note included.
    for (const outcome of ['missing', 'unreadable'] as const) {
      resolveDescriptionSpy.mockResolvedValue({ outcome, runId: 'run-1' });
      const { getByTestId, unmount } = mount(
        readyTarget(),
        row({ descriptionPreview: 'ship the', descriptionLength: 400 })
      );
      await tick();
      await tick();
      const instruction = getByTestId('run-supplemental-instruction') as HTMLTextAreaElement;
      expect(instruction.value).toBe('ship the');
      expect(getByTestId('history-rerun-prefill-extent').textContent).toContain('400');
      unmount();
    }
  });
});
