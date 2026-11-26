/**
 * Principal Review F5 — explicit installed-editor consent and revocation commands for
 * standalone uncontained native review scanners (`codex-security`).
 *
 * `codex-security` has NO observed OS containment sandbox (`mechanism: 'none'`). It stays
 * refused with zero subprocess spawns until an operator explicitly runs
 * `schegent.grantNativeReviewScanner`, reviews the uncontained posture and resolved executable
 * fingerprint digest in a modal confirmation, and confirms. `schegent.revokeNativeReviewScanner`
 * removes both the application-scoped setting entry and the workspace fingerprint binding so
 * subsequent invocations fail closed with zero spawns.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { AuditLogWriter } from '../audit/audit-log-writer';
import { CONFIGURATION_TARGET_GLOBAL } from '../config/general-settings';
import {
  REVIEW_SCANNERS,
  type BindingInput,
  type ExecutableUnresolvedCause,
  type FingerprintRecord,
  type ReviewScannerId
} from '../contracts/containment-qualification';
import { errorMessage } from '../lib/errors';
import type { SanitizedLogger } from '../lib/logger';
import { ALLOW_UNCONTAINED_SCANNER_SETTING } from '../services/backend-containment-policy';
import type { UncontainedConsentConfig } from '../services/uncontained-grant-writer';

export interface NativeReviewScannerConsentUi {
  confirmModal(summary: string, detail: string, confirmLabel: string): Promise<boolean>;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface NativeReviewScannerConsentPort {
  readonly inspectScannerForConsent: (
    scanner: ReviewScannerId
  ) => Promise<
    | {
        readonly ok: true;
        readonly fingerprint: FingerprintRecord;
        readonly resolvedPath: string;
        readonly binaryDigest: string;
      }
    | { readonly ok: false; readonly cause: ExecutableUnresolvedCause }
  >;
  readonly recordScannerAcceptance: (
    scanner: ReviewScannerId,
    fingerprint: FingerprintRecord
  ) => Promise<void>;
  readonly revokeScannerAcceptance: (scanner: ReviewScannerId) => Promise<boolean>;
  readonly readScannerBinding: (scanner: ReviewScannerId) => BindingInput;
}

export interface NativeReviewScannerCommandDeps {
  readonly config: UncontainedConsentConfig;
  readonly consent: NativeReviewScannerConsentPort;
  readonly ui: NativeReviewScannerConsentUi;
  readonly logger: Pick<SanitizedLogger, 'info' | 'warn'>;
  readonly auditWriter?: Pick<AuditLogWriter, 'append'> | undefined;
}

async function appendScannerConsentAudit(
  deps: NativeReviewScannerCommandDeps,
  outcome: 'success' | 'info',
  payload: {
    readonly scanner: ReviewScannerId;
    readonly action: 'granted' | 'denied' | 'revoked';
    readonly fingerprintDigestPrefix?: string;
    readonly removedSetting?: boolean;
    readonly clearedBinding?: boolean;
  }
): Promise<void> {
  if (deps.auditWriter === undefined) return;
  try {
    await deps.auditWriter.append({
      runId: '',
      phase: 'operator',
      iteration: 0,
      eventType: 'scanner-consent-changed',
      outcome,
      payload
    });
  } catch (error) {
    deps.logger.warn(`scanner.consent audit-append-failed reason=${errorMessage(error)}`);
  }
}

export type GrantNativeReviewScannerResult =
  | { readonly outcome: 'granted'; readonly scanner: ReviewScannerId; readonly fingerprintDigest: string }
  | { readonly outcome: 'denied'; readonly scanner: ReviewScannerId }
  | { readonly outcome: 'unresolved'; readonly scanner: ReviewScannerId; readonly cause: ExecutableUnresolvedCause }
  | { readonly outcome: 'invalid-scanner' }
  | { readonly outcome: 'write-failed'; readonly scanner: ReviewScannerId };

export type RevokeNativeReviewScannerResult =
  | { readonly outcome: 'revoked'; readonly scanner: ReviewScannerId; readonly removedSetting: boolean; readonly clearedBinding: boolean }
  | { readonly outcome: 'already-absent'; readonly scanner: ReviewScannerId }
  | { readonly outcome: 'invalid-scanner' }
  | { readonly outcome: 'write-failed'; readonly scanner: ReviewScannerId };

const DEFAULT_SCANNER: ReviewScannerId = 'codex-security';

function parseScannerArg(rawArg: unknown): ReviewScannerId | null {
  if (rawArg === undefined || rawArg === null) return DEFAULT_SCANNER;
  const candidate =
    typeof rawArg === 'string'
      ? rawArg
      : typeof rawArg === 'object' && !Array.isArray(rawArg) && typeof (rawArg as Record<string, unknown>).scanner === 'string'
        ? ((rawArg as Record<string, unknown>).scanner as string)
        : null;
  if (candidate === null) return null;
  return (REVIEW_SCANNERS as readonly string[]).includes(candidate)
    ? (candidate as ReviewScannerId)
    : null;
}

function readGrantedScannersList(config: UncontainedConsentConfig): readonly string[] {
  const raw = config.get<unknown>(ALLOW_UNCONTAINED_SCANNER_SETTING);
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string');
}

export function scannerConsentApproveLabel(scanner: ReviewScannerId): string {
  return `Enable '${scanner}' for This Installation`;
}

export async function runGrantNativeReviewScanner(
  deps: NativeReviewScannerCommandDeps,
  rawArg?: unknown
): Promise<GrantNativeReviewScannerResult> {
  const scanner = parseScannerArg(rawArg);
  if (scanner === null) {
    deps.ui.warn(
      `Schegent: unsupported review scanner id. Supported standalone scanners: ${REVIEW_SCANNERS.join(', ')}.`
    );
    return { outcome: 'invalid-scanner' };
  }

  let inspected: Awaited<ReturnType<NativeReviewScannerConsentPort['inspectScannerForConsent']>>;
  try {
    inspected = await deps.consent.inspectScannerForConsent(scanner);
  } catch (error) {
    deps.logger.warn(`scanner.consent inspect-failed scanner=${scanner} reason=${errorMessage(error)}`);
    deps.ui.error(`Schegent: could not inspect '${scanner}' (see the Schegent log for details).`);
    return { outcome: 'write-failed', scanner };
  }

  if (!inspected.ok) {
    const why =
      inspected.cause === 'not-found'
        ? 'the executable was not found on the sanitized PATH'
        : 'the resolved file is not executable';
    deps.logger.info(`scanner.consent unresolved scanner=${scanner} cause=${inspected.cause}`);
    deps.ui.warn(
      `Schegent: cannot grant '${scanner}' because ${why}. Install '${scanner}' and try again.`
    );
    return { outcome: 'unresolved', scanner, cause: inspected.cause };
  }

  const shortBinaryDigest = inspected.binaryDigest.slice(0, 16);
  const shortFingerprint = inspected.fingerprint.digest.slice(0, 16);
  const version = inspected.fingerprint.components.version;
  const approveLabel = scannerConsentApproveLabel(scanner);

  let confirmed = false;
  try {
    confirmed = await deps.ui.confirmModal(
      `Allow uncontained native review scanner '${scanner}'?`,
      `'${scanner}' runs with NO observed OS containment sandbox (mechanism: none): it executes with your local user authority. ` +
        `Disabling write flags (--patch=false, --create-pr=false, --validate=false) reduces risk but is not OS containment.\n\n` +
        `Observed executable identity:\n` +
        `• Version: ${version}\n` +
        `• Binary SHA-256: ${shortBinaryDigest}…\n` +
        `• Fingerprint: ${shortFingerprint}…\n\n` +
        `Confirming adds '${scanner}' to application-scoped '${ALLOW_UNCONTAINED_SCANNER_SETTING}' (all trusted workspaces in this installation) ` +
        `and binds this exact executable fingerprint for this workspace. Any change to the binary or version revokes admission automatically.`,
      approveLabel
    );
  } catch (error) {
    deps.logger.warn(`scanner.consent modal-failed scanner=${scanner} reason=${errorMessage(error)}`);
    return { outcome: 'denied', scanner };
  }

  if (!confirmed) {
    deps.logger.info(`scanner.consent denied scanner=${scanner}`);
    await appendScannerConsentAudit(deps, 'info', { scanner, action: 'denied' });
    return { outcome: 'denied', scanner };
  }

  try {
    const current = readGrantedScannersList(deps.config);
    if (!current.includes(scanner)) {
      await deps.config.update(
        ALLOW_UNCONTAINED_SCANNER_SETTING,
        [...current, scanner],
        CONFIGURATION_TARGET_GLOBAL
      );
    }
    await deps.consent.recordScannerAcceptance(scanner, inspected.fingerprint);
  } catch (error) {
    deps.logger.warn(`scanner.consent write-failed scanner=${scanner} reason=${errorMessage(error)}`);
    deps.ui.error(
      `Schegent: could not persist consent for '${scanner}' (see the Schegent log for details).`
    );
    return { outcome: 'write-failed', scanner };
  }

  deps.logger.info(
    `scanner.consent granted scanner=${scanner} version=${version} fingerprint=${shortFingerprint}`
  );
  await appendScannerConsentAudit(deps, 'success', {
    scanner,
    action: 'granted',
    fingerprintDigestPrefix: shortFingerprint
  });
  deps.ui.info(
    `Schegent: granted '${scanner}' (${version}, fingerprint ${shortFingerprint}…). Use "Schegent: Revoke Native Review Scanner" to revoke.`
  );
  return { outcome: 'granted', scanner, fingerprintDigest: inspected.fingerprint.digest };
}

export async function runRevokeNativeReviewScanner(
  deps: NativeReviewScannerCommandDeps,
  rawArg?: unknown
): Promise<RevokeNativeReviewScannerResult> {
  const scanner = parseScannerArg(rawArg);
  if (scanner === null) {
    deps.ui.warn(
      `Schegent: unsupported review scanner id. Supported standalone scanners: ${REVIEW_SCANNERS.join(', ')}.`
    );
    return { outcome: 'invalid-scanner' };
  }

  const current = readGrantedScannersList(deps.config);
  const hasSetting = current.includes(scanner);
  const existingBinding = deps.consent.readScannerBinding(scanner);
  const hasBinding = existingBinding !== null;

  if (!hasSetting && !hasBinding) {
    deps.logger.info(`scanner.consent revoke-already-absent scanner=${scanner}`);
    deps.ui.info(`Schegent: '${scanner}' is not currently granted or bound in this workspace.`);
    return { outcome: 'already-absent', scanner };
  }

  let removedSetting = false;
  let clearedBinding = false;
  try {
    if (hasSetting) {
      const next = current.filter((entry) => entry !== scanner);
      await deps.config.update(
        ALLOW_UNCONTAINED_SCANNER_SETTING,
        next,
        CONFIGURATION_TARGET_GLOBAL
      );
      removedSetting = true;
    }
    clearedBinding = await deps.consent.revokeScannerAcceptance(scanner);
  } catch (error) {
    deps.logger.warn(`scanner.consent revoke-failed scanner=${scanner} reason=${errorMessage(error)}`);
    deps.ui.error(
      `Schegent: could not revoke consent for '${scanner}' (see the Schegent log for details).`
    );
    return { outcome: 'write-failed', scanner };
  }

  deps.logger.info(
    `scanner.consent revoked scanner=${scanner} removedSetting=${removedSetting} clearedBinding=${clearedBinding}`
  );
  await appendScannerConsentAudit(deps, 'success', {
    scanner,
    action: 'revoked',
    removedSetting,
    clearedBinding
  });
  deps.ui.info(
    `Schegent: revoked '${scanner}' consent and cleared its workspace fingerprint binding.`
  );
  return { outcome: 'revoked', scanner, removedSetting, clearedBinding };
}

