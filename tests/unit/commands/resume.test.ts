// FR-R4-F05 (FR-014; contract F, F6; contract O, O5) — `runResume`, the palette resume.
//
// WHY THIS FILE. The command had no test, and its generic catch arm toasted
// `Schegent: ${message}` and logged the bare message, so a path in an exception reached the
// operator's screen. The arm now shows fixed text and sends the detail to the log through
// `describeFailure`. The arms beside it are pinned here as well, so a rewrite of the catch
// cannot drop the other-window refusal: that one is a notice, not a failure, and must not
// become an error toast.
import { describe, expect, it, vi } from 'vitest';
import { RESUME_FAILED_TOAST, runResume } from '../../../src/commands/resume';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import type { WorkspaceLockManager } from '../../../src/state/lock';
import type { WorkspaceStateStore } from '../../../src/state/workspace-state';
import type { Notifier } from '../../../src/ui/notifications';

const PATH = '/synthetic/home/user-252/lock.json';

function makeNotifier(): Notifier {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;
}

/** A store whose run record holds one paused run, or none. */
function makeStore(paused: boolean): WorkspaceStateStore {
  const runs = paused ? { [DEFAULT_QUEUE_ID]: { id: 'run-1', status: 'paused' } } : {};
  return { getRunMap: () => runs } as unknown as WorkspaceStateStore;
}

function makeLock(
  tryAcquire: () => Promise<{ acquired: boolean; ownerId: string }> = async () => ({
    acquired: true,
    ownerId: 'this-window'
  })
): WorkspaceLockManager {
  return { tryAcquire: vi.fn(tryAcquire) } as unknown as WorkspaceLockManager;
}

function makeController(
  resumeExisting: (queueId: string, prompt?: string) => Promise<boolean> = async () => true
): SchegentWorkflowController {
  return { resumeExisting: vi.fn(resumeExisting) } as unknown as SchegentWorkflowController;
}

/** Every string the notifier received, so a test can search for free text. */
function everyToast(notifier: Notifier): string {
  return JSON.stringify([
    vi.mocked(notifier.info).mock.calls,
    vi.mocked(notifier.warn).mock.calls,
    vi.mocked(notifier.error).mock.calls
  ]);
}

describe('runResume — the arms beside the generic catch', () => {
  it('resumes the one resumable run, passing the continuation prompt, with no failure toast', async () => {
    const notifier = makeNotifier();
    const controller = makeController();

    await runResume({
      store: makeStore(true),
      controller,
      lock: makeLock(),
      notifier,
      logger: new SanitizedLogger(),
      prompt: 'carry on'
    });

    expect(controller.resumeExisting).toHaveBeenCalledWith(DEFAULT_QUEUE_ID, 'carry on');
    expect(notifier.error).not.toHaveBeenCalled();
  });

  it('says another window holds the lock, as a notice and not as an error', async () => {
    const notifier = makeNotifier();
    const controller = makeController();

    await runResume({
      store: makeStore(true),
      controller,
      lock: makeLock(async () => ({ acquired: false, ownerId: 'other-window' })),
      notifier,
      logger: new SanitizedLogger()
    });

    expect(notifier.info).toHaveBeenCalledWith(
      'Schegent: another window holds the workspace lock.'
    );
    expect(notifier.error).not.toHaveBeenCalled();
    expect(controller.resumeExisting).not.toHaveBeenCalled();
  });
});

describe('runResume — the unexpected-failure arm (FR-R4-F05)', () => {
  it('toasts the fixed text and logs the detail when the lock fault carries a path', async () => {
    const notifier = makeNotifier();
    const logger = new SanitizedLogger();
    const errorLog = vi.spyOn(logger, 'error');

    await runResume({
      store: makeStore(true),
      controller: makeController(),
      lock: makeLock(async () => {
        throw new Error(`EACCES: permission denied, open '${PATH}'`);
      }),
      notifier,
      logger
    });

    expect(notifier.error).toHaveBeenCalledTimes(1);
    expect(notifier.error).toHaveBeenCalledWith(RESUME_FAILED_TOAST);
    expect(everyToast(notifier)).not.toContain('user-252');
    expect(errorLog).toHaveBeenCalledWith(
      'resume: unexpected failure',
      expect.objectContaining({ error: expect.stringContaining('user-252') })
    );
  });

  it('answers the same when the controller rejects the resume', async () => {
    const notifier = makeNotifier();
    const logger = new SanitizedLogger();
    const errorLog = vi.spyOn(logger, 'error');

    await runResume({
      store: makeStore(true),
      controller: makeController(async () => {
        throw new Error(`run record unreadable at ${PATH}`);
      }),
      lock: makeLock(),
      notifier,
      logger
    });

    expect(notifier.error).toHaveBeenCalledWith(RESUME_FAILED_TOAST);
    expect(everyToast(notifier)).not.toContain('user-252');
    expect(errorLog).toHaveBeenCalledWith(
      'resume: unexpected failure',
      expect.objectContaining({ error: expect.stringContaining('user-252') })
    );
  });

  it('toasts the fixed text for a thrown null and logs a bounded description of it', async () => {
    const notifier = makeNotifier();
    const logger = new SanitizedLogger();
    const errorLog = vi.spyOn(logger, 'error');

    await runResume({
      store: makeStore(true),
      controller: makeController(),
      // A library may throw anything; the command must not assume an `Error`.
      lock: makeLock(async () => {
        throw null;
      }),
      notifier,
      logger
    });

    expect(notifier.error).toHaveBeenCalledWith(RESUME_FAILED_TOAST);
    expect(errorLog).toHaveBeenCalledWith(
      'resume: unexpected failure',
      expect.objectContaining({ error: 'null thrown' })
    );
  });

  it('words the toast without an exception, a path or a code', () => {
    expect(RESUME_FAILED_TOAST).toBe(
      'Schegent: the run could not be resumed. See the Schegent log for details.'
    );
  });
});
