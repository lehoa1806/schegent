// FR-R3-103 (FR-041, FR-045) — who is holding the working tree, in a form a later host
// can check.
//
// THE GAP THIS CLOSES. Children are spawned detached — deliberately, so the terminate
// ladder can reach descendants — and **no process identity was ever persisted**. Pids
// existed only in memory, in audit payloads, and in temp-file names. So when the extension
// host died mid-phase, activation resumed every persisted in-flight Run with no way to ask
// whether the previous host's process tree was still alive, and the resumed phase raced the
// orphan in one shared worktree.
//
// The ownership fence protects Memento writes. It says nothing about the tree, and the tree
// is what the CLI actually mutates.
//
// WHY A TRIPLE AND NOT A PID. Pids are recycled, and on a busy machine they are recycled
// fast. `kill(pid, 0)` against a recycled pid answers "alive" about a process that has
// nothing to do with this Run — and the consequence of that false positive is refusing to
// resume a Run that is genuinely abandoned, forever. The start timestamp is what makes the
// question answerable about *that* process: a recycled pid has a later start time than the
// one recorded.
//
// `pgid` is carried because the termination ladder signals the GROUP, and by the time an
// orphan is found its group is what has to be reached. Deriving it from the pid at that
// point would assume the child is still its own group leader, which is exactly what a
// re-parented descendant is not.
//
// This module imports nothing, on purpose. It is a leaf.

/**
 * The identity of one live invocation's process tree.
 *
 * Persisted beside its Run record at spawn and cleared when the child is reaped, so its
 * presence means a tree was live when this record was last written — not that one is live
 * now, which is the question `LivenessVerdict` answers.
 */
export interface SpawnIdentity {
  /** The direct child's process id. Recyclable, which is why it is not the whole identity. */
  readonly pid: number;
  /**
   * The process GROUP the terminate ladder signals.
   *
   * Equal to `pid` for a detached POSIX spawn, and carried separately anyway: on Windows
   * `detached` is false, so the two are not the same question, and a reader must not have to
   * know which platform wrote the record.
   */
  readonly pgid: number;
  /**
   * Epoch milliseconds at spawn.
   *
   * The discriminator. Compared with a tolerance rather than for equality, because the
   * recorded value is the host's clock at spawn and any figure the OS reports for process
   * start time is its own measurement of a slightly different moment.
   */
  readonly startedAtMs: number;
}

/**
 * What a liveness check concluded.
 *
 * Four arms, and the fourth is the one that matters. `unanswerable` is NOT folded into
 * `dead`: a platform that cannot answer must not be recorded as having answered, and an
 * operator reading the audit trail needs to tell "we checked and it is gone" from "we could
 * not check". They lead to the same resume decision today — see `RESUME_ON` — and that is a
 * decision, recorded as one, rather than a conflation baked into the type.
 */
export type LivenessVerdict = 'alive' | 'dead' | 'unrecorded' | 'unanswerable';

/**
 * The verdicts that permit a resume.
 *
 * `unanswerable` is included deliberately. Refusing every resume on a platform that cannot
 * answer would strand Runs exactly where the mechanism is weakest — Windows, where
 * `detached` is already false and the job-object gap is a stated permanent limit — and a
 * mechanism whose failure mode is "nothing ever resumes here" would be turned off. The audit
 * trail records which verdict applied, so an operator can see that the check could not
 * answer rather than inferring it from a resume that looks ordinary.
 */
export const RESUME_ON: ReadonlyArray<LivenessVerdict> = Object.freeze([
  'dead',
  'unrecorded',
  'unanswerable'
]);

/**
 * How far apart the recorded start time and an observed one may be and still be the same
 * process.
 *
 * The recorded value is the host's `Date.now()` immediately before `spawn` returns; any
 * observed value comes from the OS, measured at a slightly different instant and often at
 * coarser resolution. Two seconds is wide enough to absorb that and far narrower than the
 * window in which a pid could plausibly be recycled into a process that also matches.
 */
export const START_TIME_TOLERANCE_MS = 2_000;

/** Whether an observed process start time can be the recorded one. */
export function startTimesMatch(recordedMs: number, observedMs: number): boolean {
  return Math.abs(recordedMs - observedMs) <= START_TIME_TOLERANCE_MS;
}
