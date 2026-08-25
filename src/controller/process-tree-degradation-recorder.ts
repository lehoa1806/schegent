import type { AuditEntry } from '../audit/audit-entry';
import type { Phase } from './phase';
import type { RunnerLabel, TreeEscalation } from '../contracts/backend-runner';
import type { ProcessTreeUnconfirmedPayload } from '../contracts/audit-events';

/**
 * FR-R3-083 / FR-R3-054 §5 — a process group that survived SIGKILL, in the audit
 * record.
 *
 * The runners report the fact through the monitor sidecar hook and do not write it.
 * This is what turns that report into evidence, following
 * `backend-posture-recorder`'s shape with ONE deliberate difference.
 *
 * BEST-EFFORT, NOT REQUIRED — AND WHY THAT IS THE OPPOSITE CHOICE FROM FR-R3-064
 *
 * `backend-posture-admitted` is REQUIRED evidence: a Run that cannot record that it
 * is about to drive an unbounded agent does not proceed unrecorded, and that costs
 * nothing because it gates a run that has not started.
 *
 * This one fires on an `unref`'d timer up to `TREE_CONFIRM_DELAY_MS` after SIGKILL,
 * by which time the phase has ended and may have been finalized. Failing a
 * completed phase on a late append would be a new failure mode invented by an
 * OBSERVATION — the phase's outcome would depend on whether the audit writer was
 * still around when a background timer fired. So the append is best-effort, and the
 * runtime-log warning the runners still emit is what survives a failed append.
 *
 * THE DEACTIVATION RACE, WHICH IS NOT HYPOTHETICAL
 *
 * `deactivate()` disposes `context.subscriptions`, and the audit writer is among
 * them. Deactivation mid-run is one of the exact paths `FR-R3-054` was written for:
 * the tree gets killed BECAUSE the extension is going away, and the confirmation
 * timer fires after that. So an append arriving into a disposed writer is the
 * expected case here, not an edge one, and it must not throw into a disposal that is
 * already in progress.
 */
export class ProcessTreeDegradationRecorder {
  constructor(
    /**
     * The append. Injected so this class has no opinion about which writer, and so
     * a test does not construct one.
     */
    private readonly append: (entry: Omit<AuditEntry, 'id' | 'timestamp'>) => Promise<AuditEntry>
  ) {}

  /**
   * Record one degraded tree.
   *
   * Never throws and never rejects. The caller is a sidecar hook whose own contract
   * is that hook errors do not propagate into runner control flow; this holds up its
   * end of that rather than relying on the runner's `catch`.
   */
  public async record(event: {
    readonly runId: string | null;
    readonly phase: Phase;
    readonly iteration: number;
    readonly pid: number | null;
    readonly runner: RunnerLabel;
    readonly escalation: TreeEscalation;
  }): Promise<void> {
    // An unattributable event is DROPPED, not guessed at. This is how the monitor
    // already treats a `runId: null` lifecycle event, and the reasoning is the same:
    // with more than one Run in a window, attributing this to whichever Run happens
    // to be enumerated first records a surviving process against a Run that never
    // spawned it. A missing entry is a gap; a wrong one is a false lead.
    if (event.runId === null) return;

    const payload: ProcessTreeUnconfirmedPayload = {
      runner: event.runner,
      pid: event.pid,
      // CARRIED from the runner, never stamped here. An earlier version hardcoded
      // the full-ladder value, so a survivor found after the direct child had exited
      // -- where SIGKILL is never sent -- was recorded as having survived one. "Not
      // confirmed gone after SIGKILL" and "not confirmed gone after SIGTERM alone"
      // are different findings, and the second is the weaker claim.
      escalation: event.escalation
    };

    try {
      await this.append({
        runId: event.runId,
        phase: event.phase,
        iteration: event.iteration,
        eventType: 'process-tree-unconfirmed',
        // Spread rather than a cast: a closed interface has no index signature, so
        // it is not assignable to the writer's `Record<string, unknown>`. Here so a
        // later reader does not "simplify" it back into a compile error.
        payload: { ...payload },
        // `info`, and the reason is worth stating because `failure` looks tempting.
        // `AuditOutcome` is the closed union `success | failure | info`, and the
        // phase's own outcome is UNCHANGED — it may well have succeeded. What is
        // degraded is the claim that the work stopped, and the entry's existence is
        // what carries that; no event is emitted when the tree is confirmed gone.
        // Recording `failure` would make a Run that completed read as one that did
        // not. Widening the union to add `warning` is a contract change with a
        // schema regeneration and a webview mirror behind it, which is not this
        // item's to take.
        outcome: 'info'
      });
    } catch {
      // Best-effort, per the class note. The commonest reason to land here is a
      // writer disposed by `deactivate()` while this timer was pending, which is the
      // expected shape rather than a fault. The runtime-log warning stands.
    }
  }
}
