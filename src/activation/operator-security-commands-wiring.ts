// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Registers the four operator security and credential commands through `registerGuardedCommand`
// (each mutating handler re-checks trust at the point of effect inside `registerGuardedCommand`):
//   - `schegent.grantNativeReviewScanner` (mutating, owner-only)
//   - `schegent.revokeNativeReviewScanner` (mutating, owner-only)
//   - `schegent.setTelemetryCredential` (mutating)
//   - `schegent.clearTelemetryCredential` (mutating)
// Extracted out of `registerStage2Ui()` to respect `ui-wiring.ts`'s composition-root LOC budget.

import * as vscode from 'vscode';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import {
  runGrantNativeReviewScanner,
  runRevokeNativeReviewScanner,
  type NativeReviewScannerConsentPort,
  type NativeReviewScannerConsentUi
} from '../commands/native-review-scanner-consent';
import {
  runClearTelemetryCredential,
  runSetTelemetryCredential,
  type TelemetryCredentialCommandUi,
  type TelemetrySecretStoragePort
} from '../commands/telemetry-credential';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { Notifier } from '../ui/notifications';
import { registerGuardedCommand, type GuardedCommandDeps } from './guarded-command-registration';
import { getSqliteCutoverCoordinator } from './sqlite-cutover-wiring';
import { readTelemetryExportUserSettings } from './uncached-settings-accessors';

export interface OperatorSecurityCommandsWiringDeps {
  readonly store: WorkspaceStateStore;
  readonly secrets: TelemetrySecretStoragePort;
  readonly scannerConsent: NativeReviewScannerConsentPort;
  readonly auditWriter: Pick<AuditLogWriter, 'append'>;
  readonly notifier: Notifier;
  readonly logger: Pick<SanitizedLogger, 'info' | 'warn'>;
}

function createVscodeScannerConsentUi(notifier: Notifier): NativeReviewScannerConsentUi {
  return {
    async confirmModal(summary, detail, confirmLabel) {
      const chosen = await vscode.window.showWarningMessage(
        summary,
        { modal: true, detail },
        confirmLabel
      );
      return chosen === confirmLabel;
    },
    info: (message) => {
      void notifier.info(message);
    },
    warn: (message) => {
      void notifier.warn(message);
    },
    error: (message) => {
      void notifier.error(message);
    }
  };
}

function createVscodeTelemetryCredentialUi(notifier: Notifier): TelemetryCredentialCommandUi {
  return {
    async promptSecretKey(options) {
      return await vscode.window.showInputBox({
        title: options.title,
        prompt: options.prompt,
        value: options.value,
        placeHolder: options.placeHolder,
        ignoreFocusOut: true,
        validateInput: options.validateInput
      });
    },
    async promptSecretValue(options) {
      return await vscode.window.showInputBox({
        title: options.title,
        prompt: options.prompt,
        placeHolder: options.placeHolder,
        password: true,
        ignoreFocusOut: true,
        validateInput: options.validateInput
      });
    },
    async confirmModal(summary, detail, confirmLabel) {
      const chosen = await vscode.window.showWarningMessage(
        summary,
        { modal: true, detail },
        confirmLabel
      );
      return chosen === confirmLabel;
    },
    info: (message) => {
      void notifier.info(message);
    },
    warn: (message) => {
      void notifier.warn(message);
    },
    error: (message) => {
      void notifier.error(message);
    }
  };
}

export function registerOperatorSecurityCommands(
  guard: GuardedCommandDeps,
  deps: OperatorSecurityCommandsWiringDeps
): readonly vscode.Disposable[] {
  const scannerUi = createVscodeScannerConsentUi(deps.notifier);
  const telemetryUi = createVscodeTelemetryCredentialUi(deps.notifier);

  const globalConfig = () => vscode.workspace.getConfiguration();
  const invalidateTelemetryCredential = (reference?: string): void => {
    getSqliteCutoverCoordinator(deps.store)?.getTelemetryHost()?.invalidateCredential(reference);
  };

  return [
    registerGuardedCommand(guard, 'schegent.grantNativeReviewScanner', (rawArg?: unknown) =>
      runGrantNativeReviewScanner(
        {
          config: globalConfig(),
          consent: deps.scannerConsent,
          ui: scannerUi,
          logger: deps.logger,
          auditWriter: deps.auditWriter
        },
        rawArg
      )
    ),
    registerGuardedCommand(guard, 'schegent.revokeNativeReviewScanner', (rawArg?: unknown) =>
      runRevokeNativeReviewScanner(
        {
          config: globalConfig(),
          consent: deps.scannerConsent,
          ui: scannerUi,
          logger: deps.logger,
          auditWriter: deps.auditWriter
        },
        rawArg
      )
    ),
    registerGuardedCommand(guard, 'schegent.setTelemetryCredential', (rawArg?: unknown) =>
      runSetTelemetryCredential(
        {
          secrets: deps.secrets,
          readConfiguredSecretKey: () => readTelemetryExportUserSettings().credentialSecretKey,
          invalidateTelemetryCredential,
          ui: telemetryUi,
          logger: deps.logger,
          auditWriter: deps.auditWriter
        },
        rawArg
      )
    ),
    registerGuardedCommand(guard, 'schegent.clearTelemetryCredential', (rawArg?: unknown) =>
      runClearTelemetryCredential(
        {
          secrets: deps.secrets,
          readConfiguredSecretKey: () => readTelemetryExportUserSettings().credentialSecretKey,
          invalidateTelemetryCredential,
          ui: telemetryUi,
          logger: deps.logger,
          auditWriter: deps.auditWriter
        },
        rawArg
      )
    )
  ];
}
