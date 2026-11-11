import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteApplicationStore, createSwitchableCatalogFsAdapter } from '../../../src/services/sqlite-store';
import {
  CONNECTED_RUNS_CACHE_MAX,
  PostCutoverMementoWriteForbiddenError,
  createSwitchableOperationalMemento
} from '../../../src/state/sqlite-operational-backing';
import { KEYS, type Memento } from '../../../src/state/workspace-state';
import type { ConnectedWorkflowRun } from '../../../src/state/connected-workflow-run';
import type { CatalogFsPort } from '../../../src/catalog/ports';

function createMemoryMemento(initial: Record<string, unknown> = {}): Memento & { writes: number } {
  const map = new Map<string, unknown>(Object.entries(initial));
  return {
    writes: 0,
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      this.writes += 1;
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    }
  };
}

function createMemoryCatalogFs(files: Record<string, string>): CatalogFsPort & { writes: number } {
  const map = new Map<string, string>(Object.entries(files));
  return {
    writes: 0,
    async readFile(at) {
      const k = at.join('/');
      const v = map.get(k);
      return v === undefined ? { outcome: 'absent' } : { outcome: 'read', contents: v };
    },
    async writeFileAtomic(at, contents) {
      this.writes += 1;
      map.set(at.join('/'), contents);
      return { outcome: 'written' };
    },
    async writeFileIfAbsent(at, contents) {
      const k = at.join('/');
      if (map.has(k)) return { outcome: 'exists' };
      this.writes += 1;
      map.set(k, contents);
      return { outcome: 'written' };
    },
    async listDirectory(at) {
      const prefix = at.length === 0 ? '' : `${at.join('/')}/`;
      const out = new Set<string>();
      for (const k of map.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rem = k.slice(prefix.length);
        if (!rem) continue;
        const slash = rem.indexOf('/');
        out.add(slash === -1 ? rem : rem.slice(0, slash));
      }
      return [...out].sort();
    },
    async removeFile(at) {
      const existed = map.delete(at.join('/'));
      return { outcome: existed ? 'removed' : 'absent' };
    },
    async checkWritability() {
      return 'writable';
    }
  };
}

describe('SQLite operational & catalog cutover backing (FR-R6-F04 & FR-R6-F03)', () => {
  it('migrates legacy Memento once through retain-source, commits atomically to SQLite, and fences post-cutover Memento writes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'schegent-sqlite-backing-'));
    try {
      const dbPath = join(tempDir, 'schegent-state.db');
      const legacy = createMemoryMemento({
        [KEYS.schemaVersion]: 14,
        [KEYS.run]: {
          default: {
            id: 'run-legacy-1',
            featureId: 'feat-1',
            featureDir: 'specs/001-feat',
            status: 'paused',
            currentPhase: 'implement',
            currentIteration: 2,
            startedAt: 1_700_000_000_000,
            lastTransitionAt: 1_700_000_050_000,
            phasesCompleted: [],
            lastError: null
          }
        }
      });

      const switchable = createSwitchableOperationalMemento(legacy);
      const sqliteStore = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });

      const backing = switchable.attachSqlite(sqliteStore, 'scope-alpha', () => 1_700_000_100_000);
      expect(backing.migrationOutcome?.completed).toBe(true);
      expect(sqliteStore.cutoverGuard.getSentinel('scope-alpha')?.authority).toBe('sqlite');
      expect(legacy.writes).toBe(0);

      // Imported state is readable from SQLite
      const importedRuns = switchable.get<Record<string, { id: string }>>(KEYS.run);
      expect(importedRuns?.default?.id).toBe('run-legacy-1');

      // Relational projection in `runs` table exists
      const sqlRun = sqliteStore.writerConnection.get<{ run_id: string; status: string }>(
        `SELECT run_id, status FROM runs WHERE run_id = ?`,
        'run-legacy-1'
      );
      expect(sqlRun).toEqual({ run_id: 'run-legacy-1', status: 'paused' });

      // Post-cutover write commits to SQLite without touching legacy Memento
      await switchable.update(KEYS.queueDefaultId, 'alpha');
      expect(legacy.writes).toBe(0);

      // If detached after cutover (e.g., lost primacy), legacy Memento writes are strictly refused
      switchable.detachSqlite();
      await expect(switchable.update(KEYS.queueDefaultId, 'beta')).rejects.toBeInstanceOf(
        PostCutoverMementoWriteForbiddenError
      );

      // Read-only snapshot inspection in an untrusted / non-primary window succeeds without mutating
      const follower = createSwitchableOperationalMemento(createMemoryMemento());
      expect(follower.attachReadOnlySnapshotIfPresent(dbPath, 'scope-alpha')).toBe(true);
      expect(follower.get<string>(KEYS.queueDefaultId)).toBe('alpha');
      await expect(follower.update(KEYS.queueDefaultId, 'beta')).rejects.toBeInstanceOf(
        PostCutoverMementoWriteForbiddenError
      );

      sqliteStore.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('prunes terminal connectedRuns at CONNECTED_RUNS_CACHE_MAX (512) while preserving every non-terminal run (F03)', async () => {
    const sqliteStore = SqliteApplicationStore.openInMemory();
    try {
      const switchable = createSwitchableOperationalMemento(createMemoryMemento());
      const now = 1_800_000_000_000;
      switchable.attachSqlite(sqliteStore, 'scope-bounds', () => now);

      const connectedMap: Record<string, ConnectedWorkflowRun> = {};
      // 3 non-terminal runs (pendingHandoff set)
      for (let i = 0; i < 3; i += 1) {
        const id = `active-wf-${i}`;
        connectedMap[id] = {
          connectedRunId: id,
          workflowId: 'wf-main',
          graph: {} as unknown as ConnectedWorkflowRun['graph'],
          pipelines: {},
          revision: 1,
          startedAt: now - 10_000,
          nodes: {},
          decisions: [],
          pendingHandoff: {
            fromNodeId: 'n1',
            toNodeId: 'n2',
            pausedAt: now - 5_000
          } as unknown as ConnectedWorkflowRun['pendingHandoff']
        };
      }
      // 600 terminal runs
      for (let i = 0; i < 600; i += 1) {
        const id = `term-wf-${String(i).padStart(4, '0')}`;
        connectedMap[id] = {
          connectedRunId: id,
          workflowId: 'wf-main',
          graph: {} as unknown as ConnectedWorkflowRun['graph'],
          pipelines: {},
          revision: 1,
          startedAt: now - (600 - i) * 1_000,
          nodes: {},
          decisions: [],
          invocations: {
            root: {
              invocationId: 'root',
              parentInvocationId: null,
              status: 'completed',
              startedAt: now - (600 - i) * 1_000,
              completedAt: now - (600 - i) * 500
            } as unknown as NonNullable<ConnectedWorkflowRun['invocations']>[string]
          }
        };
      }

      await switchable.update(KEYS.connectedRuns, connectedMap);
      const stored = switchable.get<Record<string, ConnectedWorkflowRun>>(KEYS.connectedRuns)!;
      const keys = Object.keys(stored);
      expect(keys.length).toBe(CONNECTED_RUNS_CACHE_MAX);
      expect(stored['active-wf-0']).toBeDefined();
      expect(stored['active-wf-1']).toBeDefined();
      expect(stored['active-wf-2']).toBeDefined();
      // Newest terminal run kept, oldest evicted
      expect(stored['term-wf-0599']).toBeDefined();
      expect(stored['term-wf-0000']).toBeUndefined();
    } finally {
      sqliteStore.close();
    }
  });

  it('imports legacy .schegent/catalog into SQLite once and syncs relational definitions/versions/heads', async () => {
    const sqliteStore = SqliteApplicationStore.openInMemory();
    try {
      const v1Json = JSON.stringify({
        schemaVersion: 1,
        kind: 'phase',
        id: 'specify',
        version: 'v1',
        createdAt: 1_700_000_000_000,
        digest: 'sha256:' + 'a'.repeat(64),
        body: { id: 'specify', name: 'Specify Phase' }
      });
      const manifestJson = JSON.stringify({
        schemaVersion: 1,
        entries: [{ kind: 'phase', id: 'specify', activeVersion: 'v1', draftVersion: null }]
      });
      const legacyCatalog = createMemoryCatalogFs({
        'phases/specify/v1.json': v1Json,
        'manifest.json': manifestJson
      });

      const switchableCatalog = createSwitchableCatalogFsAdapter(legacyCatalog);
      await switchableCatalog.attachSqlite(sqliteStore, 'scope-cat');

      expect(legacyCatalog.writes).toBe(0);
      const readBack = await switchableCatalog.readFile(['phases', 'specify', 'v1.json']);
      expect(readBack).toEqual({ outcome: 'read', contents: v1Json });

      const defRow = sqliteStore.writerConnection.get<{ slug: string; display_name: string }>(
        `SELECT slug, display_name FROM definitions WHERE layer = 'phase' AND slug = 'specify'`
      );
      expect(defRow).toEqual({ slug: 'specify', display_name: 'Specify Phase' });

      const headRow = sqliteStore.writerConnection.get<{ revision: number }>(
        `SELECT ch.revision FROM catalog_heads ch JOIN definitions d ON d.definition_id = ch.definition_id WHERE d.slug = 'specify'`
      );
      expect(headRow?.revision).toBe(1);
    } finally {
      sqliteStore.close();
    }
  });
});
