// Feature 089 (T028, US5, FR-029, SC-004) — a second window on the same
// workspace cannot write.
//
// The companion to `untrusted-workspace.test.ts`: same router, same live
// command table, same write recorder, and the same "refused *before* any write"
// claim. Only the closed predicate and the token differ. The two are separate
// files because they qualify separate requirements, and because a single file
// asserting both would let one gate's regression hide behind the other's
// coverage in a summary.

import { describe, expect, it } from 'vitest';
import { MUTATING_COMMAND_TYPES } from '../../../src/contracts/sidebar-command-metadata';
import { CMD_SAVE_PHASES, CMD_START } from '../../../src/ui/sidebar/messages';
import { makeGateProbe, SECONDARY_REJECT, UNTRUSTED_REJECT } from './gate-harness';

const SECONDARY = { isTrusted: () => true, isPrimary: () => false };
const PRIMARY = { isTrusted: () => true, isPrimary: () => true };

describe('a secondary window refuses every mutating command (T028, FR-029)', () => {
  it('has a table to drive — the live mutating set is not empty', () => {
    expect(MUTATING_COMMAND_TYPES.length).toBeGreaterThan(0);
  });

  it.each([...MUTATING_COMMAND_TYPES])('refuses %s before any write', async (type) => {
    const probe = makeGateProbe(SECONDARY);
    const ack = await probe.dispatch(type);

    expect(ack?.status).toBe('rejected');
    expect(ack?.reason).toBe(SECONDARY_REJECT);
    // The requirement is not "the window is told no" — it is that nothing
    // durable moved. Only the recorder can say that.
    expect(probe.writes).toEqual([]);
  });

  it('does not mistake a secondary window for an untrusted one', async () => {
    // The two gates carry distinct tokens because the operator's remedy
    // differs: trust the folder, versus close the other window. A refusal that
    // named the wrong one would send them to the wrong fix.
    const probe = makeGateProbe(SECONDARY);
    const ack = await probe.dispatch(CMD_SAVE_PHASES);

    expect(ack?.reason).toBe(SECONDARY_REJECT);
    expect(ack?.reason).not.toBe(UNTRUSTED_REJECT);
  });

  it('refuses when the primary check throws, not just when it returns false', async () => {
    // A host whose lock probe fails must not be read as "this window holds it".
    const probe = makeGateProbe({
      isTrusted: () => true,
      isPrimary: () => {
        throw new Error('lock probe unavailable');
      }
    });
    const ack = await probe.dispatch(CMD_SAVE_PHASES);

    expect(ack?.reason).toBe(SECONDARY_REJECT);
    expect(probe.writes).toEqual([]);
  });

  it('would have recorded a write had one happened (positive control)', async () => {
    // The same guard as the trust fixture: an unwired recorder is also an empty
    // one, so every assertion above would survive deleting the gate.
    const probe = makeGateProbe(PRIMARY);
    await probe.dispatch(CMD_START, { description: 'probe', pipelineId: null });

    expect(probe.writes).toContain('executeCommand:schegent.enqueue');
  });
});
