// Feature 088 (T037, US3) — start one more node of a run that already exists.
// Contract: specs/088-workflow-continuation/contracts/workflow-run-ipc.md
//
// Feature 089 T006 — what remains here is what only an editor window can supply:
// the canonical workspace root, the clock, the projector by reference, and the
// ack. Gate 1, the launcher call, the launcher-result to wire-result mapping, and
// the projection both refusal arms carry moved to
// `services/workflow-execution/continuation-service.ts`, which the headless
// entrypoint calls too (FR-003, FR-004). Gates 2-7 belong, as before, to
// `services/workflow-execution/workflow-launcher.ts`.
//
// The workspace root is read here rather than in the service because
// `getCanonicalWorkspaceRoot()` is the host's own reader and the service holds no
// host API — a headless caller resolves its own root and passes it the same way.
//
// Both refusal arms that carry a projection build it with the same
// `projectConnectedRun` the snapshot uses, so a view on a superseded snapshot
// corrects itself from the refusal (FR-045) and there is one renderer, not two.
// Eligibility (gate 4) comes from that same projection through `isNodeStartable`,
// which is why the host and the view cannot come to disagree about what is legal.
// Both are handed over by reference; the service binds the child-state reader.

import type { ContinueWorkflowCommand } from '../../../contracts/sidebar-ipc';
import { continueConnectedRun } from '../../../services/workflow-execution/continuation-service';
import { getCanonicalWorkspaceRoot } from '../../../state/workspace-folder-picker';
import { isNodeStartable, projectConnectedRun } from '../connected-run-projector';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

export const handler: CommandHandler<ContinueWorkflowCommand> = async (ctx, command) => {
  const result = await continueConnectedRun(
    { ...ctx.deps, projectRun: projectConnectedRun, isNodeStartable },
    {
      payload: command.payload,
      workspaceRoot: getCanonicalWorkspaceRoot()?.uri.fsPath ?? null,
      startedAt: Date.now()
    }
  );

  await ack(
    ctx,
    result.outcome === 'started' ? 'accepted' : 'rejected',
    result.outcome === 'started' ? undefined : result.outcome,
    result
  );
};
