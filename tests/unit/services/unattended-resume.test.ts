import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResumeAdmission } from '../../../src/controller/run-admission';
import { SanitizedLogger } from '../../../src/lib/logger';
import {
  resumeUnattended,
  type UnattendedResumeDeps
} from '../../../src/services/unattended-resume';
import type { WorkflowRun } from '../../../src/state/workflow-run';

/**
 * FR-R3-192 (contract C2, FR-006, FR-007, FR-009) — the helper every unattended resume path calls.
 *
 * It is `resumeExisting`'s three statements with one synchronous step between admission and
 * completion. The cases below hold the step to its two promises: it speaks once the resume is
 * admitted and before the Run ends, and nothing it does can change what the resume does.
 */

const FIXED_FAILURE_LINE = 'unattended resume: the announcement could not be shown';

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = (): Promise<void> => new Promise((done) => setImmediate(done));

const RUN = { id: 'abcdef12-3456-4789-8abc-def012345678', currentPhase: 'speckit-plan' } as WorkflowRun;

interface Fixture {
  readonly deps: UnattendedResumeDeps;
  readonly admit: ReturnType<typeof vi.fn>;
  readonly getRun: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly loggerWarn: ReturnType<typeof vi.fn>;
  readonly completed: Deferred;
}

function fixture(options: {
  resumed?: boolean;
  run?: WorkflowRun | null;
  warn?: (message: string) => unknown;
  admit?: () => Promise<ResumeAdmission>;
} = {}): Fixture {
  const completed = deferred();
  const resumed = options.resumed ?? true;
  const admit = vi.fn(
    options.admit ?? (async (): Promise<ResumeAdmission> => ({ resumed, completed: completed.promise }))
  );
  const getRun = vi.fn(() => (options.run === undefined ? RUN : options.run));
  const warn = vi.fn(options.warn ?? ((): Thenable<string | undefined> => Promise.resolve(undefined)));
  const loggerWarn = vi.fn();
  const real = new SanitizedLogger();
  const deps = {
    admit,
    store: { getRun },
    notifier: { warn },
    logger: { sanitize: (value: string) => real.sanitize(value), warn: loggerWarn }
  } as unknown as UnattendedResumeDeps;
  return { deps, admit, getRun, warn, loggerWarn, completed };
}

describe('FR-R3-192 — resumeUnattended', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    unhandled.length = 0;
  });

  it('announces an admitted resume once, while the Run is still going', async () => {
    const f = fixture();
    let settled = false;
    const result = resumeUnattended('default', f.deps).then((value) => {
      settled = true;
      return value;
    });
    await flush();

    expect(f.warn).toHaveBeenCalledTimes(1);
    const message = f.warn.mock.lastCall?.[0] as string;
    expect(message).toContain('queue "default"');
    expect(message).toContain('run abcdef12 ');
    expect(message).toContain('phase "speckit-plan"');
    expect(settled).toBe(false);

    f.completed.resolve();
    await expect(result).resolves.toBe(true);
    expect(f.warn).toHaveBeenCalledTimes(1);
  });

  it('resolves only after the Run completes, as resumeExisting does', async () => {
    const f = fixture();
    let settled = false;
    const result = resumeUnattended('default', f.deps).then((value) => {
      settled = true;
      return value;
    });
    await flush();
    expect(settled).toBe(false);
    f.completed.resolve();
    expect(await result).toBe(true);
    expect(settled).toBe(true);
  });

  it('reads the admitted Run back by its queue', async () => {
    const f = fixture();
    const result = resumeUnattended('side-queue', f.deps);
    await flush();
    expect(f.admit).toHaveBeenCalledWith('side-queue');
    expect(f.getRun).toHaveBeenCalledWith('side-queue');
    f.completed.resolve();
    await result;
  });

  it('announces nothing for a refused admission, and resolves false', async () => {
    const f = fixture({ resumed: false });
    f.completed.resolve();
    await expect(resumeUnattended('default', f.deps)).resolves.toBe(false);
    expect(f.warn).not.toHaveBeenCalled();
    expect(f.getRun).not.toHaveBeenCalled();
    expect(f.loggerWarn).not.toHaveBeenCalled();
  });

  it('still resumes, and logs one fixed line, when the notifier throws', async () => {
    const f = fixture({
      warn: () => {
        throw new Error('the notification surface is gone');
      }
    });
    const result = resumeUnattended('default', f.deps);
    await flush();
    f.completed.resolve();

    await expect(result).resolves.toBe(true);
    expect(f.loggerWarn).toHaveBeenCalledTimes(1);
    expect(f.loggerWarn.mock.calls[0]).toEqual([FIXED_FAILURE_LINE]);
  });

  it('still resumes, and logs one fixed line, when the notification rejects', async () => {
    process.on('unhandledRejection', onUnhandled);
    const f = fixture({ warn: () => Promise.reject(new Error('rejected with sk-ant-' + 'A'.repeat(30))) });
    const result = resumeUnattended('default', f.deps);
    await flush();
    f.completed.resolve();

    await expect(result).resolves.toBe(true);
    await flush();
    expect(unhandled).toEqual([]);
    expect(f.loggerWarn).toHaveBeenCalledTimes(1);
    expect(f.loggerWarn.mock.calls[0]).toEqual([FIXED_FAILURE_LINE]);
  });

  it('announces nothing and logs the same line when the Run cannot be read back', async () => {
    const f = fixture({ run: null });
    const result = resumeUnattended('default', f.deps);
    await flush();
    f.completed.resolve();

    await expect(result).resolves.toBe(true);
    expect(f.warn).not.toHaveBeenCalled();
    expect(f.loggerWarn).toHaveBeenCalledTimes(1);
    expect(f.loggerWarn.mock.calls[0]).toEqual([FIXED_FAILURE_LINE]);
  });

  it('rejects with the admission error itself, unchanged, and announces nothing', async () => {
    const failure = new Error('admission failed');
    const f = fixture({ admit: () => Promise.reject(failure) });
    await expect(resumeUnattended('default', f.deps)).rejects.toBe(failure);
    expect(f.warn).not.toHaveBeenCalled();
  });

  it('offers no action: the notifier is called with the message alone', async () => {
    const f = fixture();
    const result = resumeUnattended('default', f.deps);
    await flush();
    f.completed.resolve();
    await result;
    expect(f.warn.mock.calls[0]).toHaveLength(1);
    expect(typeof f.warn.mock.lastCall?.[0]).toBe('string');
  });
});
