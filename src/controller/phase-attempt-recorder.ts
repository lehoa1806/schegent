import type { AuditEntry } from '../audit/audit-entry';
import type { AuditOutcome } from '../contracts/audit-events';
import type { PhaseEndOutcome } from '../audit/audit-payload';
import type { TerminationReason } from '../state/workflow-run';

/**
 * Feature 212 (FR-001, FR-002, FR-015) — the single site that owns both ends of
 * one attempt to run a phase.
 *
 * WHY A SEPARATE MODULE
 *
 * The same reason `BackendPostureRecorder` is one, and the same gate said so:
 * `phase-runner.ts` is a coordinator shell that forwards decisions it does not
 * compute, and this computes several — which attempt a terminal record belongs
 * to, whether that attempt is still open, and which envelope-level outcome a
 * never-spawned or cancelled attempt records. FR-015 also requires the pairing
 * invariant to be enforced at ONE site rather than reconstructed afterwards by a
 * sweep, and a responsibility stated once needs somewhere to live.
 *
 * WHAT IT DOES NOT DO
 *
 * It mints nothing. The attempt identifier is the `phase-start` row's own
 * `AuditEntry.id` — a `randomUUID()` the writer already generates
 * (`src/audit/audit-log-writer.ts:317`) and hands back, and which the runner
 * discarded. A second identifier would be a second thing that can disagree.
 *
 * It opens no second write path. Everything goes through the caller's injected
 * required-evidence append, which is `PhaseRunner`'s own `appendRequiredAudit` →
 * `auditWriter.append` — hard rule 21, and FR-010.
 *
 * It reads nothing back. No stream diagnostics, no raw transcript, no salvage of
 * a discarded result (FR-013). Every fact on a terminal record is passed in by
 * the caller that observed it.
 */

/** The envelope fields an entry needs, and nothing more. */
export interface AttemptAuditContext {
  readonly runId: string;
  readonly phase: string;
  readonly iteration: number;
}

/**
 * What the caller observed about how the attempt ended.
 *
 * `resultEnvelope` is OPTIONAL and omitting it is meaningful: per FR-014 a
 * missing field means UNKNOWN, permanently, and must never be defaulted to
 * either value. A caller that did not observe the envelope leaves it out rather
 * than guessing `'absent'` — "we never looked" and "we looked and nothing came"
 * are different facts, and only the second one is `'absent'`.
 *
 * The file and command counts are deliberately NOT fields here. They ride in
 * `payload` when the caller parsed an audit block and are simply absent when it
 * did not, which is what lets `projectPhaseEnd` omit all three derived counts
 * together (FR-009). Declaring them here with a numeric type would invite a
 * caller to pass the zero this feature exists to stop recording.
 */
export interface TerminalRecordInputs {
  readonly outcome: PhaseEndOutcome;
  readonly terminationReason: TerminationReason;
  readonly resultEnvelope?: 'received' | 'absent';
  /** The rest of the `phase-end` payload, exactly as the caller assembled it. */
  readonly payload?: Record<string, unknown>;
}

/**
 * The envelope-level `AuditEntry.outcome` for a terminal record.
 *
 * Fixed here, in code, rather than left to each call site: `AuditOutcome` is
 * required and closed (`'success' | 'failure' | 'info'`,
 * `src/contracts/audit-events.ts:1417`), no FR names which one a never-spawned or
 * cancelled attempt records, and this feature ADDS both populations to every
 * census taken over `phase-end` outcomes. A value decided per call site is a
 * value that will be decided differently.
 *
 * Two cases are named ahead of the standing mapping, and only one of them
 * diverges from it:
 *
 *   - Pre-spawn refusal → `'failure'`. The attempt did fail. This AGREES with
 *     the standing mapping (the path's own `outcome` is `failed`) and with the
 *     existing cap-exhausted write in `PhaseRunner.appendCapExhaustedPhaseEnd`;
 *     it is stated explicitly anyway so a test can assert it rather than infer
 *     it.
 *   - Cancellation → `'info'`, deliberately NOT `'failure'`. The standing
 *     mapping would say `'failure'`, because the cancel arm — the
 *     `raw.killed && raw.exitCode === null` branch of `PhaseRunner.runInner` —
 *     sets `outcome: 'failed'`. Do not follow it: the system's own existing
 *     statement about a cancel is `'info'`, written on the `cancel` row that
 *     same branch appends. Cancellation writes no `phase-end` today, so
 *     recording it as `'failure'` would silently reclassify every operator
 *     cancel as a system failure the first time this feature ships. The phase's
 *     own non-clean result stays legible in `payload.outcome` and
 *     `terminationReason: 'cancel'` — the same split the `cancel` row already
 *     uses.
 *
 * Everything else keeps the standing mapping verbatim — the
 * `outcome === 'clean' ? 'success' : outcome === 'failed' ? 'failure' : 'info'`
 * ternary the ordinary arm of `PhaseRunner.runInner` passes to
 * `appendPhaseEnd` — so this function is not a second opinion about the
 * ordinary paths.
 *
 * Cited by symbol, not by line. Feature 212 grew `phase-runner.ts` by 273 lines
 * and moved every one of these anchors; a re-derived number would be wrong again
 * on the next edit to that file, and a wrong citation is worse than none because
 * it is read as checked.
 */
export function terminalAuditOutcome(
  outcome: PhaseEndOutcome,
  terminationReason: TerminationReason
): AuditOutcome {
  if (terminationReason === 'cancel') return 'info';
  if (terminationReason === 'pre_spawn_refusal') return 'failure';
  return outcome === 'clean' ? 'success' : outcome === 'failed' ? 'failure' : 'info';
}

/**
 * One recorded attempt, and the right to close it exactly once.
 *
 * Not constructed directly — `PhaseAttemptRecorder.begin()` hands one back after
 * the `phase-start` row exists, so an instance always carries a real identifier
 * rather than a promise of one.
 */
export class PhaseAttempt {
  /**
   * Whether the terminal record for this attempt has been claimed.
   *
   * Claimed SYNCHRONOUSLY, before any `await`, by whichever caller gets there
   * first. That is what makes "at most one" hold rather than merely be likely:
   * the losing caller is refused deterministically instead of racing through an
   * append that the winner is already inside.
   *
   * Never un-claimed, including when the append fails. An append that threw may
   * or may not have reached disk, so retrying it risks a SECOND terminal record
   * — and a duplicate is worse than the absence here, because FR-003 forbids
   * order-based pairing precisely so that a missing record stays detectable.
   */
  private closed = false;

  /**
   * The id of the row that closed this attempt, once one has.
   *
   * Private with a read-only getter, like `closed`/`isClosed` beside it. This is
   * the record of WHICH row closed the attempt — the pairing fact the class
   * exists to keep true — so it is not state a holder of a `PhaseAttempt` gets
   * to rewrite. `null` while claimed-but-not-yet-written is a real state; see
   * `markClosedBy`.
   */
  private closedBy: string | null = null;

  public get terminalEntryId(): string | null {
    return this.closedBy;
  }

  constructor(
    /**
     * The `phase-start` row's `AuditEntry.id`. FR-002's attempt identifier: it is
     * unique because the writer mints it per row, which is what makes pairing
     * survive the case `(runId, phase, iteration)` cannot — four distinct
     * attempts under one such triple in the retained logs.
     */
    public readonly attemptId: string,
    private readonly context: AttemptAuditContext,
    private readonly appendRequired: (
      entry: Omit<AuditEntry, 'id' | 'timestamp'>
    ) => Promise<AuditEntry>,
    private readonly logger: { warn(message: string): void }
  ) {}

  public get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Claim the attempt on behalf of a caller that writes its own terminal record.
   *
   * The five arms of `PhaseRunner.run()` that already append their own
   * `phase-end` keep doing so; this is how they tell the shared `finally` seam
   * that the attempt is spoken for. Without it that seam would write a SECOND
   * terminal record on the most common paths in the retained logs.
   *
   * Returns whether THIS call claimed it, so a caller can tell "I closed it"
   * from "it was already closed" without reading the flag separately.
   */
  public markClosedBy(terminalEntryId: string | null): boolean {
    if (this.closed) return false;
    this.closed = true;
    this.closedBy = terminalEntryId;
    return true;
  }

  /**
   * Name the row that closed this attempt, for a caller that claimed it BEFORE
   * writing and so had no id to give `markClosedBy` yet.
   *
   * That order is the point, not an inconvenience. `AuditLogWriter.append` is
   * bounded for the caller (`APPEND_TIMEOUT_MS`), and `src/lib/io-barrier.ts`
   * states what the bound means: a rejection says "you were not told this
   * landed", NOT that the write was abandoned. A caller that claimed only on
   * success would therefore leave the attempt open for a row that is still on
   * its way to disk, and the `finally` seam would write a SECOND terminal
   * record for it — the "satisfied twice" ambiguity FR-003 exists to prevent,
   * and strictly worse than the gap this feature removes.
   *
   * Never un-claims and never overwrites an id already recorded: this only ever
   * fills in the blank `markClosedBy(null)` left.
   */
  public recordTerminalEntryId(terminalEntryId: string): void {
    if (this.closedBy === null) this.closedBy = terminalEntryId;
  }

  /**
   * Write the terminal record, if this attempt is still open.
   *
   * Returns the written entry, or `null` when the attempt was already closed —
   * closing a closed attempt does nothing and is not an error. That is what
   * lets the runner call this unconditionally from one `finally` block while
   * five arms still write their own.
   *
   * NEVER THROWS. The seam this is called from is a `finally`, and an exception
   * raised inside a `finally` REPLACES the exception already propagating — so a
   * failed audit append here would swallow the very refusal the record exists to
   * report, and the caller would see an audit error where a backend refusal
   * should have been. The write failure is contained and surfaced as a
   * diagnostic instead (FR-001 holds for every path the host survives; a dead
   * audit writer is not one, and it already fails the phase at `phase-start`).
   */
  public async close(inputs: TerminalRecordInputs): Promise<AuditEntry | null> {
    if (this.closed) return null;
    this.closed = true;
    try {
      const entry = await this.appendRequired({
        runId: this.context.runId,
        phase: this.context.phase,
        iteration: this.context.iteration,
        eventType: 'phase-end',
        payload: {
          // The caller's payload first, so the four fields below cannot be
          // overwritten by a stray key in it. `attemptId` in particular is the
          // pairing identifier: a caller able to replace it could produce a
          // terminal record that pairs to a different attempt, which is the one
          // failure this module exists to make impossible.
          ...(inputs.payload ?? {}),
          attemptId: this.attemptId,
          outcome: inputs.outcome,
          terminationReason: inputs.terminationReason,
          // Omitted when unknown, never defaulted — see `TerminalRecordInputs`.
          ...(inputs.resultEnvelope !== undefined
            ? { resultEnvelope: inputs.resultEnvelope }
            : {})
        },
        outcome: terminalAuditOutcome(inputs.outcome, inputs.terminationReason)
      });
      this.closedBy = entry.id;
      return entry;
    } catch {
      // The identifier, not the payload: this line is a diagnostic about a
      // failed audit write, and it must not become a second, unredacted copy of
      // the evidence the writer just refused.
      //
      // Wrapped, because a throw HERE is not covered by the try above — a catch
      // block is outside its own guard — and this method is reached from a
      // `finally`. The logger arrives as a structural `{ warn }` and TypeScript
      // has no effect type, so the signature cannot promise the injected
      // implementation returns. `SanitizedLogger` is total today; the contract
      // this method advertises must not depend on which logger was passed.
      // Nothing is reported when even reporting fails: the alternative is to
      // replace a backend refusal with a logging error, which is the exact
      // substitution the NEVER THROWS note above exists to prevent.
      try {
        this.logger.warn(
          `phase-attempt-recorder: terminal record unavailable for attempt ${this.attemptId}`
        );
      } catch {
        // Intentionally empty — see above.
      }
      return null;
    }
  }
}

/**
 * Opens attempts and hands back the right to close them.
 *
 * Holds no ledger. An attempt's open/closed state lives on the `PhaseAttempt`
 * the caller is already holding, so there is no table to evict from and no way
 * for one Run's entry to satisfy the invariant for another.
 */
export class PhaseAttemptRecorder {
  constructor(
    /**
     * The caller's required-evidence append. Injected rather than reimplemented,
     * so there is one definition of what "required" means — the same reason
     * `BackendPostureRecorder` takes it.
     */
    private readonly appendRequired: (
      entry: Omit<AuditEntry, 'id' | 'timestamp'>
    ) => Promise<AuditEntry>,
    private readonly logger: { warn(message: string): void }
  ) {}

  /**
   * Record the attempt and take its identifier from the row that recorded it.
   *
   * Deliberately NOT contained: a `phase-start` that cannot be written already
   * stops the phase today, and that is the correct behaviour — a phase does not
   * proceed unrecorded. It also keeps the pairing invariant true rather than
   * merely enforced, because an attempt that was never recorded needs no
   * terminal record to pair with.
   */
  public async begin(
    context: AttemptAuditContext,
    payload: Record<string, unknown>
  ): Promise<PhaseAttempt> {
    const entry = await this.appendRequired({
      runId: context.runId,
      phase: context.phase,
      iteration: context.iteration,
      eventType: 'phase-start',
      payload,
      outcome: 'info'
    });
    return new PhaseAttempt(entry.id, context, this.appendRequired, this.logger);
  }
}
