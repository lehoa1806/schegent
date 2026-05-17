export type SetTimeoutFn = (callback: () => void, ms: number) => unknown;
export type ClearTimeoutFn = (handle: unknown) => void;

export interface StallDetectorOptions {
  readonly thresholdMs: number;
  readonly monotonicNow: () => number;
  readonly setTimeout: SetTimeoutFn;
  readonly clearTimeout: ClearTimeoutFn;
  readonly onStall: () => void;
}

export class StallDetector {
  private timer: unknown = null;
  private armedAt: number | null = null;
  private remainingMs: number;
  private readonly opts: StallDetectorOptions;

  constructor(opts: StallDetectorOptions) {
    this.opts = opts;
    this.remainingMs = opts.thresholdMs;
  }

  public start(): void {
    this.armTimer(this.opts.thresholdMs);
  }

  public noteStdoutChunk(): void {
    this.remainingMs = this.opts.thresholdMs;
    this.armTimer(this.remainingMs);
  }

  public pause(): void {
    if (this.timer !== null && this.armedAt !== null) {
      const elapsed = this.opts.monotonicNow() - this.armedAt;
      this.remainingMs = Math.max(0, this.remainingMs - elapsed);
      this.opts.clearTimeout(this.timer);
      this.timer = null;
      this.armedAt = null;
    }
  }

  public resume(): void {
    this.armTimer(this.remainingMs);
  }

  public dispose(): void {
    if (this.timer !== null) {
      this.opts.clearTimeout(this.timer);
      this.timer = null;
      this.armedAt = null;
    }
  }

  private armTimer(durationMs: number): void {
    if (this.timer !== null) {
      this.opts.clearTimeout(this.timer);
    }
    this.armedAt = this.opts.monotonicNow();
    this.timer = this.opts.setTimeout(() => {
      this.timer = null;
      this.armedAt = null;
      try {
        this.opts.onStall();
      } catch {
        // listener errors must not propagate
      }
    }, durationMs);
  }
}
