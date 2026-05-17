import { describe, expect, it, vi } from 'vitest';
import { QueueScheduleWatchdog } from '../../../src/controller/schedule-watchdog';
import { makeDefaultRegistry, setQueueSchedule, type QueueRegistry } from '../../../src/queue/queue-registry';

const NOW = Date.parse('2026-05-13T00:00:00.000Z');

function withSchedule(targetAt: number): QueueRegistry {
  return setQueueSchedule(makeDefaultRegistry(NOW), {
    id: 'default',
    now: NOW,
    schedule: {
      kind: 'relative',
      expression: 'in 1m',
      setAt: new Date(NOW).toISOString(),
      targetAt: new Date(targetAt).toISOString(),
      recurrence: 'one-shot'
    }
  });
}

function makeWatchdog(opts: {
  registry: QueueRegistry;
  now?: number;
  primary?: boolean;
}) {
  const fired: string[][] = [];
  const queue = {
    fireDueSchedules: vi.fn(async () => {
      fired.push(['default']);
      return ['default'];
    })
  };
  const drain = vi.fn(async () => undefined);
  const audit = { append: vi.fn(async () => undefined) };
  const logger = { warn: vi.fn(), info: vi.fn() };
  const watchdog = new QueueScheduleWatchdog({
    getRegistry: () => opts.registry,
    queue,
    drain,
    isPrimary: () => opts.primary ?? true,
    logger,
    audit,
    now: () => opts.now ?? NOW
  });
  return { watchdog, queue, drain, audit, logger };
}

describe('QueueScheduleWatchdog', () => {
  // Feature 030 (US3, T047) — single-queue mode. The watchdog is a
  // strict no-op shim: `QueueRegistryEntry.schedule` is always `null`
  // after the v5 → v6 migration, so `tick()` returns `[]` early without
  // touching the registry scan, the audit pipeline, or the drain hop.
  // The historical "fires at the 60,000 ms boundary" / "fires past-due
  // schedules" tests covered behavior that no longer exists; the no-op
  // contract is pinned below.

  it('returns [] and does not fire the queue even when a schedule is set', async () => {
    // Even when the registry carries a schedule entry (the registry
    // module still exposes setQueueSchedule for forward compat), the
    // watchdog never reaches into the queue: single-queue mode means
    // no due-firing.
    const h = makeWatchdog({ registry: withSchedule(NOW + 60_000), now: NOW + 60_000 });
    await expect(h.watchdog.tick()).resolves.toEqual([]);
    expect(h.queue.fireDueSchedules).not.toHaveBeenCalled();
    expect(h.drain).not.toHaveBeenCalled();
    expect(h.audit.append).not.toHaveBeenCalled();
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it('returns [] for past-due schedules without emitting diagnostics', async () => {
    // The "60 seconds late" delayed-trigger diagnostic is gone with the
    // multi-queue scheduling code; the no-op shim never inspects clock
    // delta against schedule.
    const h = makeWatchdog({ registry: withSchedule(NOW), now: NOW + 60_001 });
    await expect(h.watchdog.tick()).resolves.toEqual([]);
    expect(h.queue.fireDueSchedules).not.toHaveBeenCalled();
    expect(h.logger.warn).not.toHaveBeenCalled();
    expect(h.audit.append).not.toHaveBeenCalled();
  });

  it('does not fire from a secondary host', async () => {
    const h = makeWatchdog({ registry: withSchedule(NOW), now: NOW + 1, primary: false });
    await expect(h.watchdog.tick()).resolves.toEqual([]);
    expect(h.queue.fireDueSchedules).not.toHaveBeenCalled();
  });

  it('disposes the installed interval', () => {
    const handle = { id: 1 };
    const clearTimer = vi.fn();
    const h = new QueueScheduleWatchdog(
      {
        getRegistry: () => makeDefaultRegistry(NOW),
        queue: { fireDueSchedules: vi.fn() },
        drain: vi.fn(),
        isPrimary: () => true,
        logger: { warn: vi.fn(), info: vi.fn() },
        setTimer: vi.fn(() => handle),
        clearTimer
      },
      60_000
    );
    h.start();
    h.dispose();
    expect(clearTimer).toHaveBeenCalledWith(handle);
  });
});
