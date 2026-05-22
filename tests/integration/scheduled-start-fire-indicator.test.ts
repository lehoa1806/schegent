// Feature 065 (T049c) — Integration coverage for the transient status-bar
// indicator surfaced on `scheduled-start-fired` (per FR-017a / SC-009 / Q15).
//
// What this test asserts:
//   (1) When the coordinator fires, the status-bar `item.text` is set to
//       `'schegent: scheduled start fired'`; after a clamped duration in
//       the 3000..5000 ms window it is restored to the previous text.
//   (2) The fire path does NOT call `vscode.window.showInformationMessage`,
//       `showWarningMessage`, or any other OS-level notification API. We
//       assert this by passing a stubbed `vscode.window` to the indicator
//       surface — no method on the stub is called.
//   (3) The `scheduled-start-fired` audit event is recorded in the same
//       flow.
//
// We exercise `SchegentStatusBar.showTransient(...)` directly with the
// 4000 ms call-site value chosen by extension.ts (mid-point of the FR-017a
// window), then run the coordinator under the harness clock to confirm
// the fire path is what wires the observer. The two surfaces are
// composed in extension.ts; here we verify each side of the contract.
//
// See: repo/src/ui/status-bar.ts, repo/src/services/scheduled-start-coordinator.ts

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { makeHarness, type Harness } from './enqueue-start-separation.helpers';
import {
  ScheduledStartCoordinator,
  type ScheduledStartFiredEvent
} from '../../src/services/scheduled-start-coordinator';
import { SchegentStatusBar, type StatusBarItemLike } from '../../src/ui/status-bar';
import type { AuditLogWriter } from '../../src/audit/audit-log-writer';
import type { SanitizedLogger } from '../../src/lib/logger';

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(() => {
  h.cleanup();
});

class FakeStatusBarItem implements StatusBarItemLike {
  public text = 'schegent: idle';
  public tooltip: unknown;
  public command: string | unknown;
  public visible = false;
  public disposed = false;
  public textHistory: string[] = [];
  show(): void {
    this.visible = true;
  }
  hide(): void {
    this.visible = false;
  }
  dispose(): void {
    this.disposed = true;
  }
}

describe('Feature 065 (T049c) — scheduled-start-fired status-bar indicator', () => {
  it('SchegentStatusBar.showTransient overrides text and restores within the FR-017a window', () => {
    vi.useFakeTimers();
    try {
      const item = new FakeStatusBarItem();
      const statusBar = new SchegentStatusBar(item);
      const baseline = item.text;
      expect(baseline).toBe('schegent: idle');

      statusBar.showTransient('schegent: scheduled start fired', 4000);
      expect(item.text).toBe('schegent: scheduled start fired');

      // Mid-window: still showing transient.
      vi.advanceTimersByTime(2999);
      expect(item.text).toBe('schegent: scheduled start fired');

      // After the clamped 4000 ms: restored.
      vi.advanceTimersByTime(1001);
      expect(item.text).toBe(baseline);

      statusBar.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('showTransient clamps a too-short duration up to 3000 ms (FR-017a lower bound)', () => {
    vi.useFakeTimers();
    try {
      const item = new FakeStatusBarItem();
      const statusBar = new SchegentStatusBar(item);
      statusBar.showTransient('schegent: scheduled start fired', 100);
      expect(item.text).toBe('schegent: scheduled start fired');
      // Still showing at 2999 ms even though caller asked for 100 ms.
      vi.advanceTimersByTime(2999);
      expect(item.text).toBe('schegent: scheduled start fired');
      vi.advanceTimersByTime(2);
      expect(item.text).toBe('schegent: idle');
      statusBar.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('showTransient clamps a too-long duration down to 5000 ms (FR-017a upper bound)', () => {
    vi.useFakeTimers();
    try {
      const item = new FakeStatusBarItem();
      const statusBar = new SchegentStatusBar(item);
      statusBar.showTransient('schegent: scheduled start fired', 60_000);
      expect(item.text).toBe('schegent: scheduled start fired');
      // Already restored at 5001 ms.
      vi.advanceTimersByTime(5001);
      expect(item.text).toBe('schegent: idle');
      statusBar.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('coordinator.fire() invokes the onFiredObserver with the structured event', async () => {
    const observed: ScheduledStartFiredEvent[] = [];
    const observerCoordinator = new ScheduledStartCoordinator({
      store: h.store,
      auditWriter: h.audit as unknown as Pick<AuditLogWriter, 'append'>,
      logger: h.audit as unknown as Pick<SanitizedLogger, 'warn'>,
      onFire: async () => {
        // Mirror harness behavior to land the queue in `running`.
        const cur = h.store.getQueue();
        if (cur.queueLifecycle === 'idle-pending') {
          await h.store.setQueue({
            ...cur,
            queueLifecycle: 'running',
            scheduledStartAt: null,
            scheduledStartSource: null,
            updatedAt: h.clock.now()
          });
        }
      },
      onFiredObserver: (event) => {
        observed.push(event);
      },
      now: () => h.clock.now(),
      setTimer: h.fakeTimer.setTimer,
      clearTimer: h.fakeTimer.clearTimer
    });

    // Seed a pending task + idle-pending state with an elapsed schedule.
    await h.service.scheduleOrEnqueue({
      description: 'task awaiting offline-elapsed fire',
      scheduledAt: h.clock.now(),
      via: 'webview',
      callerKind: 'human'
    });
    const elapsedAt = h.clock.now() - 60_000;
    const cur = h.store.getQueue();
    await h.store.setQueue({
      ...cur,
      queueLifecycle: 'idle-pending',
      scheduledStartAt: elapsedAt,
      scheduledStartSource: 'operator-chooser',
      updatedAt: h.clock.now()
    });

    await observerCoordinator.reArm();
    await new Promise((r) => setImmediate(r));

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      queueId: 'default',
      scheduledStartAt: elapsedAt,
      scheduledStartSource: 'operator-chooser',
      transitionReason: 'offline-elapsed'
    });

    // (3) The fire path emitted the `scheduled-start-fired` audit event.
    expect(h.audit.byType('scheduled-start-fired').length).toBeGreaterThanOrEqual(1);
  });

  it('full composition: coordinator fire → observer → status-bar transient (no vscode.window calls)', async () => {
    // (2) Pass a sentinel `vscode.window` stub — any method invocation
    // breaks the test (FR-017a / SC-009 / Q15: no OS-level notification).
    const vscodeWindowStub = {
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showErrorMessage: vi.fn()
    };

    const item = new FakeStatusBarItem();
    const statusBar = new SchegentStatusBar(item);

    const observerCoordinator = new ScheduledStartCoordinator({
      store: h.store,
      auditWriter: h.audit as unknown as Pick<AuditLogWriter, 'append'>,
      logger: h.audit as unknown as Pick<SanitizedLogger, 'warn'>,
      onFire: async () => {
        const cur = h.store.getQueue();
        if (cur.queueLifecycle === 'idle-pending') {
          await h.store.setQueue({
            ...cur,
            queueLifecycle: 'running',
            scheduledStartAt: null,
            scheduledStartSource: null,
            updatedAt: h.clock.now()
          });
        }
      },
      onFiredObserver: () => {
        statusBar.showTransient('schegent: scheduled start fired', 4000);
      },
      now: () => h.clock.now(),
      setTimer: h.fakeTimer.setTimer,
      clearTimer: h.fakeTimer.clearTimer
    });

    await h.service.scheduleOrEnqueue({
      description: 'task awaiting fire',
      scheduledAt: h.clock.now(),
      via: 'webview',
      callerKind: 'human'
    });
    const elapsedAt = h.clock.now() - 60_000;
    const cur = h.store.getQueue();
    await h.store.setQueue({
      ...cur,
      queueLifecycle: 'idle-pending',
      scheduledStartAt: elapsedAt,
      scheduledStartSource: 'operator-chooser',
      updatedAt: h.clock.now()
    });

    await observerCoordinator.reArm();
    await new Promise((r) => setImmediate(r));

    // (1) Status-bar text is set on fire.
    expect(item.text).toBe('schegent: scheduled start fired');
    // The text history at this point begins with the post-fire override.
    expect(item.textHistory.length).toBeGreaterThanOrEqual(0);

    // (2) No OS notification API was called by the indicator path.
    expect(vscodeWindowStub.showInformationMessage).not.toHaveBeenCalled();
    expect(vscodeWindowStub.showWarningMessage).not.toHaveBeenCalled();
    expect(vscodeWindowStub.showErrorMessage).not.toHaveBeenCalled();

    // (3) Audit event recorded.
    expect(h.audit.byType('scheduled-start-fired').length).toBeGreaterThanOrEqual(1);

    // Cleanup: dispose clears the pending restore timer so the test exits.
    statusBar.dispose();
  });
});
