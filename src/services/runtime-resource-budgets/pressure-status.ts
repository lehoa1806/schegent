/**
 * Hysteresis and rate-limited warning tracker for user-visible resource pressure statuses
 * (`FR-017`, `F03-AC-05`).
 *
 * Host-side state machine only (clarification Q4); zero `vscode` imports.
 * - Raises status when `value >= raiseAt`.
 * - Clears status only after a measured sample confirms `value <= clearAt` (`clearAt <= raiseAt`).
 * - Rate-limits repeated warning emissions across `minWarningIntervalMs` while counting
 *   suppressed warnings during flapping.
 */

export interface PressureStatusOptions {
  readonly id: string;
  readonly raiseAt: number;
  readonly clearAt: number;
  readonly minWarningIntervalMs: number;
}

export interface PressureObservationResult {
  readonly status: 'clear' | 'raised';
  readonly transition: 'raised' | 'cleared' | null;
  readonly warningEmitted: boolean;
  readonly suppressedWarnings: number;
  readonly lastObservedValue: number;
}

export class PressureStatusTracker {
  private readonly id: string;
  private readonly raiseAt: number;
  private readonly clearAt: number;
  private readonly minWarningIntervalMs: number;
  private currentStatus: 'clear' | 'raised' = 'clear';
  private lastWarningAtMs: number | null = null;
  private suppressedWarnings = 0;
  private lastObservedValue = 0;

  constructor(options: PressureStatusOptions) {
    if (!Number.isFinite(options.raiseAt) || !Number.isFinite(options.clearAt)) {
      throw new Error(`PressureStatusTracker(${options.id}): raiseAt and clearAt must be finite.`);
    }
    if (options.clearAt > options.raiseAt) {
      throw new Error(
        `PressureStatusTracker(${options.id}): clearAt (${options.clearAt}) must be <= raiseAt (${options.raiseAt}).`
      );
    }
    if (!Number.isFinite(options.minWarningIntervalMs) || options.minWarningIntervalMs < 0) {
      throw new Error(
        `PressureStatusTracker(${options.id}): minWarningIntervalMs must be a non-negative finite number.`
      );
    }
    this.id = options.id;
    this.raiseAt = options.raiseAt;
    this.clearAt = options.clearAt;
    this.minWarningIntervalMs = options.minWarningIntervalMs;
  }

  observe(value: number, nowMs: number): PressureObservationResult {
    if (!Number.isFinite(value)) {
      throw new Error(`PressureStatusTracker(${this.id}): observed value must be finite.`);
    }
    this.lastObservedValue = value;
    let transition: 'raised' | 'cleared' | null = null;
    let warningEmitted = false;

    if (this.currentStatus === 'clear' && value >= this.raiseAt) {
      this.currentStatus = 'raised';
      transition = 'raised';
      if (
        this.lastWarningAtMs === null ||
        nowMs - this.lastWarningAtMs >= this.minWarningIntervalMs
      ) {
        warningEmitted = true;
        this.lastWarningAtMs = nowMs;
      } else {
        this.suppressedWarnings += 1;
      }
    } else if (this.currentStatus === 'raised' && value <= this.clearAt) {
      this.currentStatus = 'clear';
      transition = 'cleared';
    } else if (this.currentStatus === 'raised' && value >= this.raiseAt) {
      if (
        this.lastWarningAtMs === null ||
        nowMs - this.lastWarningAtMs >= this.minWarningIntervalMs
      ) {
        warningEmitted = true;
        this.lastWarningAtMs = nowMs;
      } else {
        this.suppressedWarnings += 1;
      }
    }

    return {
      status: this.currentStatus,
      transition,
      warningEmitted,
      suppressedWarnings: this.suppressedWarnings,
      lastObservedValue: this.lastObservedValue
    };
  }

  get state() {
    return {
      id: this.id,
      status: this.currentStatus,
      raiseAt: this.raiseAt,
      clearAt: this.clearAt,
      minWarningIntervalMs: this.minWarningIntervalMs,
      suppressedWarnings: this.suppressedWarnings,
      lastObservedValue: this.lastObservedValue
    };
  }
}

