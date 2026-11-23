/**
 * FR-R7-10 & FR-R7-11 (Tasks 16–19) — One SQLite operational store per folder, with
 * crash-safe, WAL-preserving one-time relocation from legacy per-window `storageUri` roots
 * into the canonical folder-keyed `<globalStorageUri>/sqlite/<scope>/schegent-state.db`.
 *
 * Security & durability invariants:
 * - Zero `vscode` imports (docs/hard-rules.md rule 13).
 * - Zero raw `node:fs` creating/writing/chmod primitives (docs/hard-rules.md rule 69):
 *   directories use `ensureAnchorWithinRoot(..., 0o700)`, file reads/writes use
 *   `openWithinRoot` with explicit owner-only modes (`0o600` / `0o400`), post-VACUUM
 *   narrowing uses `narrowMode(..., 0o600)`, and every `rename` / `unlink` is preceded
 *   by `resolveContainedLink` containment proof within 25 lines.
 * - Strict segment-by-segment symlink rejection & zero-mutation read-only inspection
 *   (`src/lib/sqlite-readonly-inspect.ts`): `immutable=1` when `-wal` absent, private
 *   `0o700`/`0o600` staged copy when `-wal` present, leaving unselected & schema-refused
 *   databases byte-identical with zero newly created sidecars.
 * - Real host filesystem verdict probing (`src/services/sqlite-store/filesystem-type-detector.ts`)
 *   for both canonical destination and legacy source before any canonical write.
 * - Exact Spec 324 winner rule: max persisted operational/schema timestamp (fallback max
 *   `.db`/`-wal` mtime), summed Run count (`runs + operational_runs`), canonical preference,
 *   lexicographical path order. Zero silent row merging.
 */

import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { SQLITE_SCHEMA_CURRENT_VERSION } from '../../contracts/sqlite-store/schema-types';
import { parseStrictSchemaMetaVersion } from '../../lib/operational-value-helpers';
import { ensureAnchorWithinRoot, judgeLeafRedirect, openWithinRoot, platformLacksNoFollow, walkDirectoriesWithinRoot } from '../../lib/safe-open';
import {
  verifySqliteCandidateWithinRoot,
  withZeroMutationReadOnlySqlite
} from '../../lib/sqlite-readonly-inspect';
import {
  classifyFilesystemTypeName,
  detectFilesystemType,
  type FilesystemTypeVerdict
} from './filesystem-type-detector';
import {
  CANONICAL_DB_FILENAME, STAGING_DB_FILENAME, computeFileSha256WithinRoot, fingerprintFromVerified,
  fingerprintsMatch, matchesPreviousCanonical, publishStagedRelocation, readJsonStatusWithinRoot,
  readRegularFileWithinRoot, renameContainedEntry, syncRelocationDirectory, unlinkContainedEntry,
  writeAtomicJsonWithinAnchor, writeFully
} from './store-relocation-files';

const UNSELECTED_TMP_FILENAME = '.schegent-state.unselected.tmp.db';
const UNSELECTED_READONLY_TMP_FILENAME = '.schegent-state.unselected.readonly.tmp.db';
const JOURNAL_FILENAME = '.relocation-in-progress.json';
const RECEIPT_FILENAME = 'relocation-receipt.json';
const RECEIPT_TMP_FILENAME = '.relocation-receipt.json.tmp';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const READONLY_PRESERVED_MODE = 0o400;
const MAX_WORKSPACE_STORAGE_ENTRIES = 2048;
const MAX_DIAGNOSTICS = 16;
const SAFE_SCOPE_SEGMENT = /^[A-Za-z0-9._-]+$/;

const POPULATED_DATA_TABLES = [
  'operational_queue_meta', 'operational_tasks', 'operational_runs',
  'operational_kv_documents', 'runs', 'definitions', 'usage_observations', 'artifacts'
] as const;

const OPERATIONAL_TIMESTAMP_SOURCES: ReadonlyArray<readonly [string, string]> = [
  ['operational_queue_meta', 'updated_at_ms'], ['operational_tasks', 'updated_at_ms'],
  ['operational_runs', 'last_transition_at_ms'], ['operational_kv_documents', 'updated_at_ms'],
  ['runs', 'updated_at_ms'], ['definitions', 'created_at_ms'],
  ['usage_observations', 'observed_at_ms'], ['artifacts', 'created_at_ms']
];

const METADATA_TIMESTAMP_SOURCES: ReadonlyArray<readonly [string, string]> = [
  ['cutover_sentinel', 'updated_at_ms'], ['schema_meta', 'updated_at_ms'], ['schema_migrations', 'applied_at_ms']
];

export type RelocationStage =
  | 'after_stage_copy' | 'after_stage_verify' | 'after_stage_losing_canonical' | 'after_preserve_losing_canonical'
  | 'after_write_journal' | 'after_remove_canonical_sidecars' | 'after_atomic_publish' | 'after_retire_legacy' | 'after_write_receipt';

export interface CandidateFileFingerprint {
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly walSizeBytes: number;
  readonly walMtimeMs: number;
}

export interface PreservedConflictEntry {
  readonly databasePath: string;
  readonly origin: 'legacy_in_place' | 'canonical_sibling_readonly';
  readonly fingerprint: CandidateFileFingerprint;
  readonly recordedAtMs: number;
}

export interface RelocationReceipt {
  readonly version: 1;
  readonly scopeId: string;
  readonly relocatedAtMs: number;
  readonly winnerSourcePath: string | null;
  readonly preservedConflicts: readonly PreservedConflictEntry[];
}

export interface RelocationJournal {
  readonly version: 1;
  readonly scopeId: string;
  readonly stagedSha256: string;
  readonly winnerDatabasePath: string;
  readonly winnerStorageRoot: string;
  readonly winnerFingerprint: CandidateFileFingerprint;
  readonly previousCanonicalFingerprint?: CandidateFileFingerprint | null | undefined;
  readonly preservedConflicts: readonly PreservedConflictEntry[];
  readonly startedAtMs: number;
  readonly retirementPending?: boolean | undefined;
}

export interface RelocationDiagnosticsFields {
  readonly corruptCandidateCount?: number | undefined;
  readonly incompleteDiscovery?: boolean | undefined;
  readonly retirementPending?: boolean | undefined;
  readonly diagnostics?: readonly string[] | undefined;
  readonly activeFilesystemVerdict?: FilesystemTypeVerdict | undefined;
}

interface CanonicalActiveBase extends RelocationDiagnosticsFields {
  readonly activeStorageRoot: string;
  readonly activeDatabasePath: string;
  readonly activeSourceKind: 'host_global_storage_uri';
  readonly preservedUnselectedPaths: readonly string[];
  readonly noticeRequired: boolean;
}

interface InspectedStoreCandidate {
  readonly storageRoot: string;
  readonly databasePath: string;
  readonly isCanonical: boolean;
  readonly sourceKind: 'host_global_storage_uri' | 'host_storage_uri';
  readonly populated: boolean;
  readonly lastWriteMs: number;
  readonly runCount: number;
  readonly schemaVersion: number;
  readonly minReaderVersion: number;
  readonly fingerprint: CandidateFileFingerprint;
}

type NewerSchemaRefusal = {
  readonly kind: 'refused_newer_schema';
  readonly reason: 'UNSUPPORTED_MIN_READER_VERSION' | 'UNSUPPORTED_FUTURE_SCHEMA_VERSION';
  readonly offendingPath: string;
  readonly recordedVersion: number | null;
  readonly maxSupportedVersion: number;
  readonly diagnostic: string;
};

type CandidateInspectionResult =
  | { readonly kind: 'ok'; readonly candidate: InspectedStoreCandidate }
  | NewerSchemaRefusal
  | { readonly kind: 'corrupt'; readonly databasePath: string; readonly reason: string };

type RootCandidateProbeResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'acknowledged' }
  | { readonly kind: 'containment_refused'; readonly reason: string; readonly errno: string }
  | { readonly kind: 'unreadable'; readonly reason: string; readonly errno: string }
  | CandidateInspectionResult;

type FallbackReason =
  | 'network_share_wal_unsupported'
  | 'canonical_filesystem_unknown'
  | 'canonical_target_unwritable'
  | 'symlink_or_containment_refused';

export type StoreRelocationOutcome =
  | ({ readonly outcome: 'noop' } & CanonicalActiveBase)
  | ({ readonly outcome: 'relocated'; readonly relocatedFromPath: string } & CanonicalActiveBase)
  | ({
      readonly outcome: 'conflict_resolved';
      readonly winnerSourcePath: string;
      readonly newlyDiscoveredConflictPaths: readonly string[];
      readonly selectionRule: 'last_write_then_run_count_then_canonical_then_path';
    } & CanonicalActiveBase)
  | ({
      readonly outcome: 'refused_newer_schema';
      readonly reason: 'UNSUPPORTED_MIN_READER_VERSION' | 'UNSUPPORTED_FUTURE_SCHEMA_VERSION';
      readonly offendingPath: string;
      readonly recordedVersion: number | null;
      readonly maxSupportedVersion: number;
      readonly diagnostic: string;
      readonly noticeRequired: true;
    } & RelocationDiagnosticsFields)
  | ({
      readonly outcome: 'fallback_legacy_preserved';
      readonly activeStorageRoot: string;
      readonly activeDatabasePath: string;
      readonly activeSourceKind: 'host_storage_uri';
      readonly reason: FallbackReason;
      readonly diagnostic: string;
      readonly preservedUnselectedPaths: readonly string[];
      readonly noticeRequired: true;
    } & RelocationDiagnosticsFields);

export interface RelocateLegacySqliteStoreRequest {
  readonly scopeId: string;
  readonly globalStorageUri: string;
  readonly legacyStorageUri?: string | undefined;
  readonly additionalLegacyStorageRoots?: readonly string[] | undefined;
  readonly canonicalFilesystemType?: string | undefined;
  readonly legacyFilesystemType?: string | undefined;
  readonly detectFilesystemType?: ((targetPath: string) => Promise<FilesystemTypeVerdict>) | undefined;
  readonly requestedJournalMode?: 'wal' | 'delete' | undefined;
  readonly maxSupportedSchemaVersion?: number | undefined;
  readonly verifyPrimacy: () => Promise<boolean>;
  readonly nowMs?: (() => number) | undefined;
  readonly onStage?: ((stage: RelocationStage) => void | Promise<void>) | undefined;
  readonly logger?: { warn(message: string, context?: Record<string, unknown>): void } | undefined;
  readonly maxWorkspaceStorageEntries?: number | undefined;
  readonly unlinkLegacyFile?: ((resolvedPath: string) => Promise<void>) | undefined;
}

export class RelocationPrimacyLostError extends Error {
  public readonly code = 'RELOCATION_PRIMACY_LOST' as const;
  public constructor(message: string) {
    super(message);
    this.name = 'RelocationPrimacyLostError';
  }
}

export class RelocationWalFilesystemRefusedError extends Error {
  public readonly code = 'NETWORK_SHARE_WAL_UNSUPPORTED' as const;
  public readonly reason = 'network_share_wal_unsupported' as const;
  public constructor(
    message: string,
    public readonly canonicalVerdict: FilesystemTypeVerdict,
    public readonly legacyVerdict?: FilesystemTypeVerdict | undefined
  ) {
    super(message);
    this.name = 'RelocationWalFilesystemRefusedError';
  }
}

interface DiagnosticsBag {
  corruptCandidateCount: number;
  incompleteDiscovery: boolean;
  readonly diagnostics: string[];
  add(code: string): void;
  hasWarning(retirementPending?: boolean): boolean;
  fields(extra?: { readonly retirementPending?: boolean; readonly activeFilesystemVerdict?: FilesystemTypeVerdict }): RelocationDiagnosticsFields;
  emitWarn(logger: RelocateLegacySqliteStoreRequest['logger'], retirementPending?: boolean): void;
}

function createDiagnosticsBag(): DiagnosticsBag {
  const bag: DiagnosticsBag = {
    corruptCandidateCount: 0,
    incompleteDiscovery: false,
    diagnostics: [],
    add(code): void {
      if (bag.diagnostics.length < MAX_DIAGNOSTICS && !bag.diagnostics.includes(code)) bag.diagnostics.push(code);
    },
    hasWarning(retirementPending): boolean {
      return bag.corruptCandidateCount > 0 || bag.incompleteDiscovery || retirementPending === true || bag.diagnostics.length > 0;
    },
    fields(extra): RelocationDiagnosticsFields {
      return {
        ...(bag.corruptCandidateCount > 0 ? { corruptCandidateCount: bag.corruptCandidateCount } : {}),
        ...(bag.incompleteDiscovery ? { incompleteDiscovery: true } : {}),
        ...(extra?.retirementPending === true ? { retirementPending: true } : {}),
        ...(bag.diagnostics.length > 0 ? { diagnostics: [...bag.diagnostics] } : {}),
        ...(extra?.activeFilesystemVerdict !== undefined ? { activeFilesystemVerdict: extra.activeFilesystemVerdict } : {})
      };
    },
    emitWarn(logger, retirementPending): void {
      if (!bag.hasWarning(retirementPending)) return;
      logger?.warn('store-relocation: diagnostic notice required', {
        corruptCandidateCount: bag.corruptCandidateCount,
        incompleteDiscovery: bag.incompleteDiscovery,
        retirementPending: retirementPending === true,
        diagnostics: [...bag.diagnostics]
      });
    }
  };
  return bag;
}

const errnoOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;

const isMissing = (error: unknown): boolean => {
  const code = errnoOf(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonNegFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isNonNegSafeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isAbsCleanPath = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && !v.includes('\0') && path.isAbsolute(v);

function parseTimestampMs(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const asNum = Number(trimmed);
      return Number.isSafeInteger(asNum) && asNum > 0 ? asNum : null;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

const isValidCandidateFileFingerprint = (v: unknown): v is CandidateFileFingerprint =>
  isPlainObject(v) && isNonNegSafeInt(v.sizeBytes) && isNonNegFinite(v.mtimeMs) &&
  isNonNegSafeInt(v.walSizeBytes) && isNonNegFinite(v.walMtimeMs);

export function isValidPreservedConflictEntry(candidate: unknown): candidate is PreservedConflictEntry {
  return (
    isPlainObject(candidate) && isAbsCleanPath(candidate.databasePath) &&
    (candidate.origin === 'legacy_in_place' || candidate.origin === 'canonical_sibling_readonly') &&
    isValidCandidateFileFingerprint(candidate.fingerprint) && isNonNegFinite(candidate.recordedAtMs)
  );
}

export function isValidRelocationReceipt(candidate: unknown, expectedScopeId: string): candidate is RelocationReceipt {
  return (
    isPlainObject(candidate) && candidate.version === 1 && candidate.scopeId === expectedScopeId &&
    isNonNegFinite(candidate.relocatedAtMs) &&
    (candidate.winnerSourcePath === null || isAbsCleanPath(candidate.winnerSourcePath)) &&
    Array.isArray(candidate.preservedConflicts) &&
    candidate.preservedConflicts.every((entry) => isValidPreservedConflictEntry(entry))
  );
}

export function isValidRelocationJournal(candidate: unknown, expectedScopeId: string, canonicalRoot?: string): candidate is RelocationJournal {
  if (
    !isPlainObject(candidate) || candidate.version !== 1 || candidate.scopeId !== expectedScopeId ||
    typeof candidate.stagedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.stagedSha256) ||
    !isAbsCleanPath(candidate.winnerDatabasePath) || !isAbsCleanPath(candidate.winnerStorageRoot) ||
    !isValidCandidateFileFingerprint(candidate.winnerFingerprint) || !isNonNegFinite(candidate.startedAtMs) ||
    (candidate.previousCanonicalFingerprint !== undefined && candidate.previousCanonicalFingerprint !== null &&
      !isValidCandidateFileFingerprint(candidate.previousCanonicalFingerprint)) ||
    (candidate.retirementPending !== undefined && typeof candidate.retirementPending !== 'boolean') ||
    !Array.isArray(candidate.preservedConflicts) || !candidate.preservedConflicts.every((entry) => isValidPreservedConflictEntry(entry))
  ) return false;
  const winnerRoot = path.resolve(candidate.winnerStorageRoot);
  return (canonicalRoot === undefined || winnerRoot !== path.resolve(canonicalRoot)) &&
    path.resolve(candidate.winnerDatabasePath) === path.join(winnerRoot, 'sqlite', expectedScopeId, CANONICAL_DB_FILENAME);
}

async function discoverLegacyStorageRoots(
  globalStorageUri: string,
  legacyStorageUri: string | undefined,
  additionalLegacyStorageRoots: readonly string[] | undefined,
  maxEntries: number | undefined,
  diag: DiagnosticsBag
): Promise<readonly string[]> {
  const seen = new Set<string>([path.resolve(globalStorageUri)]);
  const roots: string[] = [];
  const tryAddRoot = (candidate: string | undefined): void => {
    if (!isAbsCleanPath(candidate)) return;
    const resolved = path.resolve(candidate);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      roots.push(resolved);
    }
  };
  tryAddRoot(legacyStorageUri);
  for (const extra of additionalLegacyStorageRoots ?? []) tryAddRoot(extra);
  if (legacyStorageUri === undefined || !path.isAbsolute(legacyStorageUri)) return roots;

  const resolvedLegacy = path.resolve(legacyStorageUri);
  const extDir = path.basename(resolvedLegacy);
  const wsParent = path.dirname(path.dirname(resolvedLegacy));
  if (extDir.length === 0 || extDir === '.' || extDir === '..' || path.basename(wsParent) !== 'workspaceStorage') {
    return roots;
  }

  let parentStat: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    parentStat = await fsp.lstat(wsParent);
  } catch (error) {
    if (!isMissing(error)) {
      diag.incompleteDiscovery = true;
      diag.add(`legacy-parent-unreadable:${errnoOf(error) ?? 'io'}`);
    }
    return roots;
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    diag.incompleteDiscovery = true;
    diag.add('legacy-parent-not-directory-or-symlink');
    return roots;
  }

  let entries: string[];
  try {
    entries = await fsp.readdir(wsParent);
  } catch (error) {
    if (!isMissing(error)) {
      diag.incompleteDiscovery = true;
      diag.add(`legacy-parent-readdir-failed:${errnoOf(error) ?? 'io'}`);
    }
    return roots;
  }

  const limit = Math.max(1, Math.min(maxEntries ?? MAX_WORKSPACE_STORAGE_ENTRIES, MAX_WORKSPACE_STORAGE_ENTRIES));
  const sorted = [...entries].sort();
  if (sorted.length > limit) {
    diag.incompleteDiscovery = true;
    diag.add(`legacy-discovery-truncated:skipped=${sorted.length - limit}:limit=${limit}`);
  }
  let unreadableSiblings = 0;
  let firstErrno = 'io';
  for (const entry of sorted.slice(0, limit)) {
    if (entry === '.' || entry === '..') continue;
    const siblingWindowDir = path.join(wsParent, entry);
    try {
      const st = await fsp.lstat(siblingWindowDir);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      const siblingRoot = path.join(siblingWindowDir, extDir);
      const extSt = await fsp.lstat(siblingRoot);
      if (!extSt.isSymbolicLink() && extSt.isDirectory()) tryAddRoot(siblingRoot);
    } catch (error) {
      if (!isMissing(error)) {
        if (unreadableSiblings === 0) firstErrno = errnoOf(error) ?? 'io';
        unreadableSiblings += 1;
      }
    }
  }
  if (unreadableSiblings > 0) {
    diag.incompleteDiscovery = true;
    diag.add(`legacy-siblings-unreadable:count=${unreadableSiblings}:errno=${firstErrno}`);
  }
  return roots;
}

function checkSchemaMetaBound(
  db: DatabaseSync,
  metaKey: 'min_reader_version' | 'schema_version',
  reason: 'UNSUPPORTED_MIN_READER_VERSION' | 'UNSUPPORTED_FUTURE_SCHEMA_VERSION',
  databasePath: string,
  maxSupported: number
): { readonly ok: true; readonly version: number } | { readonly ok: false; readonly refusal: NewerSchemaRefusal } {
  const row = db.prepare(`SELECT meta_value FROM schema_meta WHERE meta_key = ?`).get(metaKey) as { meta_value: string } | undefined;
  if (row === undefined) return { ok: true, version: 0 };
  const parsed = parseStrictSchemaMetaVersion(row.meta_value);
  if (parsed === null || parsed > maxSupported) {
    return {
      ok: false,
      refusal: {
        kind: 'refused_newer_schema',
        reason,
        offendingPath: databasePath,
        recordedVersion: parsed,
        maxSupportedVersion: maxSupported,
        diagnostic:
          parsed === null
            ? `${reason}: database records an unreadable ${metaKey}`
            : `${reason}: database ${metaKey}=${parsed} exceeds supported max=${maxSupported}`
      }
    };
  }
  return { ok: true, version: parsed };
}

function inspectOpenDatabaseReadOnly(
  db: DatabaseSync,
  storageRoot: string,
  databasePath: string,
  isCanonical: boolean,
  fingerprint: CandidateFileFingerprint,
  maxSupportedSchemaVersion: number
): CandidateInspectionResult {
  try {
    const quickValues = (db.prepare('PRAGMA quick_check').all() as Array<{ quick_check?: string }>).map((r) => String(r.quick_check ?? ''));
    if (quickValues.length === 0 || quickValues.some((v) => v.toLowerCase() !== 'ok')) {
      return { kind: 'corrupt', databasePath, reason: `quick_check failed: ${quickValues.join(', ')}` };
    }
    const tables = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((r) => r.name)
    );

    let schemaVersion = 0;
    let minReaderVersion = 0;
    if (tables.has('schema_meta')) {
      const minCheck = checkSchemaMetaBound(db, 'min_reader_version', 'UNSUPPORTED_MIN_READER_VERSION', databasePath, maxSupportedSchemaVersion);
      if (!minCheck.ok) return minCheck.refusal;
      minReaderVersion = minCheck.version;
      const verCheck = checkSchemaMetaBound(db, 'schema_version', 'UNSUPPORTED_FUTURE_SCHEMA_VERSION', databasePath, maxSupportedSchemaVersion);
      if (!verCheck.ok) return verCheck.refusal;
      schemaVersion = verCheck.version;
    }

    let populated = POPULATED_DATA_TABLES.some(
      (t) => tables.has(t) && db.prepare(`SELECT 1 AS hit FROM "${t}" LIMIT 1`).get() !== undefined
    );
    if (!populated && tables.has('cutover_sentinel')) {
      populated = db.prepare(`SELECT 1 AS hit FROM cutover_sentinel WHERE authority IN ('sqlite', 'retired_legacy') LIMIT 1`).get() !== undefined;
    }

    const readMaxTs = (sources: ReadonlyArray<readonly [string, string]>): number => {
      let maxTs = 0;
      for (const [table, column] of sources) {
        if (!tables.has(table)) continue;
        try {
          const parsed = parseTimestampMs((db.prepare(`SELECT MAX("${column}") AS ts FROM "${table}"`).get() as { ts: unknown } | undefined)?.ts);
          if (parsed !== null && parsed > maxTs) maxTs = parsed;
        } catch {
          // Ignore older schema variants lacking a column.
        }
      }
      return maxTs;
    };

    const lastWriteMs =
      Math.max(readMaxTs(OPERATIONAL_TIMESTAMP_SOURCES), readMaxTs(METADATA_TIMESTAMP_SOURCES)) ||
      Math.max(fingerprint.mtimeMs, fingerprint.walMtimeMs);
    const countRows = (table: string): number =>
      tables.has(table) ? Number((db.prepare(`SELECT COUNT(*) AS cnt FROM "${table}"`).get() as { cnt: number } | undefined)?.cnt ?? 0) : 0;

    return {
      kind: 'ok',
      candidate: {
        storageRoot,
        databasePath,
        isCanonical,
        sourceKind: isCanonical ? 'host_global_storage_uri' : 'host_storage_uri',
        populated,
        lastWriteMs,
        runCount: countRows('operational_runs') + countRows('runs'),
        schemaVersion,
        minReaderVersion,
        fingerprint
      }
    };
  } catch (error) {
    return { kind: 'corrupt', databasePath, reason: error instanceof Error ? error.message : 'unreadable sqlite database' };
  }
}

async function probeAndInspectCandidateWithinRoot(
  storageRoot: string,
  relativeDirSegments: readonly string[],
  dbFileName: string,
  isCanonical: boolean,
  maxSupportedSchemaVersion: number,
  existingReceipt: RelocationReceipt | null
): Promise<RootCandidateProbeResult> {
  const verifiedRes = await verifySqliteCandidateWithinRoot(storageRoot, relativeDirSegments, dbFileName);
  if (verifiedRes.outcome === 'absent') return { kind: 'absent' };
  if (verifiedRes.outcome === 'refused') return { kind: 'containment_refused', reason: verifiedRes.reason, errno: verifiedRes.errno };
  if (verifiedRes.outcome === 'unreadable') return { kind: 'unreadable', reason: verifiedRes.reason, errno: verifiedRes.errno };
  if (!isCanonical && isReceiptAcknowledged(existingReceipt, verifiedRes.verified.verifiedDbPath, fingerprintFromVerified(verifiedRes.verified))) {
    return { kind: 'acknowledged' };
  }

  const inspected = await withZeroMutationReadOnlySqlite(
    storageRoot,
    relativeDirSegments,
    dbFileName,
    (db, verified) =>
      inspectOpenDatabaseReadOnly(db, storageRoot, verified.verifiedDbPath, isCanonical, fingerprintFromVerified(verified), maxSupportedSchemaVersion),
    { queryOnly: true }
  );
  if (inspected.outcome === 'absent') return { kind: 'absent' };
  if (inspected.outcome === 'refused') return { kind: 'containment_refused', reason: inspected.reason, errno: inspected.errno };
  if (inspected.outcome === 'unreadable') return { kind: 'unreadable', reason: inspected.reason, errno: inspected.errno };
  if (inspected.outcome === 'sqlite-error') {
    return {
      kind: 'corrupt',
      databasePath: inspected.verified.verifiedDbPath,
      reason: inspected.error instanceof Error ? inspected.error.message : 'unreadable sqlite database'
    };
  }
  return inspected.value;
}

function recordNonOkProbeDiagnostic(probe: RootCandidateProbeResult, role: 'canonical' | 'legacy', diag: DiagnosticsBag): void {
  if (probe.kind === 'corrupt') {
    diag.corruptCandidateCount += 1;
    diag.add(`candidate-corrupt:${role}`);
  } else if (probe.kind === 'containment_refused') {
    diag.incompleteDiscovery = true;
    diag.add(`candidate-containment-refused:${role}:${probe.reason}`);
  } else if (probe.kind === 'unreadable') {
    diag.incompleteDiscovery = true;
    diag.add(`candidate-unreadable:${role}:${probe.errno}`);
  }
}

function compareCandidatesDeterministic(a: InspectedStoreCandidate, b: InspectedStoreCandidate): number {
  if (a.lastWriteMs !== b.lastWriteMs) return b.lastWriteMs - a.lastWriteMs;
  if (a.runCount !== b.runCount) return b.runCount - a.runCount;
  if (a.isCanonical !== b.isCanonical) return a.isCanonical ? -1 : 1;
  return a.databasePath < b.databasePath ? -1 : a.databasePath > b.databasePath ? 1 : 0;
}

async function vacuumIntoTarget(
  sourceStorageRoot: string,
  sourceScopeId: string,
  sourceFileName: string,
  destinationAnchorDir: string,
  destinationFileName: string
): Promise<string> {
  const destPath = path.join(destinationAnchorDir, destinationFileName);
  for (const file of [destPath, `${destPath}-wal`, `${destPath}-shm`]) {
    if (!(await unlinkContainedEntry(destinationAnchorDir, file))) {
      throw new Error('RELOCATION_STAGE_REFUSED');
    }
  }

  // SQLite accepts an empty VACUUM destination. Reserve it privately before SQLite writes any bytes.
  const destination = await openWithinRoot(destinationAnchorDir, [destinationFileName], { flags: 'wx', fileMode: FILE_MODE });
  if (destination.outcome !== 'opened') throw new Error(`RELOCATION_STAGE_REFUSED:${destination.reason}`);
  await destination.handle.close();

  const vacRes = await withZeroMutationReadOnlySqlite(
    sourceStorageRoot,
    ['sqlite', sourceScopeId],
    sourceFileName,
    (roDb) => { roDb.prepare('VACUUM INTO ?').run(destPath); },
    { queryOnly: false }
  );
  if (vacRes.outcome !== 'ok') {
    await unlinkContainedEntry(destinationAnchorDir, destPath);
    throw new Error(
      vacRes.outcome === 'sqlite-error'
        ? (vacRes.error instanceof Error ? vacRes.error.message : 'RELOCATION_VACUUM_FAILED')
        : `RELOCATION_SOURCE_REFUSED:${vacRes.outcome}`
    );
  }

  return destPath;
}

async function preserveLosingCanonicalReadOnly(
  canonicalRoot: string,
  scopeId: string,
  canonicalAnchorDir: string,
  nowMs: number,
  onStage: RelocateLegacySqliteStoreRequest['onStage']
): Promise<PreservedConflictEntry> {
  await vacuumIntoTarget(canonicalRoot, scopeId, CANONICAL_DB_FILENAME, canonicalAnchorDir, UNSELECTED_TMP_FILENAME);
  const bytes = await readRegularFileWithinRoot(canonicalAnchorDir, [UNSELECTED_TMP_FILENAME]);
  await unlinkContainedEntry(canonicalAnchorDir, path.join(canonicalAnchorDir, UNSELECTED_TMP_FILENAME));
  if (bytes === null) throw new Error('RELOCATION_PRESERVE_CANONICAL_FAILED');

  const digest = createHash('sha256').update(bytes).digest('hex');
  const preservedName = `schegent-state.unselected-${digest.slice(0, 12)}.db`;
  const preservedPath = path.join(canonicalAnchorDir, preservedName);
  const existingDigest = await computeFileSha256WithinRoot(canonicalAnchorDir, [preservedName]);
  if (existingDigest === null) {
    const readonlyTempPath = path.join(canonicalAnchorDir, UNSELECTED_READONLY_TMP_FILENAME);
    await unlinkContainedEntry(canonicalAnchorDir, readonlyTempPath);
    const opened = await openWithinRoot(canonicalAnchorDir, [UNSELECTED_READONLY_TMP_FILENAME], {
      flags: 'wx', fileMode: READONLY_PRESERVED_MODE
    });
    if (opened.outcome !== 'opened') throw new Error(`RELOCATION_PRESERVE_CANONICAL_REFUSED:${opened.reason}:${opened.errno}`);
    try {
      await writeFully(opened.handle, bytes);
      await opened.handle.sync();
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
    await onStage?.('after_stage_losing_canonical');
    if (!(await renameContainedEntry(canonicalAnchorDir, UNSELECTED_READONLY_TMP_FILENAME, preservedName))) {
      throw new Error('RELOCATION_PRESERVE_CANONICAL_PUBLISH_REFUSED');
    }
  } else if (existingDigest !== digest) {
    throw new Error('RELOCATION_PRESERVE_CANONICAL_DIGEST_MISMATCH');
  }
  const verified = await verifySqliteCandidateWithinRoot(canonicalAnchorDir, [], preservedName);
  return {
    databasePath: preservedPath,
    origin: 'canonical_sibling_readonly',
    fingerprint: verified.outcome === 'ok'
      ? fingerprintFromVerified(verified.verified)
      : { sizeBytes: bytes.byteLength, mtimeMs: nowMs, walSizeBytes: 0, walMtimeMs: 0 },
    recordedAtMs: nowMs
  };
}

async function retireLegacyWinnerFiles(winnerStorageRoot: string, scopeId: string, unlinkFn?: (resolvedPath: string) => Promise<void>): Promise<{ readonly retired: boolean; readonly failedPaths: readonly string[] }> {
  const dbPath = path.join(path.resolve(winnerStorageRoot), 'sqlite', scopeId, CANONICAL_DB_FILENAME);
  if (!(await unlinkContainedEntry(winnerStorageRoot, dbPath, unlinkFn))) return { retired: false, failedPaths: [dbPath] };
  const failedPaths: string[] = [];
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!(await unlinkContainedEntry(winnerStorageRoot, sidecar, unlinkFn))) failedPaths.push(sidecar);
  }
  return { retired: failedPaths.length === 0, failedPaths };
}

function mergePreservedConflicts(
  existing: readonly PreservedConflictEntry[],
  added: readonly PreservedConflictEntry[]
): readonly PreservedConflictEntry[] {
  const byPath = new Map<string, PreservedConflictEntry>();
  for (const item of [...existing, ...added]) byPath.set(item.databasePath, item);
  return [...byPath.values()].sort((a, b) => a.databasePath.localeCompare(b.databasePath));
}

function isReceiptAcknowledged(receipt: RelocationReceipt | null, candidatePath: string, fp: CandidateFileFingerprint): boolean {
  return receipt !== null && receipt.preservedConflicts.some((e) => e.databasePath === candidatePath && fingerprintsMatch(e.fingerprint, fp));
}

async function finishPostPublishStep(params: {
  readonly canonicalAnchorDir: string;
  readonly canonicalDbPath: string;
  readonly journal: RelocationJournal;
  readonly existingReceipt: RelocationReceipt | null;
  readonly nowMs: () => number;
  readonly onStage?: ((stage: RelocationStage) => void | Promise<void>) | undefined;
  readonly unlinkLegacyFile?: ((resolvedPath: string) => Promise<void>) | undefined;
  readonly logger?: RelocateLegacySqliteStoreRequest['logger'];
  readonly diag: DiagnosticsBag;
  readonly activeFilesystemVerdict: FilesystemTypeVerdict;
}): Promise<StoreRelocationOutcome> {
  const { canonicalAnchorDir, canonicalDbPath, journal, existingReceipt, nowMs, onStage, unlinkLegacyFile, logger, diag, activeFilesystemVerdict } = params;
  const activeStorageRoot = path.dirname(path.dirname(canonicalAnchorDir));
  // Barrier the publication and its containing directories before discarding the source.
  await syncRelocationDirectory(canonicalAnchorDir);
  await syncRelocationDirectory(path.dirname(canonicalAnchorDir));
  await syncRelocationDirectory(activeStorageRoot);
  const retirement = await retireLegacyWinnerFiles(journal.winnerStorageRoot, journal.scopeId, unlinkLegacyFile);
  await onStage?.('after_retire_legacy');

  const mergedConflicts = mergePreservedConflicts(existingReceipt?.preservedConflicts ?? [], journal.preservedConflicts);
  const newConflictPaths = journal.preservedConflicts
    .filter((e) => !isReceiptAcknowledged(existingReceipt, e.databasePath, e.fingerprint))
    .map((e) => e.databasePath);

  await writeAtomicJsonWithinAnchor(canonicalAnchorDir, RECEIPT_TMP_FILENAME, RECEIPT_FILENAME, {
    version: 1,
    scopeId: journal.scopeId,
    relocatedAtMs: nowMs(),
    winnerSourcePath: journal.winnerDatabasePath,
    preservedConflicts: mergedConflicts
  } satisfies RelocationReceipt);
  await onStage?.('after_write_receipt');

  await unlinkContainedEntry(activeStorageRoot, path.join(canonicalAnchorDir, STAGING_DB_FILENAME));
  const retirementPending = !retirement.retired;
  if (retirementPending) {
    diag.add('legacy-retirement-pending');
    await writeAtomicJsonWithinAnchor(canonicalAnchorDir, `${JOURNAL_FILENAME}.tmp`, JOURNAL_FILENAME, {
      ...journal,
      retirementPending: true
    });
  } else {
    await unlinkContainedEntry(activeStorageRoot, path.join(canonicalAnchorDir, JOURNAL_FILENAME));
  }

  diag.emitWarn(logger, retirementPending);
  const extra = diag.fields({ retirementPending, activeFilesystemVerdict });
  const preservedUnselectedPaths = mergedConflicts.map((c) => c.databasePath);

  if (journal.preservedConflicts.length > 0) {
    return {
      outcome: 'conflict_resolved',
      activeStorageRoot,
      activeDatabasePath: canonicalDbPath,
      activeSourceKind: 'host_global_storage_uri',
      winnerSourcePath: journal.winnerDatabasePath,
      preservedUnselectedPaths,
      newlyDiscoveredConflictPaths: newConflictPaths,
      selectionRule: 'last_write_then_run_count_then_canonical_then_path',
      noticeRequired: newConflictPaths.length > 0 || diag.hasWarning(retirementPending),
      ...extra
    };
  }
  return {
    outcome: 'relocated',
    activeStorageRoot,
    activeDatabasePath: canonicalDbPath,
    activeSourceKind: 'host_global_storage_uri',
    relocatedFromPath: journal.winnerDatabasePath,
    preservedUnselectedPaths,
    noticeRequired: diag.hasWarning(retirementPending),
    ...extra
  };
}

export async function relocateLegacySqliteStore(
  request: RelocateLegacySqliteStoreRequest
): Promise<StoreRelocationOutcome> {
  if (!isAbsCleanPath(request.globalStorageUri)) throw new Error('RELOCATION_INVALID_ROOT: globalStorageUri must be an absolute path');
  if (!SAFE_SCOPE_SEGMENT.test(request.scopeId) || request.scopeId === '.' || request.scopeId === '..') {
    throw new Error('RELOCATION_INVALID_SCOPE: scopeId must be a safe single segment');
  }
  if (!(await request.verifyPrimacy())) {
    throw new RelocationPrimacyLostError('Cannot relocate SQLite store without holding the workspace ownership fence');
  }

  const nowMs = request.nowMs ?? (() => Date.now());
  const maxSupportedSchemaVersion = request.maxSupportedSchemaVersion ?? SQLITE_SCHEMA_CURRENT_VERSION;
  const requestedJournalMode = request.requestedJournalMode ?? 'wal';
  const canonicalRoot = path.resolve(request.globalStorageUri);
  const scopeRelSegments = ['sqlite', request.scopeId] as const;
  const canonicalScopeDir = path.join(canonicalRoot, ...scopeRelSegments);
  const canonicalDbPath = path.join(canonicalScopeDir, CANONICAL_DB_FILENAME);
  const diag = createDiagnosticsBag();

  const fsDetector = request.detectFilesystemType ?? detectFilesystemType;
  const canonicalFsVerdict = request.canonicalFilesystemType !== undefined ? classifyFilesystemTypeName(request.canonicalFilesystemType) : await fsDetector(canonicalScopeDir);
  const probeLegacyFs = async (storageRoot: string): Promise<FilesystemTypeVerdict> =>
    request.legacyFilesystemType !== undefined ? classifyFilesystemTypeName(request.legacyFilesystemType) : await fsDetector(path.join(storageRoot, ...scopeRelSegments));

  const canonicalWalRefused = requestedJournalMode === 'wal' && canonicalFsVerdict.classification === 'network';
  const canonicalDirExists = (await walkDirectoriesWithinRoot(canonicalRoot, scopeRelSegments)).outcome === 'ready';
  const legacyRoots = await discoverLegacyStorageRoots(
    canonicalRoot, request.legacyStorageUri, request.additionalLegacyStorageRoots, request.maxWorkspaceStorageEntries, diag
  );
  const toSchemaRefusalOutcome = (r: NewerSchemaRefusal): StoreRelocationOutcome => ({
    outcome: 'refused_newer_schema', reason: r.reason, offendingPath: r.offendingPath,
    recordedVersion: r.recordedVersion, maxSupportedVersion: r.maxSupportedVersion,
    diagnostic: r.diagnostic, noticeRequired: true, ...diag.fields()
  });

  let existingReceipt: RelocationReceipt | null = null;
  if (canonicalDirExists) {
    const receiptRes = await readJsonStatusWithinRoot(canonicalRoot, [...scopeRelSegments, RECEIPT_FILENAME]);
    if (receiptRes.kind === 'parsed' && isValidRelocationReceipt(receiptRes.value, request.scopeId)) existingReceipt = receiptRes.value;
    else if (receiptRes.kind !== 'absent') { diag.incompleteDiscovery = true; diag.add('relocation-receipt-malformed'); }
  }

  const journalRes = canonicalDirExists && !canonicalWalRefused
    ? await readJsonStatusWithinRoot(canonicalRoot, [...scopeRelSegments, JOURNAL_FILENAME])
    : ({ kind: 'absent' } as const);
  let skipCanonicalJournal = canonicalWalRefused;
  if (!skipCanonicalJournal && journalRes.kind !== 'absent' && requestedJournalMode === 'wal' && canonicalFsVerdict.classification === 'unknown') {
    for (const r of legacyRoots) {
      if ((await verifySqliteCandidateWithinRoot(r, scopeRelSegments, CANONICAL_DB_FILENAME)).outcome === 'ok' && (await probeLegacyFs(r)).classification === 'local') { skipCanonicalJournal = true; break; }
    }
  }
  const validJournal = !skipCanonicalJournal && journalRes.kind === 'parsed' && isValidRelocationJournal(journalRes.value, request.scopeId, canonicalRoot) ? journalRes.value : null;

  if (validJournal !== null && legacyRoots.includes(path.resolve(validJournal.winnerStorageRoot))) {
    const canonicalCheck = await probeAndInspectCandidateWithinRoot(
      canonicalRoot, scopeRelSegments, CANONICAL_DB_FILENAME, true, maxSupportedSchemaVersion, null
    );
    if (canonicalCheck.kind === 'refused_newer_schema') return toSchemaRefusalOutcome(canonicalCheck);
    const winnerCheck = await probeAndInspectCandidateWithinRoot(
      validJournal.winnerStorageRoot, scopeRelSegments, CANONICAL_DB_FILENAME, false, maxSupportedSchemaVersion, null
    );
    if (winnerCheck.kind === 'refused_newer_schema') return toSchemaRefusalOutcome(winnerCheck);
    const winnerUnchanged = winnerCheck.kind === 'ok' &&
      fingerprintsMatch(winnerCheck.candidate.fingerprint, validJournal.winnerFingerprint);
    const publishedSha = canonicalCheck.kind === 'ok'
      ? await computeFileSha256WithinRoot(canonicalRoot, [...scopeRelSegments, CANONICAL_DB_FILENAME])
      : null;
    const legacyRetired = winnerCheck.kind === 'absent';
    const published = canonicalCheck.kind === 'ok' && canonicalCheck.candidate.populated && (
      publishedSha === validJournal.stagedSha256 || validJournal.retirementPending === true || legacyRetired
    );
    const mayResumePublication = !published && winnerUnchanged && await matchesPreviousCanonical(
      canonicalRoot, scopeRelSegments, validJournal.previousCanonicalFingerprint
    );
    const canResumePublication = mayResumePublication &&
      await computeFileSha256WithinRoot(canonicalRoot, [...scopeRelSegments, STAGING_DB_FILENAME]) === validJournal.stagedSha256;
    if ((published || canResumePublication) && !(await request.verifyPrimacy())) {
      throw new RelocationPrimacyLostError('Lost ownership fence while recovering interrupted relocation');
    }
    const canonicalAnchor = await ensureAnchorWithinRoot(canonicalRoot, scopeRelSegments, DIR_MODE);
    if (canonicalAnchor.outcome === 'ready') {
      const resolvedCanonicalDbPath = path.join(canonicalAnchor.anchor, CANONICAL_DB_FILENAME);
      if (canResumePublication) {
        await publishStagedRelocation(canonicalRoot, canonicalAnchor.anchor, request.onStage);
      }
      if ((published && (winnerUnchanged || legacyRetired)) || canResumePublication) {
        return await finishPostPublishStep({
          canonicalAnchorDir: canonicalAnchor.anchor, canonicalDbPath: resolvedCanonicalDbPath, journal: validJournal,
          existingReceipt, nowMs, onStage: request.onStage, unlinkLegacyFile: request.unlinkLegacyFile,
          logger: request.logger, diag, activeFilesystemVerdict: canonicalFsVerdict
        });
      }
      await unlinkContainedEntry(canonicalRoot, path.join(canonicalAnchor.anchor, STAGING_DB_FILENAME));
      await unlinkContainedEntry(canonicalRoot, path.join(canonicalAnchor.anchor, JOURNAL_FILENAME));
    }
  } else if (!skipCanonicalJournal && journalRes.kind !== 'absent' && canonicalDirExists) {
    request.logger?.warn('store-relocation: discarding malformed relocation journal', {});
    await unlinkContainedEntry(canonicalRoot, path.join(canonicalScopeDir, JOURNAL_FILENAME));
  }

  const inspectedPopulated: InspectedStoreCandidate[] = [];
  const inspectedHealthyLegacy: InspectedStoreCandidate[] = [];

  const canonicalProbe = await probeAndInspectCandidateWithinRoot(
    canonicalRoot, ['sqlite', request.scopeId], CANONICAL_DB_FILENAME, true, maxSupportedSchemaVersion, existingReceipt
  );
  if (canonicalProbe.kind === 'refused_newer_schema') return toSchemaRefusalOutcome(canonicalProbe);
  if (canonicalProbe.kind === 'ok' && canonicalProbe.candidate.populated) inspectedPopulated.push(canonicalProbe.candidate);
  else recordNonOkProbeDiagnostic(canonicalProbe, 'canonical', diag);

  for (const legacyRoot of legacyRoots) {
    const legacyProbe = await probeAndInspectCandidateWithinRoot(
      legacyRoot, ['sqlite', request.scopeId], CANONICAL_DB_FILENAME, false, maxSupportedSchemaVersion, existingReceipt
    );
    if (legacyProbe.kind === 'refused_newer_schema') return toSchemaRefusalOutcome(legacyProbe);
    if (legacyProbe.kind === 'ok') {
      inspectedHealthyLegacy.push(legacyProbe.candidate);
      if (legacyProbe.candidate.populated) inspectedPopulated.push(legacyProbe.candidate);
    } else {
      recordNonOkProbeDiagnostic(legacyProbe, 'legacy', diag);
    }
  }

  const existingPreservedPaths = (existingReceipt?.preservedConflicts ?? []).map((c) => c.databasePath);
  const buildNoopOutcome = (): StoreRelocationOutcome => {
    diag.emitWarn(request.logger);
    return {
      outcome: 'noop', activeStorageRoot: canonicalRoot, activeDatabasePath: canonicalDbPath,
      activeSourceKind: 'host_global_storage_uri', preservedUnselectedPaths: existingPreservedPaths,
      noticeRequired: diag.hasWarning(), ...diag.fields({ activeFilesystemVerdict: canonicalFsVerdict })
    };
  };

  const buildFallbackOutcome = async (
    legacyCandidate: InspectedStoreCandidate,
    losers: readonly InspectedStoreCandidate[],
    reason: FallbackReason,
    diagnostic: string,
    legacyFsVerdict?: FilesystemTypeVerdict
  ): Promise<StoreRelocationOutcome> => {
    const resolvedLegacyFs = legacyFsVerdict ?? (await probeLegacyFs(legacyCandidate.storageRoot));
    if (requestedJournalMode === 'wal' && resolvedLegacyFs.classification === 'network') {
      throw new RelocationWalFilesystemRefusedError(
        `Refused SQLite WAL mode: both canonical (${canonicalFsVerdict.filesystemType}) and legacy (${resolvedLegacyFs.filesystemType}) are WAL-ineligible.`,
        canonicalFsVerdict, resolvedLegacyFs
      );
    }
    diag.emitWarn(request.logger);
    return {
      outcome: 'fallback_legacy_preserved', activeStorageRoot: legacyCandidate.storageRoot,
      activeDatabasePath: legacyCandidate.databasePath, activeSourceKind: 'host_storage_uri',
      reason, diagnostic, preservedUnselectedPaths: [...existingPreservedPaths, ...losers.map((l) => l.databasePath)],
      noticeRequired: true, ...diag.fields({ activeFilesystemVerdict: resolvedLegacyFs })
    };
  };

  if (inspectedPopulated.length === 0) {
    if (requestedJournalMode === 'wal' && canonicalFsVerdict.classification === 'network') {
      if (inspectedHealthyLegacy.length > 0) {
        return await buildFallbackOutcome(
          inspectedHealthyLegacy[0]!, [], 'network_share_wal_unsupported',
          `Refused SQLite WAL relocation onto network filesystem '${canonicalFsVerdict.filesystemType}'; keeping legacy store active in place.`
        );
      }
      throw new RelocationWalFilesystemRefusedError(
        `Refused SQLite WAL store on network filesystem '${canonicalFsVerdict.filesystemType}' with no usable local legacy store.`,
        canonicalFsVerdict
      );
    }
    if (requestedJournalMode === 'wal' && canonicalFsVerdict.classification === 'unknown' && inspectedHealthyLegacy.length > 0) {
      const legacyFs = await probeLegacyFs(inspectedHealthyLegacy[0]!.storageRoot);
      if (legacyFs.classification === 'local') {
        return await buildFallbackOutcome(
          inspectedHealthyLegacy[0]!, [], 'canonical_filesystem_unknown',
          `Refused SQLite WAL relocation off local legacy store onto unverified filesystem '${canonicalFsVerdict.filesystemType}'; keeping legacy store active in place.`,
          legacyFs
        );
      }
    }
    if (canonicalDirExists && canonicalFsVerdict.classification !== 'network') {
      await unlinkContainedEntry(canonicalRoot, path.join(canonicalScopeDir, STAGING_DB_FILENAME));
    }
    return buildNoopOutcome();
  }

  const ranked = [...inspectedPopulated].sort(compareCandidatesDeterministic);
  const winner = ranked[0]!;
  const losers = ranked.slice(1);

  if (winner.isCanonical) {
    if (requestedJournalMode === 'wal' && canonicalFsVerdict.classification === 'network') {
      throw new RelocationWalFilesystemRefusedError(`Refused SQLite WAL store on network filesystem '${canonicalFsVerdict.filesystemType}'.`, canonicalFsVerdict);
    }
    if (losers.length === 0) {
      if (canonicalDirExists && canonicalFsVerdict.classification !== 'network') {
        await unlinkContainedEntry(canonicalRoot, path.join(canonicalScopeDir, STAGING_DB_FILENAME));
      }
      return buildNoopOutcome();
    }
    if (!(await request.verifyPrimacy())) throw new RelocationPrimacyLostError('Lost ownership fence before recording conflict receipt');
    const anchorResult = await ensureAnchorWithinRoot(canonicalRoot, ['sqlite', request.scopeId], DIR_MODE);
    if (anchorResult.outcome !== 'ready') throw new Error(`RELOCATION_CANONICAL_ANCHOR_REFUSED:${anchorResult.reason}`);
    const resolvedCanonicalDbPath = path.join(anchorResult.anchor, CANONICAL_DB_FILENAME);
    const ts = nowMs();
    const newEntries: PreservedConflictEntry[] = losers.map((loser) => ({
      databasePath: loser.databasePath, origin: 'legacy_in_place', fingerprint: loser.fingerprint, recordedAtMs: ts
    }));
    const mergedConflicts = mergePreservedConflicts(existingReceipt?.preservedConflicts ?? [], newEntries);
    await writeAtomicJsonWithinAnchor(anchorResult.anchor, RECEIPT_TMP_FILENAME, RECEIPT_FILENAME, {
      version: 1, scopeId: request.scopeId, relocatedAtMs: ts,
      winnerSourcePath: resolvedCanonicalDbPath, preservedConflicts: mergedConflicts
    } satisfies RelocationReceipt);
    diag.emitWarn(request.logger);
    return {
      outcome: 'conflict_resolved', activeStorageRoot: path.dirname(path.dirname(anchorResult.anchor)),
      activeDatabasePath: resolvedCanonicalDbPath, activeSourceKind: 'host_global_storage_uri',
      winnerSourcePath: resolvedCanonicalDbPath, preservedUnselectedPaths: mergedConflicts.map((c) => c.databasePath),
      newlyDiscoveredConflictPaths: newEntries.map((c) => c.databasePath),
      selectionRule: 'last_write_then_run_count_then_canonical_then_path',
      noticeRequired: newEntries.length > 0 || diag.hasWarning(),
      ...diag.fields({ activeFilesystemVerdict: canonicalFsVerdict })
    };
  }

  // Case 1b / 2b: A legacy database won and must be relocated to canonicalDbPath.
  const winnerLegacyFs = await probeLegacyFs(winner.storageRoot);
  if (canonicalProbe.kind === 'containment_refused') {
    return await buildFallbackOutcome(
      winner, losers, 'symlink_or_containment_refused',
      `Cannot prepare canonical SQLite store (${canonicalProbe.reason}); keeping legacy store active in place.`,
      winnerLegacyFs
    );
  }
  if (requestedJournalMode === 'wal' && canonicalFsVerdict.classification === 'network') {
    return await buildFallbackOutcome(
      winner, losers, 'network_share_wal_unsupported',
      `Refused SQLite WAL relocation onto network filesystem '${canonicalFsVerdict.filesystemType}'; keeping legacy store active in place.`,
      winnerLegacyFs
    );
  }
  if (requestedJournalMode === 'wal' && canonicalFsVerdict.classification === 'unknown' && winnerLegacyFs.classification === 'local') {
    return await buildFallbackOutcome(
      winner, losers, 'canonical_filesystem_unknown',
      `Refused SQLite WAL relocation off local legacy store onto unverified filesystem '${canonicalFsVerdict.filesystemType}'; keeping legacy store active in place.`,
      winnerLegacyFs
    );
  }

  const anchorResult = await ensureAnchorWithinRoot(canonicalRoot, ['sqlite', request.scopeId], DIR_MODE);
  if (anchorResult.outcome === 'refused') {
    // Pure-Node containment refusal classification; see
    // `docs/architecture/native-binding-decision.md` for the no-native-binding decision.
    const isSymlink =
      anchorResult.reason === 'symlink-component' || anchorResult.reason === 'symlink-leaf' ||
      anchorResult.reason === 'reparse-point-leaf' || anchorResult.reason === 'escapes-root';
    return await buildFallbackOutcome(
      winner, losers, isSymlink ? 'symlink_or_containment_refused' : 'canonical_target_unwritable',
      `Cannot prepare canonical SQLite store (${anchorResult.reason}); keeping legacy store active in place.`,
      winnerLegacyFs
    );
  }

  const canonicalAnchorDir = anchorResult.anchor;
  const resolvedCanonicalDbPath = path.join(canonicalAnchorDir, CANONICAL_DB_FILENAME);
  for (const file of [resolvedCanonicalDbPath, `${resolvedCanonicalDbPath}-wal`, `${resolvedCanonicalDbPath}-shm`]) {
    const leaf = await judgeLeafRedirect(file, ['ENOENT'], platformLacksNoFollow());
    if (leaf.outcome === 'refused') {
      return await buildFallbackOutcome(
        winner, losers, 'symlink_or_containment_refused',
        `Cannot prepare canonical SQLite store (${leaf.reason}); keeping legacy store active in place.`,
        winnerLegacyFs
      );
    }
  }
  let stagingPath: string;
  try {
    stagingPath = await vacuumIntoTarget(winner.storageRoot, request.scopeId, CANONICAL_DB_FILENAME, canonicalAnchorDir, STAGING_DB_FILENAME);
  } catch (error) {
    await unlinkContainedEntry(canonicalRoot, path.join(canonicalAnchorDir, STAGING_DB_FILENAME));
    const boundedReason = errnoOf(error) ?? (error instanceof Error ? error.name : 'write_error');
    return await buildFallbackOutcome(
      winner, losers, 'canonical_target_unwritable',
      `Cannot stage relocated SQLite store into globalStorage (${boundedReason}); keeping legacy store active in place.`,
      winnerLegacyFs
    );
  }
  await request.onStage?.('after_stage_copy');

  const syncHandle = await openWithinRoot(canonicalRoot, [...scopeRelSegments, STAGING_DB_FILENAME], { flags: 'r' });
  if (syncHandle.outcome !== 'opened') {
    await unlinkContainedEntry(canonicalRoot, stagingPath);
    throw new Error(`RELOCATION_STAGE_SYNC_REFUSED:${syncHandle.reason}`);
  }
  let stagedSha256: string;
  try {
    await syncHandle.handle.sync();
    stagedSha256 = createHash('sha256').update(await syncHandle.handle.readFile()).digest('hex');
  } finally {
    await syncHandle.handle.close().catch(() => undefined);
  }

  const stagedInspection = await probeAndInspectCandidateWithinRoot(
    canonicalRoot, scopeRelSegments, STAGING_DB_FILENAME, true, maxSupportedSchemaVersion, null
  );
  if (stagedInspection.kind !== 'ok' || !stagedInspection.candidate.populated || stagedInspection.candidate.runCount < winner.runCount) {
    await unlinkContainedEntry(canonicalRoot, stagingPath);
    throw new Error('RELOCATION_STAGE_VERIFICATION_FAILED');
  }
  await request.onStage?.('after_stage_verify');

  const ts = nowMs();
  const preservedConflicts: PreservedConflictEntry[] = [];
  for (const loser of losers) {
    if (loser.isCanonical) {
      preservedConflicts.push(await preserveLosingCanonicalReadOnly(canonicalRoot, request.scopeId, canonicalAnchorDir, ts, request.onStage));
      await request.onStage?.('after_preserve_losing_canonical');
    } else {
      preservedConflicts.push({ databasePath: loser.databasePath, origin: 'legacy_in_place', fingerprint: loser.fingerprint, recordedAtMs: ts });
    }
  }

  const journal: RelocationJournal = {
    version: 1, scopeId: request.scopeId, stagedSha256,
    winnerDatabasePath: winner.databasePath, winnerStorageRoot: winner.storageRoot,
    winnerFingerprint: winner.fingerprint,
    previousCanonicalFingerprint: canonicalProbe.kind === 'ok' ? canonicalProbe.candidate.fingerprint :
      canonicalProbe.kind === 'absent' ? null : undefined,
    preservedConflicts, startedAtMs: ts
  };
  await writeAtomicJsonWithinAnchor(canonicalAnchorDir, `${JOURNAL_FILENAME}.tmp`, JOURNAL_FILENAME, journal);
  await request.onStage?.('after_write_journal');

  if (!(await request.verifyPrimacy())) {
    await unlinkContainedEntry(canonicalRoot, stagingPath);
    await unlinkContainedEntry(canonicalRoot, path.join(canonicalAnchorDir, JOURNAL_FILENAME));
    throw new RelocationPrimacyLostError('Lost ownership fence before publishing relocated SQLite store');
  }

  await publishStagedRelocation(canonicalRoot, canonicalAnchorDir, request.onStage);

  return await finishPostPublishStep({
    canonicalAnchorDir, canonicalDbPath: resolvedCanonicalDbPath, journal, existingReceipt, nowMs,
    onStage: request.onStage, unlinkLegacyFile: request.unlinkLegacyFile, logger: request.logger,
    diag, activeFilesystemVerdict: canonicalFsVerdict
  });
}
