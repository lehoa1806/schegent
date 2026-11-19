/**
 * FR-R7-10 — One SQLite operational store per folder, with crash-safe,
 * WAL-preserving one-time relocation from legacy per-window `storageUri` roots
 * into the canonical folder-keyed `<globalStorageUri>/sqlite/<scope>/schegent-state.db`.
 *
 * Security & durability invariants:
 * - Zero `vscode` imports (docs/hard-rules.md rule 13).
 * - Zero raw `node:fs` creating/writing/chmod primitives (docs/hard-rules.md rule 69):
 *   directories use `ensureAnchorWithinRoot(..., 0o700)`, file reads/writes use
 *   `openWithinRoot` with explicit owner-only modes (`0o600` / `0o400`), post-VACUUM
 *   narrowing uses `narrowMode(..., 0o600)`, and every `rename` / `unlink` is preceded
 *   by `resolveContainedLink` containment proof within 25 lines.
 * - Forward-only schema protection (GC-09): `min_reader_version` and `schema_version`
 *   are inspected strictly read-only BEFORE any copy, move, or mutation.
 * - Deterministic conflict resolution with zero silent row merging: unselected legacy
 *   stores remain completely untouched in place; a displaced canonical store is
 *   preserved unmodified at mode `0o400` beside the canonical database.
 */

import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SQLITE_SCHEMA_CURRENT_VERSION } from '../../contracts/sqlite-store/schema-types';
import { narrowMode } from '../../lib/narrow-mode';
import { parseStrictSchemaMetaVersion } from '../../lib/operational-value-helpers';
import { resolveContainedLink } from '../../lib/path-containment';
import { ensureAnchorWithinRoot, judgeLeafRedirect, openWithinRoot, platformLacksNoFollow } from '../../lib/safe-open';
import { isNetworkFilesystem } from './storage-location-resolver';

const CANONICAL_DB_FILENAME = 'schegent-state.db';
const STAGING_DB_FILENAME = '.schegent-state.relocate.staging.db';
const UNSELECTED_TMP_FILENAME = '.schegent-state.unselected.tmp.db';
const JOURNAL_FILENAME = '.relocation-in-progress.json';
const RECEIPT_FILENAME = 'relocation-receipt.json';
const RECEIPT_TMP_FILENAME = '.relocation-receipt.json.tmp';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const READONLY_PRESERVED_MODE = 0o400;
const MAX_WORKSPACE_STORAGE_ENTRIES = 2048;

const SAFE_SCOPE_SEGMENT = /^[A-Za-z0-9._-]+$/;

const POPULATED_DATA_TABLES = [
  'operational_queue_meta',
  'operational_tasks',
  'operational_runs',
  'operational_kv_documents',
  'runs',
  'definitions',
  'usage_observations',
  'artifacts'
] as const;

const OPERATIONAL_TIMESTAMP_SOURCES: ReadonlyArray<{ readonly table: string; readonly column: string }> = [
  { table: 'operational_queue_meta', column: 'updated_at_ms' },
  { table: 'operational_tasks', column: 'updated_at_ms' },
  { table: 'operational_runs', column: 'last_transition_at_ms' },
  { table: 'operational_kv_documents', column: 'updated_at_ms' },
  { table: 'runs', column: 'updated_at_ms' },
  { table: 'definitions', column: 'created_at_ms' },
  { table: 'usage_observations', column: 'observed_at_ms' },
  { table: 'artifacts', column: 'created_at_ms' }
];

const METADATA_TIMESTAMP_SOURCES: ReadonlyArray<{ readonly table: string; readonly column: string }> = [
  { table: 'cutover_sentinel', column: 'updated_at_ms' },
  { table: 'schema_meta', column: 'updated_at_ms' },
  { table: 'schema_migrations', column: 'applied_at_ms' }
];

export type RelocationStage =
  | 'after_stage_copy'
  | 'after_stage_verify'
  | 'after_preserve_losing_canonical'
  | 'after_write_journal'
  | 'after_atomic_publish'
  | 'after_retire_legacy'
  | 'after_write_receipt';

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

interface RelocationJournal {
  readonly version: 1;
  readonly scopeId: string;
  readonly stagedSha256: string;
  readonly winnerDatabasePath: string;
  readonly winnerStorageRoot: string;
  readonly winnerFingerprint: CandidateFileFingerprint;
  readonly preservedConflicts: readonly PreservedConflictEntry[];
  readonly startedAtMs: number;
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

type CandidateInspectionResult =
  | { readonly kind: 'ok'; readonly candidate: InspectedStoreCandidate }
  | {
      readonly kind: 'refused_newer_schema';
      readonly reason: 'UNSUPPORTED_MIN_READER_VERSION' | 'UNSUPPORTED_FUTURE_SCHEMA_VERSION';
      readonly offendingPath: string;
      readonly recordedVersion: number | null;
      readonly maxSupportedVersion: number;
      readonly diagnostic: string;
    }
  | { readonly kind: 'corrupt'; readonly databasePath: string; readonly reason: string };

export type StoreRelocationOutcome =
  | {
      readonly outcome: 'noop';
      readonly activeStorageRoot: string;
      readonly activeDatabasePath: string;
      readonly activeSourceKind: 'host_global_storage_uri';
      readonly preservedUnselectedPaths: readonly string[];
      readonly noticeRequired: false;
    }
  | {
      readonly outcome: 'relocated';
      readonly activeStorageRoot: string;
      readonly activeDatabasePath: string;
      readonly activeSourceKind: 'host_global_storage_uri';
      readonly relocatedFromPath: string;
      readonly preservedUnselectedPaths: readonly string[];
      readonly noticeRequired: false;
    }
  | {
      readonly outcome: 'conflict_resolved';
      readonly activeStorageRoot: string;
      readonly activeDatabasePath: string;
      readonly activeSourceKind: 'host_global_storage_uri';
      readonly winnerSourcePath: string;
      readonly preservedUnselectedPaths: readonly string[];
      readonly newlyDiscoveredConflictPaths: readonly string[];
      readonly selectionRule: 'last_write_then_run_count_then_canonical_then_path';
      readonly noticeRequired: boolean;
    }
  | {
      readonly outcome: 'refused_newer_schema';
      readonly reason: 'UNSUPPORTED_MIN_READER_VERSION' | 'UNSUPPORTED_FUTURE_SCHEMA_VERSION';
      readonly offendingPath: string;
      readonly recordedVersion: number | null;
      readonly maxSupportedVersion: number;
      readonly diagnostic: string;
      readonly noticeRequired: true;
    }
  | {
      readonly outcome: 'fallback_legacy_preserved';
      readonly activeStorageRoot: string;
      readonly activeDatabasePath: string;
      readonly activeSourceKind: 'host_storage_uri';
      readonly reason:
        | 'network_share_wal_unsupported'
        | 'canonical_target_unwritable'
        | 'symlink_or_containment_refused';
      readonly diagnostic: string;
      readonly preservedUnselectedPaths: readonly string[];
      readonly noticeRequired: true;
    };

export interface RelocateLegacySqliteStoreRequest {
  readonly scopeId: string;
  readonly globalStorageUri: string;
  readonly legacyStorageUri?: string | undefined;
  readonly additionalLegacyStorageRoots?: readonly string[] | undefined;
  readonly canonicalFilesystemType?: string | undefined;
  readonly requestedJournalMode?: 'wal' | 'delete' | undefined;
  readonly maxSupportedSchemaVersion?: number | undefined;
  readonly verifyPrimacy: () => Promise<boolean>;
  readonly nowMs?: (() => number) | undefined;
  readonly onStage?: ((stage: RelocationStage) => void | Promise<void>) | undefined;
}

export class RelocationPrimacyLostError extends Error {
  public readonly code = 'RELOCATION_PRIMACY_LOST' as const;

  public constructor(message: string) {
    super(message);
    this.name = 'RelocationPrimacyLostError';
  }
}

function errnoOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isMissing(error: unknown): boolean {
  const code = errnoOf(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function parseTimestampMs(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
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

function fingerprintsMatch(a: CandidateFileFingerprint, b: CandidateFileFingerprint): boolean {
  return (
    a.sizeBytes === b.sizeBytes &&
    Math.trunc(a.mtimeMs) === Math.trunc(b.mtimeMs) &&
    a.walSizeBytes === b.walSizeBytes &&
    Math.trunc(a.walMtimeMs) === Math.trunc(b.walMtimeMs)
  );
}

async function writeFully(handle: fsp.FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    offset += bytesWritten;
  }
}

async function readRegularFileWithinRoot(root: string, segments: readonly string[]): Promise<Buffer | null> {
  const opened = await openWithinRoot(root, segments, { flags: 'r' });
  if (opened.outcome !== 'opened') return null;
  try {
    return await opened.handle.readFile();
  } catch {
    return null;
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

async function computeFileSha256WithinRoot(root: string, segments: readonly string[]): Promise<string | null> {
  const bytes = await readRegularFileWithinRoot(root, segments);
  if (bytes === null) return null;
  return createHash('sha256').update(bytes).digest('hex');
}

async function unlinkContainedEntry(root: string, targetPath: string): Promise<boolean> {
  const verdict = await resolveContainedLink(targetPath, [root]);
  if (verdict.outcome === 'absent') return true;
  if (verdict.outcome !== 'contained') return false;
  try {
    await fsp.unlink(verdict.resolved);
    return true;
  } catch (error) {
    return isMissing(error);
  }
}

async function renameContainedEntry(anchorDir: string, fromName: string, toName: string): Promise<boolean> {
  const fromPath = path.join(anchorDir, fromName);
  const toPath = path.join(anchorDir, toName);
  const fromVerdict = await resolveContainedLink(fromPath, [anchorDir]);
  const toVerdict = await resolveContainedLink(toPath, [anchorDir]);
  if (fromVerdict.outcome !== 'contained') return false;
  if (toVerdict.outcome !== 'contained' && toVerdict.outcome !== 'absent') return false;
  const resolvedTo = toVerdict.outcome === 'contained' ? toVerdict.resolved : toPath;
  if (path.dirname(fromVerdict.resolved) !== anchorDir || path.dirname(resolvedTo) !== anchorDir) {
    return false;
  }
  await fsp.rename(fromVerdict.resolved, resolvedTo);
  return true;
}

async function writeAtomicJsonWithinAnchor(anchorDir: string, tempName: string, finalName: string, payload: unknown): Promise<void> {
  await unlinkContainedEntry(anchorDir, path.join(anchorDir, tempName));
  const opened = await openWithinRoot(anchorDir, [tempName], { flags: 'wx', fileMode: FILE_MODE });
  if (opened.outcome !== 'opened') {
    throw new Error(`RELOCATION_WRITE_REFUSED:${opened.reason}:${opened.errno}`);
  }
  try {
    await writeFully(opened.handle, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8'));
    await opened.handle.sync();
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
  const renamed = await renameContainedEntry(anchorDir, tempName, finalName);
  if (!renamed) {
    await unlinkContainedEntry(anchorDir, path.join(anchorDir, tempName));
    throw new Error('RELOCATION_ATOMIC_RENAME_REFUSED');
  }
}

async function readJsonWithinAnchor<T>(anchorDir: string, fileName: string): Promise<T | null> {
  const bytes = await readRegularFileWithinRoot(anchorDir, [fileName]);
  if (bytes === null) return null;
  try {
    return JSON.parse(bytes.toString('utf8')) as T;
  } catch {
    return null;
  }
}

async function statRegularNonSymlink(targetPath: string): Promise<{ readonly sizeBytes: number; readonly mtimeMs: number } | null> {
  try {
    const st = await fsp.lstat(targetPath);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    return { sizeBytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

async function fingerprintDatabase(databasePath: string): Promise<CandidateFileFingerprint | null> {
  const dbStat = await statRegularNonSymlink(databasePath);
  if (dbStat === null) return null;
  const walStat = await statRegularNonSymlink(`${databasePath}-wal`);
  const walSizeBytes = walStat?.sizeBytes ?? 0;
  return {
    sizeBytes: dbStat.sizeBytes,
    mtimeMs: dbStat.mtimeMs,
    walSizeBytes,
    walMtimeMs: walSizeBytes > 0 && walStat !== null ? walStat.mtimeMs : 0
  };
}

async function verifyCandidateContained(storageRoot: string, scopeId: string): Promise<string | null> {
  const dbPath = path.join(storageRoot, 'sqlite', scopeId, CANONICAL_DB_FILENAME);
  const verdict = await resolveContainedLink(dbPath, [storageRoot]);
  if (verdict.outcome !== 'contained') return null;
  const st = await statRegularNonSymlink(verdict.resolved);
  return st !== null ? verdict.resolved : null;
}

async function discoverLegacyStorageRoots(
  globalStorageUri: string,
  legacyStorageUri: string | undefined,
  additionalLegacyStorageRoots: readonly string[] | undefined
): Promise<readonly string[]> {
  const normalizedGlobal = path.resolve(globalStorageUri);
  const seen = new Set<string>([normalizedGlobal]);
  const roots: string[] = [];

  const tryAddRoot = (candidate: string | undefined): void => {
    if (!candidate || !path.isAbsolute(candidate) || candidate.includes('\0')) return;
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    roots.push(resolved);
  };

  tryAddRoot(legacyStorageUri);
  if (additionalLegacyStorageRoots !== undefined) {
    for (const extra of additionalLegacyStorageRoots) {
      tryAddRoot(extra);
    }
  }

  // When legacyStorageUri sits under VS Code's standard `workspaceStorage/<window-hash>/<extensionId>`
  // layout, scan immediate non-symlink sibling window hashes strictly inside `workspaceStorage`.
  if (legacyStorageUri !== undefined && path.isAbsolute(legacyStorageUri)) {
    const resolvedLegacy = path.resolve(legacyStorageUri);
    const extensionDirName = path.basename(resolvedLegacy);
    const windowHashDir = path.dirname(resolvedLegacy);
    const workspaceStorageParent = path.dirname(windowHashDir);
    if (
      extensionDirName.length > 0 &&
      extensionDirName !== '.' &&
      extensionDirName !== '..' &&
      path.basename(workspaceStorageParent) === 'workspaceStorage'
    ) {
      try {
        const parentStat = await fsp.lstat(workspaceStorageParent);
        if (!parentStat.isSymbolicLink() && parentStat.isDirectory()) {
          const entries = await fsp.readdir(workspaceStorageParent);
          const bounded = entries.slice(0, MAX_WORKSPACE_STORAGE_ENTRIES).sort();
          for (const entry of bounded) {
            if (entry === '.' || entry === '..') continue;
            const siblingWindowDir = path.join(workspaceStorageParent, entry);
            try {
              const entryStat = await fsp.lstat(siblingWindowDir);
              if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) continue;
              const siblingRoot = path.join(siblingWindowDir, extensionDirName);
              const extStat = await fsp.lstat(siblingRoot);
              if (extStat.isSymbolicLink() || !extStat.isDirectory()) continue;
              tryAddRoot(siblingRoot);
            } catch {
              // Skip unreadable or missing sibling extension directory.
            }
          }
        }
      } catch {
        // Ignore unreadable workspaceStorage parent.
      }
    }
  }

  return roots;
}

function inspectCandidateReadOnly(
  storageRoot: string,
  databasePath: string,
  isCanonical: boolean,
  fingerprint: CandidateFileFingerprint,
  maxSupportedSchemaVersion: number
): CandidateInspectionResult {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(databasePath, {
      open: true,
      readOnly: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false
    });
    db.exec('PRAGMA trusted_schema = OFF');
    db.exec('PRAGMA busy_timeout = 250');

    const quickRows = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check?: string }>;
    const quickValues = quickRows.map((r) => String(r.quick_check ?? ''));
    if (quickValues.length === 0 || quickValues.some((v) => v.toLowerCase() !== 'ok')) {
      return { kind: 'corrupt', databasePath, reason: `quick_check failed: ${quickValues.join(', ')}` };
    }

    const tableRows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>;
    const tables = new Set(tableRows.map((r) => r.name));

    let schemaVersion = 0;
    let minReaderVersion = 0;
    if (tables.has('schema_meta')) {
      const minReaderRow = db
        .prepare(`SELECT meta_value FROM schema_meta WHERE meta_key = 'min_reader_version'`)
        .get() as { meta_value: string } | undefined;
      if (minReaderRow !== undefined) {
        const floor = parseStrictSchemaMetaVersion(minReaderRow.meta_value);
        if (floor === null) {
          return {
            kind: 'refused_newer_schema',
            reason: 'UNSUPPORTED_MIN_READER_VERSION',
            offendingPath: databasePath,
            recordedVersion: null,
            maxSupportedVersion: maxSupportedSchemaVersion,
            diagnostic: 'UNSUPPORTED_MIN_READER_VERSION: database records an unreadable reader floor'
          };
        }
        if (floor > maxSupportedSchemaVersion) {
          return {
            kind: 'refused_newer_schema',
            reason: 'UNSUPPORTED_MIN_READER_VERSION',
            offendingPath: databasePath,
            recordedVersion: floor,
            maxSupportedVersion: maxSupportedSchemaVersion,
            diagnostic: `UNSUPPORTED_MIN_READER_VERSION: database requires a reader of schema ${floor} or later; this build reads up to ${maxSupportedSchemaVersion}`
          };
        }
        minReaderVersion = floor;
      }

      const schemaVersionRow = db
        .prepare(`SELECT meta_value FROM schema_meta WHERE meta_key = 'schema_version'`)
        .get() as { meta_value: string } | undefined;
      if (schemaVersionRow !== undefined) {
        const recorded = parseStrictSchemaMetaVersion(schemaVersionRow.meta_value);
        if (recorded === null) {
          return {
            kind: 'refused_newer_schema',
            reason: 'UNSUPPORTED_FUTURE_SCHEMA_VERSION',
            offendingPath: databasePath,
            recordedVersion: null,
            maxSupportedVersion: maxSupportedSchemaVersion,
            diagnostic: 'UNSUPPORTED_FUTURE_SCHEMA_VERSION: database records an unreadable schema_version'
          };
        }
        if (recorded > maxSupportedSchemaVersion) {
          return {
            kind: 'refused_newer_schema',
            reason: 'UNSUPPORTED_FUTURE_SCHEMA_VERSION',
            offendingPath: databasePath,
            recordedVersion: recorded,
            maxSupportedVersion: maxSupportedSchemaVersion,
            diagnostic: `UNSUPPORTED_FUTURE_SCHEMA_VERSION: database schema_version=${recorded} exceeds supported max=${maxSupportedSchemaVersion}`
          };
        }
        schemaVersion = recorded;
      }
    }

    let populated = false;
    for (const tableName of POPULATED_DATA_TABLES) {
      if (!tables.has(tableName)) continue;
      const present = db.prepare(`SELECT 1 AS hit FROM "${tableName}" LIMIT 1`).get() as { hit: number } | undefined;
      if (present !== undefined) {
        populated = true;
        break;
      }
    }
    if (!populated && tables.has('cutover_sentinel')) {
      const activeSentinel = db
        .prepare(`SELECT 1 AS hit FROM cutover_sentinel WHERE authority IN ('sqlite', 'retired_legacy') LIMIT 1`)
        .get() as { hit: number } | undefined;
      if (activeSentinel !== undefined) {
        populated = true;
      }
    }

    let operationalMaxTs = 0;
    for (const src of OPERATIONAL_TIMESTAMP_SOURCES) {
      if (!tables.has(src.table)) continue;
      try {
        const row = db.prepare(`SELECT MAX("${src.column}") AS ts FROM "${src.table}"`).get() as
          | { ts: unknown }
          | undefined;
        const parsed = parseTimestampMs(row?.ts);
        if (parsed !== null && parsed > operationalMaxTs) {
          operationalMaxTs = parsed;
        }
      } catch {
        // Older schema variant may omit a column; ignore safely.
      }
    }

    let metadataMaxTs = 0;
    if (operationalMaxTs === 0) {
      for (const src of METADATA_TIMESTAMP_SOURCES) {
        if (!tables.has(src.table)) continue;
        try {
          const row = db.prepare(`SELECT MAX("${src.column}") AS ts FROM "${src.table}"`).get() as
            | { ts: unknown }
            | undefined;
          const parsed = parseTimestampMs(row?.ts);
          if (parsed !== null && parsed > metadataMaxTs) {
            metadataMaxTs = parsed;
          }
        } catch {
          // Ignore older schema differences.
        }
      }
    }

    const fileMaxMtimeMs = Math.max(fingerprint.mtimeMs, fingerprint.walMtimeMs);
    const lastWriteMs = operationalMaxTs > 0 ? operationalMaxTs : metadataMaxTs > 0 ? metadataMaxTs : fileMaxMtimeMs;

    let operationalRunsCount = 0;
    if (tables.has('operational_runs')) {
      const row = db.prepare('SELECT COUNT(*) AS cnt FROM operational_runs').get() as { cnt: number } | undefined;
      operationalRunsCount = Number(row?.cnt ?? 0);
    }
    let runsCount = 0;
    if (tables.has('runs')) {
      const row = db.prepare('SELECT COUNT(*) AS cnt FROM runs').get() as { cnt: number } | undefined;
      runsCount = Number(row?.cnt ?? 0);
    }
    const runCount = Math.max(operationalRunsCount, runsCount);

    return {
      kind: 'ok',
      candidate: {
        storageRoot,
        databasePath,
        isCanonical,
        sourceKind: isCanonical ? 'host_global_storage_uri' : 'host_storage_uri',
        populated,
        lastWriteMs,
        runCount,
        schemaVersion,
        minReaderVersion,
        fingerprint
      }
    };
  } catch (error) {
    return {
      kind: 'corrupt',
      databasePath,
      reason: error instanceof Error ? error.message : 'unreadable sqlite database'
    };
  } finally {
    db?.close();
  }
}

function compareCandidatesDeterministic(a: InspectedStoreCandidate, b: InspectedStoreCandidate): number {
  if (a.lastWriteMs !== b.lastWriteMs) return b.lastWriteMs - a.lastWriteMs;
  if (a.runCount !== b.runCount) return b.runCount - a.runCount;
  if (a.isCanonical !== b.isCanonical) return a.isCanonical ? -1 : 1;
  if (a.databasePath < b.databasePath) return -1;
  if (a.databasePath > b.databasePath) return 1;
  return 0;
}

async function vacuumIntoTarget(sourceDbPath: string, destinationAnchorDir: string, destinationFileName: string): Promise<string> {
  const destPath = path.join(destinationAnchorDir, destinationFileName);
  await unlinkContainedEntry(destinationAnchorDir, destPath);
  await unlinkContainedEntry(destinationAnchorDir, `${destPath}-wal`);
  await unlinkContainedEntry(destinationAnchorDir, `${destPath}-shm`);

  const leafCheck = await judgeLeafRedirect(destPath, ['ENOENT'], platformLacksNoFollow());
  if (leafCheck.outcome === 'refused') {
    throw new Error(`RELOCATION_STAGE_REFUSED:${leafCheck.reason}`);
  }

  const roDb = new DatabaseSync(sourceDbPath, {
    open: true,
    readOnly: true,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false
  });
  try {
    roDb.exec('PRAGMA trusted_schema = OFF');
    roDb.exec('PRAGMA busy_timeout = 250');
    roDb.prepare('VACUUM INTO ?').run(destPath);
  } finally {
    roDb.close();
  }

  const narrow = await narrowMode(destPath, FILE_MODE);
  if (narrow.outcome === 'refused-symlink') {
    await unlinkContainedEntry(destinationAnchorDir, destPath);
    throw new Error('RELOCATION_STAGE_REFUSED:symlink-leaf');
  }
  if (process.platform !== 'win32' && narrow.outcome === 'unsupported') {
    await unlinkContainedEntry(destinationAnchorDir, destPath);
    throw new Error(`RELOCATION_STAGE_MODE_REFUSED:${narrow.code}`);
  }
  return destPath;
}

async function preserveLosingCanonicalReadOnly(
  canonicalAnchorDir: string,
  canonicalDbPath: string,
  nowMs: number
): Promise<PreservedConflictEntry> {
  await vacuumIntoTarget(canonicalDbPath, canonicalAnchorDir, UNSELECTED_TMP_FILENAME);
  const bytes = await readRegularFileWithinRoot(canonicalAnchorDir, [UNSELECTED_TMP_FILENAME]);
  await unlinkContainedEntry(canonicalAnchorDir, path.join(canonicalAnchorDir, UNSELECTED_TMP_FILENAME));
  if (bytes === null) {
    throw new Error('RELOCATION_PRESERVE_CANONICAL_FAILED');
  }
  const shortHash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const preservedName = `schegent-state.unselected-${shortHash}.db`;
  const preservedPath = path.join(canonicalAnchorDir, preservedName);

  const opened = await openWithinRoot(canonicalAnchorDir, [preservedName], {
    flags: 'wx',
    fileMode: READONLY_PRESERVED_MODE
  });
  if (opened.outcome === 'opened') {
    try {
      await writeFully(opened.handle, bytes);
      await opened.handle.sync();
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  } else if (opened.errno !== 'EEXIST') {
    throw new Error(`RELOCATION_PRESERVE_CANONICAL_REFUSED:${opened.reason}:${opened.errno}`);
  } else {
    // Crash-recovery idempotency: verify existing sibling matches digest before reusing.
    const existingDigest = await computeFileSha256WithinRoot(canonicalAnchorDir, [preservedName]);
    if (existingDigest === null || existingDigest.slice(0, 12) !== shortHash) {
      throw new Error('RELOCATION_PRESERVE_CANONICAL_DIGEST_MISMATCH');
    }
  }

  const fp = await fingerprintDatabase(preservedPath);
  return {
    databasePath: preservedPath,
    origin: 'canonical_sibling_readonly',
    fingerprint: fp ?? { sizeBytes: bytes.byteLength, mtimeMs: nowMs, walSizeBytes: 0, walMtimeMs: 0 },
    recordedAtMs: nowMs
  };
}

async function retireLegacyWinnerFiles(winnerStorageRoot: string, winnerDatabasePath: string): Promise<void> {
  await unlinkContainedEntry(winnerStorageRoot, `${winnerDatabasePath}-wal`);
  await unlinkContainedEntry(winnerStorageRoot, `${winnerDatabasePath}-shm`);
  await unlinkContainedEntry(winnerStorageRoot, winnerDatabasePath);
}

function mergePreservedConflicts(
  existing: readonly PreservedConflictEntry[],
  added: readonly PreservedConflictEntry[]
): readonly PreservedConflictEntry[] {
  const byPath = new Map<string, PreservedConflictEntry>();
  for (const item of existing) {
    byPath.set(item.databasePath, item);
  }
  for (const item of added) {
    byPath.set(item.databasePath, item);
  }
  return [...byPath.values()].sort((a, b) => a.databasePath.localeCompare(b.databasePath));
}

function isReceiptAcknowledged(receipt: RelocationReceipt | null, candidatePath: string, fp: CandidateFileFingerprint): boolean {
  if (receipt === null) return false;
  return receipt.preservedConflicts.some(
    (entry) => entry.databasePath === candidatePath && fingerprintsMatch(entry.fingerprint, fp)
  );
}

function isValidRelocationJournal(candidate: unknown, expectedScopeId: string): candidate is RelocationJournal {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const obj = candidate as Record<string, unknown>;
  return (
    obj.version === 1 &&
    obj.scopeId === expectedScopeId &&
    typeof obj.stagedSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(obj.stagedSha256) &&
    typeof obj.winnerDatabasePath === 'string' &&
    path.isAbsolute(obj.winnerDatabasePath) &&
    typeof obj.winnerStorageRoot === 'string' &&
    path.isAbsolute(obj.winnerStorageRoot) &&
    Array.isArray(obj.preservedConflicts)
  );
}

async function finishPostPublishStep(
  canonicalAnchorDir: string,
  canonicalDbPath: string,
  journal: RelocationJournal,
  existingReceipt: RelocationReceipt | null,
  nowMs: () => number,
  onStage?: (stage: RelocationStage) => void | Promise<void>
): Promise<StoreRelocationOutcome> {
  // Retire the winning legacy database (idempotent if already removed before crash).
  const legacyStillPresent = await statRegularNonSymlink(journal.winnerDatabasePath);
  if (legacyStillPresent !== null) {
    await retireLegacyWinnerFiles(journal.winnerStorageRoot, journal.winnerDatabasePath);
  }
  await onStage?.('after_retire_legacy');

  const mergedConflicts = mergePreservedConflicts(
    existingReceipt?.preservedConflicts ?? [],
    journal.preservedConflicts
  );
  const newConflictPaths = journal.preservedConflicts
    .filter((entry) => !isReceiptAcknowledged(existingReceipt, entry.databasePath, entry.fingerprint))
    .map((entry) => entry.databasePath);

  const receipt: RelocationReceipt = {
    version: 1,
    scopeId: journal.scopeId,
    relocatedAtMs: nowMs(),
    winnerSourcePath: journal.winnerDatabasePath,
    preservedConflicts: mergedConflicts
  };
  await writeAtomicJsonWithinAnchor(canonicalAnchorDir, RECEIPT_TMP_FILENAME, RECEIPT_FILENAME, receipt);
  await onStage?.('after_write_receipt');

  await unlinkContainedEntry(canonicalAnchorDir, path.join(canonicalAnchorDir, JOURNAL_FILENAME));
  await unlinkContainedEntry(canonicalAnchorDir, path.join(canonicalAnchorDir, STAGING_DB_FILENAME));

  const preservedPaths = mergedConflicts.map((c) => c.databasePath);
  if (journal.preservedConflicts.length > 0) {
    return {
      outcome: 'conflict_resolved',
      activeStorageRoot: path.dirname(path.dirname(canonicalAnchorDir)),
      activeDatabasePath: canonicalDbPath,
      activeSourceKind: 'host_global_storage_uri',
      winnerSourcePath: journal.winnerDatabasePath,
      preservedUnselectedPaths: preservedPaths,
      newlyDiscoveredConflictPaths: newConflictPaths,
      selectionRule: 'last_write_then_run_count_then_canonical_then_path',
      noticeRequired: newConflictPaths.length > 0
    };
  }

  return {
    outcome: 'relocated',
    activeStorageRoot: path.dirname(path.dirname(canonicalAnchorDir)),
    activeDatabasePath: canonicalDbPath,
    activeSourceKind: 'host_global_storage_uri',
    relocatedFromPath: journal.winnerDatabasePath,
    preservedUnselectedPaths: preservedPaths,
    noticeRequired: false
  };
}

export async function relocateLegacySqliteStore(
  request: RelocateLegacySqliteStoreRequest
): Promise<StoreRelocationOutcome> {
  if (!path.isAbsolute(request.globalStorageUri) || request.globalStorageUri.includes('\0')) {
    throw new Error('RELOCATION_INVALID_ROOT: globalStorageUri must be an absolute path');
  }
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
  const canonicalScopeDir = path.join(canonicalRoot, 'sqlite', request.scopeId);
  const canonicalDbPath = path.join(canonicalScopeDir, CANONICAL_DB_FILENAME);

  // Read existing receipt & journal (read-only) if the canonical directory already exists.
  const canonicalDirStat = await fsp.lstat(canonicalScopeDir).catch(() => null);
  const canonicalDirExists = canonicalDirStat !== null && !canonicalDirStat.isSymbolicLink() && canonicalDirStat.isDirectory();
  const existingReceipt = canonicalDirExists
    ? await readJsonWithinAnchor<RelocationReceipt>(canonicalScopeDir, RECEIPT_FILENAME)
    : null;
  const existingJournal: unknown = canonicalDirExists
    ? await readJsonWithinAnchor<unknown>(canonicalScopeDir, JOURNAL_FILENAME)
    : null;

  // Crash recovery check: if `.relocation-in-progress.json` exists AND canonical DB already
  // carries the exact published `stagedSha256` (or the legacy winner is already retired),
  // resume Step 5 directly so an interrupted post-publish crash never triggers a false conflict.
  if (isValidRelocationJournal(existingJournal, request.scopeId)) {
    const canonicalAnchor = await ensureAnchorWithinRoot(canonicalRoot, ['sqlite', request.scopeId], DIR_MODE);
    if (canonicalAnchor.outcome === 'ready') {
      const resolvedCanonicalDbPath = path.join(canonicalAnchor.anchor, CANONICAL_DB_FILENAME);
      const publishedSha = await computeFileSha256WithinRoot(canonicalAnchor.anchor, [CANONICAL_DB_FILENAME]);
      const winnerStillPresent = await statRegularNonSymlink(existingJournal.winnerDatabasePath);
      if (
        publishedSha !== null &&
        (publishedSha === existingJournal.stagedSha256 || winnerStillPresent === null)
      ) {
        if (!(await request.verifyPrimacy())) {
          throw new RelocationPrimacyLostError('Lost ownership fence while recovering interrupted relocation');
        }
        return await finishPostPublishStep(
          canonicalAnchor.anchor,
          resolvedCanonicalDbPath,
          existingJournal,
          existingReceipt,
          nowMs,
          request.onStage
        );
      }
      // Step 4 had NOT published yet; clean up stale staging/journal and evaluate cleanly below.
      await unlinkContainedEntry(canonicalAnchor.anchor, path.join(canonicalAnchor.anchor, STAGING_DB_FILENAME));
      await unlinkContainedEntry(canonicalAnchor.anchor, path.join(canonicalAnchor.anchor, JOURNAL_FILENAME));
    }
  } else if (existingJournal !== null && canonicalDirExists) {
    // Discard malformed journal left by an interrupted or corrupted write.
    await unlinkContainedEntry(canonicalScopeDir, path.join(canonicalScopeDir, JOURNAL_FILENAME));
  }

  // Discover canonical + all legacy candidate stores strictly under host-trusted roots.
  const legacyRoots = await discoverLegacyStorageRoots(
    canonicalRoot,
    request.legacyStorageUri,
    request.additionalLegacyStorageRoots
  );

  const inspectedPopulated: InspectedStoreCandidate[] = [];
  const inspectedHealthyLegacy: InspectedStoreCandidate[] = [];

  // Inspect canonical candidate first (read-only).
  const verifiedCanonicalPath = await verifyCandidateContained(canonicalRoot, request.scopeId);
  if (verifiedCanonicalPath !== null) {
    const fp = await fingerprintDatabase(verifiedCanonicalPath);
    if (fp !== null) {
      const res = inspectCandidateReadOnly(canonicalRoot, verifiedCanonicalPath, true, fp, maxSupportedSchemaVersion);
      if (res.kind === 'refused_newer_schema') {
        return {
          outcome: 'refused_newer_schema',
          reason: res.reason,
          offendingPath: res.offendingPath,
          recordedVersion: res.recordedVersion,
          maxSupportedVersion: res.maxSupportedVersion,
          diagnostic: res.diagnostic,
          noticeRequired: true
        };
      }
      if (res.kind === 'ok' && res.candidate.populated) {
        inspectedPopulated.push(res.candidate);
      }
    }
  }

  // Inspect every legacy candidate read-only BEFORE any filesystem mutation.
  for (const legacyRoot of legacyRoots) {
    const verifiedLegacyPath = await verifyCandidateContained(legacyRoot, request.scopeId);
    if (verifiedLegacyPath === null) continue;
    const fp = await fingerprintDatabase(verifiedLegacyPath);
    if (fp === null) continue;

    // Skip previously acknowledged unselected legacy stores if unmodified since receipt.
    if (isReceiptAcknowledged(existingReceipt, verifiedLegacyPath, fp)) {
      continue;
    }

    const res = inspectCandidateReadOnly(legacyRoot, verifiedLegacyPath, false, fp, maxSupportedSchemaVersion);
    if (res.kind === 'refused_newer_schema') {
      return {
        outcome: 'refused_newer_schema',
        reason: res.reason,
        offendingPath: res.offendingPath,
        recordedVersion: res.recordedVersion,
        maxSupportedVersion: res.maxSupportedVersion,
        diagnostic: res.diagnostic,
        noticeRequired: true
      };
    }
    if (res.kind === 'ok') {
      inspectedHealthyLegacy.push(res.candidate);
      if (res.candidate.populated) {
        inspectedPopulated.push(res.candidate);
      }
    }
  }

  const existingPreservedPaths = (existingReceipt?.preservedConflicts ?? []).map((c) => c.databasePath);

  // Case 0: Zero populated candidates -> clean canonical no-op (clean up any leftover staging file).
  if (inspectedPopulated.length === 0) {
    if (canonicalDirExists) {
      await unlinkContainedEntry(canonicalScopeDir, path.join(canonicalScopeDir, STAGING_DB_FILENAME));
    }
    // Still honor network-FS / unwritable fallback if an empty healthy legacy store exists and target is refused.
    if (requestedJournalMode === 'wal' && isNetworkFilesystem(request.canonicalFilesystemType) && inspectedHealthyLegacy.length > 0) {
      const legacyFallback = inspectedHealthyLegacy[0]!;
      return {
        outcome: 'fallback_legacy_preserved',
        activeStorageRoot: legacyFallback.storageRoot,
        activeDatabasePath: legacyFallback.databasePath,
        activeSourceKind: 'host_storage_uri',
        reason: 'network_share_wal_unsupported',
        diagnostic: `Refused SQLite WAL relocation onto network filesystem '${request.canonicalFilesystemType}'; keeping legacy store active in place.`,
        preservedUnselectedPaths: existingPreservedPaths,
        noticeRequired: true
      };
    }
    return {
      outcome: 'noop',
      activeStorageRoot: canonicalRoot,
      activeDatabasePath: canonicalDbPath,
      activeSourceKind: 'host_global_storage_uri',
      preservedUnselectedPaths: existingPreservedPaths,
      noticeRequired: false
    };
  }

  // Deterministic ranking across all populated candidates.
  const ranked = [...inspectedPopulated].sort(compareCandidatesDeterministic);
  const winner = ranked[0]!;
  const losers = ranked.slice(1);

  // Case 1: Canonical store is the sole populated store -> fast idempotent no-op.
  if (winner.isCanonical && losers.length === 0) {
    if (canonicalDirExists) {
      await unlinkContainedEntry(canonicalScopeDir, path.join(canonicalScopeDir, STAGING_DB_FILENAME));
    }
    return {
      outcome: 'noop',
      activeStorageRoot: canonicalRoot,
      activeDatabasePath: canonicalDbPath,
      activeSourceKind: 'host_global_storage_uri',
      preservedUnselectedPaths: existingPreservedPaths,
      noticeRequired: false
    };
  }

  // Case 2a: Canonical store won a conflict against one or more legacy stores.
  // Leave every losing legacy store completely untouched in place, record receipt, emit notice once.
  if (winner.isCanonical && losers.length > 0) {
    if (!(await request.verifyPrimacy())) {
      throw new RelocationPrimacyLostError('Lost ownership fence before recording conflict receipt');
    }
    const anchorResult = await ensureAnchorWithinRoot(canonicalRoot, ['sqlite', request.scopeId], DIR_MODE);
    if (anchorResult.outcome !== 'ready') {
      throw new Error(`RELOCATION_CANONICAL_ANCHOR_REFUSED:${anchorResult.reason}`);
    }
    const resolvedCanonicalDbPath = path.join(anchorResult.anchor, CANONICAL_DB_FILENAME);
    const ts = nowMs();
    const newEntries: PreservedConflictEntry[] = losers.map((loser) => ({
      databasePath: loser.databasePath,
      origin: 'legacy_in_place',
      fingerprint: loser.fingerprint,
      recordedAtMs: ts
    }));
    const mergedConflicts = mergePreservedConflicts(existingReceipt?.preservedConflicts ?? [], newEntries);
    const receipt: RelocationReceipt = {
      version: 1,
      scopeId: request.scopeId,
      relocatedAtMs: ts,
      winnerSourcePath: resolvedCanonicalDbPath,
      preservedConflicts: mergedConflicts
    };
    await writeAtomicJsonWithinAnchor(anchorResult.anchor, RECEIPT_TMP_FILENAME, RECEIPT_FILENAME, receipt);
    return {
      outcome: 'conflict_resolved',
      activeStorageRoot: path.dirname(path.dirname(anchorResult.anchor)),
      activeDatabasePath: resolvedCanonicalDbPath,
      activeSourceKind: 'host_global_storage_uri',
      winnerSourcePath: resolvedCanonicalDbPath,
      preservedUnselectedPaths: mergedConflicts.map((c) => c.databasePath),
      newlyDiscoveredConflictPaths: newEntries.map((c) => c.databasePath),
      selectionRule: 'last_write_then_run_count_then_canonical_then_path',
      noticeRequired: newEntries.length > 0
    };
  }

  // Case 1b / 2b: A legacy database won and must be relocated to canonicalDbPath.
  // Check network-FS WAL refusal before touching canonical target.
  if (requestedJournalMode === 'wal' && isNetworkFilesystem(request.canonicalFilesystemType)) {
    return {
      outcome: 'fallback_legacy_preserved',
      activeStorageRoot: winner.storageRoot,
      activeDatabasePath: winner.databasePath,
      activeSourceKind: 'host_storage_uri',
      reason: 'network_share_wal_unsupported',
      diagnostic: `Refused SQLite WAL relocation onto network filesystem '${request.canonicalFilesystemType}'; keeping legacy store active in place.`,
      preservedUnselectedPaths: [
        ...existingPreservedPaths,
        ...losers.map((l) => l.databasePath)
      ],
      noticeRequired: true
    };
  }

  // Ensure canonical directory anchor with 0o700; on read-only / permission / symlink refusal,
  // leave the winning legacy store working in place with zero third-location fallback.
  const anchorResult = await ensureAnchorWithinRoot(canonicalRoot, ['sqlite', request.scopeId], DIR_MODE);
  if (anchorResult.outcome === 'refused') {
    const isSymlinkRefusal =
      anchorResult.reason === 'symlink-component' ||
      anchorResult.reason === 'symlink-leaf' ||
      anchorResult.reason === 'reparse-point-leaf' ||
      anchorResult.reason === 'escapes-root';
    return {
      outcome: 'fallback_legacy_preserved',
      activeStorageRoot: winner.storageRoot,
      activeDatabasePath: winner.databasePath,
      activeSourceKind: 'host_storage_uri',
      reason: isSymlinkRefusal ? 'symlink_or_containment_refused' : 'canonical_target_unwritable',
      diagnostic: `Cannot prepare canonical SQLite store (${anchorResult.reason}); keeping legacy store active in place.`,
      preservedUnselectedPaths: [
        ...existingPreservedPaths,
        ...losers.map((l) => l.databasePath)
      ],
      noticeRequired: true
    };
  }

  const canonicalAnchorDir = anchorResult.anchor;
  const resolvedCanonicalDbPath = path.join(canonicalAnchorDir, CANONICAL_DB_FILENAME);

  // Step 1: Stage consistent WAL-preserving copy inside canonicalAnchorDir via read-only VACUUM INTO.
  let stagingPath: string;
  try {
    stagingPath = await vacuumIntoTarget(winner.databasePath, canonicalAnchorDir, STAGING_DB_FILENAME);
  } catch (error) {
    await unlinkContainedEntry(canonicalAnchorDir, path.join(canonicalAnchorDir, STAGING_DB_FILENAME));
    const boundedReason = errnoOf(error) ?? (error instanceof Error ? error.name : 'write_error');
    return {
      outcome: 'fallback_legacy_preserved',
      activeStorageRoot: winner.storageRoot,
      activeDatabasePath: winner.databasePath,
      activeSourceKind: 'host_storage_uri',
      reason: 'canonical_target_unwritable',
      diagnostic: `Cannot stage relocated SQLite store into globalStorage (${boundedReason}); keeping legacy store active in place.`,
      preservedUnselectedPaths: [
        ...existingPreservedPaths,
        ...losers.map((l) => l.databasePath)
      ],
      noticeRequired: true
    };
  }
  await request.onStage?.('after_stage_copy');

  // Step 2: Sync staging file to disk and verify integrity + schema bounds + hash.
  const syncHandle = await openWithinRoot(canonicalAnchorDir, [STAGING_DB_FILENAME], { flags: 'r' });
  if (syncHandle.outcome !== 'opened') {
    await unlinkContainedEntry(canonicalAnchorDir, stagingPath);
    throw new Error(`RELOCATION_STAGE_SYNC_REFUSED:${syncHandle.reason}`);
  }
  let stagedSha256: string;
  try {
    await syncHandle.handle.sync();
    const stagedBytes = await syncHandle.handle.readFile();
    stagedSha256 = createHash('sha256').update(stagedBytes).digest('hex');
  } finally {
    await syncHandle.handle.close().catch(() => undefined);
  }

  const stagedFp = await fingerprintDatabase(stagingPath);
  if (stagedFp === null) {
    await unlinkContainedEntry(canonicalAnchorDir, stagingPath);
    throw new Error('RELOCATION_STAGE_MISSING_AFTER_SYNC');
  }
  const stagedInspection = inspectCandidateReadOnly(
    canonicalRoot,
    stagingPath,
    true,
    stagedFp,
    maxSupportedSchemaVersion
  );
  if (stagedInspection.kind !== 'ok' || !stagedInspection.candidate.populated || stagedInspection.candidate.runCount < winner.runCount) {
    await unlinkContainedEntry(canonicalAnchorDir, stagingPath);
    throw new Error('RELOCATION_STAGE_VERIFICATION_FAILED');
  }
  await request.onStage?.('after_stage_verify');

  // Step 3: Preserve any losing canonical database as a read-only 0o400 sibling before replacing canonicalDbPath.
  const ts = nowMs();
  const preservedConflicts: PreservedConflictEntry[] = [];
  for (const loser of losers) {
    if (loser.isCanonical) {
      const preservedCanonical = await preserveLosingCanonicalReadOnly(canonicalAnchorDir, loser.databasePath, ts);
      preservedConflicts.push(preservedCanonical);
      await request.onStage?.('after_preserve_losing_canonical');
    } else {
      preservedConflicts.push({
        databasePath: loser.databasePath,
        origin: 'legacy_in_place',
        fingerprint: loser.fingerprint,
        recordedAtMs: ts
      });
    }
  }

  // Step 4: Persist crash-recovery journal before atomic publish.
  const journal: RelocationJournal = {
    version: 1,
    scopeId: request.scopeId,
    stagedSha256,
    winnerDatabasePath: winner.databasePath,
    winnerStorageRoot: winner.storageRoot,
    winnerFingerprint: winner.fingerprint,
    preservedConflicts,
    startedAtMs: ts
  };
  await writeAtomicJsonWithinAnchor(canonicalAnchorDir, `${JOURNAL_FILENAME}.tmp`, JOURNAL_FILENAME, journal);
  await request.onStage?.('after_write_journal');

  // Re-verify ownership fence immediately before atomic publish.
  if (!(await request.verifyPrimacy())) {
    await unlinkContainedEntry(canonicalAnchorDir, stagingPath);
    await unlinkContainedEntry(canonicalAnchorDir, path.join(canonicalAnchorDir, JOURNAL_FILENAME));
    throw new RelocationPrimacyLostError('Lost ownership fence before publishing relocated SQLite store');
  }

  // Step 5: Remove stale canonical WAL/SHM sidecars (safe under ownership fence) and atomically publish.
  await unlinkContainedEntry(canonicalAnchorDir, `${resolvedCanonicalDbPath}-wal`);
  await unlinkContainedEntry(canonicalAnchorDir, `${resolvedCanonicalDbPath}-shm`);
  const published = await renameContainedEntry(canonicalAnchorDir, STAGING_DB_FILENAME, CANONICAL_DB_FILENAME);
  if (!published) {
    await unlinkContainedEntry(canonicalAnchorDir, stagingPath);
    await unlinkContainedEntry(canonicalAnchorDir, path.join(canonicalAnchorDir, JOURNAL_FILENAME));
    throw new Error('RELOCATION_ATOMIC_PUBLISH_REFUSED');
  }
  await request.onStage?.('after_atomic_publish');

  // Step 6 & 7: Retire winning legacy store, write receipt, clean up journal.
  return await finishPostPublishStep(
    canonicalAnchorDir,
    resolvedCanonicalDbPath,
    journal,
    existingReceipt,
    nowMs,
    request.onStage
  );
}
