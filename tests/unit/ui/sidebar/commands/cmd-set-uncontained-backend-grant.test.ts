// FR-R3-144 (T018, D-2) — the `CMD_SET_UNCONTAINED_BACKEND_GRANT` handler.
//
// The task this file discharges is stated as a property rather than a call
// sequence: "a failing unrelated general-settings write does not revoke a grant,
// and vice versa". So the two handlers are exercised against ONE store — the same
// object standing in for `settings.json` — with the real
// `services/uncontained-grant-writer.ts` behind the grant port. Stubbing the port
// would let the isolation be true of the test doubles and false of the product;
// what is asserted below is what the store actually holds after each pair of
// commands.
//
// The general-settings side is a fake, and deliberately a hostile one: it writes
// to the same store, and its failure mode is the batch rejection
// `CMD_SAVE_GENERAL_SETTINGS` really has. If the two writes were ever unified
// behind one port, the first two tests in the "isolation" block fail — which is
// the point of writing them as store assertions rather than as
// `expect(port).not.toHaveBeenCalled()`.

import { describe, it, expect, vi } from 'vitest';

import { handler as setGrantHandler } from '../../../../../src/ui/sidebar/commands/cmd-set-uncontained-backend-grant';
import { handler as saveGeneralSettingsHandler } from '../../../../../src/ui/sidebar/commands/cmd-save-general-settings';
import { setUncontainedGrant } from '../../../../../src/services/uncontained-grant-writer';
import { ALLOW_UNCONTAINED_SETTING } from '../../../../../src/services/backend-containment-policy';
import {
  CMD_SET_UNCONTAINED_BACKEND_GRANT,
  CMD_SAVE_GENERAL_SETTINGS
} from '../../../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  SetUncontainedBackendGrantCommand,
  SaveGeneralSettingsCommand
} from '../../../../../src/contracts/sidebar-ipc';
import type { BackendRunnerKind } from '../../../../../src/contracts/backend-kinds';

const VERBOSE_KEY = 'schegent.logging.verbose';

/**
 * One store, two writers, and a switch that makes the general-settings writer
 * fail the way a rejected draft field does.
 */
function buildHarness(
  opts: {
    initialGrants?: unknown;
    grantWriteRejects?: unknown;
    generalSettingsRejects?: string;
    omitGrantPort?: boolean;
  } = {}
) {
  const store: Record<string, unknown> = {
    [ALLOW_UNCONTAINED_SETTING]: opts.initialGrants ?? [],
    [VERBOSE_KEY]: false
  };
  const acks: CommandAckMessage[] = [];
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    sanitize: (s: string) => s
  };

  const config = {
    get: <T,>(key: string): T | undefined => store[key] as T | undefined,
    update: async (key: string, value: unknown): Promise<void> => {
      if (opts.grantWriteRejects !== undefined) throw opts.grantWriteRejects;
      store[key] = value;
    }
  };

  const writeGeneralSettings = vi.fn(
    async (updates: Readonly<Record<string, unknown>>) => {
      if (opts.generalSettingsRejects !== undefined) {
        // The real batch save writes nothing when a field is rejected. Nothing
        // in this store moves — including, crucially, the grant list.
        return { ok: false as const, reason: opts.generalSettingsRejects };
      }
      for (const [key, value] of Object.entries(updates)) store[key] = value;
      return { ok: true as const };
    }
  );

  const deps: Record<string, unknown> = { logger, writeGeneralSettings };
  if (!opts.omitGrantPort) {
    deps.setUncontainedBackendGrant = (kind: BackendRunnerKind, granted: boolean) =>
      setUncontainedGrant({ config, logger }, kind, granted);
  }

  const ctx = {
    deps,
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'test-grant-1'
  } as unknown as Parameters<typeof setGrantHandler>[0];

  return {
    ctx,
    acks,
    logger,
    writeGeneralSettings,
    grants: (): unknown => store[ALLOW_UNCONTAINED_SETTING],
    verbose: (): unknown => store[VERBOSE_KEY],
    lastAck: (): CommandAckMessage => acks[acks.length - 1]
  };
}

function grantCmd(kind: string, granted: boolean): SetUncontainedBackendGrantCommand {
  return {
    type: CMD_SET_UNCONTAINED_BACKEND_GRANT,
    correlationId: 'test-grant-1',
    payload: { kind, granted }
  } as SetUncontainedBackendGrantCommand;
}

function saveCmd(updates: Record<string, unknown>): SaveGeneralSettingsCommand {
  return {
    type: CMD_SAVE_GENERAL_SETTINGS,
    correlationId: 'test-grant-1',
    payload: { updates }
  } as unknown as SaveGeneralSettingsCommand;
}

describe('FR-R3-144 T018 — the handler reports what the writer decided', () => {
  it('accepts a grant and names the id it moved', async () => {
    const h = buildHarness();

    await setGrantHandler(h.ctx, grantCmd('claude', true));

    expect(h.grants()).toEqual(['claude']);
    expect(h.lastAck()).toEqual({
      type: 'CMD_ACK',
      correlationId: 'test-grant-1',
      status: 'accepted',
      result: { decision: 'granted', kind: 'claude' }
    });
  });

  it('accepts a revoke and reports `denied` — the state that now holds', async () => {
    // `denied` after a revoke is success for that request: the operator asked for
    // the grant to be gone and it is gone. The ack carries the resulting STATE,
    // not a verdict on the request, which is why the same word appears here and
    // when the consent modal is cancelled.
    const h = buildHarness({ initialGrants: ['claude', 'agy'] });

    await setGrantHandler(h.ctx, grantCmd('agy', false));

    expect(h.grants()).toEqual(['claude']);
    expect(h.lastAck().status).toBe('accepted');
    expect(h.lastAck().result).toEqual({ decision: 'denied', kind: 'agy' });
  });

  it('rejects with `write-failed` and the host reason when the setting did not move', async () => {
    const h = buildHarness({ grantWriteRejects: new Error('EROFS: read-only profile') });

    await setGrantHandler(h.ctx, grantCmd('claude', true));

    expect(h.grants()).toEqual([]);
    expect(h.lastAck().status).toBe('rejected');
    expect(h.lastAck().reason).toBe('write-failed');
    expect(h.lastAck().result).toEqual({
      kind: 'claude',
      reason: 'EROFS: read-only profile'
    });
  });

  it('rejects a contained backend with the policy module`s own problem and sentence', async () => {
    // `codex` carries an OS-enforced bound, so this list does not govern it. The
    // ack carries `already-contained` and the message the policy module writes —
    // not a sentence this handler composed, which would be a second statement of
    // a rule it does not own.
    const h = buildHarness();

    await setGrantHandler(h.ctx, grantCmd('codex', true));

    expect(h.grants()).toEqual([]);
    expect(h.lastAck().status).toBe('rejected');
    expect(h.lastAck().reason).toBe('already-contained');
    const result = h.lastAck().result as { kind: string; message: string };
    expect(result.kind).toBe('codex');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('rejects rather than silently accepting when the host wired no port', async () => {
    // A host with no wiring has written nothing. Reporting that as success would
    // leave an operator believing a backend is granted — or revoked — when the
    // setting never moved.
    const h = buildHarness({ omitGrantPort: true });

    await setGrantHandler(h.ctx, grantCmd('claude', true));

    expect(h.grants()).toEqual([]);
    expect(h.lastAck().status).toBe('rejected');
    expect(h.lastAck().reason).toBe('config-ops-unavailable');
  });
});

describe('FR-R3-144 T018 — the grant is not routed through the general-settings save', () => {
  it('a failing general-settings save does not disturb an existing grant', async () => {
    const h = buildHarness({ generalSettingsRejects: 'invalid-value' });

    await setGrantHandler(h.ctx, grantCmd('claude', true));
    expect(h.grants()).toEqual(['claude']);

    await saveGeneralSettingsHandler(h.ctx, saveCmd({ [VERBOSE_KEY]: 'not-a-boolean' }));

    expect(h.lastAck().status).toBe('rejected');
    // The grant is exactly where it was. If these two writes shared a port or a
    // batched draft, the rejected field above would have taken it down with it.
    expect(h.grants()).toEqual(['claude']);
  });

  it('a failing grant write does not disturb the general settings', async () => {
    const h = buildHarness({ grantWriteRejects: new Error('EACCES') });

    await saveGeneralSettingsHandler(h.ctx, saveCmd({ [VERBOSE_KEY]: true }));
    expect(h.lastAck().status).toBe('accepted');
    expect(h.verbose()).toBe(true);

    await setGrantHandler(h.ctx, grantCmd('claude', true));

    expect(h.lastAck().status).toBe('rejected');
    expect(h.lastAck().reason).toBe('write-failed');
    // The saved preference survives the failed grant, and each command's ack
    // named its own outcome. One batched surface could report neither.
    expect(h.verbose()).toBe(true);
  });

  it('never reaches `writeGeneralSettings`, in either direction', async () => {
    // The store assertions above are the load-bearing ones; this is the direct
    // reading of "not routed through", kept because it names the seam a future
    // refactor would cross.
    const h = buildHarness({ initialGrants: ['claude'] });

    await setGrantHandler(h.ctx, grantCmd('agy', true));
    await setGrantHandler(h.ctx, grantCmd('claude', false));

    expect(h.writeGeneralSettings).not.toHaveBeenCalled();
    expect(h.grants()).toEqual(['agy']);
  });
});
