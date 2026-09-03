// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT. Registers a
// command through `registerGuardedCommand`; the registration itself performs
// nothing; the handler re-checks trust at the point of effect, same as every
// other registration in `ui-wiring.ts`.
//
// Feature 195 (T037, FR-018, FR-019) — the one registered-only VS Code
// command this feature adds: this queue's own halt-on-failure answer, or its
// removal (`policy: null`). Extracted out of `registerStage2Ui()` rather than
// left as one more inline block there, the same reason the dozen other
// `*-wiring.ts` modules exist — a cohesive span with its own reason to
// exist, kept out of the composition root's own line count.
//
// Registered-only (no `package.json` palette entry), same shape as
// `schegent.clearQueue`: called only from `cmd-set-queue-failure-policy.ts`,
// which is where the operator-facing route lives.

import * as vscode from 'vscode';
import { registerGuardedCommand, type GuardedCommandDeps } from './guarded-command-registration';
import { runSetQueueFailurePolicyCommand } from '../commands/set-queue-failure-policy';
import type { QueueFailurePolicy } from '../contracts/queue-failure-policy';
import type { QueueManager } from '../queue/queue-manager';
import type { SanitizedLogger } from '../lib/logger';

export interface QueueFailurePolicyWiringDeps {
  readonly queue: Pick<QueueManager, 'setFailurePolicy'>;
  readonly logger: Pick<SanitizedLogger, 'error'>;
}

export function registerQueueFailurePolicyCommand(
  guard: GuardedCommandDeps,
  deps: QueueFailurePolicyWiringDeps
): vscode.Disposable {
  return registerGuardedCommand(
    guard,
    'schegent.setQueueFailurePolicy',
    (queueId: string, policy: QueueFailurePolicy | null) =>
      runSetQueueFailurePolicyCommand({ queueId, policy }, deps)
  );
}
