import type { AuditEntry } from '../audit/audit-entry';
import type { BackendPostureAdmittedPayload } from '../contracts/audit-events';
import type { BackendRunnerKind } from '../runner/backend-runner-factory';
import { containmentOf } from '../services/backend-containment-policy';

/**
 * FR-R3-064 — the per-run record of which backend a Run was admitted to.
 *
 * WHY A SEPARATE MODULE
 *
 * It began inside `PhaseRunner.run` and the LoC gate said no, correctly. The
 * coordinator shell forwards decisions it does not compute; this computes one —
 * read the posture, derive the classification, decide whether this pair has
 * already been recorded, write the entry. That is a responsibility, and feature
 * 057 already set the precedent for where one goes: `PhaseSidecarReader`,
 * `PhaseRetryEvaluator` and `PhaseOutcomeMapper` all came out of the same file
 * for the same reason.
 *
 * The decision this implements is recorded in
 * `docs/architecture/agent-capability-posture.md` — shape B, chosen over
 * narrowing the setting's description. Read that before changing anything here.
 */

/**
 * The uncontained-backends posture, read fresh at each emission.
 *
 * Same never-cached pattern as `PhaseRunner`'s four settings accessors, and here
 * it is load-bearing rather than conventional: `extension.ts` reads this setting
 * once at activation for the runner registry's construction-time refusal, and
 * reusing that boolean would record an activation-time posture for a Run
 * happening now — the cached-verdict defect FR-R3-056 finding 1 removed when it
 * deleted a runner held across a posture the operator can change.
 */
export interface BackendPostureAccessor {
  /** `schegent.backend.allowUncontainedBackends` as it reads right now. */
  isUncontainedAllowed(): boolean;
}

/** The envelope fields an entry needs, and nothing more. */
export interface PostureAuditContext {
  readonly runId: string;
  readonly phase: string;
  readonly iteration: number;
}

/**
 * How many (run id, backend kind) pairs the ledger remembers.
 *
 * DERIVED, not picked. The property that has to hold is that eviction can never
 * touch a pair belonging to a Run that is still live — otherwise a long Run's
 * later phase would re-record, and "once per Run" would depend on how busy the
 * window had been. The ceiling on simultaneously live pairs is the product of two
 * constants this repo already fixes:
 *
 *     MAX_QUEUES (20, `queue/queue-registry`) — a workspace cannot have more
 *       queues, and each runs at most one Task at a time, so no window can have
 *       more than 20 Runs in flight;
 *     SUPPORTED_BACKENDS.length (3) — the most distinct kinds one Run can reach.
 *
 * 20 x 3 = 60 live pairs at the absolute ceiling. 512 clears that eightfold, and
 * the remainder is headroom for FINISHED Runs whose pairs the ledger still holds
 * within one activation. `phase-runner-backend-posture` asserts the 60-pair floor
 * against those two constants rather than against this literal, so widening
 * either one fails the assertion instead of shrinking the margin unnoticed.
 */
export const POSTURE_LEDGER_MAX_PAIRS = 512;

/**
 * Separates the two halves of a ledger key.
 *
 * NUL, and the reason is a collision this must not have. A run id is not a
 * constrained string as far as this module is concerned, so a separator that a
 * run id could itself contain makes `runId + sep + kind` ambiguous — and an
 * ambiguous key means one Run's entry can satisfy the ledger for a DIFFERENT
 * Run, suppressing a record that the setting's description promises. NUL cannot
 * appear in a `BackendRunnerKind` (all are `[a-z]+`) and cannot appear in a run
 * id that survived JSON round-tripping, so the split is unambiguous by
 * construction rather than by argument. `phase-runner-backend-posture` asserts
 * the kind half of that against `SUPPORTED_BACKENDS` rather than trusting this
 * comment.
 */
export const LEDGER_KEY_SEPARATOR = '\u0000';

export class BackendPostureRecorder {
  /**
   * (run id, backend kind) pairs this activation has already recorded.
   * Insertion-ordered, capped, first-in eviction.
   *
   * Never persisted: a durable "already recorded" flag would be a posture
   * decision cached across a restart, which is exactly what this feature refuses
   * to do. A Run resumed in a fresh host therefore records again from a fresh
   * read, and that is the intended behaviour rather than a tolerated duplicate.
   *
   * The failure direction is what makes the bound safe rather than a risk: a miss
   * in this set means "emit", so an evicted pair can only ever cause a SECOND
   * entry for a long-finished Run, never a missing one.
   */
  private readonly recorded = new Set<string>();

  constructor(
    private readonly accessor: BackendPostureAccessor | null,
    /**
     * The caller's required-evidence append. Injected rather than reimplemented,
     * so there is one definition of what "required" means: the throw that stops a
     * phase proceeding unrecorded lives with the writer, not in two places.
     */
    private readonly appendRequired: (
      entry: Omit<AuditEntry, 'id' | 'timestamp'>
    ) => Promise<AuditEntry>
  ) {}

  /**
   * Record which backend this Run was admitted to, once.
   *
   * "Once" is per (run id, backend kind) per activation, NOT per Run. A Run may
   * override its backend per phase; recording only the first kind would leave the
   * manifest's promise false for the second, which is the defect this closes. For
   * a Run on one backend — the ordinary case — this is exactly one entry, and it
   * is never one per phase.
   *
   * The entry is REQUIRED evidence: a Run that cannot record that it is about to
   * drive an unbounded agent does not proceed unrecorded. No new failure mode —
   * an audit writer that cannot append fails the same phase at `phase-start`.
   */
  public async recordOnce(
    context: PostureAuditContext,
    runner: BackendRunnerKind
  ): Promise<void> {
    if (!this.accessor) return;
    const key = `${context.runId}${LEDGER_KEY_SEPARATOR}${runner}`;
    if (this.recorded.has(key)) return;
    const payload: BackendPostureAdmittedPayload = {
      runner,
      // Derived from the policy, never passed in, so the recorded classification
      // cannot disagree with the one the refusal enforces.
      containment: containmentOf(runner),
      // Read now. See `BackendPostureAccessor` for why not the registry's value.
      uncontainedAllowed: this.accessor.isUncontainedAllowed()
    };
    await this.appendRequired({
      runId: context.runId,
      phase: context.phase,
      iteration: context.iteration,
      eventType: 'backend-posture-admitted',
      // Spread, not a cast: a closed interface has no index signature, so it is
      // not assignable to the writer's `Record<string, unknown>`. The spread
      // satisfies that without `as unknown as`, and it is here so a later reader
      // does not "simplify" it back into a compile error.
      payload: { ...payload },
      outcome: 'info'
    });
    // Marked only AFTER a successful append. Marking first would let a failed
    // append suppress the retry on the next phase, turning required evidence into
    // evidence that is required once and then optional.
    if (this.recorded.size >= POSTURE_LEDGER_MAX_PAIRS) {
      // Insertion-ordered: the first key is the oldest.
      const oldest = this.recorded.values().next();
      if (!oldest.done) this.recorded.delete(oldest.value);
    }
    this.recorded.add(key);
  }
}
