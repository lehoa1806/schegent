// FR-R4-F03 (FR-011; contract T15, O3; TA8, TA9) — the owner-only palette commands.
//
// WHAT THIS PINS. A command that would start or record work writes audit evidence, and only the
// window that owns the workspace may write it. `registerGuardedCommand` checks Workspace Trust first
// (unchanged), then asks whether this window is the owner, and refuses with the palette wording the
// queue commands already use, before the handler runs, so nothing starts and nothing is recorded.
// The check is asynchronous (`lock.hasPrimacy()` reads the fenced record), so an owner-only
// registration answers with a promise, and a throw from the predicate counts as "not the owner"
// (fail closed, like `isWindowPrimary`).
//
// THE LIST IS ITERATED, NOT RESTATED. Every id of `OWNER_ONLY_COMMAND_IDS` is held to the same
// rows, so the ninth id (the checkpoint reset, TA9) is covered by construction when it arrives, and
// a mutation that drops one id from the set shows up here as a missing row.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { registered } = vi.hoisted(() => ({
  registered: new Map<string, (...args: unknown[]) => unknown>()
}));

vi.mock('vscode', () => ({
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      registered.set(id, handler);
      return { dispose: () => undefined };
    }
  }
}));

import {
  registerGuardedCommand,
  type GuardedCommandDeps
} from '../../../src/activation/guarded-command-registration';
import {
  MUTATING_COMMAND_IDS,
  OWNER_ONLY_COMMAND_IDS,
  type ExtensionCommandId
} from '../../../src/contracts/entry-point-dispositions';

const PALETTE_REFUSAL = 'Schegent: another window holds the workspace lock; ignoring request.';
const REFUSED_LOG = 'command refused: not the owner window';
const OWNER_ONLY_IDS = Object.keys(OWNER_ONLY_COMMAND_IDS) as ExtensionCommandId[];

/**
 * The eight commands data-model §9 names for the first release of this set. The ninth, the
 * checkpoint reset, joins later (TA9) and is covered by the iteration below. Each of these is
 * required by name, so dropping any one of them fails here instead of silently shrinking the rows.
 */
const NAMED_BY_THE_PLAN: readonly ExtensionCommandId[] = [
  'schegent.startQueue',
  'schegent.restartCanceledTask',
  'schegent.cancel',
  'schegent.reset',
  'schegent.pausePhase',
  'schegent.resumePhase',
  'schegent.restartPhase',
  'schegent.deleteRunEvidence'
];

function harness(options: { trusted: boolean; isOwner?: () => Promise<boolean> }) {
  const warnings: string[] = [];
  const logs: { message: string; context: Record<string, unknown> | undefined }[] = [];
  const deps: GuardedCommandDeps = {
    isWorkspaceTrusted: () => options.trusted,
    notifier: {
      warn: (message: string) => {
        warnings.push(message);
        return undefined;
      }
    },
    logger: {
      info: (message: string, context?: Record<string, unknown>) => {
        logs.push({ message, context });
      }
    },
    ...(options.isOwner === undefined ? {} : { isOwner: options.isOwner })
  };
  return { warnings, logs, deps };
}

beforeEach(() => registered.clear());

describe('the owner-only commands refuse in a window that is not the owner', () => {
  it('has the commands the plan names, and each is a mutating command', () => {
    for (const id of NAMED_BY_THE_PLAN) {
      expect(OWNER_ONLY_IDS, `${id} must be owner-only`).toContain(id);
    }
    for (const id of OWNER_ONLY_IDS) {
      expect(
        Object.prototype.hasOwnProperty.call(MUTATING_COMMAND_IDS, id),
        `${id} must also be classified mutating`
      ).toBe(true);
    }
  });

  it.each(OWNER_ONLY_IDS)('%s: a non-owner window runs nothing, says why once, and logs the id', async (id) => {
    const ran: string[] = [];
    const h = harness({ trusted: true, isOwner: async () => false });
    registerGuardedCommand(h.deps, id, () => {
      ran.push(id);
      return 'ran';
    });

    expect(await registered.get(id)!('an-argument-that-must-not-be-logged')).toBeUndefined();

    expect(ran, 'the handler must not run').toEqual([]);
    expect(h.warnings).toEqual([PALETTE_REFUSAL]);
    expect(h.logs).toEqual([{ message: REFUSED_LOG, context: { commandId: id } }]);
    expect(JSON.stringify(h.logs)).not.toContain('an-argument-that-must-not-be-logged');
  });

  it.each(OWNER_ONLY_IDS)('%s: the owner window runs the handler once', async (id) => {
    const ran: string[] = [];
    const h = harness({ trusted: true, isOwner: async () => true });
    registerGuardedCommand(h.deps, id, () => {
      ran.push(id);
      return 'ran';
    });

    expect(await registered.get(id)!()).toBe('ran');

    expect(ran).toEqual([id]);
    expect(h.warnings).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  it.each(OWNER_ONLY_IDS)('%s: untrusted, the trust refusal comes first and ownership is never asked', async (id) => {
    let asked = 0;
    const ran: string[] = [];
    const h = harness({
      trusted: false,
      isOwner: async () => {
        asked += 1;
        return true;
      }
    });
    registerGuardedCommand(h.deps, id, () => {
      ran.push(id);
      return 'ran';
    });

    expect(await registered.get(id)!()).toBeUndefined();

    expect(asked).toBe(0);
    expect(ran).toEqual([]);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).not.toBe(PALETTE_REFUSAL);
    expect(h.logs.map((entry) => entry.message)).toEqual(['command refused: workspace not trusted']);
  });

  it('counts a predicate that throws as not the owner', async () => {
    const id = OWNER_ONLY_IDS[0] as ExtensionCommandId;
    const ran: string[] = [];
    const h = harness({
      trusted: true,
      isOwner: async () => {
        throw new Error('ownership record unreadable');
      }
    });
    registerGuardedCommand(h.deps, id, () => {
      ran.push(id);
    });

    expect(await registered.get(id)!()).toBeUndefined();

    expect(ran).toEqual([]);
    expect(h.warnings).toEqual([PALETTE_REFUSAL]);
  });

  it('throws at registration when an owner-only id is registered without a predicate', () => {
    for (const id of OWNER_ONLY_IDS) {
      const h = harness({ trusted: true });
      expect(() => registerGuardedCommand(h.deps, id, () => undefined), id).toThrow(/owner/i);
      expect(registered.has(id), 'nothing is registered for it').toBe(false);
    }
  });

  it('leaves a mutating command that is not owner-only exactly as it was', () => {
    const h = harness({ trusted: true });
    registerGuardedCommand(h.deps, 'schegent.enqueue', () => 'ran');
    expect(registered.get('schegent.enqueue')!()).toBe('ran');
  });
});
