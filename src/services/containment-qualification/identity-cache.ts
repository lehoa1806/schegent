// FR-R6-F09 (FR-014; research R13) -- the last identity the spawn gate observed, per backend.
//
// The posture projection reads it so the sidebar can show a backend's qualification without
// starting a process: nothing here probes. One entry per kind, replaced on each observation, held
// in memory only -- a reload starts from `not-observed` until the next admission.

import type { BackendRunnerKind } from '../../contracts/backend-kinds';
import type { BackendIdentity } from '../../contracts/containment-qualification';

export class BackendIdentityCache {
  private readonly entries = new Map<BackendRunnerKind, BackendIdentity>();

  /** Keeps a frozen copy of `identity`, replacing the kind's previous one. */
  record(identity: BackendIdentity): void {
    this.entries.set(identity.kind, Object.freeze({ ...identity }));
  }

  /** The kind's last observed identity, or `null` when none was observed. */
  read(kind: BackendRunnerKind): BackendIdentity | null {
    return this.entries.get(kind) ?? null;
  }
}
