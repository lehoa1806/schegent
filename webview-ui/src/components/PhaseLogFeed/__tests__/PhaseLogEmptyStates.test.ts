// Feature 020 T022 — PhaseLogEmptyStates: no-log card vs.
// verbose-off guidance card; "Open Settings" button posts via the
// shared helper (no inline `postCommand`).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import PhaseLogEmptyStates from '../PhaseLogEmptyStates.svelte';
import type { VerboseDiagnosticsBanner } from '../../../../../src/services/phase-log/types';

const openVerboseSettingSpy = vi.fn();
vi.mock('../../../lib/phase-log-ipc', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/phase-log-ipc')>(
    '../../../lib/phase-log-ipc'
  );
  return {
    ...actual,
    openVerboseSetting: (...args: unknown[]) => openVerboseSettingSpy(...args)
  };
});

afterEach(() => {
  cleanup();
  openVerboseSettingSpy.mockReset();
});

describe('Feature 020 T022 — PhaseLogEmptyStates', () => {
  it('renders the no-log card when banner.kind === enabled-no-sessions-for-tuple', () => {
    const banner: VerboseDiagnosticsBanner = { kind: 'enabled-no-sessions-for-tuple' };
    const { getByTestId, queryByTestId } = render(PhaseLogEmptyStates, {
      props: { banner }
    });
    expect(getByTestId('phase-log-empty-no-log')).toBeTruthy();
    expect(queryByTestId('phase-log-empty-disabled')).toBeNull();
    expect(queryByTestId('phase-log-empty-open-settings')).toBeNull();
  });

  it('renders the disabled-no-sessions guidance card with "Open Settings" CTA', () => {
    const banner: VerboseDiagnosticsBanner = {
      kind: 'disabled-no-sessions',
      settingKey: 'schegent.logging.verbose'
    };
    const { getByTestId, queryByTestId } = render(PhaseLogEmptyStates, {
      props: { banner }
    });
    expect(getByTestId('phase-log-empty-disabled')).toBeTruthy();
    expect(getByTestId('phase-log-empty-open-settings')).toBeTruthy();
    expect(queryByTestId('phase-log-empty-no-log')).toBeNull();
  });

  it('calls the shared phase-log-ipc.openVerboseSetting helper on Open Settings click', async () => {
    const banner: VerboseDiagnosticsBanner = {
      kind: 'disabled-no-sessions',
      settingKey: 'schegent.logging.verbose'
    };
    const { getByTestId } = render(PhaseLogEmptyStates, {
      props: { banner }
    });
    await fireEvent.click(getByTestId('phase-log-empty-open-settings'));
    expect(openVerboseSettingSpy).toHaveBeenCalledTimes(1);
  });

  it('renders no empty card when banner.kind === enabled-with-sessions', () => {
    const banner: VerboseDiagnosticsBanner = { kind: 'enabled-with-sessions' };
    const { queryByTestId } = render(PhaseLogEmptyStates, {
      props: { banner }
    });
    expect(queryByTestId('phase-log-empty-no-log')).toBeNull();
    expect(queryByTestId('phase-log-empty-disabled')).toBeNull();
  });
});

// Bug "the phase log that asked for a phase named done" (2026-09-02), second
// finding — the hole between two components that each defer to the other.
//
// Both cards above are driven by `banner`, and the host only sends a banner in
// answer to a COMPLETE tuple. A selection that names a task but no phase reads
// nothing, so `banner` stays null, so this component renders nothing — while
// `PhaseLogReadingPane` renders nothing of its own on zero entries and says so
// in a comment: "the empty-state guidance can sit in its place." Neither side
// is wrong on its own; between them the operator gets a blank pane.
//
// That state is reachable and normal: `RunDetailTier` pins a settled Run with
// `phaseId: null` by design (pinning is what keeps the workspace-wide cold-start
// fallback from redirecting the tier at another queue's task), and the Activity
// Feed reaches it whenever a task is picked without a phase.
describe('no phase selected — the third empty state', () => {
  it('names the action when a task is selected but no phase is', () => {
    const { getByTestId } = render(PhaseLogEmptyStates, {
      props: { banner: null, noPhaseSelected: true }
    });
    const card = getByTestId('phase-log-empty-no-phase');
    expect(card).toBeTruthy();
    // The card has to say what to do, not merely that nothing is here. The
    // phase strip is already on screen beside it; the gap was that nothing
    // connected the blank pane to it.
    expect(card.textContent).toMatch(/phase/i);
  });

  it('does not render when a phase IS selected and the host simply sent no banner', () => {
    // The pre-existing pass-through: a complete tuple that is still loading has
    // a null banner too, and must keep showing the reading pane rather than
    // telling the operator to pick something they have already picked.
    const { queryByTestId } = render(PhaseLogEmptyStates, {
      props: { banner: null, noPhaseSelected: false }
    });
    expect(queryByTestId('phase-log-empty-no-phase')).toBeNull();
  });

  it('defaults to off, so every existing caller renders exactly as before', () => {
    const { queryByTestId } = render(PhaseLogEmptyStates, {
      props: { banner: null }
    });
    expect(queryByTestId('phase-log-empty-no-phase')).toBeNull();
  });

  it('wins over a stale banner, because the tuple it described is gone', () => {
    // Deselecting a phase can leave the previous tuple's banner in state for a
    // frame. "Pick a phase" is true then; "no log for this phase yet" is not,
    // because there is no this-phase.
    const banner: VerboseDiagnosticsBanner = { kind: 'enabled-no-sessions-for-tuple' };
    const { getByTestId, queryByTestId } = render(PhaseLogEmptyStates, {
      props: { banner, noPhaseSelected: true }
    });
    expect(getByTestId('phase-log-empty-no-phase')).toBeTruthy();
    expect(queryByTestId('phase-log-empty-no-log')).toBeNull();
  });
});
