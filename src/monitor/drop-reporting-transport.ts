// FR-R3-106 (FR-075) — a transport sink whose backpressure refusals reach the operator.
//
// THE GAP. `CliTransportSink` has counted refused lines and bytes since `FR-R3-052`, and
// exposed them on `droppedForBackpressure` — whose only readers were two unit tests. So the
// operator question *"did the transport log lose lines?"* was answerable by the code and
// answered nowhere. A bound that silently drops evidence is the same class as a declared
// threshold no command enforces.
//
// WHY A WRAPPER RATHER THAN A CHANGE TO THE SINK. The sink's job is bounded writing, and it
// does that correctly; what was missing was a reader. Putting the health dependency inside
// the sink would give a write path a reason to know about a UI surface. This wraps instead,
// so the sink stays ignorant of who is watching.
//
// WHY A MODULE RATHER THAN A CLOSURE IN `extension.ts`. It was a closure there first, and
// `tests/lint/source-loc-budget.test.ts` refused it — 21 lines over the activation shell's
// budget. That refusal was right: the shell should gain a call, not a policy. Same reasoning
// the three recorder modules record for `phase-runner.ts`.
//
// REPORTED ON RECORD, NOT POLLED. The sink already knows the moment it refuses. A poll would
// either miss a burst between ticks or run forever for a counter that is almost always zero.
// `noteTransportDrops` is a no-op when the counts have not moved, so the common path costs
// one comparison per line and notifies nobody.
import type { CliTransportRecord } from './cli-transport-sink';

/**
 * What this needs from the sink — narrower than the sink, so a fake is a handful
 * of members.
 *
 * FR-R3-137 — `flushAndDispose` is REQUIRED, not optional, and that is the whole
 * point of putting it here. This interface is what the wiring retains and what
 * every consumer sees, so a lifecycle member a caller may omit is a lifecycle
 * member a caller will omit: the descriptor leak this closed existed precisely
 * because the type between the owner and the sink had no close on it.
 */
export interface BoundedTransport {
  readonly record: (entry: CliTransportRecord) => void;
  readonly flushPendingWrites: () => Promise<void>;
  readonly droppedForBackpressure: { readonly lines: number; readonly bytes: number };
  readonly flushAndDispose: () => Promise<void>;
}

/** What this needs from the health surface. */
export interface DropReporter {
  readonly noteTransportDrops: (counts: { readonly lines: number; readonly bytes: number }) => void;
}

export function withDropReporting(
  sink: BoundedTransport,
  reporter: DropReporter
): BoundedTransport {
  // FR-R3-137 — the wrapper goes quiet after the sink is disposed.
  //
  // A drop reported during shutdown would push a count at a health surface whose
  // own disposal is a step or two away in the same teardown. So the final counts
  // are reported ONCE, after the sink settles — which is the only report that
  // includes lines the drain abandoned — and nothing is reported after that.
  let reporting = true;
  return {
    record: (entry: CliTransportRecord): void => {
      sink.record(entry);
      if (reporting) reporter.noteTransportDrops(sink.droppedForBackpressure);
    },
    flushPendingWrites: () => sink.flushPendingWrites(),
    get droppedForBackpressure() {
      return sink.droppedForBackpressure;
    },
    flushAndDispose: async (): Promise<void> => {
      await sink.flushAndDispose();
      if (reporting) {
        reporting = false;
        reporter.noteTransportDrops(sink.droppedForBackpressure);
      }
    }
  };
}
