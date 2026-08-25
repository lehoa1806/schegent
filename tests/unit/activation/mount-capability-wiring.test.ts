import { beforeEach, describe, expect, it } from 'vitest';
import {
  reportMountCapability,
  resetMountCapabilityWarnings,
  type MountCapabilityNotifier
} from '../../../src/activation/mount-capability-wiring';
import type { MountCapabilityVerdict } from '../../../src/state/mount-capability';

/**
 * FR-R3-083 — the surface, which is a decision and not a detail.
 *
 * `FR-R3-083` §5: "a probe that finds an unsupported mount and continues quietly
 * is worse than no probe". A log line in an output channel nobody has open is
 * quiet, so `unsupported` notifies. `undetermined` does not, because notifying on
 * a non-finding is how an operator learns to dismiss the notification that
 * matters.
 */
interface Recorded {
  readonly level: 'info' | 'warn';
  readonly message: string;
}

function harness(): {
  readonly lines: Recorded[];
  readonly notifications: string[];
  readonly logger: { info(m: string): void; warn(m: string): void };
  readonly notifier: MountCapabilityNotifier;
} {
  const lines: Recorded[] = [];
  const notifications: string[] = [];
  return {
    lines,
    notifications,
    logger: {
      info: (message: string) => void lines.push({ level: 'info', message }),
      warn: (message: string) => void lines.push({ level: 'warn', message })
    },
    notifier: { warn: (m: string) => void notifications.push(m) }
  };
}

const ROOT = '/private/tmp/some-workspace-root';

function report(verdict: MountCapabilityVerdict, root = ROOT): ReturnType<typeof harness> {
  const h = harness();
  reportMountCapability(verdict, root, h.logger, h.notifier);
  return h;
}

beforeEach(() => resetMountCapabilityWarnings());

describe('mount capability reporting (FR-R3-083)', () => {
  it('notifies the operator when the mount cannot arbitrate', () => {
    const h = report({ capability: 'unsupported', cause: 'second-exclusive-create-succeeded' });
    expect(h.notifications).toHaveLength(1);
    // The three things FR-009 requires: condition, consequence, remedy.
    expect(h.notifications[0]).toContain('exclusive creation');
    expect(h.notifications[0]).toContain('primary');
    expect(h.notifications[0]).toMatch(/Move the workspace|single window/);
    expect(h.lines.some((l) => l.level === 'warn')).toBe(true);
  });

  it('does NOT notify on an undetermined result', () => {
    // The asymmetry is the design. A notification for a non-finding trains the
    // operator to dismiss this notification, and the one that matters then arrives
    // looking identical to the four that did not.
    const h = report({ capability: 'undetermined', cause: 'probe-timed-out' });
    expect(h.notifications).toEqual([]);
    expect(h.lines.some((l) => l.level === 'warn' && /UNDETERMINED/.test(l.message))).toBe(true);
  });

  it('does not report a read-only checkout as a broken mount', () => {
    const h = report({ capability: 'read-only', cause: 'read-only-workspace', errno: 'EROFS' });
    expect(h.notifications).toEqual([]);
    expect(h.lines[0].message).toContain('read-only');
    expect(h.lines[0].message).not.toContain('UNSUPPORTED');
  });

  it('keeps the three reported outcomes distinguishable in the log', () => {
    // SC-004. A reader of the log must be able to tell which of the three answers
    // was reached, without inferring it from what is absent.
    const messages = [
      report({ capability: 'supported', cause: 'exclusive-create-holds' }),
      (resetMountCapabilityWarnings(), report({ capability: 'unsupported', cause: 'exclusive-create-unsupported', errno: 'ENOTSUP' })),
      (resetMountCapabilityWarnings(), report({ capability: 'undetermined', cause: 'probe-timed-out' }))
    ].map((h) => h.lines[0].message);
    expect(new Set(messages).size).toBe(3);
  });

  it('never puts the workspace root in an operator-visible message', () => {
    // FR-015. The standing rule against serializing workspace roots applies to
    // anything an operator might copy out of a log or a notification, and the
    // operator already knows which workspace they opened.
    const h = report({ capability: 'unsupported', cause: 'exclusive-create-unsupported', errno: 'ENOTSUP' });
    for (const text of [...h.notifications, ...h.lines.map((l) => l.message)]) {
      expect(text).not.toContain(ROOT);
      expect(text).not.toContain('some-workspace-root');
    }
  });

  it('warns once per workspace root, not once per window', async () => {
    // FR-012, matching `warnIfEnvironmentIsUnrestricted`. Keyed by root rather than
    // a boolean so a window that adds a folder can warn about the new one.
    //
    // The `await` is load-bearing, and so is the reason for it: the root is marked
    // notified only when the notifier's `Thenable` RESOLVES. Marking synchronously
    // recorded an attempt rather than a delivery, so a rejection -- the shape VS Code
    // produces while the host is disposing, which is exactly this verdict's window --
    // burned the one notification for that root for the life of the extension host.
    //
    // The cost of the async mark is a window of one microtask in which two verdicts
    // for the same root would both notify. A second verdict requires stage 2 to be
    // re-wired, which is not same-tick, so the window is not reachable in practice.
    const verdict: MountCapabilityVerdict = { capability: 'unsupported', cause: 'exclusive-create-unsupported' };
    const first = report(verdict, '/a');
    await Promise.resolve();
    const again = report(verdict, '/a');
    await Promise.resolve();
    const other = report(verdict, '/b');
    await Promise.resolve();
    expect(first.notifications).toHaveLength(1);
    expect(again.notifications).toEqual([]);
    expect(other.notifications).toHaveLength(1);
  });

  it('does NOT mark the root when the notification is rejected', async () => {
    // The failure the delivery-not-attempt rule exists for. A rejected warn must
    // leave the root unmarked, so the next verdict for it can still reach the
    // operator.
    resetMountCapabilityWarnings();
    const verdict: MountCapabilityVerdict = { capability: 'unsupported', cause: 'exclusive-create-unsupported' };
    const rejecting = harness();
    reportMountCapability(
      verdict,
      '/c',
      rejecting.logger,
      { warn: () => Promise.reject(new Error('host disposing')) }
    );
    await Promise.resolve();
    await Promise.resolve();
    const retry = report(verdict, '/c');
    await Promise.resolve();
    expect(retry.notifications).toHaveLength(1);
  });

  it('preserves the deciding errno in the log line', () => {
    const h = report({ capability: 'unsupported', cause: 'exclusive-create-unsupported', errno: 'ENOSYS' });
    expect(h.lines[0].message).toContain('ENOSYS');
  });
});
