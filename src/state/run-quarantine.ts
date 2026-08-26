// FR-R3-111 (FR-112, FR-114) — preserve unparseable Run records, bounded, and say so.
//
// WHY THIS IS ITS OWN MODULE. It was inline in `workspace-state.ts` first, and
// `tests/lint/source-loc-budget.test.ts` refused it: +92 lines past that file's waived high-water
// mark. The waiver's own rule is the right one — *"the waiver retired the ceiling, not the forcing
// function. Either keep the addition size-neutral, extract the new behaviour into its own module,
// or raise the mark and say why"* — and this is a distinct concern with a distinct failure mode, so
// extraction is the honest answer rather than a raised number.
//
// WHAT IT REPLACES. Two branches of the Run load path threw records away. The map branch did
// `changed = true; continue;` — dropped, written over, no audit event. The singular branch did
// `return []`, without even that flag. Meanwhile an unparseable QUEUE entry has been preserved for
// inspection since the v9 -> v10 migrator. The asymmetry was unexplained and the silence was the
// worse half: an operator whose Run vanished had nothing to read, and no reader could tell a
// corrupt record from one that never existed.
//
// TWO PROPERTIES, both load-bearing:
//
//   * **Bounded, oldest-out.** A corruption loop must not fill the Memento — the same shape the
//     queue quarantine uses. `RUN_QUARANTINE_CAP` is small on purpose: these exist to be looked at
//     once, and twenty is already more than anyone will read.
//   * **Never throws.** This runs inside `initialize()`. A workspace that cannot start because its
//     own corruption bookkeeping failed is worse than one that started having lost a record it had
//     already lost. A failure is warned; the load continues.
import {
  RUN_QUARANTINE_CAP,
  type RunQuarantineEntry,
  type RunRecordQuarantinedPayload
} from '../contracts/audit-events';

export interface RunQuarantineDeps {
  readonly read: () => RunQuarantineEntry[];
  readonly write: (entries: readonly RunQuarantineEntry[]) => Thenable<void> | Promise<void>;
  readonly now: () => number;
  readonly warn: (reason: string) => void;
}

export interface RunQuarantineEvent {
  readonly eventType: 'run-record-quarantined';
  readonly payload: RunRecordQuarantinedPayload;
}

export function createRunQuarantine(deps: RunQuarantineDeps): {
  readonly capture: (
    entries: ReadonlyArray<{ readonly queueId: string; readonly raw: unknown }>
  ) => Promise<void>;
  readonly drain: () => readonly RunQuarantineEvent[];
} {
  /**
   * Events awaiting an audit writer.
   *
   * `initialize()` runs before the writer exists — the same reason the migration events use a
   * forwarder — so these are buffered rather than dropped. Dropping them would restore the silence
   * this module removed, one layer further out.
   */
  const pending: RunQuarantineEvent[] = [];

  return {
    capture: async (entries) => {
      if (entries.length === 0) return;
      try {
        const existing = deps.read();
        const additions: RunQuarantineEntry[] = entries.map((entry) => ({
          queueId: entry.queueId,
          capturedAtMs: deps.now(),
          reason: 'unparseable',
          raw: entry.raw
        }));
        // Oldest out: keep the tail, which is the most recent.
        const kept = [...existing, ...additions].slice(-RUN_QUARANTINE_CAP);
        await deps.write(kept);
        for (const entry of additions) {
          pending.push({
            eventType: 'run-record-quarantined',
            payload: {
              queueId: entry.queueId,
              reason: entry.reason,
              quarantineDepth: kept.length
            }
          });
        }
      } catch {
        deps.warn('quarantine-write-failed');
      }
    },
    drain: () => {
      const drained = [...pending];
      pending.length = 0;
      return drained;
    }
  };
}
