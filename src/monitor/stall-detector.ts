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

  /**
   * Output arrived on a stream that counts as liveness — rearm.
   *
   * FR-R3-106 (FR-072) — the detector's only rearm input used to be stdout, from a single
   * call site inside `onStdoutChunk`. `onStderrChunk` never touched it, so a CLI doing
   * legitimate stderr-only work was declared stalled at the threshold and **stayed**
   * declared: the recovery branch that clears a stall existed only on the stdout path too.
   * A build that logs progress to stderr is a normal program, and the product called it
   * stuck.
   *
   * Named for activity rather than for a stream, because the detector's question is "is
   * this child doing anything", and which pipe the answer came down is not its business.
   */
  public noteActivity(): void {
    this.remainingMs = this.opts.thresholdMs;
    this.armTimer(this.remainingMs);
  }

  /**
   * Retained name for the stdout call site.
   *
   * Kept as an alias rather than renamed at every caller: the rename would touch files this
   * item has no other reason to change, and `noteActivity` is the name that says what the
   * method now means.
   */
  public noteStdoutChunk(): void {
    this.noteActivity();
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
