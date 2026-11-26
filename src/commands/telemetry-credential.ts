/**
 * Principal Review F6 — operator commands for storing, rotating, and clearing OTLP telemetry
 * export credentials in VS Code `SecretStorage`, with immediate exporter credential-cache
 * invalidation.
 *
 * Security invariants:
 *   - Secret values are NEVER read from command arguments (only from a password-masked prompt),
 *     NEVER written to settings/files/audit payloads, and NEVER logged.
 *   - Secret values are validated as printable ASCII header values (<= 8,192 chars, no CR/LF or
 *     control characters) before writing to `SecretStorage`.
 *   - After storing or deleting a secret, the live telemetry exporter's cached credential is
 *     invalidated immediately so rotation or deletion takes effect on the next batch without
 *     reloading VS Code.
 *
 * Zero `vscode` imports and zero imports from `src/services/telemetry-export/`
 * (`tests/lint/expansion-freeze.test.ts`).
 */
import { createHash } from 'node:crypto';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import { errorMessage } from '../lib/errors';
import type { SanitizedLogger } from '../lib/logger';

const CREDENTIAL_REFERENCE_CHARS_MAX = 256;
const CREDENTIAL_VALUE_CHARS_MAX = 8_192;
const FIRST_KEY_PRINTABLE = 0x21;
const FIRST_VALUE_PRINTABLE = 0x20;
const LAST_PRINTABLE = 0x7e;

export interface TelemetrySecretStoragePort {
  store(key: string, value: string): Promise<void> | Thenable<void>;
  delete(key: string): Promise<void> | Thenable<void>;
}

export interface TelemetryCredentialCommandUi {
  promptSecretKey(options: {
    readonly title: string;
    readonly prompt: string;
    readonly value: string;
    readonly placeHolder: string;
    readonly validateInput: (candidate: string) => string | undefined;
  }): Promise<string | undefined>;
  promptSecretValue(options: {
    readonly title: string;
    readonly prompt: string;
    readonly placeHolder: string;
    readonly validateInput: (candidate: string) => string | undefined;
  }): Promise<string | undefined>;
  confirmModal(summary: string, detail: string, confirmLabel: string): Promise<boolean>;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface TelemetryCredentialCommandDeps {
  readonly secrets: TelemetrySecretStoragePort;
  readonly readConfiguredSecretKey: () => string;
  readonly invalidateTelemetryCredential: (reference?: string) => void;
  readonly ui: TelemetryCredentialCommandUi;
  readonly logger: Pick<SanitizedLogger, 'info' | 'warn'>;
  readonly auditWriter?: Pick<AuditLogWriter, 'append'> | undefined;
  readonly hasPrimacy?: () => Promise<boolean> | boolean;
}

const OPERATOR_SECURITY_AUDIT_RUN_ID = 'operator-security';
const ALLOWED_SCHEGENT_TELEMETRY_PREFIXES = ['schegent.telemetry.', 'schegent.otlp.'] as const;

function hashSecretKeyPrefix(secretKey: string): string {
  return createHash('sha256').update(secretKey, 'utf8').digest('hex').slice(0, 16);
}

async function appendTelemetryCredentialAudit(
  deps: TelemetryCredentialCommandDeps,
  payload: {
    readonly action: 'stored' | 'cleared';
    readonly secretKeyDigestPrefix: string;
    readonly matchesConfiguredKey?: boolean;
  }
): Promise<void> {
  if (deps.auditWriter === undefined) return;
  if (deps.hasPrimacy !== undefined && !(await deps.hasPrimacy())) {
    deps.logger.info('telemetry.credential audit-skipped reason=secondary-window');
    return;
  }
  try {
    await deps.auditWriter.append({
      runId: OPERATOR_SECURITY_AUDIT_RUN_ID,
      phase: 'operator',
      iteration: 0,
      eventType: 'telemetry-credential-changed',
      outcome: 'info',
      payload
    });
  } catch (error) {
    deps.logger.warn(`telemetry.credential audit-append-failed reason=${errorMessage(error)}`);
  }
}

export type SetTelemetryCredentialResult =
  | { readonly outcome: 'stored'; readonly secretKey: string; readonly matchesConfiguredKey: boolean }
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'invalid-input'; readonly field: 'secretKey' | 'secretValue' }
  | { readonly outcome: 'write-failed' };

export type ClearTelemetryCredentialResult =
  | { readonly outcome: 'cleared'; readonly secretKey: string }
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'invalid-input' }
  | { readonly outcome: 'write-failed' };

export function validateTelemetrySecretKey(
  candidate: string,
  configuredKey?: string
): string | undefined {
  if (candidate.length === 0) return 'SecretStorage key name cannot be empty.';
  if (candidate.length > CREDENTIAL_REFERENCE_CHARS_MAX) {
    return `SecretStorage key name must be at most ${CREDENTIAL_REFERENCE_CHARS_MAX} characters.`;
  }
  for (let i = 0; i < candidate.length; i += 1) {
    const code = candidate.charCodeAt(i);
    if (code < FIRST_KEY_PRINTABLE || code > LAST_PRINTABLE) {
      return 'SecretStorage key name must contain only printable non-whitespace ASCII characters.';
    }
  }
  // Protect non-telemetry internal `schegent.*` SecretStorage namespaces from cross-feature
  // overwrite or deletion unless the operator explicitly configured that exact key in User settings.
  if (
    candidate.startsWith('schegent.') &&
    candidate !== configuredKey &&
    !ALLOWED_SCHEGENT_TELEMETRY_PREFIXES.some((prefix) => candidate.startsWith(prefix))
  ) {
    return 'Keys under the "schegent." namespace must start with "schegent.telemetry." or "schegent.otlp." (or match schegent.telemetry.export.credentialSecretKey).';
  }
  return undefined;
}

export function validateTelemetrySecretValue(candidate: string): string | undefined {
  if (candidate.length === 0) return 'Credential value cannot be empty.';
  if (candidate.length > CREDENTIAL_VALUE_CHARS_MAX) {
    return `Credential value must be at most ${CREDENTIAL_VALUE_CHARS_MAX} characters.`;
  }
  for (let i = 0; i < candidate.length; i += 1) {
    const code = candidate.charCodeAt(i);
    if (code < FIRST_VALUE_PRINTABLE || code > LAST_PRINTABLE) {
      return 'Credential value must contain only printable ASCII characters (no line breaks or control characters).';
    }
  }
  return undefined;
}

function extractSecretKeyArg(rawArg: unknown): string | undefined {
  if (typeof rawArg === 'string') return rawArg.trim();
  if (
    rawArg !== null &&
    typeof rawArg === 'object' &&
    !Array.isArray(rawArg) &&
    typeof (rawArg as Record<string, unknown>).secretKey === 'string'
  ) {
    return ((rawArg as Record<string, unknown>).secretKey as string).trim();
  }
  return undefined;
}

export async function runSetTelemetryCredential(
  deps: TelemetryCredentialCommandDeps,
  rawArg?: unknown
): Promise<SetTelemetryCredentialResult> {
  const configuredKey = deps.readConfiguredSecretKey().trim();
  const explicitKey = extractSecretKeyArg(rawArg);

  let secretKey: string | undefined;
  if (explicitKey !== undefined) {
    secretKey = explicitKey;
  } else {
    secretKey = await deps.ui.promptSecretKey({
      title: 'Schegent: Set Telemetry Export Credential (1/2)',
      prompt:
        'Enter the VS Code SecretStorage key referenced by schegent.telemetry.export.credentialSecretKey.',
      value: configuredKey,
      placeHolder: 'e.g. schegent.otlp.token',
      validateInput: (candidate) => validateTelemetrySecretKey(candidate, configuredKey)
    });
    if (secretKey === undefined) return { outcome: 'cancelled' };
    secretKey = secretKey.trim();
  }

  const keyError = validateTelemetrySecretKey(secretKey, configuredKey);
  if (keyError !== undefined) {
    deps.ui.warn(`Schegent: invalid telemetry credential key (${keyError})`);
    return { outcome: 'invalid-input', field: 'secretKey' };
  }

  const secretValue = await deps.ui.promptSecretValue({
    title: 'Schegent: Set Telemetry Export Credential (2/2)',
    prompt:
      `Enter the HTTP header credential value to store under SecretStorage key "${secretKey}" (e.g. "Bearer <token>"). The value is never written to settings or logs.`,
    placeHolder: 'Bearer <token>',
    validateInput: validateTelemetrySecretValue
  });
  if (secretValue === undefined) return { outcome: 'cancelled' };

  const valueError = validateTelemetrySecretValue(secretValue);
  if (valueError !== undefined) {
    deps.ui.warn(`Schegent: invalid telemetry credential value (${valueError})`);
    return { outcome: 'invalid-input', field: 'secretValue' };
  }

  try {
    await deps.secrets.store(secretKey, secretValue);
  } catch (error) {
    deps.logger.warn(`telemetry.credential store-failed reason=${errorMessage(error)}`);
    deps.ui.error('Schegent: failed to store telemetry export credential in SecretStorage.');
    return { outcome: 'write-failed' };
  }

  deps.invalidateTelemetryCredential(secretKey);
  deps.logger.info('telemetry.credential stored and cache invalidated');

  const matchesConfiguredKey = configuredKey === secretKey;
  await appendTelemetryCredentialAudit(deps, {
    action: 'stored',
    secretKeyDigestPrefix: hashSecretKeyPrefix(secretKey),
    matchesConfiguredKey
  });
  if (matchesConfiguredKey) {
    deps.ui.info(
      'Schegent: stored telemetry export credential in SecretStorage and refreshed active exporter credentials.'
    );
  } else {
    deps.ui.info(
      'Schegent: stored telemetry export credential in SecretStorage. Set User setting "schegent.telemetry.export.credentialSecretKey" to match this key to use it.'
    );
  }

  return { outcome: 'stored', secretKey, matchesConfiguredKey };
}

export async function runClearTelemetryCredential(
  deps: TelemetryCredentialCommandDeps,
  rawArg?: unknown
): Promise<ClearTelemetryCredentialResult> {
  const configuredKey = deps.readConfiguredSecretKey().trim();
  const explicitKey = extractSecretKeyArg(rawArg);

  let secretKey: string | undefined;
  if (explicitKey !== undefined) {
    secretKey = explicitKey;
  } else {
    secretKey = await deps.ui.promptSecretKey({
      title: 'Schegent: Clear Telemetry Export Credential',
      prompt: 'Enter the VS Code SecretStorage key to remove.',
      value: configuredKey,
      placeHolder: 'e.g. schegent.otlp.token',
      validateInput: (candidate) => validateTelemetrySecretKey(candidate, configuredKey)
    });
    if (secretKey === undefined) return { outcome: 'cancelled' };
    secretKey = secretKey.trim();
  }

  const keyError = validateTelemetrySecretKey(secretKey, configuredKey);
  if (keyError !== undefined) {
    deps.ui.warn(`Schegent: invalid telemetry credential key (${keyError})`);
    return { outcome: 'invalid-input' };
  }

  let confirmed = false;
  try {
    confirmed = await deps.ui.confirmModal(
      `Remove telemetry export credential "${secretKey}" from SecretStorage?`,
      `Deleting SecretStorage key "${secretKey}" immediately invalidates any cached credential in the OTLP telemetry exporter. Future authenticated exports referencing this key will drop batches with credential-unavailable until a new secret is stored.`,
      'Remove Credential'
    );
  } catch (error) {
    deps.logger.warn(`telemetry.credential clear-modal-failed reason=${errorMessage(error)}`);
    return { outcome: 'cancelled' };
  }

  if (!confirmed) return { outcome: 'cancelled' };

  try {
    await deps.secrets.delete(secretKey);
  } catch (error) {
    deps.logger.warn(`telemetry.credential delete-failed reason=${errorMessage(error)}`);
    deps.ui.error('Schegent: failed to remove telemetry export credential from SecretStorage.');
    return { outcome: 'write-failed' };
  }

  deps.invalidateTelemetryCredential(secretKey);
  deps.logger.info('telemetry.credential cleared and cache invalidated');
  await appendTelemetryCredentialAudit(deps, {
    action: 'cleared',
    secretKeyDigestPrefix: hashSecretKeyPrefix(secretKey)
  });
  deps.ui.info(
    'Schegent: removed telemetry export credential from SecretStorage and invalidated cached exporter credentials.'
  );
  return { outcome: 'cleared', secretKey };
}

