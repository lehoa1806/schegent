import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getHostTransport,
  resetHostTransport,
  setHostTransport
} from '../host-transport';
import { createMemoryHostTransport } from '../test-host-transport';
import { CMD_OPEN_DASHBOARD, STATE_SNAPSHOT } from '../messages';
import { onHostMessage, postCommand } from '../vscode-api';

afterEach(() => {
  resetHostTransport();
});

describe('Feature 065 — host transport facade', () => {
  it('routes postCommand envelopes through the configured host transport', () => {
    const transport = createMemoryHostTransport();
    setHostTransport(transport);

    const result = postCommand(CMD_OPEN_DASHBOARD, undefined, {
      correlationId: 'fixed-correlation-id'
    });

    expect(result).toEqual({ correlationId: 'fixed-correlation-id' });
    expect(transport.postedMessages).toEqual([
      {
        type: CMD_OPEN_DASHBOARD,
        correlationId: 'fixed-correlation-id'
      }
    ]);
  });

  it('routes host messages through the configured transport and unsubscribes cleanly', () => {
    const transport = createMemoryHostTransport();
    const handler = vi.fn();
    setHostTransport(transport);

    const unsubscribe = onHostMessage(handler);
    transport.emitHostMessage({ type: STATE_SNAPSHOT, snapshot: { queue: [] } });
    unsubscribe();
    transport.emitHostMessage({ type: STATE_SNAPSHOT, snapshot: { queue: ['ignored'] } });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual({
      type: STATE_SNAPSHOT,
      snapshot: { queue: [] }
    });
  });

  it('exposes host state through the active transport', () => {
    const transport = createMemoryHostTransport({ selectedTab: 'settings' });
    setHostTransport(transport);

    expect(getHostTransport().getState<{ selectedTab: string }>()).toEqual({
      selectedTab: 'settings'
    });

    getHostTransport().setState({ selectedTab: 'activity' });
    expect(transport.getState()).toEqual({ selectedTab: 'activity' });
  });
});
