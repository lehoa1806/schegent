// FR-R3-136 (FR-003, FR-005, FR-006, FR-007) — the registration helper.
//
// THE ASSERTION THAT MATTERS MOST is the one about re-reading. A registered VS
// Code command survives its registration and can be invoked at any later time by
// another extension, a task, or the operator — VS Code's Workspace Trust guide
// says so explicitly. So the test that would have caught the original defect is
// not "does it refuse while untrusted" but "does it still refuse after the trust
// value has changed under it", in both directions. That is `re-reads trust on
// every invocation` below.
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` + static imports, following `tests/unit/extension/
// configuration-access.test.ts`. A top-level `await import` also works at
// runtime but does not typecheck under this project's CommonJS test config.
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

import { registerGuardedCommand } from '../../../src/activation/guarded-command-registration';
import {
  MUTATING_COMMAND_IDS,
  MUTATING_COMMAND_ID_LIST,
  READ_ONLY_COMMAND_ID_LIST,
  UnclassifiedCommandError,
  type ExtensionCommandId
} from '../../../src/contracts/entry-point-dispositions';

function harness(trusted: () => boolean) {
  const warnings: string[] = [];
  // `context: … | undefined` and not `context?: …`. A recorder records what the
  // call passed, and "passed no context" is one of the things it can have passed;
  // an optional key would say the recorder sometimes forgets to write the field
  // down, which is a different claim. It also keeps this file off the
  // `exactOptionalPropertyTypes` baseline the FR-R3-110 ratchet pins: under that
  // flag a `Record | undefined` value is not assignable to an optional key, and
  // the ratchet counts a new one as growth (it caught this one at +1).
  const logs: { message: string; context: Record<string, unknown> | undefined }[] = [];
  return {
    warnings,
    logs,
    deps: {
      isWorkspaceTrusted: trusted,
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
      }
    }
  };
}

beforeEach(() => registered.clear());

describe('registerGuardedCommand', () => {
  it('runs a mutating handler when the workspace is trusted', () => {
    const calls: string[] = [];
    const h = harness(() => true);
    registerGuardedCommand(h.deps, 'schegent.enqueue', (arg: string) => {
      calls.push(arg);
      return 'ran';
    });
    expect(registered.get('schegent.enqueue')!('x')).toBe('ran');
    expect(calls).toEqual(['x']);
    expect(h.warnings).toEqual([]);
  });

  it('refuses a mutating handler when the workspace is untrusted', () => {
    const calls: string[] = [];
    const h = harness(() => false);
    registerGuardedCommand(h.deps, 'schegent.enqueue', () => {
      calls.push('ran');
      return 'ran';
    });
    expect(registered.get('schegent.enqueue')!()).toBeUndefined();
    expect(calls, 'the handler must not run').toEqual([]);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('schegent.enqueue');
    expect(h.warnings[0]).toContain('queue enqueue');
  });

  it('records a refusal once, at info, with the reason and no payload', () => {
    const h = harness(() => false);
    registerGuardedCommand(h.deps, 'schegent.auto', (secret: string) => secret);
    registered.get('schegent.auto')!('a-prompt-that-must-not-be-logged');
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]!.context).toEqual({
      commandId: 'schegent.auto',
      reason: 'workflow start',
      refusal: 'workspace-untrusted'
    });
    // CLAUDE.md: never log request payloads. The argument is the operator's
    // prompt text and must not reach a log line.
    expect(JSON.stringify(h.logs)).not.toContain('a-prompt-that-must-not-be-logged');
  });

  it('runs a read-only handler in both trust states, unwrapped', () => {
    for (const trusted of [true, false]) {
      registered.clear();
      const h = harness(() => trusted);
      registerGuardedCommand(h.deps, 'schegent.showAuditLog', () => 'shown');
      expect(registered.get('schegent.showAuditLog')!()).toBe('shown');
      expect(h.warnings).toEqual([]);
      expect(h.logs).toEqual([]);
    }
  });

  it('re-reads trust on every invocation, in both directions', () => {
    // The programmatic-invocation case. A boolean captured at registration would
    // pass the first two assertions and fail the third and fourth.
    let trusted = false;
    const calls: number[] = [];
    const h = harness(() => trusted);
    registerGuardedCommand(h.deps, 'schegent.cancel', () => {
      calls.push(calls.length);
      return 'ran';
    });
    const invoke = registered.get('schegent.cancel')!;

    expect(invoke()).toBeUndefined();
    expect(calls).toEqual([]);

    trusted = true;
    expect(invoke()).toBe('ran');
    expect(calls).toEqual([0]);

    // There is no revoke event in VS Code (spec C1), so this direction is not a
    // scenario the host produces — it is asserted because "re-read, never cache"
    // is the requirement, and a cache that refreshed once would pass the row
    // above while failing this one.
    trusted = false;
    expect(invoke()).toBeUndefined();
    expect(calls).toEqual([0]);
  });

  it('throws at registration for an id with no disposition', () => {
    const h = harness(() => true);
    expect(() =>
      registerGuardedCommand(
        h.deps,
        'schegent.notAThing' as ExtensionCommandId,
        () => undefined
      )
    ).toThrow(UnclassifiedCommandError);
    expect(registered.has('schegent.notAThing'), 'nothing may be registered').toBe(false);
  });

  it('passes every argument through unchanged', () => {
    const seen: unknown[][] = [];
    const h = harness(() => true);
    registerGuardedCommand(h.deps, 'schegent.resumePhase', (...args: unknown[]) => {
      seen.push(args);
      return undefined;
    });
    registered.get('schegent.resumePhase')!('prompt', 'queue-1');
    expect(seen).toEqual([['prompt', 'queue-1']]);
  });
});

// FR-R3-136 (FR-008) — the whole inventory, not a sample.
//
// The rows above prove the helper behaves correctly for the ids they name. These
// two prove it behaves correctly for *every* id, driven off the frozen maps
// rather than a hand-written list — so a command added tomorrow is covered by
// this file the moment it is classified, and a misclassification shows up as a
// failure here rather than as a surprise in a real window.
describe('registerGuardedCommand — over the full inventory', () => {
  it('refuses all twenty-three mutating ids while untrusted, each naming its own reason', () => {
    expect(MUTATING_COMMAND_ID_LIST.length, 'the inventory is empty').toBeGreaterThan(15);
    for (const id of MUTATING_COMMAND_ID_LIST) {
      registered.clear();
      const calls: string[] = [];
      const h = harness(() => false);
      registerGuardedCommand(h.deps, id, () => {
        calls.push('ran');
        return 'ran';
      });
      expect(registered.get(id), `${id} was not registered`).toBeTypeOf('function');
      expect(registered.get(id)!(), `${id} returned a value`).toBeUndefined();
      expect(calls, `${id} ran its handler while untrusted`).toEqual([]);
      expect(h.warnings, `${id} refused silently`).toHaveLength(1);
      // The reason is this id's own, not a generic string — which is what makes
      // the refusal actionable rather than just correct.
      expect(h.warnings[0], `${id} did not name its reason`).toContain(
        MUTATING_COMMAND_IDS[id]
      );
      expect(h.logs, `${id} did not record the refusal`).toHaveLength(1);
    }
  });

  it('runs all seven read-only ids while untrusted', () => {
    // The other half of the boundary. Refusing these would be a regression the
    // manifest's `limited` claim promises against, and it would look like safety.
    expect(READ_ONLY_COMMAND_ID_LIST.length).toBeGreaterThan(3);
    for (const id of READ_ONLY_COMMAND_ID_LIST) {
      registered.clear();
      const h = harness(() => false);
      registerGuardedCommand(h.deps, id, () => 'ran');
      expect(registered.get(id)!(), `${id} was refused`).toBe('ran');
      expect(h.warnings, `${id} warned`).toEqual([]);
    }
  });
});
