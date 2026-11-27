// FR-R7-11 (Hard Rule 22) — closed 7-field metadata-only projection for
// `store-backup` and `store-restore`. Only `operation`, `outcome`, `backupId`,
// and optional `errorCode`, `schemaVersion`, `databaseBytes`, `restoredTableCount`
// may reach the audit log; any extra key or malformed value throws
// `AuditPayloadValidationError`.
import type { StoreBackupRestoreAuditPayload } from '../contracts/sqlite-store/schema-types';
import { AuditPayloadValidationError } from './audit-payload-error';

const REASON = 'malformed-store-backup-restore';
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'operation',
  'outcome',
  'backupId',
  'errorCode',
  'schemaVersion',
  'databaseBytes',
  'restoredTableCount'
]);
const ALLOWED_OUTCOMES: ReadonlySet<string> = new Set([
  'succeeded',
  'rejected',
  'refused',
  'failed'
]);
const SAFE_BACKUP_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const CLOSED_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

const reject = (): AuditPayloadValidationError => new AuditPayloadValidationError(REASON);

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function projectStoreBackupRestorePayload(
  payload: Record<string, unknown>,
  eventType?: 'store-backup' | 'store-restore'
): StoreBackupRestoreAuditPayload {
  if (Object.keys(payload).some((key) => !ALLOWED_KEYS.has(key))) throw reject();

  const {
    operation,
    outcome,
    backupId,
    errorCode,
    schemaVersion,
    databaseBytes,
    restoredTableCount
  } = payload;

  if (operation !== 'backup' && operation !== 'restore') throw reject();
  if (eventType === 'store-backup' && operation !== 'backup') throw reject();
  if (eventType === 'store-restore' && operation !== 'restore') throw reject();

  if (typeof outcome !== 'string' || !ALLOWED_OUTCOMES.has(outcome)) throw reject();
  if (typeof backupId !== 'string' || !SAFE_BACKUP_ID_RE.test(backupId) || backupId.includes('..')) {
    throw reject();
  }
  if (
    errorCode !== undefined &&
    (typeof errorCode !== 'string' || !CLOSED_ERROR_CODE_RE.test(errorCode))
  ) {
    throw reject();
  }
  if (schemaVersion !== undefined && (!isNonNegativeSafeInt(schemaVersion) || schemaVersion < 1)) {
    throw reject();
  }
  if (databaseBytes !== undefined && !isNonNegativeSafeInt(databaseBytes)) throw reject();
  if (restoredTableCount !== undefined && !isNonNegativeSafeInt(restoredTableCount)) throw reject();

  return Object.freeze({
    operation,
    outcome: outcome as StoreBackupRestoreAuditPayload['outcome'],
    backupId,
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(schemaVersion !== undefined ? { schemaVersion } : {}),
    ...(databaseBytes !== undefined ? { databaseBytes } : {}),
    ...(restoredTableCount !== undefined ? { restoredTableCount } : {})
  });
}
