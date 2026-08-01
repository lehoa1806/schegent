import type { Readable } from 'node:stream';
import type { InvocationOutputSink } from './invocation-result';

type OutputStream = 'stdout' | 'stderr';

/**
 * Coordinates subprocess-pipe backpressure across stdout and stderr.
 *
 * A child can block when either pipe is paused, so the idle timer stays
 * suspended until every backpressured output sink has drained. The caller
 * owns the timer and supplies the suspend/resume callbacks because Claude's
 * completion-settle window differs from the other runners' idle window.
 */
export class OutputSinkBackpressure {
  private readonly blocked = new Set<OutputStream>();

  constructor(
    private readonly sink: InvocationOutputSink | undefined,
    private readonly suspendIdleTimer: () => void,
    private readonly resumeIdleTimer: () => void
  ) {}

  public get isBlocked(): boolean {
    return this.blocked.size > 0;
  }

  public write(stream: OutputStream, source: Readable, chunk: string): void {
    if (!this.sink || this.sink.write(stream, chunk)) return;

    const wasUnblocked = this.blocked.size === 0;
    if (!this.blocked.has(stream)) {
      this.blocked.add(stream);
      source.pause();
      if (wasUnblocked) this.suspendIdleTimer();
    }

    this.sink.onceDrain(stream, () => {
      if (!this.blocked.delete(stream)) return;
      source.resume();
      if (this.blocked.size === 0) this.resumeIdleTimer();
    });
  }
}
