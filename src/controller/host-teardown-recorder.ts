// FR-R4-F06 (FR-023; contract S, S7; research R32; TA15) -- shutdown evidence, written before
// ownership is released.
//
// THE GAP. Shutdown used to release the execution leases and window primacy with no record of
// which backend trees it could not answer for. A tree the host could not confirm gone, or one
// still being killed when the bound elapsed, then outlived the window that owned it and nothing in
// the audit trail said so.
//
// WHAT IT RECORDS. One `host-teardown-unconfirmed` row per tree whose outcome is
// `platform-unanswerable` (Windows: `taskkill` was sent and no tree can be confirmed) or
// `bound-elapsed` (the ladder had not settled at the bound). It is a NEW event because no existing
// one can say "ownership was released with this tree unanswered": `process-tree-unconfirmed` means a
// delivered SIGKILL and a surviving group, and neither of these is that. `group-gone` needs no
// evidence, and `tree-unconfirmed` already filed its `process-tree-unconfirmed` row, which this
// waits for.
//
// WHY BEFORE RELEASE. The audit writer refuses appends outside the owner window, so every row has
// to land while this window is still primary. This runs inside the teardown thunk, which
// `closeStage2Resources` awaits before the caller releases anything.
//
// WHAT IT ADDS TO THE BOUND: nothing but its appends. It starts no timer and makes no wait of its
// own (TA15); the teardown bound covers the ladders, and these appends are counted, like the lease
// and lock writes, in the slack the bound leaves inside the editor's allowance.
//
// BEST-EFFORT, LIKE `ProcessTreeDegradationRecorder`. It never throws: a failed append is logged by
// kind only (no message, which could hold a path) and the rest are still attempted.
import type { AuditEntry } from '../audit/audit-entry';
import type { HostTeardownUnconfirmedPayload } from '../contracts/audit-events';
import type { SanitizedLogger } from '../lib/logger';
import type { BackendRunnerRegistry, TeardownReport } from '../runner/backend-runner-registry';
import type { ProcessTreeDegradationRecorder } from './process-tree-degradation-recorder';

export interface HostTeardownRecorderDeps {
  /** Awaited first, so every `process-tree-unconfirmed` row the ladders filed has landed. */
  readonly treeRecorder: Pick<ProcessTreeDegradationRecorder, 'settled'>;
  readonly append: (entry: Omit<AuditEntry, 'id' | 'timestamp'>) => Promise<unknown>;
  readonly logger: Pick<SanitizedLogger, 'warn'>;
}

const EVENT_TYPE = 'host-teardown-unconfirmed';

/** Record the shutdown evidence for `report`. Resolves; never rejects. */
export async function recordTeardownEvidence(
  report: TeardownReport,
  deps: HostTeardownRecorderDeps
): Promise<void> {
  try {
    await deps.treeRecorder.settled();
  } catch {
    // A recorder that cannot say it has settled is not a reason to lose this evidence.
  }
  for (const outcome of report.outcomes) {
    if (outcome.result !== 'platform-unanswerable' && outcome.result !== 'bound-elapsed') continue;
    // An unattributable tree is DROPPED, as `ProcessTreeDegradationRecorder` drops it: with more than
    // one Run in a window, naming one would record a tree against a Run that never spawned it.
    const { runId, phase, iteration } = outcome.attribution;
    if (runId === null) continue;
    const payload: HostTeardownUnconfirmedPayload = {
      runner: outcome.runner,
      pid: outcome.pid,
      result: outcome.result,
      boundMs: report.boundMs
    };
    try {
      await deps.append({
        runId,
        phase,
        iteration,
        eventType: EVENT_TYPE,
        // Spread, not cast: a closed interface has no index signature, so it is not assignable to the
        // writer's `Record<string, unknown>`.
        payload: { ...payload },
        // `info`: the Run's own outcome is unchanged. What is degraded is the claim that its backend
        // stopped, and the row's existence carries that.
        outcome: 'info'
      });
    } catch {
      // By kind only. The thrown message may hold a path or a value (hard rule 22).
      deps.logger.warn(`${EVENT_TYPE} evidence append failed`);
    }
  }
}

/**
 * The teardown `closeStage2Resources` awaits (S5): close the runners and wait for the backend
 * trees under the bound, then record the evidence. One function, used by the activation wiring and
 * by the shutdown-order test, so the composition the test measures is the one that ships.
 *
 * The order inside is the point. The evidence is built from the SETTLED report, so it cannot be
 * recorded before the registry has finished; and the caller releases ownership only after this
 * resolves. Never rejects: `closeAndTearDown` and `recordTeardownEvidence` do not.
 */
export function createHostTeardown(
  registry: Pick<BackendRunnerRegistry, 'closeAndTearDown'>,
  deps: HostTeardownRecorderDeps
): () => Promise<void> {
  return async () => recordTeardownEvidence(await registry.closeAndTearDown(), deps);
}
