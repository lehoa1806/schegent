import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import PhaseControlMenu from '../PhaseControlMenu.svelte';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import {
  CMD_ACK,
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

// FR-R3-154 (T1646) — the stub returns a `correlationId` because the real
// `postCommand` does, and Pause/Resume/Restart/Retry-now now read it: they
// await the ACK instead of dropping it. A bare `vi.fn()` used to be harmless
// here for the same reason the defect was invisible in production — nothing
// looked at the return value. It is not harmless now: `.correlationId` off
// `undefined` throws inside the click handler, which surfaces as an unhandled
// rejection (`vitest run` exits 1 on it) while every assertion below still
// passes, because they all assert on the post that already happened.
let nextCorrelationId = 0;
const postCommandSpy = vi.fn((..._args: readonly unknown[]) => ({
  correlationId: `corr-${++nextCorrelationId}`
}));
vi.mock('../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args)
}));

/**
 * Answer the post at `callIndex` the way the host would, through the real
 * store's real message entry point.
 *
 * `snapshotStore.apply({type: CMD_ACK, …})` rather than a mocked IPC module,
 * following `QueueConfigModal.test.ts`: it runs the store's own `applyAck`, the
 * real `correlatedLifecycle`, and the real refusal table, so the rendered
 * sentence is the one an operator would see. Mocking the IPC module would make
 * these cases assert the mock.
 */
function ack(
  callIndex: number,
  status: 'accepted' | 'rejected',
  reason?: string,
  outcome?: 'accepted' | 'no-op' | 'refused' | 'failed'
): void {
  const result = postCommandSpy.mock.results[callIndex];
  expect(result, `no post at index ${callIndex}`).toBeDefined();
  const { correlationId } = result!.value as { correlationId: string };
  snapshotStore.apply({
    type: CMD_ACK,
    correlationId,
    status,
    ...(reason !== undefined ? { reason } : {}),
    ...(outcome !== undefined ? { outcome } : {})
  } as never);
}

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

  // FR-R3-154 (T1646) — the four lifecycle controls in this menu report what
  // the host answered. Before this change all four posted and returned: a
  // refusal `decidePhaseControl` had always been able to answer arrived, the
  // store cleared the pending flag, and the operator saw a menu that had
  // apparently done as asked. The negative control for this block is the
  // absence assertion in the last case — a component that renders its message
  // element unconditionally would pass the three above it.
  describe('reports the host answer', () => {
    function menu() {
      return render(PhaseControlMenu, {
        props: {
          targetsSubjectRun: true,
          queueId: TEST_QUEUE_ID,
          currentPhase: 'speckit-plan',
          selectedPhase: 'speckit-plan',
          isPrimary: true,
          manualPauseAt: null
        }
      });
    }

    it('renders a refused pause as a sentence, not a reason code', async () => {
      const { getByTestId, queryByTestId } = menu();
      await fireEvent.click(getByTestId('phase-control-pause'));
      expect(queryByTestId('phase-control-message')).toBeNull();

      ack(0, 'rejected', 'run-already-paused', 'refused');
      await waitFor(() => {
        expect(getByTestId('phase-control-message').textContent).toBe('This Run is already paused.');
      });
      // The code itself never reaches the operator — that is the failure the
      // sibling `queue-control-ipc` table shipped for a release.
      expect(getByTestId('phase-control-message').textContent).not.toContain('run-already-paused');
    });

    it('renders a refused restart of a finished Run', async () => {
      const { getByTestId } = menu();
      await fireEvent.click(getByTestId('phase-control-restart'));
      ack(0, 'rejected', 'run-terminal', 'refused');
      await waitFor(() => {
        expect(getByTestId('phase-control-message').textContent).toBe(
          'This Run has already finished, so its phases can no longer be changed.'
        );
      });
    });

    it('says nothing when the host accepts', async () => {
      const { getByTestId, queryByTestId } = menu();
      await fireEvent.click(getByTestId('phase-control-pause'));
      ack(0, 'accepted', undefined, 'accepted');
      // Nothing to tell the operator: the phase state they can already see is
      // the report. A message on the happy path would train them to ignore it.
      await waitFor(() => expect(postCommandSpy).toHaveBeenCalledTimes(1));
      expect(queryByTestId('phase-control-message')).toBeNull();
    });

    it('clears the previous refusal when the control is used again', async () => {
      const { getByTestId, queryByTestId } = menu();
      await fireEvent.click(getByTestId('phase-control-pause'));
      ack(0, 'rejected', 'run-already-paused', 'refused');
      await waitFor(() => expect(getByTestId('phase-control-message')).toBeTruthy());

      await fireEvent.click(getByTestId('phase-control-pause'));
      // Cleared on dispatch, not left standing until the next answer: a stale
      // refusal beside a control that is now working is a lie in the other
      // direction.
      expect(queryByTestId('phase-control-message')).toBeNull();
      ack(1, 'accepted', undefined, 'accepted');
      await waitFor(() => expect(postCommandSpy).toHaveBeenCalledTimes(2));
      expect(queryByTestId('phase-control-message')).toBeNull();
    });

    // Code-review finding (iteration 5). The case above uses the SAME control
    // twice, which is the only shape the clear used to cover: `controlMessage`
    // was reset by the four handlers that can write it and by nobody else. Six
    // controls dispatch without reporting — Skip, Disable, Enable, Delete and
    // the two breakpoint actions — so a refusal from one of the four stayed on
    // screen, in a `role="alert"`, beside whichever of the six the operator
    // used next and which had just committed.
    it('clears a previous control’s refusal when a non-reporting control dispatches', async () => {
      const { getByTestId, queryByTestId } = render(PhaseControlMenu, {
        props: {
          targetsSubjectRun: true,
          queueId: TEST_QUEUE_ID,
          currentPhase: 'speckit-plan',
          // A future, no-override selection, so Disable is eligible at the same
          // time Pause is — the two-control sequence needs both live at once.
          selectedPhase: 'speckit-implement',
          selectedPhaseState: 'not-started' as const,
          isPrimary: true,
          manualPauseAt: null
        }
      });

      await fireEvent.click(getByTestId('phase-control-pause'));
      ack(0, 'rejected', 'run-already-paused', 'refused');
      await waitFor(() => expect(getByTestId('phase-control-message')).toBeTruthy());

      await fireEvent.click(getByTestId('phase-control-disable'));
      expect(postCommandSpy).toHaveBeenCalledWith(CMD_DISABLE_PHASE, {
        queueId: TEST_QUEUE_ID,
        phaseId: 'speckit-implement'
      });
      // Disable cannot write this line; it must still not leave Pause's answer
      // attributed to it.
      expect(queryByTestId('phase-control-message')).toBeNull();
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
    // Feature 201 — `currentPhase` moved off the selection and
    // `selectedPhaseIsFuture: true` was added. The fixture previously selected
    // the Phase the runner was standing on, which the host's own
    // `isPhaseFuture` calls not-future, so it described a situation in which
    // Enable would have been refused. The assertion is unchanged; the inputs
    // now describe a case the host would accept.
    const { getByTestId } = render(PhaseControlMenu, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-specify',
        selectedPhase: 'speckit-plan',
        selectedPhaseState: 'disabled',
        selectedPhaseIsFuture: true,
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

  // FR-R3-154 (T1646) — retry-now's post stays in the component beside its
  // confirm (the destructive-actions lint requires the two to share a brace
  // block), so it hands the post to `correlatedLifecycle` as a callback rather
  // than moving into `phase-control.ts`. This case pins that the callback form
  // reports its answer too — `already-retrying` and `not-pending-retry` are
  // both refusals `applyManualRetryOverride` answers for a race the operator
  // cannot see, and this was the control most likely to hit one.
  it('renders the refusal when the host declines the retry', async () => {
    const { getByTestId } = waiting();

    await fireEvent.click(getByTestId('phase-control-retry-now'));
    await waitFor(() => expect(postCommandSpy).toHaveBeenCalledTimes(1));
    ack(0, 'rejected', 'already-retrying', 'refused');

    await waitFor(() => {
      expect(getByTestId('phase-control-message').textContent).toBe(
        'A retry is already under way.'
      );
    });
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
        selectedPhaseIsFuture: true,
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

  // Feature 201 (FR-006, FR-007, FR-035) — the other origin of `disabled`, at
  // the component boundary. The lib test pins the predicate; this pins the
  // wiring, which is a separate failure: a component that never passes the prop
  // through would keep the lib test green and still offer a refused control.
  it('withholds Enable for a disabled Phase the runner already bypassed', async () => {
    const { getByTestId } = render(PhaseControlMenu, {
      props: {
        targetsSubjectRun: true,
        queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-implement',
        selectedPhase: 'speckit-plan',
        selectedPhaseState: 'disabled' as const,
        selectedPhaseIsFuture: false,
        isPrimary: true,
        manualPauseAt: null,
        phaseOverrides: [{ phaseId: 'speckit-plan', action: 'disabled' as const }]
      }
    });

    expect(getByTestId('phase-control-enable').getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(getByTestId('phase-control-enable'));
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  // The prop is optional, so a caller that has not been updated omits it. That
  // must withhold the control rather than offer one the host refuses — the
  // `false` default is the component-boundary half of FR-035's fail-closed
  // rule, and this is the case that would notice if the default were flipped.
  it('withholds Enable when the caller supplies no futureness at all', async () => {
    const { getByTestId } = render(PhaseControlMenu, {
      props: {
        targetsSubjectRun: true,
        queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-specify',
        selectedPhase: 'speckit-plan',
        selectedPhaseState: 'disabled' as const,
        isPrimary: true,
        manualPauseAt: null,
        phaseOverrides: [{ phaseId: 'speckit-plan', action: 'disabled' as const }]
      }
    });

    expect(getByTestId('phase-control-enable').getAttribute('aria-disabled')).toBe('true');
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
