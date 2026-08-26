// FR-R3-103 (FR-041) — record which process tree a Run is holding, and clear it when the
// child is reaped.
//
// WHY IT HAS TO BE PERSISTED. Children spawn detached, deliberately, so the terminate ladder
// reaches descendants. Nothing persisted their identity: pids lived in memory, in audit
// payloads and in temp-file names. So a NEW host had no way to ask whether the OLD host's tree
// was still live, and activation resumed into whatever was left behind.
//
// FENCED, because it is a Run-record write like any other. It goes through `setRun`, which is
// a whole-map read-modify-write on the store's existing serialize chain — the hard rule against
// a second write path for Runs applies here as much as anywhere, and a targeted key-level write
// would reintroduce the last-writer-wins loss that rule exists to prevent.
//
// CLEARED AT REAPED EXIT, so the field's presence means "a tree was live when this record was
// last written". A stale identity would make an ordinary completed Run look like an orphan on
// the next activation, and the operator would be told a Run was executing that had finished
// hours ago — a false refusal is worse than no check, because it cannot be cleared by waiting.
import { errorMessage } from '../lib/errors';
import type { SpawnIdentity } from '../contracts/spawn-identity';
import type { WorkflowRun } from './workflow-run';
import type { WorkspaceStateStore } from './workspace-state';

/** The store surface this needs. Narrow, so a test supplies two methods. */
export type SpawnIdentityStore = Pick<
  WorkspaceStateStore,
  'getRunMap' | 'setRun' | 'runCommitClaim'
>;

export interface SpawnIdentityRecorderDeps {
  readonly store: SpawnIdentityStore;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

/**
 * Which queue owns the Run with this id.
 *
 * A scan rather than an index: the map has at most `MAX_QUEUES` entries, this runs twice per
 * invocation, and an index would be a second thing to keep in step with the map.
 */
function queueForRun(
  store: SpawnIdentityStore,
  runId: string
): { queueId: string; run: WorkflowRun } | null {
  for (const [queueId, run] of Object.entries(store.getRunMap())) {
    if (run.id === runId) return { queueId, run };
  }
  return null;
}

export function createSpawnIdentityRecorder(deps: SpawnIdentityRecorderDeps): {
  readonly recordSpawn: (runId: string | null, pid: number | null) => Promise<void>;
  readonly clearOnExit: (runId: string | null) => Promise<void>;
} {
  /**
   * Write, or refuse without pretending.
   *
   * Every refusal is silent-by-design except in the runtime log: this is a bookkeeping write
   * on a hot path, and a notification per spawn would be noise. What it must never do is
   * throw — a failure to record the identity must not fail the invocation that just started.
   * The cost of a missed write is one Run that reads as `unrecorded` next activation, which
   * resumes exactly as it did before this feature existed.
   */
  async function write(runId: string | null, identity: SpawnIdentity | undefined): Promise<void> {
    if (runId === null) return;
    const found = queueForRun(deps.store, runId);
    if (found === null) return;
    // The claim comes from the store, which is the single site that decides whether this
    // window holds a lease on that queue and names the reason when it does not. Asking the
    // lock manager for a bare fence number here would be a second answer to the same
    // question — and the commit point's own signature refuses a bare number for exactly that
    // reason.
    const claim = deps.store.runCommitClaim(found.queueId);
    try {
      const next: WorkflowRun =
        identity === undefined
          ? (() => {
              // Delete rather than set to undefined: an explicit `undefined` serializes into
              // the Memento as a present key, and `unrecorded` must mean absent.
              const { spawnIdentity: _dropped, ...rest } = found.run;
              return rest as WorkflowRun;
            })()
          : { ...found.run, spawnIdentity: identity };
      await deps.store.setRun(found.queueId, next, claim);
    } catch (error) {
      deps.log(
        `spawn-identity: could not record for run ${runId}: ${errorMessage(error)}`
      );
    }
  }

  return {
    recordSpawn: async (runId, pid) => {
      if (pid === null) return;
      // `pgid === pid` for a detached POSIX spawn, which is what `processTreeSpawnOptions()`
      // requests. Recorded as its own field rather than derived at read time: by the time an
      // orphan is found, deriving it would assume the child is still its own group leader,
      // which is exactly what a re-parented descendant is not.
      await write(runId, { pid, pgid: pid, startedAtMs: deps.now() });
    },
    clearOnExit: async (runId) => {
      await write(runId, undefined);
    }
  };
}
