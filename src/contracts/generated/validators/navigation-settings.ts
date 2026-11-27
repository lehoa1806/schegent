// GENERATED FILE — do not edit.
//
// Emitted from scripts/contracts/ipc-descriptors/navigation-settings.mjs by scripts/generate-contract-schemas.mjs.
// Edit the descriptor and run: npm run contracts:generate

import {
  CMD_DISMISS_MIGRATION_NOTICE,
  CMD_OPEN_AUDIT_LOG,
  CMD_OPEN_DASHBOARD,
  CMD_OPEN_TRUST_SETTINGS,
  CMD_OPEN_VERBOSE_SETTING,
  CMD_PING_BACKEND,
  CMD_SAVE_GENERAL_SETTINGS,
  CMD_SAVE_MODELS,
  CMD_SET_CONFIRM_SUPPRESSION,
  CMD_SET_UNCONTAINED_BACKEND_GRANT,
  type DismissMigrationNoticeCommand,
  type OpenAuditLogCommand,
  type OpenDashboardCommand,
  type OpenTrustSettingsCommand,
  type OpenVerboseSettingCommand,
  type PingBackendCommand,
  type SaveGeneralSettingsCommand,
  type SaveModelsCommand,
  type SetConfirmSuppressionCommand,
  type SetUncontainedBackendGrantCommand
} from '../../sidebar-ipc';
import { fail, hasUnexpectedKeys, ok, type IpcValidationResult } from '../../validators/shared';
import { isBackendRunnerKind } from '../../backend-kinds';

export function validateOpenAuditLog(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  if ('payload' in obj && obj['payload'] !== undefined) {
    return fail('unexpected-payload', { type: CMD_OPEN_AUDIT_LOG, correlationId });
  }
  const command: OpenAuditLogCommand = { type: CMD_OPEN_AUDIT_LOG, correlationId };
  return ok(command);
}

export function validateOpenDashboard(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  if ('payload' in obj && obj['payload'] !== undefined) {
    return fail('unexpected-payload', { type: CMD_OPEN_DASHBOARD, correlationId });
  }
  const command: OpenDashboardCommand = { type: CMD_OPEN_DASHBOARD, correlationId };
  return ok(command);
}

export function validateOpenVerboseSetting(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  if ('payload' in obj && obj['payload'] !== undefined) {
    return fail('unexpected-payload', { type: CMD_OPEN_VERBOSE_SETTING, correlationId });
  }
  const command: OpenVerboseSettingCommand = { type: CMD_OPEN_VERBOSE_SETTING, correlationId };
  return ok(command);
}

export function validateOpenTrustSettings(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  if ('payload' in obj && obj['payload'] !== undefined) {
    return fail('unexpected-payload', { type: CMD_OPEN_TRUST_SETTINGS, correlationId });
  }
  const command: OpenTrustSettingsCommand = { type: CMD_OPEN_TRUST_SETTINGS, correlationId };
  return ok(command);
}

export function validateDismissMigrationNotice(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  if ('payload' in obj && obj['payload'] !== undefined) {
    return fail('unexpected-payload', { type: CMD_DISMISS_MIGRATION_NOTICE, correlationId });
  }
  const command: DismissMigrationNoticeCommand = { type: CMD_DISMISS_MIGRATION_NOTICE, correlationId };
  return ok(command);
}

export function validateSetConfirmSuppression(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('invalid-payload', { type: CMD_SET_CONFIRM_SUPPRESSION, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  const validated_actionKeyRaw: unknown = validatedObj['actionKey'];
  if (typeof validated_actionKeyRaw !== 'string') {
    return fail('invalid-payload', { type: CMD_SET_CONFIRM_SUPPRESSION, correlationId });
  }
  const validated_actionKey: string = validated_actionKeyRaw;
  const validated_suppressedRaw: unknown = validatedObj['suppressed'];
  if (typeof validated_suppressedRaw !== 'boolean') {
    return fail('invalid-payload', { type: CMD_SET_CONFIRM_SUPPRESSION, correlationId });
  }
  const validated_suppressed: boolean = validated_suppressedRaw;
  const validated = { actionKey: validated_actionKey, suppressed: validated_suppressed };
  const command: SetConfirmSuppressionCommand = { type: CMD_SET_CONFIRM_SUPPRESSION, correlationId, payload: validated };
  return ok(command);
}

export function validateSaveModels(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_SAVE_MODELS, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  const validated_modelsRaw: unknown = validatedObj['models'];
  if (validated_modelsRaw === null || typeof validated_modelsRaw !== 'object' || Array.isArray(validated_modelsRaw)) {
    return fail('invalid-payload', { type: CMD_SAVE_MODELS, correlationId });
  }
  const validated_models: Record<string, readonly string[]> = {};
  for (const [validated_modelsKey, validated_modelsEntryVal] of Object.entries(validated_modelsRaw)) {
    if (!Array.isArray(validated_modelsEntryVal)) {
      return fail('invalid-payload', { type: CMD_SAVE_MODELS, correlationId });
    }
    const validated_modelsVal: string[] = [];
    for (const validated_modelsValEl of validated_modelsEntryVal) {
      if (typeof validated_modelsValEl !== 'string') {
        return fail('invalid-payload', { type: CMD_SAVE_MODELS, correlationId });
      }
      if (validated_modelsValEl.length < 1) {
        return fail('invalid-payload', { type: CMD_SAVE_MODELS, correlationId });
      }
      const validated_modelsValItem: string = validated_modelsValEl;
      validated_modelsVal.push(validated_modelsValItem);
    }
    validated_models[validated_modelsKey] = validated_modelsVal;
  }
  const validated_expectedRevisionRaw: unknown = validatedObj['expectedRevision'];
  let validated_expectedRevision: string | undefined;
  if (validated_expectedRevisionRaw !== undefined) {
    if (typeof validated_expectedRevisionRaw !== 'string') {
      return fail('invalid-payload', { type: CMD_SAVE_MODELS, correlationId });
    }
    if (validated_expectedRevisionRaw.length < 1) {
      return fail('invalid-payload', { type: CMD_SAVE_MODELS, correlationId });
    }
    const validated_expectedRevisionChecked: string = validated_expectedRevisionRaw;
    validated_expectedRevision = validated_expectedRevisionChecked;
  }
  const validated_mutationRaw: unknown = validatedObj['mutation'];
  let validated_mutation: {
  readonly kind: 'manual-edit' | 'import-package';
} | undefined;
  if (validated_mutationRaw !== undefined) {
    if (validated_mutationRaw === null || typeof validated_mutationRaw !== 'object' || Array.isArray(validated_mutationRaw)) {
      return fail('invalid-payload', { type: CMD_SAVE_MODELS, correlationId });
    }
    const validated_mutationCheckedObj = validated_mutationRaw as Record<string, unknown>;
    if (hasUnexpectedKeys(validated_mutationCheckedObj, ['kind'])) {
      return fail('invalid-payload', { type: CMD_SAVE_MODELS, correlationId });
    }
    const validated_mutationChecked_kindRaw: unknown = validated_mutationCheckedObj['kind'];
    if (!(validated_mutationChecked_kindRaw === 'manual-edit' || validated_mutationChecked_kindRaw === 'import-package')) {
      return fail('invalid-payload', { type: CMD_SAVE_MODELS, correlationId });
    }
    const validated_mutationChecked_kind: 'manual-edit' | 'import-package' = validated_mutationChecked_kindRaw;
    const validated_mutationChecked = { kind: validated_mutationChecked_kind };
    validated_mutation = validated_mutationChecked;
  }
  const validated = { models: validated_models, ...(validated_expectedRevision === undefined ? {} : { expectedRevision: validated_expectedRevision }), ...(validated_mutation === undefined ? {} : { mutation: validated_mutation }) };
  const command: SaveModelsCommand = { type: CMD_SAVE_MODELS, correlationId, payload: validated };
  return ok(command);
}

export function validateSaveGeneralSettings(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object') {
    return fail('missing-payload', { type: CMD_SAVE_GENERAL_SETTINGS, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['updates'])) {
    return fail('unexpected-payload-fields', { type: CMD_SAVE_GENERAL_SETTINGS, correlationId });
  }
  const validated_updatesRaw: unknown = validatedObj['updates'];
  if (validated_updatesRaw === null || typeof validated_updatesRaw !== 'object' || Array.isArray(validated_updatesRaw)) {
    return fail('invalid-updates', { type: CMD_SAVE_GENERAL_SETTINGS, correlationId });
  }
  const validated_updates: Readonly<Record<string, unknown>> = validated_updatesRaw as Record<string, unknown>;
  const validated = { updates: validated_updates };
  const command: SaveGeneralSettingsCommand = { type: CMD_SAVE_GENERAL_SETTINGS, correlationId, payload: validated };
  return ok(command);
}

export function validatePingBackend(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_PING_BACKEND, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['runner'])) {
    return fail('unexpected-payload-fields', { type: CMD_PING_BACKEND, correlationId });
  }
  const validated_runnerRaw: unknown = validatedObj['runner'];
  if (!(validated_runnerRaw === 'claude' || validated_runnerRaw === 'codex' || validated_runnerRaw === 'agy')) {
    return fail('invalid-runner', { type: CMD_PING_BACKEND, correlationId });
  }
  const validated_runner: 'claude' | 'codex' | 'agy' = validated_runnerRaw;
  const validated = { runner: validated_runner };
  const command: PingBackendCommand = { type: CMD_PING_BACKEND, correlationId, payload: validated };
  return ok(command);
}

export function validateSetUncontainedBackendGrant(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_SET_UNCONTAINED_BACKEND_GRANT, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['kind', 'granted'])) {
    return fail('unexpected-payload-fields', { type: CMD_SET_UNCONTAINED_BACKEND_GRANT, correlationId });
  }
  const validated_kindRaw: unknown = validatedObj['kind'];
  if (!isBackendRunnerKind(validated_kindRaw)) {
    return fail('invalid-backend-kind', { type: CMD_SET_UNCONTAINED_BACKEND_GRANT, correlationId });
  }
  const validated_kind = validated_kindRaw;
  const validated_grantedRaw: unknown = validatedObj['granted'];
  if (typeof validated_grantedRaw !== 'boolean') {
    return fail('invalid-granted', { type: CMD_SET_UNCONTAINED_BACKEND_GRANT, correlationId });
  }
  const validated_granted: boolean = validated_grantedRaw;
  const validated = { kind: validated_kind, granted: validated_granted };
  const command: SetUncontainedBackendGrantCommand = { type: CMD_SET_UNCONTAINED_BACKEND_GRANT, correlationId, payload: validated };
  return ok(command);
}
