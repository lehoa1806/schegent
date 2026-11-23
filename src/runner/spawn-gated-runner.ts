// FR-R6-F09 (FR-003, FR-008; contract section 3, research R1) & FR-R7-16 (16-14, FR-014) --
// a `BackendRunner` whose every invocation is admitted by the spawn gate first.
//
// WHY A DECORATOR. The check belongs after the runner exists and before its child does, on every
// path that spawns: a Run phase, a resume, a helper invocation. Wrapping the runner at its one
// construction site reaches all of them without an edit to a runner or to the phase runner. A
// refusal rejects `invoke` before `inner.invoke` is called, so no child is ever started.
//
// CANCEL & CLOSE SAFETY (16-14). `gate.admit(...)` is asynchronous (verifies primacy, probes
// version, binds acceptance). Cancellation (`cancellationSignal`, `cancelActive()`) or `close()`
// arriving before, during, or immediately after `await this.gate.admit(...)` settles immediately
// without ever calling `inner.invoke`, guaranteeing zero child spawns after cancellation or close.

import { getBackendDescriptor } from '../contracts/backend-descriptors';
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import type { BackendRunner, TreeTeardownOutcome } from '../contracts/backend-runner';
import type { SpawnGate } from '../contracts/containment-qualification';
import type { InvocationOutputSink, InvocationRequest, RawInvocationOutput } from './invocation-result';
import { SpawnRefusedAfterCloseError } from './spawn-refused-after-close';
import { ZippedStreamBuffer } from './zipped-stream-buffer';

interface PendingAdmission {
  cancelled: boolean;
  readonly controller: AbortController;
  wake: () => void;
}

function cancelledBeforeSpawn(command: string, startedAtMs: number): RawInvocationOutput {
  const stdoutBuffer = new ZippedStreamBuffer();
  const stderrBuffer = new ZippedStreamBuffer();
  stdoutBuffer.finalize();
  stderrBuffer.finalize();
  return {
    stdoutBuffer,
    stderrBuffer,
    exitCode: null,
    killed: true,
    timedOut: false,
    durationMs: Math.max(0, Date.now() - startedAtMs),
    command
  };
}

export class SpawnGatedRunner implements BackendRunner {
  private readonly pendingAdmissions = new Set<PendingAdmission>();
  private closed = false;

  public constructor(
    private readonly kind: BackendRunnerKind,
    private readonly inner: BackendRunner,
    private readonly gate: SpawnGate
  ) {}

  public get hasActiveProcess(): boolean {
    return this.inner.hasActiveProcess;
  }

  public get availabilityAdapter(): BackendRunner['availabilityAdapter'] {
    return this.inner.availabilityAdapter;
  }

  public async invoke(request: InvocationRequest, outputSink?: InvocationOutputSink): Promise<RawInvocationOutput> {
    const startedAtMs = Date.now();
    const label = getBackendDescriptor(this.kind).runnerLabel;
    const isClosed = (): boolean => this.closed;
    const isAborted = (): boolean => request.cancellationSignal?.aborted === true;
    if (isClosed()) {
      throw new SpawnRefusedAfterCloseError(label);
    }
    if (isAborted()) {
      return cancelledBeforeSpawn(request.cliPath, startedAtMs);
    }

    const admitController = new AbortController();
    const entry: PendingAdmission = {
      cancelled: false,
      controller: admitController,
      wake: () => undefined
    };
    const onAbort = (): void => {
      entry.cancelled = true;
      admitController.abort();
      entry.wake();
    };
    this.pendingAdmissions.add(entry);
    request.cancellationSignal?.addEventListener('abort', onAbort);

    let outcome:
      | { readonly kind: 'admitted' }
      | { readonly kind: 'rejected'; readonly error: unknown }
      | { readonly kind: 'interrupted' };
    try {
      outcome = await new Promise((resolve) => {
        let settled = false;
        const finish = (
          result:
            | { readonly kind: 'admitted' }
            | { readonly kind: 'rejected'; readonly error: unknown }
            | { readonly kind: 'interrupted' }
        ): void => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        entry.wake = () => finish({ kind: 'interrupted' });
        if (isClosed() || entry.cancelled || isAborted()) {
          admitController.abort();
          finish({ kind: 'interrupted' });
          return;
        }
        let admitPromise: Promise<void>;
        try {
          admitPromise = this.gate.admit(this.kind, {
            runId: request.runId,
            cliPath: request.cliPath,
            cancellationSignal: admitController.signal
          });
        } catch (error) {
          finish({ kind: 'rejected', error });
          return;
        }
        admitPromise.then(
          () => finish({ kind: 'admitted' }),
          (error: unknown) => finish({ kind: 'rejected', error })
        );
      });
    } finally {
      this.pendingAdmissions.delete(entry);
      request.cancellationSignal?.removeEventListener?.('abort', onAbort);
    }

    if (isClosed()) {
      throw new SpawnRefusedAfterCloseError(label);
    }
    if (entry.cancelled || isAborted()) {
      return cancelledBeforeSpawn(request.cliPath, startedAtMs);
    }
    if (outcome.kind === 'rejected') {
      throw outcome.error;
    }
    return this.inner.invoke(request, outputSink);
  }

  public cancelActive(): boolean {
    let cancelled = false;
    for (const entry of this.pendingAdmissions) {
      if (!entry.cancelled) {
        entry.cancelled = true;
        entry.controller.abort();
        entry.wake();
        cancelled = true;
      }
    }
    if (this.inner.cancelActive()) {
      cancelled = true;
    }
    return cancelled;
  }

  public close(): void {
    this.closed = true;
    for (const entry of this.pendingAdmissions) {
      entry.controller.abort();
      entry.wake();
    }
    this.inner.close();
  }

  public settleTeardowns(deadline?: Promise<void>): Promise<readonly TreeTeardownOutcome[]> {
    return this.inner.settleTeardowns(deadline);
  }
}
