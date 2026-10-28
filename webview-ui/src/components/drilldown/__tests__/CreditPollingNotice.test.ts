// FR-R4-F02 (spec 240, US6; contract W6 G18; TA3; FR-020, FR-021) — the surface for a Run that is
// paused for credits. After 24 hours the host stops polling and leaves the Run paused; this notice
// is the only thing that says no poll is coming, and its Resume is the only way on.
//
// The assertions that carry the contract: `stopped` says "Credit polling stopped" and offers one
// Resume, dispatched through the run-controls helper (`resumePhase`, mocked here); `unreachable`
// says "Status unreachable" and offers nothing; `polling` says nothing. And nothing the snapshot
// carries beyond its state is rendered, because the snapshot carries no status text.
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreditPollingNotice from '../CreditPollingNotice.svelte';
import type { CreditPollingProjection } from '../../../lib/snapshot-types';
import type { LifecycleControlResult } from '../../../lib/lifecycle-control-ipc';

const resumePhaseMock = vi.fn<(queueId: string) => Promise<LifecycleControlResult>>();
vi.mock('../../../lib/phase-control', () => ({
  resumePhase: (queueId: string) => resumePhaseMock(queueId)
}));

const QUEUE_ID = '11111111-2222-4333-8444-555555555555';
const WINDOW_END = 1_700_000_000_000 + 24 * 60 * 60 * 1000;

const projection = (state: CreditPollingProjection['state']): CreditPollingProjection => ({
  state,
  windowEndsAt: WINDOW_END
});

beforeEach(() => {
  resumePhaseMock.mockReset();
  resumePhaseMock.mockResolvedValue({ outcome: 'accepted' });
});

afterEach(() => cleanup());

describe('CreditPollingNotice', () => {
  it('stopped: says "Credit polling stopped" and offers exactly one Resume', () => {
    const { getByTestId, container } = render(CreditPollingNotice, {
      queueId: QUEUE_ID,
      creditPolling: projection('stopped')
    });

    expect(getByTestId(`credit-polling-stopped-${QUEUE_ID}`).textContent).toContain('Credit polling stopped');
    expect(container.querySelectorAll('button')).toHaveLength(1);
    expect(getByTestId(`credit-polling-resume-${QUEUE_ID}`).textContent.trim()).toBe('Resume');
  });

  it('stopped: Resume calls resumePhase with this queue, once', async () => {
    const { getByTestId } = render(CreditPollingNotice, {
      queueId: QUEUE_ID,
      creditPolling: projection('stopped')
    });

    await fireEvent.click(getByTestId(`credit-polling-resume-${QUEUE_ID}`));

    await waitFor(() => expect(resumePhaseMock).toHaveBeenCalledTimes(1));
    expect(resumePhaseMock).toHaveBeenCalledWith(QUEUE_ID);
  });

  it('stopped: shows the host refusal when the resume is refused, and nothing when accepted', async () => {
    resumePhaseMock.mockResolvedValueOnce({ outcome: 'refused', message: 'The run is no longer paused.' });
    const { getByTestId, queryByTestId } = render(CreditPollingNotice, {
      queueId: QUEUE_ID,
      creditPolling: projection('stopped')
    });
    expect(queryByTestId(`credit-polling-refusal-${QUEUE_ID}`)).toBeNull();

    await fireEvent.click(getByTestId(`credit-polling-resume-${QUEUE_ID}`));

    await waitFor(() =>
      expect(getByTestId(`credit-polling-refusal-${QUEUE_ID}`).textContent).toBe('The run is no longer paused.')
    );

    await fireEvent.click(getByTestId(`credit-polling-resume-${QUEUE_ID}`));
    await waitFor(() => expect(queryByTestId(`credit-polling-refusal-${QUEUE_ID}`)).toBeNull());
  });

  it('unreachable: says "Status unreachable" and offers no action', () => {
    const { getByTestId, container, queryByTestId } = render(CreditPollingNotice, {
      queueId: QUEUE_ID,
      creditPolling: projection('unreachable')
    });

    expect(getByTestId(`credit-polling-unreachable-${QUEUE_ID}`).textContent).toContain('Status unreachable');
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(queryByTestId(`credit-polling-stopped-${QUEUE_ID}`)).toBeNull();
  });

  it('polling: renders neither notice', () => {
    const { container } = render(CreditPollingNotice, {
      queueId: QUEUE_ID,
      creditPolling: projection('polling')
    });

    expect(container.textContent.trim()).toBe('');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('renders no text other than its own fixed words, whatever the window end is', () => {
    const { container } = render(CreditPollingNotice, {
      queueId: QUEUE_ID,
      creditPolling: { state: 'stopped', windowEndsAt: 123456789 }
    });

    expect(container.textContent).not.toContain('123456789');
    expect(container.textContent.replace(/\s+/g, ' ').trim()).toBe('Credit polling stopped Resume');
  });
});
