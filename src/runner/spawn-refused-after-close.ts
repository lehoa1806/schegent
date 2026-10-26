import type { RunnerLabel } from '../contracts/backend-runner';

/**
 * An invocation refused because the registry closed its runner at host
 * teardown. No process was started.
 *
 * The feature-228 security review, S1: teardown's SIGTERM can stop a child
 * whose turn still had background work open, which reads as an unfinished
 * turn, and the controller resumes an unfinished turn. That resume spawned a
 * detached CLI after the teardown that was meant to stop every one. The refusal
 * propagates like any other failed invocation.
 */
export class SpawnRefusedAfterCloseError extends Error {
  public constructor(public readonly runner: RunnerLabel) {
    super(`runner '${runner}' was closed at host teardown; no CLI was started`);
    this.name = 'SpawnRefusedAfterCloseError';
  }
}
