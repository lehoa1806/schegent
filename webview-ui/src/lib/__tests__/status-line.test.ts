import { afterEach, describe, expect, it } from 'vitest';

import { STATUS_LINE_READY, statusLine } from '../status-line.svelte';

describe('status line', () => {
  afterEach(() => {
    statusLine.announce(STATUS_LINE_READY);
  });

  it('reads "Ready." until something is announced', () => {
    expect(statusLine.message).toBe('Ready.');
  });

  it('shows the latest announcement only', () => {
    statusLine.announce('Showing History.');
    statusLine.announce('Showing Metrics.');
    expect(statusLine.message).toBe('Showing Metrics.');
  });
});
