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
 *
 * FR-R4-F02 (spec 240, US2; contract U6 G21 to G23) CHANGES ONE THING: it no longer waits for the
 * Run. It resolves after admission and the announcement, with `admission.resumed`, and observes
 * `completed` on the side, so a Run that runs for hours cannot hold the watchdog callback or the
 * liveness walk that called it. The two cases that asserted it resolved only at the Run's end are
 * rewritten to assert the opposite, and the detached completion has its own cases at the end.
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
    // The helper has resolved although the Run has not ended (contract U6 G21).
    expect(settled).toBe(true);

    await expect(result).resolves.toBe(true);
    f.completed.resolve();
    expect(f.warn).toHaveBeenCalledTimes(1);
  });

  it('resolves after admission and the announcement while `completed` is still pending (U6 G21)', async () => {
    const f = fixture();
    let settled = false;
    const result = resumeUnattended('default', f.deps).then((value) => {
      settled = true;
      return value;
    });
    await flush();

    expect(settled).toBe(true);
    expect(f.warn).toHaveBeenCalledTimes(1);
    expect(await result).toBe(true);
    // The Run is still open; resolving it later changes nothing about what was returned.
    f.completed.resolve();
    await flush();
    expect(f.warn).toHaveBeenCalledTimes(1);
  });

  it('reads the admitted Run back by its queue', async () => {
    const f = fixture();
    const result = resumeUnattended('side-queue', f.deps);
    await flush();
    expect(f.admit).toHaveBeenCalledWith('side-queue');
    expect(f.getRun).toHaveBeenCalledWith('side-queue');
    await result;
    f.completed.resolve();
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

describe('FR-R4-F02 (contract U6 G22, G23) — the detached completion is observed', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    unhandled.length = 0;
  });

  it('a rejecting `completed` logs one line with a reason code and no error text, and nothing is unhandled', async () => {
    process.on('unhandledRejection', onUnhandled);
    const f = fixture({
      admit: async () => ({
        resumed: true,
        completed: Promise.reject(new Error('the run failed with sk-ant-' + 'B'.repeat(30)))
      })
    });

    await expect(resumeUnattended('default', f.deps)).resolves.toBe(true);
    await flush();
    await flush();

    expect(unhandled).toEqual([]);
    expect(f.loggerWarn).toHaveBeenCalledTimes(1);
    expect(f.loggerWarn).toHaveBeenCalledWith('unattended resume: the run ended with an error', {
      reasonCode: 'unattended-completion-failed'
    });
    expect(JSON.stringify(f.loggerWarn.mock.calls)).not.toContain('sk-ant');
  });

  it('a `completed` that resolves later logs nothing', async () => {
    const f = fixture();
    await resumeUnattended('default', f.deps);
    f.completed.resolve();
    await flush();
    expect(f.loggerWarn).not.toHaveBeenCalled();
  });

  it('resumeUnattended never rejects because the Run it admitted failed', async () => {
    process.on('unhandledRejection', onUnhandled);
    const f = fixture({
      admit: async () => ({ resumed: true, completed: Promise.reject(new Error('late failure')) })
    });

    const outcome = await resumeUnattended('default', f.deps).then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    await flush();

    expect(outcome).toEqual({ value: true });
    expect(unhandled).toEqual([]);
  });

  it('a refused admission has no completion to observe and logs nothing', async () => {
    const f = fixture({ resumed: false });
    await expect(resumeUnattended('default', f.deps)).resolves.toBe(false);
    await flush();
    expect(f.loggerWarn).not.toHaveBeenCalled();
  });
});

