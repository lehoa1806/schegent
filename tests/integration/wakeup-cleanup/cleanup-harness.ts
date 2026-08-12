// Feature 091 — shared doubles for the Wake-up cleanup integration
// tests (T016, T017, T018).
//
// Not a `.test.ts` file, so vitest's include globs do not collect it.

import type { HostMemento } from '../../../src/host-services/types';
import type {
  CleanupFileSystem,
  CleanupLogger,
  CleanupNotifier,
  WakeUpCleanupDeps
} from '../../../src/cleanup/wakeup-cleanup';
import type { SchedulerAttempt, SchedulerName } from '../../../src/cleanup/schedulers/types';

/**
 * Mirrors VS Code's `Memento`: the written value is visible to the very
 * next synchronous `get`, before the returned promise settles. Two
 * concurrent cleanup runs therefore see each other's writes, which is
 * what makes the compare-then-write of plan D-04 meaningful.
 */
export class FakeMemento implements HostMemento {
  private readonly values = new Map<string, unknown>();
  public readonly writes: Array<{ key: string; value: unknown }> = [];

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.writes.push({ key, value });
    this.values.set(key, value);
  }
}

export interface LogLine {
  readonly level: 'info' | 'warn';
  readonly message: string;
}

export class RecordingLogger implements CleanupLogger {
  public readonly lines: LogLine[] = [];

  info(message: string): void {
    this.lines.push({ level: 'info', message });
  }
  warn(message: string): void {
    this.lines.push({ level: 'warn', message });
  }
  sanitize(input: string): string {
    // Stands in for `SanitizedLogger.sanitize`. The tests assert that
    // reasons pass THROUGH it, not what the redaction set does — that is
    // owned by the logger's own tests.
    return input.replace(/sk-[A-Za-z0-9]+/g, '[redacted]');
  }
}

export interface NotifyCall {
  readonly message: string;
  readonly action: string;
}

export class RecordingNotifier implements CleanupNotifier {
  public readonly calls: NotifyCall[] = [];
  /** Action label to return, simulating the operator clicking it. */
  public chooseAction = false;

  async warn(message: string, action: string): Promise<string | undefined> {
    this.calls.push({ message, action });
    return this.chooseAction ? action : undefined;
  }
}

/**
 * A virtual clock. `delay()` advances modelled time and yields to the
 * microtask queue, so sequencing is real while elapsed time is modelled
 * — the SC-008 budget is then a property of the code's structure rather
 * than of the machine the suite happens to run on.
 */
export class VirtualClock {
  private ms = Date.parse('2026-08-12T00:00:00Z');
  private readonly startedAt = this.ms;

  now = (): Date => new Date(this.ms);

  async delay(durationMs: number): Promise<void> {
    this.ms += durationMs;
    await Promise.resolve();
  }

  elapsedMs(): number {
    return this.ms - this.startedAt;
  }
}

export const ALL_SCHEDULERS: readonly SchedulerName[] = [
  'launchd',
  'systemd-user',
  'cron',
  'task-scheduler'
];

/** Every scheduler remover throws — contract C-06's hostile case. */
export function throwingRemovers(
  message = 'scheduler subsystem unavailable'
): Partial<Record<SchedulerName, () => Promise<SchedulerAttempt>>> {
  const removers: Partial<Record<SchedulerName, () => Promise<SchedulerAttempt>>> = {};
  for (const name of ALL_SCHEDULERS) {
    removers[name] = async () => {
      throw new Error(message);
    };
  }
  return removers;
}

export function fixedRemovers(
  result: SchedulerAttempt['result'],
  reason?: string
): Partial<Record<SchedulerName, () => Promise<SchedulerAttempt>>> {
  const removers: Partial<Record<SchedulerName, () => Promise<SchedulerAttempt>>> = {};
  for (const name of ALL_SCHEDULERS) {
    removers[name] = async () =>
      reason === undefined
        ? { scheduler: name, result }
        : { scheduler: name, result, reason };
  }
  return removers;
}

/** A filesystem whose every call throws — contract C-06's hostile case. */
export const throwingFs: CleanupFileSystem = {
  unlink: async () => {
    throw new Error('EIO: i/o error');
  }
};

/** A filesystem where every artefact is already gone. */
export const emptyFs: CleanupFileSystem = {
  unlink: async () => {
    const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  }
};

export interface HarnessOptions {
  readonly platform?: string;
  readonly store?: HostMemento;
  readonly logger?: RecordingLogger;
  readonly notifier?: RecordingNotifier;
  readonly fs?: CleanupFileSystem;
  readonly removers?: Partial<Record<SchedulerName, () => Promise<SchedulerAttempt>>>;
  readonly now?: () => Date;
  readonly openUpgradeNote?: () => Promise<void> | void;
}

export interface Harness {
  readonly deps: WakeUpCleanupDeps;
  readonly store: FakeMemento;
  readonly logger: RecordingLogger;
  readonly notifier: RecordingNotifier;
  readonly upgradeNoteOpens: () => number;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const store = (options.store as FakeMemento | undefined) ?? new FakeMemento();
  const logger = options.logger ?? new RecordingLogger();
  const notifier = options.notifier ?? new RecordingNotifier();
  let opens = 0;

  const deps: WakeUpCleanupDeps = {
    store,
    wakeUpHomeDir: '/fake/global-storage/wakeup',
    logger,
    notifier,
    openUpgradeNote: async () => {
      opens += 1;
      await options.openUpgradeNote?.();
    },
    platform: options.platform ?? 'darwin',
    now: options.now ?? ((): Date => new Date('2026-08-12T00:00:00Z')),
    removers: options.removers ?? fixedRemovers('removed'),
    fs: options.fs ?? emptyFs
  };

  return { deps, store, logger, notifier, upgradeNoteOpens: () => opens };
}
