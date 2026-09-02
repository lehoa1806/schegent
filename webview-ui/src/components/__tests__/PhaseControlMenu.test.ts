import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import PhaseControlMenu from '../PhaseControlMenu.svelte';
import {
  CMD_PAUSE_PHASE,
  CMD_RESTART_PHASE,
  CMD_RESUME_PHASE,
  CMD_SKIP_PHASE,
  CMD_DISABLE_PHASE,
  CMD_ENABLE_PHASE,
  CMD_RETRY_PHASE_NOW,
  CMD_REMOVE_TASK_PHASE
} from '../../lib/messages';
import { useConfirm } from '../../lib/use-confirm';

// Feature 093 (T080) — lifecycle controls are queue-addressed, so the component
// under test needs the queue whose Run it acts on, and every payload it posts
// carries that queue. The assertions below are the webview-side half of the
// contract the host pins in `queue-addressed-phase-controls.test.ts`.
const TEST_QUEUE_ID = 'q-alpha';

const postCommandSpy = vi.fn();
vi.mock('../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args)
}));

vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn().mockResolvedValue(true)
}));

const confirmMock = vi.mocked(useConfirm);

beforeEach(() => {
  postCommandSpy.mockReset();
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
});

afterEach(() => cleanup());

describe('PhaseControlMenu', () => {
  it('dispatches pause, resume, and restart through phase-control helpers', async () => {
    const { getByTestId, rerender } = render(PhaseControlMenu, {
      props: {
        targetsSubjectRun: true,
        queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-plan',
        // FR-R3-151 — Disable is now `selectedPhase`-targeted; this test
        // selects the same tile as `currentPhase` since it is not exercising
        // the differentiated-target scenario (see the `selectedPhase`
        // describe block below for that).
        selectedPhase: 'speckit-plan',
        isPrimary: true,
        manualPauseAt: null
      }
    });

    await fireEvent.click(getByTestId('phase-control-pause'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_PAUSE_PHASE, { queueId: TEST_QUEUE_ID });

    await rerender({ targetsSubjectRun: true, queueId: TEST_QUEUE_ID,
      currentPhase: 'speckit-plan',
      selectedPhase: 'speckit-plan',
      isPrimary: true,
      manualPauseAt: '2026-05-13T00:00:00.000Z'
    });
    await fireEvent.click(getByTestId('phase-control-resume'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_RESUME_PHASE, { queueId: TEST_QUEUE_ID });

    await fireEvent.click(getByTestId('phase-control-restart'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_RESTART_PHASE, {
      queueId: TEST_QUEUE_ID,
      phaseId: 'speckit-plan'
    });

    await fireEvent.click(getByTestId('phase-control-skip'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_SKIP_PHASE, {
      queueId: TEST_QUEUE_ID,
      phaseId: 'speckit-plan'
    });

    // Disable targets a future, no-override selection — `selectedPhaseState:
    // 'not-started'` — since the active Phase ('speckit-plan', selected
    // above) is never a Disable-eligible target (FR-005).
    await rerender({
      targetsSubjectRun: true,
      queueId: TEST_QUEUE_ID,
      currentPhase: 'speckit-plan',
      selectedPhase: 'speckit-implement',
      selectedPhaseState: 'not-started',
      isPrimary: true,
      manualPauseAt: null
    });
    await fireEvent.click(getByTestId('phase-control-disable'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_DISABLE_PHASE, {
      queueId: TEST_QUEUE_ID,
      phaseId: 'speckit-implement'
    });
  });

  it('disables mutating controls when not primary', async () => {
    const { container, getByTestId } = render(PhaseControlMenu, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID, currentPhase: 'speckit-plan', isPrimary: false, manualPauseAt: null }
    });

    container.querySelectorAll('button').forEach((button) => {
      expect(button.getAttribute('aria-disabled')).toBe('true');
    });
    await fireEvent.click(getByTestId('phase-control-pause'));
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  it('enables override clearing only when the selected phase carries a disabled override', async () => {
    const { getByTestId } = render(PhaseControlMenu, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-plan',
        selectedPhase: 'speckit-plan',
        selectedPhaseState: 'disabled',
        isPrimary: true,
        manualPauseAt: null,
        phaseOverrides: [{ phaseId: 'speckit-plan', action: 'disabled' }]
      }
    });

    expect(getByTestId('phase-control-enable').getAttribute('aria-disabled')).toBe('false');
    await fireEvent.click(getByTestId('phase-control-enable'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_ENABLE_PHASE, {
      queueId: TEST_QUEUE_ID,
      phaseId: 'speckit-plan'
    });
  });

  // FR-R3-151 (FR-006) — a stale `skipped` override must not leave Enable
  // clickable: the host's `decidePhaseControl` refuses it with
  // `no-disabled-override`, and that refusal is never surfaced back to the
  // operator (no ack is awaited for this fire-and-forget command), so the
  // control must fail closed here instead of relying on the host's silent
  // rejection.
  it('keeps Enable disabled when the selected phase carries a non-disabled override', async () => {
    const { getByTestId } = render(PhaseControlMenu, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-specify',
        selectedPhase: 'speckit-plan',
        selectedPhaseState: 'skipped',
        isPrimary: true,
        manualPauseAt: null,
        phaseOverrides: [{ phaseId: 'speckit-plan', action: 'skipped' }]
      }
    });

    expect(getByTestId('phase-control-enable').getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(getByTestId('phase-control-enable'));
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  // FR-R3-151 (FR-005) — Disable must refuse a selection that has already
  // started, the same way the host does, rather than leaving the button
  // clickable and relying on a refusal the operator never sees.
  it('keeps Disable disabled when the selected phase has already started', async () => {
    const { getByTestId } = render(PhaseControlMenu, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-implement',
        selectedPhase: 'speckit-plan',
        selectedPhaseState: 'completed',
        isPrimary: true,
        manualPauseAt: null
      }
    });

    expect(getByTestId('phase-control-disable').getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(getByTestId('phase-control-disable'));
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  // FR-R3-151 (US2) — a `selectedPhase` the current tile list can no longer
  // find (for example, a selection stale from before its own deletion)
  // must not present the Delete confirmation as if it were describing the
  // active Phase.
  it('describes a stale selection generically rather than as the active phase', async () => {
    let capturedTitle: string | null = null;
    const { getByTestId } = render(PhaseControlMenu, {
      props: {
        targetsSubjectRun: true,
        queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-plan',
        selectedPhase: 'speckit-implement',
        selectedPhaseState: null,
        activeTaskId: 'task-7',
        isPrimary: true,
        manualPauseAt: null,
        onRequestConfirm: (copy: { title: string }) => {
          capturedTitle = copy.title;
        }
      }
    });

    await fireEvent.click(getByTestId('phase-control-delete'));
    expect(capturedTitle).toBe('Delete phase');
    expect(capturedTitle).not.toBe('Delete active phase');
  });
});

// Lifecycle round-check finding C — retry-now had no operator route at all.
// `CMD_RETRY_PHASE_NOW` was one of thirteen `RunControlCommand` arms and the
// only one dispatched by nothing: FR-R3-140 deleted `PhaseTracker.svelte`, the
// component that used to hold the dispatcher, and `schegent.retryPhaseNow` has
// no palette entry either. The capability behind it — arm the continue gate,
// cancel the pending timer, clear a `retry-cap-exhausted` queue pause — was
// fully built and unreachable.
//
// It lives here rather than in `phase-control.ts` for the reason that module
// already records: `tests/lint/destructive-actions.lint.test.ts` requires the
// `postCommand` to sit in the same scope as the `useConfirm` gating it, and the
// confirm needs the active phase name for its body copy.
describe('PhaseControlMenu — retry now (lifecycle round-check finding C)', () => {
  const waiting = (overrides: Record<string, unknown> = {}) =>
    render(PhaseControlMenu, {
      props: {
        targetsSubjectRun: true,
        queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-implement',
        isPrimary: true,
        manualPauseAt: null,
        isWaitingRetry: true,
        ...overrides
      }
    });

  it('offers the control only while a delayed retry is armed', () => {
    // The host answers `not-pending-retry` when no backoff is running, so a
    // permanently-visible button would be an affordance whose only effect is a
    // rejection toast. It surfaces beside the countdown badge or not at all.
    const { queryByTestId } = render(PhaseControlMenu, {
      props: {
        targetsSubjectRun: true,
        queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-implement',
        isPrimary: true,
        manualPauseAt: null,
        isWaitingRetry: false
      }
    });

    expect(queryByTestId('phase-control-retry-now')).toBeNull();
  });

  it('confirms, then posts the queue-addressed retry-now command', async () => {
    const { getByTestId } = waiting();

    await fireEvent.click(getByTestId('phase-control-retry-now'));

    expect(confirmMock).toHaveBeenCalledWith(
      'run.retry-phase-now',
      expect.objectContaining({ context: { phaseName: 'speckit-implement' } })
    );
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_RETRY_PHASE_NOW, {
      queueId: TEST_QUEUE_ID
    });
  });

  it('posts nothing when the operator declines the confirmation', async () => {
    confirmMock.mockResolvedValue(false);
    const { getByTestId } = waiting();

    await fireEvent.click(getByTestId('phase-control-retry-now'));

    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  it('posts retry-now against the queue named in the confirmation dialog, even if the queue changes before the operator confirms', async () => {
    let resolveConfirm: (value: boolean) => void = () => {};
    confirmMock.mockImplementation(() => new Promise((resolve) => { resolveConfirm = resolve; }));

    const { getByTestId, rerender } = waiting();

    // Deliberately not awaited — inspecting state while `onRetryNow` is still
    // suspended on the not-yet-resolved confirm.
    void fireEvent.click(getByTestId('phase-control-retry-now'));
    await Promise.resolve();

    // The surface re-addresses a different queue while the dialog is open.
    await rerender({
      targetsSubjectRun: true,
      queueId: 'q-beta',
      currentPhase: 'speckit-implement',
      isPrimary: true,
      manualPauseAt: null,
      isWaitingRetry: true
    });

    resolveConfirm(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_RETRY_PHASE_NOW, {
      queueId: TEST_QUEUE_ID
    });
  });

  it('is disabled, and posts nothing, on a run this view is not showing', async () => {
    // `isWaitingRetry` is read off the displayed surface while the command is
    // addressed by `queueId` — the same mismatch every control here guards
    // against. Skipping the guard would let a countdown shown for one Task
    // shortcut the backoff of another.
    const { getByTestId } = waiting({ targetsSubjectRun: false });

    expect(getByTestId('phase-control-retry-now').getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(getByTestId('phase-control-retry-now'));
    expect(confirmMock).not.toHaveBeenCalled();
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  it('is disabled on a secondary window', async () => {
    const { getByTestId } = waiting({ isPrimary: false });

    expect(getByTestId('phase-control-retry-now').getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(getByTestId('phase-control-retry-now'));
    expect(postCommandSpy).not.toHaveBeenCalled();
  });
});

// Off-target phase controls — the surface can be showing one Task's phases
// while the queue it names is executing a different Run. Every control above is
// addressed by `queueId` alone, so on such a surface the command it posts is
// well-formed and names a real Run — the host cannot refuse it, because nothing
// in the payload says which Task the operator was looking at. The refusal has to
// happen here, and `isPrimary` alone was never the whole precondition.
describe('PhaseControlMenu — controls that do not address the displayed run', () => {
  const OFF_TARGET =
    'Unavailable while this view is showing a task other than the run executing on this queue.';

  const offTarget = (overrides: Record<string, unknown> = {}) =>
    render(PhaseControlMenu, {
      props: {
        targetsSubjectRun: false,
        queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-plan',
        // FR-R3-151 — Disable/Enable/Delete now target `selectedPhase`, not
        // `currentPhase`; defaulted here (same id as `currentPhase`) so the
        // off-target assertions below exercise the guard itself rather than
        // an incidental "nothing is selected" state.
        selectedPhase: 'speckit-plan',
        isPrimary: true,
        manualPauseAt: null,
        ...overrides
      }
    });

  it('disables the queue-addressed controls and posts nothing when clicked', async () => {
    const { getByTestId } = offTarget();

    for (const testId of [
      'phase-control-pause',
      'phase-control-restart',
      'phase-control-skip',
      'phase-control-disable'
    ]) {
      expect(getByTestId(testId).getAttribute('aria-disabled')).toBe('true');
      await fireEvent.click(getByTestId(testId));
    }

    // Disabled is not enough on its own — each handler must also return early.
    // A control that greys out but still posts is the same defect wearing a
    // different colour.
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  it('disables Resume on a paused run it is not showing', async () => {
    const { getByTestId } = offTarget({ manualPauseAt: '2026-05-13T00:00:00.000Z' });

    expect(getByTestId('phase-control-resume').getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(getByTestId('phase-control-resume'));
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  it('disables Enable even when the displayed phase carries an override', async () => {
    // `selectedHasOverride` is read off the *displayed* (selected) phase, so
    // without the address guard this control reads as enabled and clears an
    // override on a phase of another Run entirely.
    const { getByTestId } = offTarget({
      phaseOverrides: [{ phaseId: 'speckit-plan', action: 'disabled' as const }]
    });

    expect(getByTestId('phase-control-enable').getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(getByTestId('phase-control-enable'));
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  it('says why, rather than failing closed silently', () => {
    const { getByTestId } = offTarget();

    expect(getByTestId('phase-control-restart').getAttribute('title')).toBe(OFF_TARGET);
    expect(getByTestId('phase-control-skip').getAttribute('title')).toBe(OFF_TARGET);
  });

  it('leaves Delete enabled — it addresses the displayed task, not the queue', async () => {
    // The one control the guard must not touch. It posts the Task id and phase
    // the surface is displaying, so it was correctly addressed before this fix
    // and disabling it would remove a working capability to fix a defect it
    // does not have.
    const { getByTestId } = offTarget({ activeTaskId: 'task-7' });

    expect(getByTestId('phase-control-delete').getAttribute('aria-disabled')).toBe('false');
    expect(getByTestId('phase-control-delete').getAttribute('title')).not.toBe(OFF_TARGET);
  });
});

// FR-R3-151 (T1626) — the target-model rework itself: Disable, Enable, and
// Delete act on the operator-selected tile even when it differs from the
// active Phase, while Pause/Resume/Restart/Skip keep targeting the active
// Phase regardless of what is selected (spec.md FR-010/FR-011, US2).
describe('PhaseControlMenu — selectedPhase targeting (FR-R3-151)', () => {
  it('Disable dispatches the selected future Phase, not the active Phase', async () => {
    const { getByTestId } = render(PhaseControlMenu, {
      props: {
        targetsSubjectRun: true,
        queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-plan',
        selectedPhase: 'speckit-implement',
        selectedPhaseState: 'not-started' as const,
        isPrimary: true,
        manualPauseAt: null
      }
    });

    await fireEvent.click(getByTestId('phase-control-disable'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_DISABLE_PHASE, {
      queueId: TEST_QUEUE_ID,
      phaseId: 'speckit-implement'
    });
  });

  it('Enable dispatches the selected Phase carrying a disabled override, not the active Phase', async () => {
    const { getByTestId } = render(PhaseControlMenu, {
      props: {
        targetsSubjectRun: true,
        queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-plan',
        selectedPhase: 'speckit-implement',
        selectedPhaseState: 'disabled' as const,
        isPrimary: true,
        manualPauseAt: null,
        phaseOverrides: [{ phaseId: 'speckit-implement', action: 'disabled' as const }]
      }
    });

    await fireEvent.click(getByTestId('phase-control-enable'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_ENABLE_PHASE, {
      queueId: TEST_QUEUE_ID,
      phaseId: 'speckit-implement'
    });
  });

  it('Delete dispatches the selected Phase, not the active Phase, once confirmed', async () => {
    let confirmedAction: (() => void) | null = null;
    const { getByTestId } = render(PhaseControlMenu, {
      props: {
        targetsSubjectRun: true,
        queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-plan',
        selectedPhase: 'speckit-specify',
        selectedPhaseState: 'completed' as const,
        activeTaskId: 'task-7',
        isPrimary: true,
        manualPauseAt: null,
        onRequestConfirm: (_copy: unknown, onConfirm: () => void) => {
          confirmedAction = onConfirm;
        }
      }
    });

    await fireEvent.click(getByTestId('phase-control-delete'));
    // Confirmation is requested but not yet acted on — no dispatch until the
    // operator confirms (spec FR-021).
    expect(postCommandSpy).not.toHaveBeenCalled();
    expect(confirmedAction).not.toBeNull();

    confirmedAction!();
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_REMOVE_TASK_PHASE, {
      taskId: 'task-7',
      phaseId: 'speckit-specify',
      confirmed: true
    });
  });

  it('canceling the Delete confirmation dispatches nothing (spec FR-021)', async () => {
    const onRequestConfirm = vi.fn();
    const { getByTestId } = render(PhaseControlMenu, {
      props: {
        targetsSubjectRun: true,
        queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-plan',
        selectedPhase: 'speckit-specify',
        selectedPhaseState: 'completed' as const,
        activeTaskId: 'task-7',
        isPrimary: true,
        manualPauseAt: null,
        onRequestConfirm
      }
    });

    await fireEvent.click(getByTestId('phase-control-delete'));
    // The operator declines (never invokes the callback `onRequestConfirm`
    // was given) — the confirmation surface's own job, out of this
    // component's scope. From this component's side, nothing was dispatched.
    expect(onRequestConfirm).toHaveBeenCalledTimes(1);
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  it('Pause, Resume, Restart, and Skip keep dispatching the active Phase regardless of selectedPhase', async () => {
    const { getByTestId, rerender } = render(PhaseControlMenu, {
      props: {
        targetsSubjectRun: true,
        queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-plan',
        selectedPhase: 'speckit-implement',
        isPrimary: true,
        manualPauseAt: null
      }
    });

    await fireEvent.click(getByTestId('phase-control-pause'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_PAUSE_PHASE, { queueId: TEST_QUEUE_ID });

    await rerender({
      targetsSubjectRun: true,
      queueId: TEST_QUEUE_ID,
      currentPhase: 'speckit-plan',
      selectedPhase: 'speckit-implement',
      isPrimary: true,
      manualPauseAt: '2026-05-13T00:00:00.000Z'
    });
    await fireEvent.click(getByTestId('phase-control-resume'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_RESUME_PHASE, { queueId: TEST_QUEUE_ID });

    await fireEvent.click(getByTestId('phase-control-restart'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_RESTART_PHASE, {
      queueId: TEST_QUEUE_ID,
      phaseId: 'speckit-plan'
    });

    await rerender({
      targetsSubjectRun: true,
      queueId: TEST_QUEUE_ID,
      currentPhase: 'speckit-plan',
      selectedPhase: 'speckit-implement',
      isPrimary: true,
      manualPauseAt: null
    });
    await fireEvent.click(getByTestId('phase-control-skip'));
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_SKIP_PHASE, {
      queueId: TEST_QUEUE_ID,
      phaseId: 'speckit-plan'
    });
  });

  // `$props()` bindings are live: a naive `onSkip` that re-reads `currentPhase`
  // after its `await useConfirm(...)` would dispatch whatever Phase is active
  // by the time the operator clicks Confirm, not the one the dialog named.
  it('dispatches Skip against the Phase and queue named in the confirmation dialog, even if both change before the operator confirms', async () => {
    let resolveConfirm: (value: boolean) => void = () => {};
    confirmMock.mockImplementation(() => new Promise((resolve) => { resolveConfirm = resolve; }));

    const { getByTestId, rerender } = render(PhaseControlMenu, {
      props: {
        targetsSubjectRun: true,
        queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-plan',
        selectedPhase: 'speckit-plan',
        isPrimary: true,
        manualPauseAt: null
      }
    });

    // Deliberately not awaited — the point of this test is to inspect state
    // while `onSkip` is still suspended on the not-yet-resolved confirm.
    void fireEvent.click(getByTestId('phase-control-skip'));
    await Promise.resolve();

    // The Run advances, and the surface re-addresses a different queue,
    // while the confirm dialog is still open.
    await rerender({
      targetsSubjectRun: true,
      queueId: 'q-beta',
      currentPhase: 'speckit-implement',
      selectedPhase: 'speckit-implement',
      isPrimary: true,
      manualPauseAt: null
    });

    resolveConfirm(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_SKIP_PHASE, {
      queueId: TEST_QUEUE_ID,
      phaseId: 'speckit-plan'
    });
  });

  // Same live-binding hazard as above, for Delete: `onConfirm` is invoked
  // whenever the operator acts on the dialog, which can be well after a
  // re-render changed `selectedPhase`/`activeTaskId`.
  it('deletes the Phase and Task named in the confirmation dialog, even if the selection changes before the operator confirms', async () => {
    let confirmedAction: (() => void) | null = null;
    const { getByTestId, rerender } = render(PhaseControlMenu, {
      props: {
        targetsSubjectRun: true,
        queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-plan',
        selectedPhase: 'speckit-specify',
        selectedPhaseState: 'completed' as const,
        activeTaskId: 'task-7',
        isPrimary: true,
        manualPauseAt: null,
        onRequestConfirm: (_copy: unknown, onConfirm: () => void) => {
          confirmedAction = onConfirm;
        }
      }
    });

    await fireEvent.click(getByTestId('phase-control-delete'));
    expect(confirmedAction).not.toBeNull();

    // The operator selects a different tile and task before acting on the
    // still-open confirmation dialog.
    await rerender({
      targetsSubjectRun: true,
      queueId: TEST_QUEUE_ID,
      currentPhase: 'speckit-plan',
      selectedPhase: 'speckit-implement',
      selectedPhaseState: 'not-started' as const,
      activeTaskId: 'task-9',
      isPrimary: true,
      manualPauseAt: null
    });

    confirmedAction!();
    expect(postCommandSpy).toHaveBeenCalledWith(CMD_REMOVE_TASK_PHASE, {
      taskId: 'task-7',
      phaseId: 'speckit-specify',
      confirmed: true
    });
  });
});
