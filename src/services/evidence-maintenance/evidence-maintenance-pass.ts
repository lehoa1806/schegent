// FR-R4-F04 (FR-031, S5, S6) — one evidence maintenance pass.
//
// WHAT A PASS IS. The session retention sweep, then the transport router's pass (reconcile stages, age and
// compact Run files, expire legacy generations, enforce the total), both given ONE set of Run ids that are
// still executing.
//
// WHY THE SWEEP GOES FIRST (a recorded deviation from contract S, which listed transport first). The sweep
// ages a session group by the newest modification time under it, directories included, and removing a file
// from a directory sets that directory's modification time to now. A transport pass that ran first and
// removed an expired Run's `transport.log` would therefore make the Run's whole group look fresh, and the
// sweep in the same pass would keep it for another full retention age: expired evidence kept up to twice its
// age, which is the defect this pass exists to remove. `evidence-maintenance-pass.test.ts` measured the outcome
// (one pass left the group behind; the cause is read from `measure()` in the retention service). Sweeping first removes the group whole, its
// transport file with it, and the transport pass then handles what is left: legacy generations, stages and
// the files of Runs whose groups are still inside their age.
//
// THE ACTIVE SET IS READ AT THE START (S5), every pass. A Run that ended an hour ago must not still be
// protected, and one that started a minute ago must be: the set is not cached between passes.
//
// NO NO-OP ROW (S6). The sweep is asked not to append `session-retention-applied` when it removed nothing,
// so an idle host does not write an audit row an hour. The activation, Run-end and settings sweeps pass no
// option and are unchanged.
//
// COUNTS ONLY. The report names no path and no Run id: the pass runs unattended and its result may reach a
// log.

import type { TransportRouter } from '../../monitor/transport/transport-router';
import type { SessionArtifactRetentionService } from '../session-retention/session-artifact-retention-service';
import type { EvidenceMaintenanceReport } from './evidence-maintenance-scheduler';

export interface EvidenceMaintenancePassDeps {
  readonly protectedSessionRunIds: () => ReadonlySet<string>;
  readonly transport: Pick<TransportRouter, 'runPass'>;
  readonly sessionRetention: Pick<SessionArtifactRetentionService, 'sweep'>;
}

/** One maintenance pass as a function: sweep the session groups, then the transport files. Returns counts only. */
export function createEvidenceMaintenancePass(deps: EvidenceMaintenancePassDeps): () => Promise<EvidenceMaintenanceReport> {
  return async () => {
    const active = deps.protectedSessionRunIds();
    const sessions = await deps.sessionRetention.sweep(active, { recordNoop: false });
    const transport = await deps.transport.runPass(active);
    return {
      transportFilesRemoved: transport.removed,
      transportFilesCompacted: transport.compacted,
      sessionGroupsRemoved: sessions.removedArtifactCount,
      sessionBytesRemoved: sessions.removedBytes
    };
  };
}
