// FR-R3-103 (FR-042, FR-043, FR-044, FR-048) — decide whether to resume a persisted
// in-flight Run, and record which case applied.
//
// THE RACE THIS CLOSES. Activation resumed every persisted in-flight Run with no check that
// the previous host's process tree was dead. Children are spawned detached (deliberately, so
// the terminate ladder reaches descendants) and no identity was ever persisted, so after a
// host crash the resumed phase and the orphaned CLI both operated on one shared working tree.
// The ownership fence protects Memento writes; it says nothing about the tree, and the tree is
// what the CLI mutates.
//
// WHAT IT DOES NOT DO. On `alive` it declines and SURFACES. It does not kill the orphan and it
// does not reattach: FR-R3-103 §3.2 calls reattach-or-kill "a design decision to record, not
// to default", and both are destructive in a way a resume is not — killing discards work in
// progress, reattaching claims a child this host never spawned. Declining is the option that
// loses nothing, and the operator is told the Run is executing elsewhere.
//
// WHY A MODULE. It was a closure inside `extension.ts` first, and the LoC ratchet refused it —
// correctly, because the activation shell should make a call, not hold a policy. Same reasoning
// `drop-reporting-transport.ts` records.
import type { LivenessVerdict, SpawnIdentity } from '../contracts/spawn-identity';
import { RESUME_ON } from '../contracts/spawn-identity';
import type { RunResumeEventType, RunResumePayload } from '../contracts/audit-events';

export interface ResumeCandidate {
  readonly queueId: string;
  readonly runId: string;
  readonly spawnIdentity?: SpawnIdentity;
}

export interface ResumeDecision {
  readonly resume: boolean;
  readonly liveness: LivenessVerdict;
  readonly eventType: RunResumeEventType;
  readonly payload: RunResumePayload;
}

/**
 * The decision, pure over a liveness verdict.
 *
 * Separated from the probe so every arm is exercised without a process: a resume decision that
 * can only be tested by crashing a host is a decision nobody tests. `process-liveness.ts` owns
 * the probing and this owns the consequence.
 */
export function decideResume(
  candidate: ResumeCandidate,
  liveness: LivenessVerdict
): ResumeDecision {
  const payload: RunResumePayload = {
    queueId: candidate.queueId,
    runId: candidate.runId,
    liveness
  };
  if (!RESUME_ON.includes(liveness)) {
    return {
      resume: false,
      liveness,
      eventType: 'run-resume-declined-orphan-alive',
      payload
    };
  }
  return { resume: true, liveness, eventType: 'run-resumed', payload };
}

/** The operator-facing sentence for a declined resume. Kept here so the wording is one thing. */
export function declineMessage(candidate: ResumeCandidate): string {
  return (
    `Schegent: the run on queue "${candidate.queueId}" is still executing in another window ` +
    'or process, so this window did not resume it. Close the other window, or end that ' +
    'process, and reload.'
  );
}

/** What the activation walk needs. Narrow on purpose, so a test supplies four fakes. */
export interface ResumeWalkDeps {
  /**
   * The Runs to consider, ALREADY filtered to the in-flight ones.
   *
   * Filtering is the caller's job deliberately. `AGENTS.md` forbids the status literal outside
   * the pinned projection paths, and a module that compared `status` here would be a second
   * place that knows the status vocabulary — which is both the hard rule and the better
   * design: this module's question is "is something still holding the tree", not "what state
   * is this Run in".
   */
  readonly runs: () => ReadonlyArray<
    readonly [string, { readonly id: string; readonly currentPhase: string; readonly currentIteration: number; readonly spawnIdentity?: SpawnIdentity }]
  >;
  readonly liveness: (identity: SpawnIdentity | undefined) => Promise<LivenessVerdict>;
  readonly appendAudit: (entry: {
    readonly runId: string;
    readonly phase: string;
    readonly iteration: number;
    readonly eventType: RunResumeEventType;
    readonly payload: RunResumePayload;
    readonly outcome: 'info' | 'failure';
  }) => Promise<void>;
  readonly resume: (queueId: string) => void;
  readonly notify: (message: string) => void;
  readonly log: (message: string) => void;
}

/**
 * Walk the candidate Runs and resume the ones nothing is still holding.
 *
 * Lives here rather than in `extension.ts` because the LoC ratchet refused it there — 32 lines
 * over — and the refusal was right: this is a policy about whether to enter a shared worktree,
 * not activation wiring. The shell now calls it.
 *
 * An audit failure never decides whether a Run resumes: the append is awaited so ordering is
 * observable, and its rejection is swallowed. Evidence about the decision must not be able to
 * change the decision.
 */
export async function resumePersistedRuns(deps: ResumeWalkDeps): Promise<void> {
  for (const [queueId, run] of deps.runs()) {
    const candidate: ResumeCandidate = {
      queueId,
      runId: run.id,
      ...(run.spawnIdentity ? { spawnIdentity: run.spawnIdentity } : {})
    };
    const decision = decideResume(candidate, await deps.liveness(candidate.spawnIdentity));
    await deps
      .appendAudit({
        runId: run.id,
        phase: run.currentPhase,
        iteration: run.currentIteration,
        eventType: decision.eventType,
        payload: decision.payload,
        outcome: decision.resume ? 'info' : 'failure'
      })
      .catch(() => {
        /* evidence about a decision must not change the decision */
      });
    if (!decision.resume) {
      deps.log(`activation: declined to resume run ${run.id} — its process tree is alive`);
      deps.notify(declineMessage(candidate));
      continue;
    }
    deps.log(`activation: resuming run ${run.id} at ${run.currentPhase}`);
    deps.resume(queueId);
  }
}
