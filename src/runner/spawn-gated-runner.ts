// FR-R6-F09 (FR-003, FR-008; contract section 3, research R1) -- a `BackendRunner` whose every
// invocation is admitted by the spawn gate first.
//
// WHY A DECORATOR. The check belongs after the runner exists and before its child does, on every
// path that spawns: a Run phase, a resume, a helper invocation. Wrapping the runner at its one
// construction site reaches all of them without an edit to a runner or to the phase runner. A
// refusal rejects `invoke` before `inner.invoke` is called, so no child is ever started.

import type { BackendRunnerKind } from '../contracts/backend-kinds';
import type { BackendRunner, TreeTeardownOutcome } from '../contracts/backend-runner';
import type { SpawnGate } from '../contracts/containment-qualification';
import type { InvocationOutputSink, InvocationRequest, RawInvocationOutput } from './invocation-result';

export class SpawnGatedRunner implements BackendRunner {
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
    await this.gate.admit(this.kind, { runId: request.runId, cliPath: request.cliPath });
    return this.inner.invoke(request, outputSink);
  }

  public cancelActive(): boolean {
    return this.inner.cancelActive();
  }

  public close(): void {
    this.inner.close();
  }

  public settleTeardowns(deadline?: Promise<void>): Promise<readonly TreeTeardownOutcome[]> {
    return this.inner.settleTeardowns(deadline);
  }
}
