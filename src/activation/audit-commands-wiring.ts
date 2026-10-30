// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT. Registers
// commands through `registerGuardedCommand`; the registrations themselves
// perform nothing, and each handler re-checks trust at the point of effect, the
// same as every other registration in `ui-wiring.ts`.
//
// FR-R4-F03 (TA3) — the two audit-history commands, extracted out of
// `registerStage2Ui()` together.
//
// WHY THESE TWO. `schegent.verifyAuditChain` reads the chain and the head
// checkpoint and reports one result; `schegent.resetAuditCheckpoint` retires the
// checkpoint after a loss. They are one subject: the second is the way back from
// the findings the first reports, and the verify text names it, so keeping their
// registrations in one module keeps that pairing in one place.
//
// WHY EXTRACTED AT ALL. `registerStage2Ui()` measures 398 of the 400-line
// composition-root bound (`tests/lint/source-loc-budget.test.ts`), so the reset
// registration could not be added inline: the same forcing function that produced
// `queue-item-exit-wiring.ts` under feature 195, and the response that gate's own
// message asks for. `registerStage2Ui` spreads the result, so it shrinks.
//
// WHAT EACH REGISTRATION DOES WITH THE WRITER. Verification reports a break and a
// loss through the writer's two notes, which set audit health and write no file,
// and reads the checkpoint through the writer. The reset is owner-only (the guard
// asks `isOwner`) and goes through the writer's `retireCheckpoint()`, which asks
// the authority again inside its own step.

import type * as vscode from 'vscode';
import { registerGuardedCommand, type GuardedCommandDeps } from './guarded-command-registration';
import { runResetAuditCheckpoint } from '../commands/reset-audit-checkpoint';
import { runVerifyAuditChain } from '../commands/verify-audit-chain';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { SanitizedLogger } from '../lib/logger';
import type { Notifier } from '../ui/notifications';

export interface AuditCommandsWiringDeps {
  readonly workspaceRoot: string;
  readonly notifier: Notifier;
  readonly logger: SanitizedLogger;
  readonly auditWriter: AuditLogWriter;
}

export function registerAuditChainCommands(
  guard: GuardedCommandDeps,
  deps: AuditCommandsWiringDeps
): readonly vscode.Disposable[] {
  const { auditWriter } = deps;
  return [
    // FR-R3-112 — the chain verification, from the surface rather than only from a shell.
    registerGuardedCommand(guard, 'schegent.verifyAuditChain', () =>
      runVerifyAuditChain({
        workspaceRoot: deps.workspaceRoot,
        notifier: deps.notifier,
        logger: deps.logger,
        onBreak: (detail) => auditWriter.noteChainBreak(detail),
        onLoss: (code, detail) => auditWriter.noteHistoryLoss(code, detail),
        readCheckpoint: () => auditWriter.readCheckpoint()
      })
    ),
    // FR-R4-F03 (FR-017) — retire the head checkpoint after a loss. Owner-only, modal, never deletes.
    registerGuardedCommand(guard, 'schegent.resetAuditCheckpoint', () =>
      runResetAuditCheckpoint({
        workspaceRoot: deps.workspaceRoot,
        notifier: deps.notifier,
        writer: auditWriter
      })
    )
  ];
}
