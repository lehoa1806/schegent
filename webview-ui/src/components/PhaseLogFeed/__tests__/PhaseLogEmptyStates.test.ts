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
