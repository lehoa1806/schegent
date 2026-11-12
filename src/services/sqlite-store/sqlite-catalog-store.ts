/**
 * FR-R6-F04 (F04-C, FR-021, FR-022, SC-011) & FR-R6-F05 (FR-013) — SQLite-backed
 * `CatalogFsPort` implementation and one-time legacy `.schegent/catalog/` import.
 *
 * - Persists canonical catalog manifest and write-once version records in SQLite
 *   (`operational_kv_documents` namespace `catalog-fs:<scopeId>`) while atomically
 *   maintaining relational `definitions`, `definition_versions`, `catalog_heads`,
 *   and `catalog_revisions` rows inside the same `BEGIN IMMEDIATE` transaction.
 * - Imports pre-cutover `.schegent/catalog/` records once on first trusted-primary
 *   cutover without modifying or deleting the legacy directory (preserving it for F05).
 * - Fences post-cutover legacy `.schegent/catalog/` filesystem writes (`not-writable`
 *   in non-primary windows once SQLite authority is active).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 * Zero raw `node:fs` write primitives (docs/hard-rules.md rule 69).
 */

import { createHash } from 'node:crypto';
import type {
  CatalogFsPort,
  FsReadOutcome,
  FsRemoveOutcome,
  FsWriteIfAbsentOutcome,
  FsWriteOutcome,
  StoreSegments,
  StoreWritability
} from '../../catalog/ports';
import type { CatalogManifest } from '../../contracts/catalog-store';
import type { CatalogLayer } from '../../contracts/sqlite-store/state-census';
import { NodeSqliteConnection } from './sqlite-driver';
import type { SqliteApplicationStore } from './index';

function namespaceOf(scopeId: string): string {
  return `catalog-fs:${scopeId}`;
}

function keyOf(segments: StoreSegments): string | null {
  if (segments.length === 0) return '';
  for (const seg of segments) {
    if (
      typeof seg !== 'string' ||
      seg.length === 0 ||
      seg === '.' ||
      seg === '..' ||
      seg.includes('/') ||
      seg.includes('\\')
    ) {
      return null;
    }
  }
  return segments.join('/');
}

function parseLayerSegment(dirSegment: string): CatalogLayer | null {
  if (dirSegment === 'phases') return 'phase';
  if (dirSegment === 'pipelines') return 'pipeline';
  if (dirSegment === 'workflows') return 'workflow';
  return null;
}

function parseVersionNumber(fileName: string): number | null {
  const m = /^v(\d+)\.json$/.exec(fileName);
  if (!m) return null;
  const num = Number(m[1]);
  return Number.isSafeInteger(num) && num >= 1 ? num : null;
}

function syncRelationalCatalogRowInTx(
  conn: NodeSqliteConnection,
  scopeId: string,
  relKey: string,
  contents: string,
  nowMs: number
): void {
  const parts = relKey.split('/');
  if (parts.length === 3) {
    const layer = parseLayerSegment(parts[0]!);
    const slug = parts[1]!;
    const versionNo = parseVersionNumber(parts[2]!);
    if (layer !== null && slug.length > 0 && versionNo !== null) {
      const definitionId = `${scopeId}:${layer}:${slug}`;
      const versionId = `${definitionId}:v${versionNo}`;
      const digestSha256 = createHash('sha256').update(contents, 'utf8').digest('hex');
      let displayName = slug;
      try {
        const parsed = JSON.parse(contents) as { body?: { name?: unknown; id?: unknown } };
        if (typeof parsed.body?.name === 'string' && parsed.body.name.trim().length > 0) {
          displayName = parsed.body.name.trim();
        }
      } catch {
        // Keep slug fallback if body is opaque.
      }
      conn.run(
        `INSERT INTO definitions (definition_id, scope, layer, slug, display_name, created_at_ms)
         VALUES (?, 'workspace', ?, ?, ?, ?)
         ON CONFLICT(scope, layer, slug) DO UPDATE SET display_name = excluded.display_name`,
        definitionId,
        layer,
        slug,
        displayName,
        nowMs
      );
      const actualDef = conn.get<{ definition_id: string }>(
        `SELECT definition_id FROM definitions WHERE scope = 'workspace' AND layer = ? AND slug = ?`,
        layer,
        slug
      );
      const effectiveDefId = actualDef?.definition_id ?? definitionId;
      conn.run(
        `INSERT INTO definition_versions (
          definition_version_id, definition_id, version_number, status, canonical_yaml, digest_sha256, schema_version, created_at_ms
        ) VALUES (?, ?, ?, 'draft', ?, ?, 1, ?)
        ON CONFLICT(definition_id, version_number) DO NOTHING`,
        versionId,
        effectiveDefId,
        versionNo,
        contents,
        digestSha256,
        nowMs
      );
    }
    return;
  }

  if (relKey === 'manifest.json') {
    let manifest: Partial<CatalogManifest>;
    try {
      manifest = JSON.parse(contents) as Partial<CatalogManifest>;
    } catch {
      return;
    }
    if (!Array.isArray(manifest.entries)) return;

    for (const entry of manifest.entries) {
      if (!entry || typeof entry !== 'object') continue;
      const layer: CatalogLayer | null =
        entry.kind === 'phase' || entry.kind === 'pipeline' || entry.kind === 'workflow'
          ? entry.kind
          : null;
      if (!layer || typeof entry.id !== 'string' || entry.id.length === 0) continue;

      const actualDef = conn.get<{ definition_id: string }>(
        `SELECT definition_id FROM definitions WHERE scope = 'workspace' AND layer = ? AND slug = ?`,
        layer,
        entry.id
      );
      if (!actualDef) continue;

      const findVersionRowId = (verStr: string | null | undefined): string | null => {
        if (typeof verStr !== 'string') return null;
        const m = /^v(\d+)$/.exec(verStr);
        if (!m) return null;
        const vNum = Number(m[1]);
        const row = conn.get<{ definition_version_id: string }>(
          `SELECT definition_version_id FROM definition_versions WHERE definition_id = ? AND version_number = ?`,
          actualDef.definition_id,
          vNum
        );
        return row?.definition_version_id ?? null;
      };

      const pubRowId = findVersionRowId(entry.activeVersion);
      const draftRowId = findVersionRowId(entry.draftVersion);
      if (pubRowId !== null) {
        conn.run(
          `UPDATE definition_versions SET status = 'published' WHERE definition_version_id = ?`,
          pubRowId
        );
      }

      conn.run(
        `INSERT INTO catalog_heads (
          definition_id, published_version_id, draft_version_id, revision, updated_at_ms
        ) VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(definition_id) DO UPDATE SET
          published_version_id = excluded.published_version_id,
          draft_version_id = excluded.draft_version_id,
          revision = catalog_heads.revision + 1,
          updated_at_ms = excluded.updated_at_ms`,
        actualDef.definition_id,
        pubRowId,
        draftRowId,
        nowMs
      );
    }

    conn.run(
      `INSERT INTO catalog_revisions (scope, revision, updated_at_ms)
       VALUES ('workspace', 1, ?)
       ON CONFLICT(scope) DO UPDATE SET
         revision = catalog_revisions.revision + 1,
         updated_at_ms = excluded.updated_at_ms`,
      nowMs
    );
    conn.run(
      `INSERT INTO catalog_revisions (scope, revision, updated_at_ms)
       VALUES ('combined', 1, ?)
       ON CONFLICT(scope) DO UPDATE SET
         revision = catalog_revisions.revision + 1,
         updated_at_ms = excluded.updated_at_ms`,
      nowMs
    );
  }
}

export async function importLegacyCatalogIntoSqlite(
  store: SqliteApplicationStore,
  scopeId: string,
  legacyFs: CatalogFsPort,
  nowMs: () => number = () => Date.now()
): Promise<{ readonly importedFiles: number; readonly alreadyInitialized: boolean }> {
  const ns = namespaceOf(scopeId);
  const conn = store.writerConnection;
  const existingCount = Number(
    conn.scalar(
      `SELECT COUNT(*) FROM operational_kv_documents WHERE doc_namespace = ?`,
      ns
    ) ?? 0
  );
  if (existingCount > 0) {
    return { importedFiles: 0, alreadyInitialized: true };
  }

  const collected: Array<{ readonly relKey: string; readonly contents: string }> = [];
  const manifestRead = await legacyFs.readFile(['manifest.json']);
  if (manifestRead.outcome === 'read') {
    for (const kindDir of ['phases', 'pipelines', 'workflows'] as const) {
      const ids = await legacyFs.listDirectory([kindDir]);
      for (const id of ids) {
        const files = await legacyFs.listDirectory([kindDir, id]);
        for (const file of files) {
          const verRead = await legacyFs.readFile([kindDir, id, file]);
          if (verRead.outcome === 'read') {
            collected.push({ relKey: `${kindDir}/${id}/${file}`, contents: verRead.contents });
          }
        }
      }
    }
    // Import version files first so manifest sync finds matching `definition_versions`.
    collected.push({ relKey: 'manifest.json', contents: manifestRead.contents });
  }

  if (collected.length === 0) {
    return { importedFiles: 0, alreadyInitialized: false };
  }

  const now = nowMs();
  conn.exec('BEGIN IMMEDIATE');
  try {
    for (const item of collected) {
      const bytes = Buffer.byteLength(item.contents, 'utf8');
      conn.run(
        `INSERT INTO operational_kv_documents (
          doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
        ) VALUES (?, ?, 1, 1, ?, ?, 0, ?)
        ON CONFLICT(doc_namespace, doc_key) DO NOTHING`,
        ns,
        item.relKey,
        item.contents,
        bytes,
        now
      );
      syncRelationalCatalogRowInTx(conn, scopeId, item.relKey, item.contents, now);
    }
    conn.exec('COMMIT');
  } catch (error) {
    try {
      conn.exec('ROLLBACK');
    } catch {
      // Ignore
    }
    throw error;
  }

  return { importedFiles: collected.length, alreadyInitialized: false };
}

export class SqliteCatalogFsAdapter implements CatalogFsPort {
  private readonly ns: string;

  public constructor(
    private readonly store: SqliteApplicationStore,
    private readonly scopeId: string,
    private readonly hasWorkspace: () => boolean = () => true,
    private readonly nowMs: () => number = () => Date.now()
  ) {
    this.ns = namespaceOf(scopeId);
  }

  public async readFile(at: StoreSegments): Promise<FsReadOutcome> {
    if (!this.hasWorkspace()) return { outcome: 'absent' };
    const relKey = keyOf(at);
    if (relKey === null || relKey.length === 0) {
      return { outcome: 'failed', errno: 'EINVAL' };
    }
    try {
      const row = this.store.writerConnection.get<{ payload_json: string }>(
        `SELECT payload_json FROM operational_kv_documents WHERE doc_namespace = ? AND doc_key = ?`,
        this.ns,
        relKey
      );
      if (!row) return { outcome: 'absent' };
      return { outcome: 'read', contents: row.payload_json };
    } catch {
      return { outcome: 'failed', errno: 'EIO' };
    }
  }

  public async writeFileAtomic(at: StoreSegments, contents: string): Promise<FsWriteOutcome> {
    if (!this.hasWorkspace()) return { outcome: 'failed', errno: 'ENOENT' };
    const relKey = keyOf(at);
    if (relKey === null || relKey.length === 0) {
      return { outcome: 'failed', errno: 'EINVAL' };
    }
    const conn = this.store.writerConnection;
    const now = this.nowMs();
    const bytes = Buffer.byteLength(contents, 'utf8');
    conn.exec('BEGIN IMMEDIATE');
    try {
      conn.run(
        `INSERT INTO operational_kv_documents (
          doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
        ) VALUES (?, ?, 1, 1, ?, ?, 0, ?)
        ON CONFLICT(doc_namespace, doc_key) DO UPDATE SET
          revision = operational_kv_documents.revision + 1,
          payload_json = excluded.payload_json,
          payload_bytes = excluded.payload_bytes,
          updated_at_ms = excluded.updated_at_ms`,
        this.ns,
        relKey,
        contents,
        bytes,
        now
      );
      syncRelationalCatalogRowInTx(conn, this.scopeId, relKey, contents, now);
      conn.exec('COMMIT');
      return { outcome: 'written' };
    } catch {
      try {
        conn.exec('ROLLBACK');
      } catch {
        // Ignore
      }
      return { outcome: 'failed', errno: 'EIO' };
    }
  }

  public async writeFileIfAbsent(
    at: StoreSegments,
    contents: string
  ): Promise<FsWriteIfAbsentOutcome> {
    if (!this.hasWorkspace()) return { outcome: 'failed', errno: 'ENOENT' };
    const relKey = keyOf(at);
    if (relKey === null || relKey.length === 0) {
      return { outcome: 'failed', errno: 'EINVAL' };
    }
    const conn = this.store.writerConnection;
    const now = this.nowMs();
    const bytes = Buffer.byteLength(contents, 'utf8');
    conn.exec('BEGIN IMMEDIATE');
    try {
      const existing = conn.get<{ doc_key: string }>(
        `SELECT doc_key FROM operational_kv_documents WHERE doc_namespace = ? AND doc_key = ?`,
        this.ns,
        relKey
      );
      if (existing) {
        conn.exec('COMMIT');
        return { outcome: 'exists' };
      }
      conn.run(
        `INSERT INTO operational_kv_documents (
          doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
        ) VALUES (?, ?, 1, 1, ?, ?, 0, ?)`,
        this.ns,
        relKey,
        contents,
        bytes,
        now
      );
      syncRelationalCatalogRowInTx(conn, this.scopeId, relKey, contents, now);
      conn.exec('COMMIT');
      return { outcome: 'written' };
    } catch {
      try {
        conn.exec('ROLLBACK');
      } catch {
        // Ignore
      }
      return { outcome: 'failed', errno: 'EIO' };
    }
  }

  public async listDirectory(at: StoreSegments): Promise<readonly string[]> {
    if (!this.hasWorkspace()) return [];
    const prefixKey = keyOf(at);
    if (prefixKey === null) return [];
    const prefix = prefixKey.length === 0 ? '' : `${prefixKey}/`;
    try {
      const rows = this.store.writerConnection.all<{ doc_key: string }>(
        `SELECT doc_key FROM operational_kv_documents WHERE doc_namespace = ? AND doc_key LIKE ?`,
        this.ns,
        `${prefix}%`
      );
      const children = new Set<string>();
      for (const row of rows) {
        if (!row.doc_key.startsWith(prefix)) continue;
        const remainder = row.doc_key.slice(prefix.length);
        if (remainder.length === 0) continue;
        const slashIdx = remainder.indexOf('/');
        children.add(slashIdx === -1 ? remainder : remainder.slice(0, slashIdx));
      }
      return [...children].sort();
    } catch {
      return [];
    }
  }

  public async removeFile(at: StoreSegments): Promise<FsRemoveOutcome> {
    if (!this.hasWorkspace()) return { outcome: 'absent' };
    const relKey = keyOf(at);
    if (relKey === null || relKey.length === 0) {
      return { outcome: 'failed', errno: 'EINVAL' };
    }
    const conn = this.store.writerConnection;
    conn.exec('BEGIN IMMEDIATE');
    try {
      const res = conn.run(
        `DELETE FROM operational_kv_documents WHERE doc_namespace = ? AND doc_key = ?`,
        this.ns,
        relKey
      );
      conn.exec('COMMIT');
      return { outcome: res.changes > 0 ? 'removed' : 'absent' };
    } catch {
      try {
        conn.exec('ROLLBACK');
      } catch {
        // Ignore
      }
      return { outcome: 'failed', errno: 'EIO' };
    }
  }

  public async checkWritability(): Promise<StoreWritability> {
    if (!this.hasWorkspace()) return 'no-workspace';
    return 'writable';
  }
}

export interface SwitchableCatalogFsAdapter extends CatalogFsPort {
  attachSqlite(
    store: SqliteApplicationStore,
    scopeId: string,
    nowMs?: () => number
  ): Promise<SqliteCatalogFsAdapter>;
  attachReadOnlySnapshotIfPresent(databasePath: string, scopeId: string): boolean;
  detachSqlite(): void;
  isSqliteAttached(): boolean;
}

export function createSwitchableCatalogFsAdapter(
  legacyFs: CatalogFsPort,
  hasWorkspace: () => boolean = () => true
): SwitchableCatalogFsAdapter {
  let sqliteAdapter: SqliteCatalogFsAdapter | null = null;
  let readOnlyFiles: Map<string, string> | null = null;
  let postCutoverActive = false;

  return {
    async readFile(at: StoreSegments): Promise<FsReadOutcome> {
      if (sqliteAdapter !== null) return sqliteAdapter.readFile(at);
      if (readOnlyFiles !== null) {
        const relKey = keyOf(at);
        if (relKey === null || relKey.length === 0) return { outcome: 'failed', errno: 'EINVAL' };
        const contents = readOnlyFiles.get(relKey);
        return contents === undefined ? { outcome: 'absent' } : { outcome: 'read', contents };
      }
      return legacyFs.readFile(at);
    },

    async writeFileAtomic(at: StoreSegments, contents: string): Promise<FsWriteOutcome> {
      if (sqliteAdapter !== null) return sqliteAdapter.writeFileAtomic(at, contents);
      if (postCutoverActive) return { outcome: 'failed', errno: 'EROFS' };
      return legacyFs.writeFileAtomic(at, contents);
    },

    async writeFileIfAbsent(at: StoreSegments, contents: string): Promise<FsWriteIfAbsentOutcome> {
      if (sqliteAdapter !== null) return sqliteAdapter.writeFileIfAbsent(at, contents);
      if (postCutoverActive) return { outcome: 'failed', errno: 'EROFS' };
      return legacyFs.writeFileIfAbsent(at, contents);
    },

    async listDirectory(at: StoreSegments): Promise<readonly string[]> {
      if (sqliteAdapter !== null) return sqliteAdapter.listDirectory(at);
      if (readOnlyFiles !== null) {
        const prefixKey = keyOf(at);
        if (prefixKey === null) return [];
        const prefix = prefixKey.length === 0 ? '' : `${prefixKey}/`;
        const children = new Set<string>();
        for (const k of readOnlyFiles.keys()) {
          if (!k.startsWith(prefix)) continue;
          const rem = k.slice(prefix.length);
          if (rem.length === 0) continue;
          const idx = rem.indexOf('/');
          children.add(idx === -1 ? rem : rem.slice(0, idx));
        }
        return [...children].sort();
      }
      return legacyFs.listDirectory(at);
    },

    async removeFile(at: StoreSegments): Promise<FsRemoveOutcome> {
      if (sqliteAdapter !== null) return sqliteAdapter.removeFile(at);
      if (postCutoverActive) return { outcome: 'failed', errno: 'EROFS' };
      return legacyFs.removeFile(at);
    },

    async checkWritability(): Promise<StoreWritability> {
      if (!hasWorkspace()) return 'no-workspace';
      if (sqliteAdapter !== null) return sqliteAdapter.checkWritability();
      if (postCutoverActive) return 'not-writable';
      return legacyFs.checkWritability();
    },

    async attachSqlite(
      store: SqliteApplicationStore,
      scopeId: string,
      nowMs: () => number = () => Date.now()
    ): Promise<SqliteCatalogFsAdapter> {
      await importLegacyCatalogIntoSqlite(store, scopeId, legacyFs, nowMs);
      readOnlyFiles = null;
      sqliteAdapter = new SqliteCatalogFsAdapter(store, scopeId, hasWorkspace, nowMs);
      postCutoverActive = true;
      return sqliteAdapter;
    },

    attachReadOnlySnapshotIfPresent(databasePath: string, scopeId: string): boolean {
      if (sqliteAdapter !== null) return true;
      let roConn: NodeSqliteConnection | null = null;
      try {
        roConn = new NodeSqliteConnection({ databasePath, readOnly: true });
        const sentinel = roConn.get<{ authority: string }>(
          `SELECT authority FROM cutover_sentinel WHERE scope_id = ?`,
          scopeId
        );
        if (!sentinel || (sentinel.authority !== 'sqlite' && sentinel.authority !== 'retired_legacy')) {
          return false;
        }
        const rows = roConn.all<{ doc_key: string; payload_json: string }>(
          `SELECT doc_key, payload_json FROM operational_kv_documents WHERE doc_namespace = ?`,
          namespaceOf(scopeId)
        );
        const files = new Map<string, string>();
        for (const row of rows) {
          files.set(row.doc_key, row.payload_json);
        }
        readOnlyFiles = files;
        postCutoverActive = true;
        return true;
      } catch {
        return false;
      } finally {
        roConn?.close();
      }
    },

    detachSqlite(): void {
      sqliteAdapter = null;
    },

    isSqliteAttached(): boolean {
      return sqliteAdapter !== null;
    }
  };
}

