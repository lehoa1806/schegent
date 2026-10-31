/**
 * Backend runner interface.
 *
 * Claude, Codex, and Agy implement this contract. The orchestrator depends on
 * the **shape** of a spawn-based backend, not CLI-specific invocation flags.
 *
 * Constraints any backend MUST honor:
 *  1. Single-shot, non-interactive: each `invoke()` returns when the
 *     subprocess terminates or the per-phase timeout fires.
 *  2. Output cap: stdout/stderr each use a bounded `ZippedStreamBuffer` that
 *     retains an ordered head and rolling tail with an explicit truncation marker.
 *  3. Timeout: the runner aborts the subprocess when `request.timeoutMs`
 *     elapses. The `timedOut` flag in `RawInvocationOutput` reflects this.
 *  4. Cancellation: the runner observes `cancellationSignal` and aborts the
 *     subprocess when the signal fires. `killed` reflects this in the output.
 *  5. Monitor sidecar: every backend SHOULD emit a `MonitorSidecarEvent`
 *     stream so the audit pipeline can hydrate live monitor events.
 *  6. No retry: retry policy lives in the controller, not the runner.
 *
 * `BackendRunnerRegistry` is the runtime construction and lifecycle owner.
 */

// `InvocationRequest` and `RawInvocationOutput` are the wire shapes between
// the controller and any concrete `BackendRunner`. The canonical
// definitions live in `src/runner/invocation-result.ts` (they include
// runner-only optional fields such as `diagnosticWarnings` and
// `verboseDiagnostics` that the controller forwards untouched). The
// contract re-exports those types so adapters and consumers see a single
// type identity and the controller doesn't need to choose between two
// near-identical shapes.
import type { Phase } from '../controller/phase';
import type {
  InvocationOutputSink,
  InvocationRequest,
  RawInvocationOutput
} from '../runner/invocation-result';

export type { InvocationRequest, RawInvocationOutput };

/**
 * FR-R3-083 — which adapter's tree it was.
 *
 * A CLOSED union, not `string`, and the reason is the audit payload downstream:
 * `ProcessTreeUnconfirmedPayload` is justified as needing no redaction precisely
 * because it "has nowhere to put a secret". A free-form `string` fed from a
 * constructor argument is somewhere. These three values are the adapter module
 * identifiers and are deliberately NOT `BackendRunnerKind` ('claude' | 'codex' |
 * 'agy') -- the runner that owns a process tree is the adapter, and collapsing the
 * two would make the payload name a backend where it means an implementation.
 */
export type RunnerLabel = 'claude-cli' | 'codex-cli' | 'agy-cli';

/**
 * Which rungs of the termination ladder ran before the group was found alive.
 *
 * ONE value, and the history is worth keeping. A `'sigterm-only-child-exited'` arm
 * existed briefly, for a version that skipped SIGKILL once the direct child had
 * exited. That version was wrong — the group outlives its leader, so the signal it
 * skipped was the one that would have reaped the survivor — and with the ladder now
 * escalating on the GROUP, a report is only ever reachable after a delivered
 * SIGKILL. An enum arm nothing can emit is worse than no arm: it invites a reader
 * to handle a case that cannot occur.
 *
 * FR-R4-F06 (P1) -- the one value is unchanged, and it is now also reachable on
 * the reaped-leader path: when the leader has exited and the host holds evidence
 * that it owned the group, the ladder escalates against that group, so a report
 * after a reaped leader names this value too.
 */
export type TreeEscalation = 'sigterm-then-sigkill';

/**
 * Feature 093 (T046) — every sidecar event names the Run whose subprocess
 * produced it.
 *
 * The hook is one window-level function shared by every runner, and before this
 * the events were anonymous: the monitor attached each chunk to whichever Run
 * had most recently called `onStart`. That was unambiguous while a window could
 * only execute one Run and silently wrong the moment it can execute several —
 * Run B's stdout would extend Run A's stall deadline and land in A's audit
 * stream. `runId` is `null` only when the invocation carried none (fakes and
 * older callers); the monitor treats that as "no attributable Run" and ignores
 * the event rather than guessing.
 *
 * Feature 093 BUG-001 (T100) — and `invocationId` names the SPAWN whose
 * subprocess produced it.
 *
 * A Run outlives its subprocesses: the pre-phase session compaction is a second
 * CLI child stamped with the same `runId` as the phase it precedes, by
 * `session-compactor.ts` and deliberately (T057). So `runId` alone cannot answer
 * "did the thing this Run is waiting on just exit?", and the monitor answered it
 * with the first exit it saw under the id — which was the compaction's, six
 * hours before the phase's. Everything the monitor reports after that first exit
 * was dropped by a `terminal` latch nothing could clear.
 *
 * REQUIRED and non-nullable, unlike `runId`. An invocation that carries no Run
 * is ordinary; an event with no invocation is not, because an event exists only
 * because a spawn happened. Requiring it makes the compiler the thing that
 * stamps every emit site, which is the point: the identity has to be unique
 * across the MERGED stream the monitor consumes, and a per-runner counter is
 * unique only per runner instance — two runners each emit an invocation numbered
 * 1, which is T046a's collision moved to a new key. `nextInvocationId()` in
 * `src/runner/invocation-identity.ts` is the single site that answers this, and
 * it is the only thing either runner may key an invocation by.
 *
 * `tree-unconfirmed` below does NOT carry it, and that is a decision rather than
 * an omission: it is not a lifecycle event of the monitored invocation. It is a
 * report about a process group that outlived one, it fires after the phase has
 * ended, it reaches the audit path and never the monitor's state machine, and
 * its attribution already travels as a `TreeAttribution`. Adding the field there
 * would widen a payload that has nowhere to put it to work.
 */
export type MonitorSidecarEvent =
  | {
      readonly kind: 'started';
      readonly runId: string | null;
      readonly invocationId: string;
      /**
       * Feature 093 BUG-001 (T101) — a host-internal helper spawned on the Run's
       * behalf (the pre-phase session compaction), not the Run's own phase
       * invocation. Read straight off `InvocationRequest.helperInvocation`,
       * where the reasoning lives.
       *
       * On this arm alone, because it is only ever asked once: the monitor uses
       * it to decide which invocation to adopt, and every later event about that
       * invocation is matched by `invocationId`. A copy on the other four arms
       * would be a second place for the same fact to be wrong.
       */
      readonly helperInvocation: boolean;
      /**
       * Feature 211 — the absolute wall-clock bound this invocation's deadline
       * timer was armed with, or `null` when the runner armed no deadline.
       *
       * Read from the same `InvocationRequest.maxDurationMs` the deadline is
       * armed from, at the same moment, so the warning and the kill can never be
       * measured against different numbers. The monitor has no other supply of
       * this value: it is host configuration the runner resolves per invocation,
       * and re-reading the setting in the monitor would let the two drift the
       * first time an operator changed it mid-run.
       *
       * On this arm alone, for the reason `helperInvocation` above is: it is
       * asked once, at adoption, and every later event is matched by
       * `invocationId`.
       */
      readonly maxDurationMs: number | null;
      readonly pid: number | null;
    }
  | {
      readonly kind: 'stdout-chunk';
      readonly runId: string | null;
      readonly invocationId: string;
      readonly chunk: string;
    }
  | {
      readonly kind: 'stderr-chunk';
      readonly runId: string | null;
      readonly invocationId: string;
      readonly chunk: string;
    }
  | {
      readonly kind: 'exited';
      readonly runId: string | null;
      readonly invocationId: string;
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly killed: boolean;
      readonly timedOut: boolean;
      /** FR-R3-075 — the absolute deadline fired; distinct from the idle stall. */
      readonly deadlineExceeded?: boolean;
    }
  /**
   * FR-R3-208 — the runner's settle hold, reported so the silence it causes is
   * not read as a stall. Sent with `held: true` when a hold begins, and with
   * `held: false` when one ends by `closed` or `ceiling`. A hold that ends with
   * the CLI's own exit sends no `false`: the `exited` event is what clears it.
   * Carries no task id and no session id.
   */
  | {
      readonly kind: 'background-hold';
      readonly runId: string | null;
      readonly invocationId: string;
      readonly held: boolean;
    }
  /**
   * FR-R3-083 / FR-R3-054 §5 — the process group could not be proven gone within
   * the grace window after SIGKILL.
   *
   * Reported through this hook rather than written by the runner, for two reasons.
   * The runner has no business importing the audit writer — it reports lifecycle
   * facts and something else decides what they mean. And the probe fires on a
   * delayed, `unref`'d timer AFTER the phase may already have ended, so it needs a
   * sink that outlives the phase; this hook is a window-level function that does.
   */
  | {
      readonly kind: 'tree-unconfirmed';
      readonly runId: string | null;
      /** The phase and iteration whose invocation owned the tree, for attribution. */
      readonly phase: Phase;
      readonly iteration: number;
      readonly pid: number | null;
      /** Which adapter's tree it was, for the audit payload. */
      readonly runner: RunnerLabel;
      /** Which rungs actually ran. Never assumed — see `TreeEscalation`. */
      readonly escalation: TreeEscalation;
    };

export type MonitorSidecarHook = (event: MonitorSidecarEvent) => void;

/**
 * FR-R3-083 — who a `tree-unconfirmed` report belongs to.
 *
 * The three identity fields of the event arm above, named once so a runner
 * carries them as ONE value. Every `terminate()` call site used to repeat the
 * same triple positionally, and a repeated triple is a triple that can be
 * transposed — `phase` and `iteration` are the two an argument swap would not
 * make ill-typed at every site.
 */
export interface TreeAttribution {
  readonly runId: string | null;
  readonly phase: Phase;
  readonly iteration: number;
}

/**
 * FR-R4-F06 (FR-020) -- how one termination ladder ended.
 *
 * `group-gone` means the process GROUP is gone: the group probe answered `ESRCH`,
 * or pid `N` is now held by another process and the host will not signal it. It
 * does NOT mean no descendant survives. A descendant that left the group with
 * `setsid` is the permanent limit `docs/architecture/native-binding-decision.md`
 * records, and the name is chosen so the outcome cannot be read as more than it
 * proves.
 */
export type TreeTeardownResult =
  /** POSIX: the group probe answers `ESRCH`, or pid `N` is held by another process. */
  | 'group-gone'
  /** POSIX: the group still answers, or its probe answered `EPERM`. */
  | 'tree-unconfirmed'
  /** win32: `taskkill` was sent (or the leader was already reaped); the platform cannot confirm a tree. */
  | 'platform-unanswerable'
  /** Set by the registry only: the ladder had not settled when the teardown bound elapsed. */
  | 'bound-elapsed';

/**
 * FR-R4-F06 (FR-020) -- the report a runner gives for one ladder it started, so
 * shutdown can wait for it instead of firing it and forgetting it. The identity
 * fields are the ones `TreeAttribution` already carries; nothing here holds a
 * path, an argument vector or an environment value.
 */
export interface TreeTeardownOutcome {
  readonly attribution: TreeAttribution;
  readonly runner: RunnerLabel;
  readonly pid: number | null;
  readonly result: TreeTeardownResult;
}

export interface BackendRunner {
  /** Whether an invocation is currently running. */
  readonly hasActiveProcess: boolean;
  /** Run a single phase invocation. Resolves when the subprocess terminates. */
  invoke(
    request: InvocationRequest,
    outputSink?: InvocationOutputSink
  ): Promise<RawInvocationOutput>;
  /** Cancel any in-flight invocation. Returns true if a process was killed. */
  cancelActive(): boolean;
  /**
   * Refuse every later invocation with `SpawnRefusedAfterCloseError`, before
   * anything is spawned. A child already spawned is left to `cancelActive()`.
   * Idempotent and never throws. Called at host teardown.
   */
  close(): void;
  /**
   * FR-R4-F06 (FR-020; S1) -- Outcomes of every ladder this runner started and has not yet
   * settled. Never rejects. A runner with no ladder resolves `[]`.
   *
   * That includes a ladder an idle timeout, a deadline or an abort started before shutdown, not
   * only the ones `cancelActive()` starts. Each ladder is reported once: a settled ladder is
   * forgotten.
   *
   * `deadline` is the registry's shared teardown bound. It is a promise that resolves when the
   * bound has elapsed. A ladder still pending then is reported as `bound-elapsed`, stamped with
   * the attribution it started with, because the runner alone knows it. The registry owns the
   * deadline; the runner only reads it. Absent, the call waits for every ladder.
   */
  settleTeardowns(deadline?: Promise<void>): Promise<readonly TreeTeardownOutcome[]>;
}
