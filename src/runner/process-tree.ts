import { spawn, type ChildProcess } from 'node:child_process';
import type {
  MonitorSidecarEvent,
  RunnerLabel,
  TreeAttribution
} from '../contracts/backend-runner';

/**
 * FR-R3-054 (H-05) — own the backend process tree, not just the direct child.
 *
 * The escalation ladder called `child.kill(signal)`, which signals one process.
 * No `detached`, process group, `setsid` or Job Object existed anywhere in `src`.
 * A CLI tool that forks a helper therefore survived cancel, timeout, aggressive
 * pause and deactivation, and could keep mutating the workspace after Schegent
 * had recorded a terminal state -- racing rollback, retry, recovery and the next
 * phase.
 *
 * Demonstrated in `tests/unit/runner/process-tree.test.ts`: a grandchild
 * appending to a sentinel file keeps appending after the direct child is
 * SIGKILLed.
 */

/**
 * Spawn options that give the backend its own process group, so the whole tree
 * can be signalled at once.
 *
 * POSIX: `detached: true` makes the child a process group leader, and
 * `process.kill(-pid, …)` then reaches every descendant. The parent still awaits
 * it -- `unref()` is deliberately NOT called, because the goal is to OWN the
 * tree, not to disown the child.
 *
 * Windows: there is no process group to create. `detached` there controls
 * console allocation, not lifetime, and asking for it would suggest a guarantee
 * that does not exist. The tree is reached with `taskkill /T` instead, which is
 * the well-audited equivalent named in the requirement.
 *
 * A real Job Object with kill-on-close is stronger — it cannot be escaped by a process that
 * re-parents itself — and needs a native binding. FR-R3-083 asked that question once for the four
 * residuals that share it: `docs/architecture/native-binding-decision.md`. The answer is **no**, so
 * `taskkill /T` is not a stopgap awaiting a better one; it is what this product ships, and the
 * re-parenting escape is a PERMANENT stated limit. `docs/operations/backends.md` step 6 says so to
 * operators.
 */
export function processTreeSpawnOptions(): { readonly detached: boolean } {
  return { detached: process.platform !== 'win32' };
}

/**
 * Signal the child's whole tree, preserving the caller's escalation ladder.
 *
 * Signals the group AND the direct child. Not a fallback -- both, every time.
 * A child with no group of its own (an injected double, or a path this migration
 * has not reached) must still receive the signal, and a real child already
 * reaped via its group simply reports ESRCH for the second one.
 */
export async function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals
): Promise<void> {
  const pid = child.pid;

  // The GROUP first, where there is one. Best-effort by design: a child spawned
  // without `detached` -- an injected double, or a path not yet migrated -- has no
  // group of its own, and `process.kill(-pid)` there fails rather than doing
  // something surprising.
  if (pid !== undefined) {
    if (process.platform === 'win32') {
      await killWindowsTree(pid, signal);
    } else {
      try {
        // Negative pid means "the group whose leader is pid".
        process.kill(-pid, signal);
      } catch {
        /* no group, already gone, or not ours -- the direct signal below stands */
      }
    }
  }

  // The direct child, ALWAYS, and not only as a fallback. Signalling a process
  // already killed via its group throws ESRCH and is swallowed, so this costs
  // nothing there -- while omitting it broke every runner test whose fake child
  // has no real group, and would equally break a real child spawned by a path
  // this migration has not reached.
  try {
    child.kill(signal);
  } catch {
    /* already exited */
  }
}

/**
 * Has the direct child finished?
 *
 * `exitCode !== null || signalCode !== null`, and the second half is not optional:
 * a child killed by SIGTERM — the ORDINARY cancel outcome — reports
 * `exitCode === null, signalCode === 'SIGTERM'`. A guard testing `exitCode` alone
 * therefore never fires on the commonest path, which is how a "skip when the child
 * is gone" check came to escalate against every cleanly-reaped child.
 *
 * THIS IS ALSO THE LADDER'S SIGNAL GATE, and it is deliberately the whole rule
 * rather than "reaped and the group looks gone".
 *
 * The tempting version escalates while the group still answers, so that a CLI which
 * handles SIGTERM and exits — leaving a forked helper that ignores it — still gets
 * its group SIGKILLed. That case is real and it is what FR-R3-054 was written for.
 * But the address the ladder would use is the exited child's pid, and once Node has
 * reaped the child that pid is the operating system's to reuse: a new group leader
 * can hold it, `kill(-pid, 0)` answers "alive" about a stranger, and the ladder
 * would SIGKILL that stranger's whole tree. On Windows `taskkill /pid <pid> /T /F`
 * is the same hazard with none of the pgid reservation to soften it.
 *
 * Killing an unrelated process tree is worse than missing a kill, so the safety
 * property that held before this feature — a reaped child is never signalled — is
 * kept. What is lost is a helper that outlives its parent: the same shape as the
 * `setsid` and re-parenting escapes `docs/architecture/native-binding-decision.md`
 * records as permanent, and named as such in `docs/operations/backends.md`.
 *
 * It gates SIGNALLING only. Whether to REPORT is a different question with a
 * different cost, decided at `confirmOrReport`.
 */
export function childIsReaped(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}


/**
 * Whether the tree is gone. This is what lets a phase finalize honestly: a
 * terminal state recorded while descendants are still running is a terminal
 * state that lies.
 *
 * Signal 0 checks for existence without delivering anything. On Windows there is
 * no group to probe, so this answers only for the direct child and callers must
 * treat a `true` there as "the child is gone", not "the tree is".
 */
export function processTreeIsGone(child: ChildProcess): boolean {
  const pid = child.pid;
  if (pid === undefined) return true;
  const target = process.platform === 'win32' ? pid : -pid;
  try {
    process.kill(target, 0);
    return false;
  } catch (error) {
    // EPERM means it exists and is not ours -- still not gone.
    return errnoOf(error) !== 'EPERM';
  }
}

/**
 * `taskkill /T` walks the child tree by parent-pid. `/F` is used only for the
 * final, non-graceful step: a SIGTERM-equivalent request is sent without it so a
 * CLI that handles shutdown still gets the chance to.
 */
async function killWindowsTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  const args = ['/pid', String(pid), '/T'];
  if (signal === 'SIGKILL') args.push('/F');
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill', args, { stdio: 'ignore', shell: false });
    killer.once('exit', () => resolve());
    killer.once('error', () => resolve());
  });
}

function errnoOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
}


/**
 * How long SIGTERM is given before SIGKILL, and how long the group is given to
 * disappear after SIGKILL before the survivor is reported.
 *
 * Both were duplicated in `claude-cli.ts` and `process-lifecycle-runner.ts`. They
 * are the same two numbers describing the same ladder, and two copies is two places
 * for them to stop agreeing.
 */
// Module-private. They were exported while each runner ran its own ladder; with the
// ladder consolidated here they have no consumer outside this file, and leaving them
// exported presents them as a tunable part of the contract — an invitation to import
// them and re-implement the ladder, which is the duplication the extraction removed.
const SIGKILL_DELAY_MS = 2_000;
const TREE_CONFIRM_DELAY_MS = 500;

/**
 * FR-R3-083 — the escalation ladder, once.
 *
 * WHY THIS IS SHARED AND THE RUNNERS ARE NOT
 *
 * `CodexCliRunner` and `AgyCliRunner` delegate to `ProcessLifecycleRunner`;
 * `ClaudeCliRunner` does not, and that is a pre-existing shape this item did not
 * set out to change. But FR-R3-083 added a re-entrancy guard, a tree probe, a warn
 * and an audit emission to the ladder, and putting all of that in both files made
 * ~55 lines of byte-identical policy with two places to forget the next change.
 * `tests/lint/runners-report-not-record.test.ts` names both files as emitters,
 * which PINS the duplication rather than flagging it.
 *
 * So the ladder moves here — to the module that already owns every other
 * process-tree decision — and each runner supplies only what is genuinely its own:
 * its label, its logger, and its hook.
 *
 * WHAT IS DELIBERATELY NOT PARAMETERISED
 *
 * The trigger. Every caller gets the same escalation rule, and that rule is stated
 * in one place — at the guard itself, below. Read it there rather than here: an
 * earlier version of THIS paragraph described a different rule from the one the code
 * implemented, which in a codebase where these comments are the design record is
 * worse than no paragraph. What is worth saying at the interface is only that the
 * decision is not the caller's to vary.
 */
export interface TreeEscalationDeps {
  readonly child: ChildProcess;
  readonly attribution: TreeAttribution;
  readonly runner: RunnerLabel;
  /** Progress lines. Each runner keeps its own prefix and verbosity. */
  readonly info?: (message: string) => void;
  /** The survivor warning. It STAYS beside the audit emission: when a late append cannot land, this is the only surviving record. */
  readonly warn: (message: string) => void;
  /** The sidecar hook. The runner reports; something else records. */
  readonly emit: (event: MonitorSidecarEvent) => void;
  /**
   * Has this child's surviving group already been reported?
   *
   * The guard is on the REPORT rather than on the ladder, so two overlapping cancel
   * paths on one hung child produce one audit entry — while each still signals a
   * tree the other may have failed to reach.
   */
  readonly alreadyReported: () => boolean;
  readonly markReported: () => void;
}

/**
 * Run SIGTERM → SIGKILL → confirm, reporting a group that survives.
 *
 * WHAT THE CONFIRMATION ESTABLISHES, AND WHAT IT DOES NOT
 *
 * `processTreeIsGone` probes the process GROUP (`kill(-pid, 0)`) on POSIX and the
 * direct child on Windows. So a `true` answer means "the group is gone", and it
 * does **not** mean "no descendant survives":
 *
 *   - A descendant that calls `setsid` for itself, or is spawned `detached`, leaves
 *     the group. After SIGKILL the group is empty, the probe answers `true`, and
 *     that descendant is still running. Verified experimentally, not reasoned:
 *     leader detached, grandchild detached, group SIGKILLed — grandchild alive,
 *     probe `true`.
 *   - On Windows there is no group to probe at all, so the answer is about the
 *     direct child only.
 *
 * This is the SAME escape `docs/architecture/native-binding-decision.md` records as
 * a permanent limit: a re-parenting descendant is out of reach of `taskkill /T` and
 * of a process group alike, and closing it needs a Job Object. The evidence path
 * therefore reports a group Schegent could not kill; **absence of the report is not
 * a statement that no descendant survives**, and every document that describes it
 * says so in those words.
 *
 * Re-entrancy is the CALLER's to guard, with a `WeakSet<ChildProcess>` per runner.
 * The guard belongs on the REPORT, not on the ladder: suppressing a whole second
 * ladder means a tree the first pass failed to reach — `signalProcessTree` swallows
 * a failed group signal by design — never gets signalled again by a later, genuinely
 * different trigger. So `alreadyReported` gates the emission and the warn; the
 * signals are always sent.
 */
export function escalateAndReportTree(deps: TreeEscalationDeps): void {
  const { child, attribution, runner } = deps;

  // NOTHING LEFT TO DO: the child has been reaped AND its group is gone. Both
  // halves, for two different reasons — see `childIsReaped` for why `signalCode`
  // matters, and the note below for why the group probe alone is not enough.
  //
  // This is what keeps the raw group signal away from a reaped pid. A runner holds
  // its `active` entry until after `awaitStdinDelivery`'s grace and its diagnostic
  // writes, so a child can sit there for seconds after exiting; a `cancelAll()` at
  // deactivation landing in that window used to run the whole ladder against a dead
  // pid. On Windows that is `taskkill /pid <pid> /T /F`, which has no
  // group-id protection at all and would take an unrelated process's whole tree.
  //
  // ON WINDOWS THE PROBE IS NOT ENOUGH, so a reaped child ends it here regardless.
  // `processTreeIsGone` there is `process.kill(pid, 0)` against the direct child's
  // pid — it cannot distinguish "our child" from "a new holder of a recycled pid",
  // and Windows recycles aggressively. A probe answering "alive" against the new
  // holder would send `taskkill /pid <pid> /T /F` at an unrelated process and its
  // entire descendant tree, and then file a `tree-unconfirmed` entry against a Run
  // that no longer owns it. POSIX has the pgid reservation to lean on; Windows has
  // nothing, so the honest answer is to stop.
  //
  // The cost is stated rather than hidden: on Windows the "child exited, tree
  // survived" case is not detected. It never was — the probe only ever answered for
  // the direct child there — and it is part of the same permanent limit
  // `docs/architecture/native-binding-decision.md` records.
  if (childIsReaped(child)) return;

  // No probe on its OWN before the first signal, and the reason is FR-R3-054 §4 finding 1,
  // relearned: `processTreeIsGone` answers for the GROUP, and a child that leads no
  // group of its own — an injected double, or a real child from a spawn path this
  // migration has not reached — makes `kill(-pid, 0)` throw ESRCH, which reads as
  // "gone". Guarding the ladder on that probe therefore stopped signalling those
  // children ENTIRELY. It broke thirty-one runner tests, and it would equally have
  // stopped reaching a real child spawned without `processTreeSpawnOptions()`.
  //
  // That leaves a residual worth naming rather than closing badly: `signalProcessTree`
  // reaches the group through the raw `process.kill(-pid, …)` (and `taskkill /pid
  // <pid> /T` on Windows), which have none of the protection `child.kill()` gains
  // once Node has reaped the child. Between a child's exit and its removal from the
  // runner's `active` map, a recycled pid could in principle be signalled. A process
  // group id is not recycled while the group has members, so the window needs an
  // empty group AND pid reuse AND the new holder leading a group — the same class of
  // narrow race as the component-swap window in `docs/architecture/native-binding-decision.md`,
  // and closing it would cost the case above, which is not narrow at all.

  const confirmOrReport = (): void => {
    // NOT the signal gate. Applying it here suppressed the report in the ordinary
    // case — 500 ms after the ladder's own SIGKILL the child is reaped by definition,
    // so the one arrangement this evidence path exists for (child dead, helper still
    // alive) produced no warning and no audit entry at all. The feature's headline
    // claim was true of nothing.
    //
    // The two questions have different costs, and that is why they get different
    // gates. Signalling a possibly-recycled pgid DESTROYS an unrelated process tree.
    // Reporting on one writes an observational audit entry carrying the pid, which
    // an operator can check and which the runtime-log warning already accompanies.
    // A wrong entry here is a weak lead; a wrong kill there is someone else's work
    // gone. Treating them as the same question is what broke this.
    //
    // The residual is stated rather than closed: between a child's reaping and its
    // removal from the runner's `active` map, a recycled pid whose new holder leads
    // a group can produce a spurious entry. `docs/operations/backends.md` says so.
    //
    // On Windows the probe answers only for the direct child, so it cannot establish
    // a surviving tree at all and the evidence path does not fire there.
    // `platform-observation-record.md` records that rather than letting an operator
    // infer coverage from silence.
    if (process.platform === 'win32') return;
    if (processTreeIsGone(child)) return;
    if (deps.alreadyReported()) return;
    deps.markReported();
    // SIGKILL is not catchable, so a surviving group is one we do not own.
    deps.warn('process tree not confirmed gone after SIGKILL; descendants may still be running');
    // And into EVIDENCE. A runtime-log line is not the audit record, so an
    // operator reconstructing why a later phase saw foreign writes had nothing
    // to read. Reported through the hook, never written here.
    //
    // Fields NAMED, never spread from `attribution`: a spread bypasses
    // excess-property checks, and `cancelActive` once handed over the whole
    // `active` map entry — which holds the live `ChildProcess` and its
    // `spawnargs` — into a payload whose safety argument is that it has nowhere
    // to put a secret.
    deps.emit({
      kind: 'tree-unconfirmed',
      runId: attribution.runId,
      phase: attribution.phase,
      iteration: attribution.iteration,
      pid: child.pid ?? null,
      runner,
      escalation: 'sigterm-then-sigkill'
    });
  };

  deps.info?.('sending SIGTERM to process tree');
  void signalProcessTree(child, 'SIGTERM');
  setTimeout(() => {
    // The signal gate, and the whole of it. See `childIsReaped` for why a reaped
    // child ends the ladder rather than "reaped and the group looks gone" — an
    // earlier version of THIS comment described the second rule, which the code has
    // never implemented, and a contradicted comment in a codebase where comments are
    // the design record is worse than none.
    if (childIsReaped(child)) return;
    deps.info?.('sending SIGKILL to process tree');
    void signalProcessTree(child, 'SIGKILL').then(() => {
      setTimeout(confirmOrReport, TREE_CONFIRM_DELAY_MS).unref();
    });
  }, SIGKILL_DELAY_MS).unref();
}
