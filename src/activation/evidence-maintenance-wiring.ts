// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: GATED HERE.
// Arms an hourly timer whose every tick re-reads `isWorkspaceTrusted()` and `lock.hasPrimacy()` before it
// touches the filesystem, so a trust grant or a primacy change that lands after activation is honored at
// the act and not at wiring. The scheduler (`evidence-maintenance-scheduler.ts`) owns that gate; this module
// supplies the reads and the pass.
//
// FR-R4-F04 (FR-031, S) — WHY A TIMER, AND WHY HERE. Retention ran at activation and at a Run's end, so an
// idle window kept expired evidence for as long as it stayed open. The pass removes what retention already
// says is expired (it adds no new deletion rule): inactive Run transport files, then inactive session groups,
// skipping every Run still executing. Only the primacy owner runs it, so two windows over one workspace do
// not sweep each other's files, and only a trusted workspace, because the pass deletes.
//
// WHY THE ARMING IS NOT DEFERRED TO `stage2-producers.ts`. That module runs its producers once, at the end
// of activation, and a producer is a one-shot act. This is a recurring act whose gate has to be read each
// time, which is what the `GATED HERE` verdict names (a handler that checks trust at the act).
//
// WHERE IT IS ARMED, AND WHAT PAID FOR THE LINE. In `wireStage2`, after `await producers.run()`: the scheduler
// takes its first tick the moment it is created and that tick reads primacy, so a scheduler created ahead of
// the election can read a window that has not yet tried for the lock, and the first pass then waits an hour
// for the next tick. The primacy-gain subscription stays ahead of the election (a gain that lands during it must not
// be missed); `elect-before-recovering.test.ts` pins both orders. `wireStage2` sits at its shrink-only
// exemption in `source-loc-budget.test.ts`, so the split into two registrations is paid for by pairing two
// properties of the `createStage2Producers` call onto one line, the move `primacy-gain-wiring.ts` describes,
// and the explanation lives here and not at the call site.

import type * as vscode from 'vscode';

import type { SanitizedLogger } from '../lib/logger';
import type { TransportRouter } from '../monitor/transport/transport-router';
import { createEvidenceMaintenancePass } from '../services/evidence-maintenance/evidence-maintenance-pass';
import { createEvidenceMaintenanceScheduler } from '../services/evidence-maintenance/evidence-maintenance-scheduler';
import type { SessionArtifactRetentionService } from '../services/session-retention/session-artifact-retention-service';
import { systemScheduler, type Scheduler, type WorkspaceLockManager } from '../state/lock';

export interface EvidenceMaintenanceWiringDeps {
  readonly logger: SanitizedLogger;
  readonly isWorkspaceTrusted: () => boolean;
  readonly lock: Pick<WorkspaceLockManager, 'hasPrimacy'>;
  readonly protectedSessionRunIds: () => ReadonlySet<string>;
  readonly transportRouter: Pick<TransportRouter, 'runPass'>;
  readonly sessionRetention: Pick<SessionArtifactRetentionService, 'sweep'>;
  /** Injected for tests; the system `setInterval` otherwise. */
  readonly scheduler?: Scheduler;
}

const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,31}$/;

/** A bounded code for the warning, never the error's message (CLAUDE.md: log sanitized fields only). */
function errorCodeOf(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : 'unknown';
}

/** Build and arm the hourly evidence maintenance scheduler; disposing the result clears its interval. */
export function wireEvidenceMaintenance(deps: EvidenceMaintenanceWiringDeps): vscode.Disposable {
  const pass = createEvidenceMaintenancePass({
    protectedSessionRunIds: deps.protectedSessionRunIds,
    transport: deps.transportRouter,
    sessionRetention: deps.sessionRetention
  });
  const scheduler = createEvidenceMaintenanceScheduler({
    scheduler: deps.scheduler ?? systemScheduler,
    isTrusted: () => deps.isWorkspaceTrusted(),
    hasPrimacy: () => deps.lock.hasPrimacy(),
    runPass: async () => {
      try {
        return await pass();
      } catch (error) {
        deps.logger.warn('evidence-maintenance: pass failed', { errorCode: errorCodeOf(error) });
        throw error;
      }
    }
  });
  return { dispose: () => scheduler.dispose() };
}
