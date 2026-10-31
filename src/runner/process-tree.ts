import { spawn, type ChildProcess } from 'node:child_process';
import type {
  MonitorSidecarEvent,
  RunnerLabel,
  TreeAttribution,
  TreeTeardownOutcome,
  TreeTeardownResult
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
    // POSIX stays synchronous: callers (and their tests) rely on `child.kill` having been
    // called by the time `cancelActive()` returns. Only the Windows `taskkill` is awaited.
    if (process.platform === 'win32') await killWindowsTree(pid, signal);
    else signalPosixGroup(pid, signal);
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
 * Signal the group (POSIX) or the tree (Windows) and nothing else.
 *
 * The ladder uses this alone once the leader is reaped: `child.kill` on a reaped
 * child is a no-op at best, and the safety rule is that a reaped child is never
 * signalled (FR-017).
 */
function signalGroup(pid: number, signal: NodeJS.Signals): Promise<void> {
  if (process.platform === 'win32') return killWindowsTree(pid, signal);
  signalPosixGroup(pid, signal);
  return Promise.resolve();
}

function signalPosixGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    // Negative pid means "the group whose leader is pid".
    process.kill(-pid, signal);
  } catch {
    /* no group, already gone, or not ours -- the direct signal stands where there is one */
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
 * WHAT IT GATES. The DIRECT child's signal: once Node has reaped the child its pid is
 * the operating system's to reuse, so a reaped child is never signalled, here or on
 * Windows (`taskkill /pid <pid> /T /F` is the same hazard with none of the pgid
 * reservation to soften it).
 *
 * WHAT IT NO LONGER GATES (FR-R4-F06, FR-015, FR-017). It used to be the ladder's whole
 * signal gate, so a leader that handled SIGTERM and exited left a same-group helper that
 * ignored it with no SIGKILL and no report. The group is a separate question with a
 * separate answer: on POSIX a reaped leader's group is signalled only on OWNERSHIP
 * EVIDENCE (`trackGroupAtExit` and a fresh check immediately before each signal; see
 * `groupSignalGate`). Killing an unrelated tree is still worse than missing a kill, so no
 * evidence still means no signal. Reporting is a third question with its own cost, decided
 * at the confirmation.
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



/** What a signal-0 probe answered. `unknown` is EPERM or any other error: the OS will not say. */
type ProbeAnswer = 'present' | 'absent' | 'unknown';

function probeTarget(target: number): ProbeAnswer {
  try {
    process.kill(target, 0);
    return 'present';
  } catch (error) {
    return errnoOf(error) === 'ESRCH' ? 'absent' : 'unknown';
  }
}

/**
 * Did the leader's group still have a member when the leader exited? Kept per child.
 *
 * This is the ANCHOR of the ownership evidence (FR-R4-F06, research R20). While the group
 * has a member its id cannot be reused, so an answer at the moment of exit says the group
 * `kill(-pid, …)` addresses is the one this child led. Recorded at exit because no later
 * probe can say it: once the leader is reaped, a `kill(-pid, 0)` that answers might be
 * about a stranger's group.
 */
const groupAnsweredAtExit = new WeakMap<ChildProcess, boolean>();

/**
 * Record, at the leader's exit, whether its group still answered (POSIX only).
 *
 * A runner calls this once, right after it spawns. It is observation only: it sends signal
 * 0 and nothing else, and it records nothing on Windows, where there is no group to probe.
 * A child that was never tracked and is reaped before its ladder starts has no anchor, so
 * the ladder sends it no signal (P3).
 */
export function trackGroupAtExit(child: ChildProcess): void {
  if (process.platform === 'win32') return;
  child.once('exit', () => {
    const pid = child.pid;
    if (pid === undefined) return;
    // R20: the pid is free (it was just reaped) AND the group still answers.
    groupAnsweredAtExit.set(child, probeTarget(pid) === 'absent' && probeTarget(-pid) === 'present');
  });
}

/** What the fresh check found about a reaped leader's group, immediately before a signal. */
type Ownership = 'owned' | 'pid-held' | 'group-gone' | 'unknowable';

/**
 * The fresh check: the leader's pid is free AND the group still answers (data-model §5).
 *
 * `pid-held` means another process holds the number. A group id is not reused while the
 * group has members, so our group has ended and the number is a stranger's. `unknowable`
 * is EPERM from either probe: a member the host may not signal is not evidence the host
 * owns anything.
 */
function ownershipOf(pid: number): Ownership {
  const leader = probeTarget(pid);
  if (leader === 'present') return 'pid-held';
  if (leader === 'unknown') return 'unknowable';
  const group = probeTarget(-pid);
  if (group === 'present') return 'owned';
  return group === 'absent' ? 'group-gone' : 'unknowable';
}

/**
 * `'owned'` when a group signal may go out for a REAPED leader; otherwise the result the
 * ladder settles with, with no signal sent (P2). Pid `N` held by another process and an
 * already-empty group both settle `group-gone`: nothing of ours is left to signal.
 */
function groupSignalGate(pid: number): 'owned' | TreeTeardownResult {
  switch (ownershipOf(pid)) {
    case 'owned':
      return 'owned';
    case 'unknowable':
      return 'tree-unconfirmed';
    default:
      return 'group-gone';
  }
}

/** One probe, no signal, no report: the settle for a reaped leader with no ownership evidence (P3). */
function probeOnly(pid: number | undefined): TreeTeardownResult {
  if (pid === undefined) return 'group-gone';
  return probeTarget(-pid) === 'absent' ? 'group-gone' : 'tree-unconfirmed';
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
/** Room for the confirmation probe's timer scheduling and a Windows `taskkill` exit. */
const TEARDOWN_SLACK_MS = 250;

/**
 * FR-R4-F06 (FR-024; S8, research R29) -- how long shutdown waits for the backend trees: the
 * ladder's two delays plus slack, 2,750 ms. Exported so the relation to the host's allowance
 * lives in code (`tests/unit/runner/teardown-bound.test.ts`), not in two literals. A ladder
 * still pending when this elapses is reported `bound-elapsed`.
 */
export const TEARDOWN_BOUND_MS = SIGKILL_DELAY_MS + TREE_CONFIRM_DELAY_MS + TEARDOWN_SLACK_MS;

/**
 * How long the editor gives an extension to deactivate before it ends the extension host:
 * `Promise.race([timeout(5e3), deactivateAll()])`, read from the installed VS Code 1.144.0 and
 * Antigravity IDE 1.107.0, the manifest's `engines` floor
 * (`Contents/Resources/app/out/vs/workbench/api/node/extensionHostProcess.js` of each app).
 * Shutdown must release ownership inside it: the teardown bound, then the transport flush's
 * grace, then the lease and lock writes.
 */
export const HOST_DEACTIVATE_ALLOWANCE_MS = 5_000;

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
 * in one place — at `escalateAndReportTree`, below. The decision is not the caller's
 * to vary.
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

/** What a ladder needs besides its deps: the way to finish, and the way to keep a rung from throwing. */
interface LadderControl {
  readonly settle: (result: TreeTeardownResult) => void;
  readonly guarded: (rung: () => void) => () => void;
}

/**
 * Run SIGTERM → SIGKILL → confirm, report a group that survives, and say how it ended.
 *
 * The promise resolves once, with a {@link TreeTeardownOutcome}, and never rejects. A
 * caller that does not need the outcome ignores it, as every caller did when this
 * returned nothing; the registry's shutdown settles on it (FR-020).
 *
 * WHAT THE CONFIRMATION ESTABLISHES, AND WHAT IT DOES NOT
 *
 * `processTreeIsGone` probes the process GROUP (`kill(-pid, 0)`) on POSIX and the
 * direct child on Windows. So a `true` answer means "the group is gone", and it
 * does **not** mean "no descendant survives":
 *
 *   - A descendant that calls `setsid` for itself, or is spawned `detached`, leaves
 *     the group. After SIGKILL the group is empty, the probe answers `true`, and
 *     that descendant is still alive. Verified experimentally, not reasoned:
 *     leader detached, grandchild detached, group SIGKILLed — grandchild alive,
 *     probe `true`.
 *   - On Windows there is no group to probe at all, so the answer is about the
 *     direct child only.
 *
 * This is the SAME escape `docs/architecture/native-binding-decision.md` records as
 * a permanent limit: a re-parenting descendant is out of reach of `taskkill /T` and
 * of a process group alike, and closing it needs a Job Object. The evidence path
 * therefore reports a group Schegent could not kill; **absence of the report is not
 * a statement that no descendant survives**, and the outcome `group-gone` is named so
 * it cannot be read as more.
 *
 * THE RULE FOR A GROUP SIGNAL (FR-R4-F06, FR-015, FR-017)
 *
 * With the leader unreaped at the start, the ladder SIGTERMs the group and the child, and
 * at the SIGKILL rung it escalates AGAINST THE GROUP even if the leader has exited since:
 * a leader that handles SIGTERM and leaves a helper that ignores it is the case
 * FR-R3-054 exists for. Once the leader is reaped, though, its pid is the operating
 * system's to reuse, so a group signal needs evidence that the group is still ours:
 * an anchor (`trackGroupAtExit`, or a leader still unreaped when the ladder began) and a
 * fresh check immediately before each signal (`groupSignalGate`). A leader reaped before
 * the ladder began, with no anchor, is signalled not at all and settles from one probe.
 *
 * Re-entrancy is the CALLER's to guard, with a `WeakSet<ChildProcess>` per runner.
 * The guard belongs on the REPORT, not on the ladder: suppressing a whole second
 * ladder means a tree the first pass failed to reach — `signalProcessTree` swallows
 * a failed group signal by design — never gets signalled again by a later, genuinely
 * different trigger. So `alreadyReported` gates the emission and the warn; the
 * signals are always sent.
 */
export function escalateAndReportTree(deps: TreeEscalationDeps): Promise<TreeTeardownOutcome> {
  const { child, attribution, runner } = deps;
  return new Promise<TreeTeardownOutcome>((resolve) => {
    let settled = false;
    const settle = (result: TreeTeardownResult): void => {
      if (settled) return;
      settled = true;
      resolve({ attribution, runner, pid: child.pid ?? null, result });
    };
    // A throw inside a rung -- a hook that fails, a probe that misbehaves -- would
    // otherwise leave this promise pending or escape a timer as an uncaught error.
    // The honest settle for a ladder that could not finish is "not confirmed".
    const guarded = (rung: () => void) => (): void => {
      try {
        rung();
      } catch {
        settle('tree-unconfirmed');
      }
    };
    const control: LadderControl = { settle, guarded };
    guarded(() =>
      process.platform === 'win32' ? runWindowsLadder(deps, control) : runPosixLadder(deps, control)
    )();
  });
}

/**
 * Windows: today's signals, unchanged (P4). A reaped child ends the ladder with no signal
 * (`taskkill /pid <pid> /T /F` has no group-id protection and would take an unrelated
 * process's whole tree), and no confirmation or report runs: the probe there answers only
 * for the direct child. Every outcome is `platform-unanswerable`, which says the platform
 * could not confirm a tree, as opposed to the ladder having found one gone.
 */
function runWindowsLadder(deps: TreeEscalationDeps, { settle, guarded }: LadderControl): void {
  const { child } = deps;
  if (childIsReaped(child)) {
    settle('platform-unanswerable');
    return;
  }
  deps.info?.('sending SIGTERM to process tree');
  void signalProcessTree(child, 'SIGTERM');
  setTimeout(
    guarded(() => {
      if (childIsReaped(child)) {
        settle('platform-unanswerable');
        return;
      }
      deps.info?.('sending SIGKILL to process tree');
      void signalProcessTree(child, 'SIGKILL').then(() => settle('platform-unanswerable'));
    }),
    SIGKILL_DELAY_MS
  ).unref();
}

/** POSIX: data-model §5's sequence table. */
function runPosixLadder(deps: TreeEscalationDeps, control: LadderControl): void {
  const { child } = deps;
  const { settle, guarded } = control;
  const pid = child.pid;

  if (childIsReaped(child)) {
    // Reaped before the ladder began: signal only with an anchor and a fresh check (P2, P3).
    if (pid === undefined || groupAnsweredAtExit.get(child) !== true) {
      settle(probeOnly(pid));
      return;
    }
    const gate = groupSignalGate(pid);
    if (gate !== 'owned') {
      settle(gate);
      return;
    }
    deps.info?.('sending SIGTERM to process tree');
    void signalGroup(pid, 'SIGTERM');
  } else {
    deps.info?.('sending SIGTERM to process tree');
    void signalProcessTree(child, 'SIGTERM');
  }
  setTimeout(guarded(() => sigkillRung(deps, control)), SIGKILL_DELAY_MS).unref();
}

/**
 * The SIGKILL rung. A leader still unreaped is signalled with its group, as always. A
 * leader reaped since the ladder began has its group signalled only if the fresh check
 * still holds; otherwise the ladder settles without a signal and does not go on to confirm.
 */
function sigkillRung(deps: TreeEscalationDeps, control: LadderControl): void {
  const { child } = deps;
  const pid = child.pid;
  let sent: Promise<void>;
  if (!childIsReaped(child)) {
    deps.info?.('sending SIGKILL to process tree');
    sent = signalProcessTree(child, 'SIGKILL');
  } else {
    // A reaped child that spawned has a pid; one without has no group to signal.
    if (pid === undefined) {
      control.settle(probeOnly(pid));
      return;
    }
    const gate = groupSignalGate(pid);
    if (gate !== 'owned') {
      control.settle(gate);
      return;
    }
    deps.info?.('sending SIGKILL to process tree');
    sent = signalGroup(pid, 'SIGKILL');
  }
  void sent.then(() => {
    setTimeout(control.guarded(() => confirmOrReport(deps, control)), TREE_CONFIRM_DELAY_MS).unref();
  });
}

/**
 * The confirmation, and the report when the group answers.
 *
 * NOT the signal gate. Applying it here suppressed the report in the ordinary case --
 * 500 ms after the ladder's own SIGKILL the child is reaped by definition, so the one
 * arrangement this evidence path exists for (child dead, helper still alive) produced no
 * warning and no audit entry at all.
 *
 * Signalling and reporting have different costs. Signalling a possibly-recycled pgid
 * DESTROYS an unrelated process tree; reporting on one writes an observational audit entry
 * carrying the pid, which an operator can check and which the runtime-log warning already
 * accompanies. A wrong entry is a weak lead; a wrong kill is someone else's work gone.
 */
function confirmOrReport(deps: TreeEscalationDeps, { settle }: LadderControl): void {
  const { child, attribution, runner } = deps;
  if (processTreeIsGone(child)) {
    settle('group-gone');
    return;
  }
  if (!deps.alreadyReported()) {
    deps.markReported();
    // SIGKILL is not catchable, so a surviving group is one we do not own.
    deps.warn('process tree not confirmed gone after SIGKILL; descendants may still be running');
    // And into EVIDENCE. A runtime-log line is not the audit record, so an operator
    // reconstructing why a later phase saw foreign writes had nothing to read. Reported
    // through the hook, never written here.
    //
    // Fields NAMED, never spread from `attribution`: a spread bypasses excess-property
    // checks, and `cancelActive` once handed over the whole `active` map entry -- which
    // holds the live `ChildProcess` and its `spawnargs` -- into a payload whose safety
    // argument is that it has nowhere to put a secret.
    deps.emit({
      kind: 'tree-unconfirmed',
      runId: attribution.runId,
      phase: attribution.phase,
      iteration: attribution.iteration,
      pid: child.pid ?? null,
      runner,
      escalation: 'sigterm-then-sigkill'
    });
  }
  settle('tree-unconfirmed');
}
