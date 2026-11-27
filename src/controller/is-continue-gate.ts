/**
 * IsContinueGate — transient, never-persisted gate for the Claude CLI
 * `-c` (`--continue`) hint flag.
 *
 * Extracted from `SchegentWorkflowController` (feature 056 R5).
 *
 * Semantics (per CLAUDE.md hard rule for feature 032):
 *
 *   - Entry points that resume an existing conversation (`retryPhaseNow`,
 *     `resumeActivePhase`, breakpoint-resume, `resumeExistingFromActivation`
 *     when the persisted run has a non-null pause-cause or
 *     pending-retry-cause, cascaded-resume of a queue-paused-mid-run
 *     task) call `arm()` BEFORE invoking `RunDriver.drive()`.
 *   - `RunDriver.drive()` consumes-and-resets the flag on its FIRST runner call
 *     via `consume()`. Subsequent iterations within the same drive
 *     invocation see `false`.
 *   - `restartActivePhase`, `startNew`, loop iterations, and bugfix-loop
 *     iterations MUST NOT arm the flag. (These dispatches may use
 *     `sessionReuse` independently for cost optimization — see
 *     `PhaseRunInputs.sessionReuse` in `./phase-runner`.)
 *   - The flag is NEVER persisted — it lives only for the duration of
 *     one `RunDriver.drive()` invocation.
 *
 * The flag's lifecycle is intentionally tiny: the only reason this is
 * its own class (rather than two private fields) is to make the
 * arm-once / consume-once semantics impossible to misuse from the
 * outside.
 */
export class IsContinueGate {
  private armed = false;

  /**
   * Mark the gate so that the NEXT call to `consume()` will return
   * `true`. Idempotent: re-arming an already-armed gate is a no-op.
   * Subsequent runner calls within the same drive invocation will
   * still consume-and-reset on the first call.
   */
  arm(): void {
    this.armed = true;
  }

  /**
   * Atomic snapshot-and-reset. Returns whether the gate was armed
   * and clears it. `RunDriver.drive()` calls this on the FIRST runner
   * invocation per drive cycle; subsequent loop iterations within
   * the same drive invocation see `false` because the bit was
   * cleared by that first call.
   */
  consume(): boolean {
    const was = this.armed;
    this.armed = false;
    return was;
  }

  /**
   * Whether a drive still owes this gate a `consume()`.
   *
   * Code-review finding — read by `RunSessionRegistry.disposeIfEnded`, which
   * otherwise cannot tell a session that is finished from one holding an
   * un-consumed continuation. A predicate rather than exposing the field
   * because the arm-once/consume-once semantics are the point of this class:
   * callers may ask, and must still go through `consume()` or `disarm()` to
   * change the bit.
   */
  isArmed(): boolean {
    return this.armed;
  }

  /**
   * Drop an armed continuation that no drive will consume.
   *
   * Code-review finding — the resume entry points arm BEFORE the admission
   * checks that can still refuse (missing pipeline snapshot, declined consent).
   * A refused resume used to leave the bit set, so the queue's NEXT drive —
   * possibly a brand-new Task from `admitNew` — consumed a `true` armed for a
   * conversation it has nothing to do with, appending `-c` where the hard rule
   * forbids it. Distinct from `consume()` so the log of intent stays honest:
   * nothing continued here, the hint was abandoned.
   */
  disarm(): void {
    this.armed = false;
  }
}
