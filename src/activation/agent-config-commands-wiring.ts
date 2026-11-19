// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT. Registers
// commands through `registerGuardedCommand`; the registration itself performs
// nothing, and the handler re-checks trust at the point of effect.
//
// Feature 318 (FR-R7-04, FR-006) — registers `schegent.agentConfigAcknowledgements`
// in its own wiring module because `registerStage2Ui()` is at its LOC bound.
import * as vscode from 'vscode';
import {
  runAgentConfigAcknowledgements,
  type AgentConfigAckItem
} from '../commands/agent-config-acknowledgements';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { Notifier } from '../ui/notifications';
import { registerGuardedCommand, type GuardedCommandDeps } from './guarded-command-registration';

export interface AgentConfigCommandsWiringDeps {
  readonly store: Pick<
    WorkspaceStateStore,
    'getAgentConfigGrants' | 'forgetAgentConfigGrant' | 'forgetAllAgentConfigGrants'
  >;
  readonly notifier: Notifier;
}

export function registerAgentConfigCommands(
  guard: GuardedCommandDeps,
  deps: AgentConfigCommandsWiringDeps
): readonly vscode.Disposable[] {
  return [
    registerGuardedCommand(guard, 'schegent.agentConfigAcknowledgements', () =>
      runAgentConfigAcknowledgements({
        grants: () => deps.store.getAgentConfigGrants(),
        forget: (fingerprint) => deps.store.forgetAgentConfigGrant(fingerprint),
        forgetAll: () => deps.store.forgetAllAgentConfigGrants(),
        pick: (items) =>
          Promise.resolve(
            vscode.window.showQuickPick<AgentConfigAckItem & vscode.QuickPickItem>(
              items as (AgentConfigAckItem & vscode.QuickPickItem)[],
              {
                title: 'Schegent: Agent Config Acknowledgements',
                placeHolder:
                  'Repository agent configurations acknowledged for this workspace. Pick one to withdraw it.',
                matchOnDetail: true
              }
            )
          ),
        confirm: (message, detail, approveLabel) =>
          Promise.resolve(
            vscode.window.showWarningMessage(message, { modal: true, detail }, approveLabel)
          ),
        info: (message) => deps.notifier.info(message)
      })
    )
  ];
}
