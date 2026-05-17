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
 *     task) call `arm()` BEFORE invoking `driveRun()`.
 *   - `driveRun()` consumes-and-resets the flag on its FIRST runner call
 *     via `consume()`. Subsequent iterations within the same drive
 *     invocation see `false`.
 *   - `restartActivePhase`, `startNew`, loop iterations, and bugfix-loop
 *     iterations MUST NOT arm the flag.
 *   - The flag is NEVER persisted — it lives only for the duration of
 *     one `driveRun` invocation.
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
   * and clears it. `driveRun()` calls this on the FIRST runner
   * invocation per drive cycle; subsequent loop iterations within
   * the same drive invocation see `false` because the bit was
   * cleared by that first call.
   */
  consume(): boolean {
    const was = this.armed;
    this.armed = false;
    return was;
  }
}
