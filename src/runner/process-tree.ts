import { spawn, type ChildProcess } from 'node:child_process';
import type { MonitorSidecarEvent, RunnerLabel, TreeAttribution } from '../contracts/backend-runner';

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
export const SIGKILL_DELAY_MS = 2_000;
export const TREE_CONFIRM_DELAY_MS = 500;

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
 * The trigger. `child.exitCode`/`signalCode` decide whether to escalate and that
 * check stays at the top, unchanged, because it is the original FR-R3-054
 * behaviour and the tree probe is additive to it: the direct child's status decides
 * whether to escalate, and the probe decides only whether a terminal state may
 * claim the work has stopped. Those are different questions and conflating them was
 * FR-R3-054's own recorded first mistake.
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
}

/**
 * Run SIGTERM → SIGKILL → confirm, reporting a group that survives.
 *
 * Re-entrancy is the CALLER's to guard, with a `WeakSet<ChildProcess>` per runner:
 * two overlapping cancel paths on one hung child would otherwise start two ladders
 * and emit two `tree-unconfirmed` entries for one surviving group.
 */
export function escalateAndReportTree(deps: TreeEscalationDeps): void {
  const { child, attribution, runner } = deps;
  deps.info?.('sending SIGTERM to process tree');
  void signalProcessTree(child, 'SIGTERM');
  setTimeout(() => {
    // The original trigger, unchanged: the direct child's own status decides
    // whether to escalate.
    if (child.exitCode !== null || child.signalCode !== null) return;
    deps.info?.('sending SIGKILL to process tree');
    void signalProcessTree(child, 'SIGKILL').then(() => {
      setTimeout(() => {
        if (processTreeIsGone(child)) return;
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
          runner
        });
      }, TREE_CONFIRM_DELAY_MS).unref();
    });
  }, SIGKILL_DELAY_MS).unref();
}
