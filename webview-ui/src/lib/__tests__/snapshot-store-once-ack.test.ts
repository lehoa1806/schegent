// FR-R4-F05 (T18; contract I, I3; FR-026) — `onceAck`'s unsubscribe removes only its own listener.
//
// WHY. `onceAck` keeps one listener per correlation id. The intent ledger registers one per
// identity, and a caller that registered, unsubscribed and registered again under the same id
// (a retry that reuses its identity) used to lose the NEW listener: the OLD unsubscribe deleted
// whatever sat under the id, so the retry's outcome had nobody to tell. The unsubscribe now
// checks that the map still holds the listener it was handed.

import { describe, expect, it, vi } from 'vitest';

import { CMD_ACK } from '../messages';
import { snapshotStore } from '../snapshot-store.svelte';

function ack(correlationId: string): void {
  snapshotStore.apply({ type: CMD_ACK, correlationId, status: 'accepted' });
}

describe('snapshotStore.onceAck unsubscribe (T18)', () => {
  it('leaves a newer listener on the same id listening when an older unsubscribe is called', () => {
    const older = vi.fn();
    const newer = vi.fn();
    const unsubscribeOlder = snapshotStore.onceAck('once-ack-shared', older);
    snapshotStore.onceAck('once-ack-shared', newer);

    unsubscribeOlder();
    ack('once-ack-shared');

    expect(older).not.toHaveBeenCalled();
    expect(newer).toHaveBeenCalledTimes(1);
  });

  it('still removes its own listener', () => {
    const only = vi.fn();
    const unsubscribe = snapshotStore.onceAck('once-ack-own', only);

    unsubscribe();
    ack('once-ack-own');

    expect(only).not.toHaveBeenCalled();
  });

  it('calls a listener once and then removes it', () => {
    const once = vi.fn();
    snapshotStore.onceAck('once-ack-once', once);

    ack('once-ack-once');
    ack('once-ack-once');

    expect(once).toHaveBeenCalledTimes(1);
  });
});
