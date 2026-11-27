/**
 * Post-merge review Finding 3 — file-backed SQLite double-reopen verification
 * for the terminal-transition settlement journal (`KEYS.terminalTransitionIntent`).
 *
 * Proves:
 *   1. Mixed-version journal (readable v1 + future v2 entry): healthy sibling
 *      replay, independent sibling save/clear, and double SQLite reopen preserve
 *      the future entry's exact bytes while logging an operator-visible warning.
 *   2. Corrupt SQLite JSON envelope: primary and read-only SQLite views expose
 *      `unreadable-envelope`, replay logs an operator-visible warning and refuses,
 *      writes refuse with `terminal-journal-corrupt`, and raw SQLite bytes +
 *      revision stay intact across double reopen.
 *   3. Unsupported top-level single-intent envelope (`schemaVersion: 2`): refused
 *      without altering SQLite bytes or revision across double reopen.
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SanitizedLogger } from '../../src/lib/logger';
import { SqliteApplicationStore } from '../../src/services/sqlite-store';
import { TerminalTransitionCoordinator } from '../../src/services/terminal-transition-coordinator';
import { createSwitchableOperationalMemento } from '../../src/state/sqlite-operational-backing';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { KEYS } from '../../src/state/workspace-state-types';
import type { TerminalTransitionIntent, WorkflowRun } from '../../src/state/workflow-run';
import { removeTempRoot } from '../temp-root-cleanup';

const SCOPE_ID = 'ws-terminal-journal-test';

function createMemoryMemento(): Memento {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return map.has(key) ? (map.get(key) as T) : defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) map.delete(key);
      else map.set(key, structuredClone(value));
    }
  };
}

function makeTerminalRun(id: string, featureId: string): WorkflowRun {
  return {
    id,
    featureId,
    featureDir: '',
    status: 'completed',
    currentPhase: 'done',
    currentIteration: 1,
    startedAt: 1_700_000_000_000,
    lastTransitionAt: 1_700_000_001_000,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null
  };
}

function makeIntent(runId: string, featureId: string, createdAt: number): TerminalTransitionIntent {
  return {
    schemaVersion: 1,
    run: makeTerminalRun(runId, featureId),
    createdAt,
    description: `finish ${featureId}`
  };
}

describe('Post-merge review Finding 3 — terminal transition journal SQLite preservation', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      await removeTempRoot(dir);
    }
  });

  async function makeDbPath(): Promise<string> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'schegent-terminal-journal-'));
    tempDirs.push(dir);
    return path.join(dir, 'schegent-state.db');
  }

  function openAttachedStore(dbPath: string, logger: SanitizedLogger): {
    sqlite: SqliteApplicationStore;
    store: WorkspaceStateStore;
  } {
    const sqlite = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    const switchable = createSwitchableOperationalMemento(createMemoryMemento(), logger);
    switchable.attachSqlite(sqlite, SCOPE_ID);
    const store = new WorkspaceStateStore(switchable, logger);
    return { sqlite, store };
  }

  function readRawJournalRow(dbPath: string): { payload_json: string; revision: number } | undefined {
    const sqlite = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    try {
      return sqlite.writerConnection.get<{ payload_json: string; revision: number }>(
        `SELECT payload_json, revision FROM operational_kv_documents WHERE doc_namespace = ? AND doc_key = ?`,
        SCOPE_ID,
        KEYS.terminalTransitionIntent
      );
    } finally {
      sqlite.close();
    }
  }

  it('preserves a future-version entry across sibling replay, independent sibling write/clear, and double SQLite reopen', async () => {
    const dbPath = await makeDbPath();
    const futureEntry = {
      schemaVersion: 2,
      run: { id: 'run-v2-future', status: 'completed' },
      createdAt: 1_700_000_005_000,
      newSettlementContract: { token: 'opaque-v2-payload' }
    };

    // Initial session: attach SQLite and write mixed v1 + v2 journal row.
    {
      const logger = new SanitizedLogger();
      const { sqlite, store } = openAttachedStore(dbPath, logger);
      await store.setTerminalTransitionIntent('run-v1', makeIntent('run-v1', 'task-v1', 100));
      const mixedPayload = JSON.stringify({
        'run-v1': makeIntent('run-v1', 'task-v1', 100),
        'run-v2-future': futureEntry
      });
      sqlite.writerConnection.run(
        `UPDATE operational_kv_documents SET payload_json = ?, payload_bytes = ? WHERE doc_namespace = ? AND doc_key = ?`,
        mixedPayload,
        Buffer.byteLength(mixedPayload, 'utf8'),
        SCOPE_ID,
        KEYS.terminalTransitionIntent
      );
      sqlite.close();
    }

    // Reopen #1: inspect degraded status, replay readable sibling, and perform another sibling save + clear.
    const warnings: string[] = [];
    {
      const logger = new SanitizedLogger();
      vi.spyOn(logger, 'warn').mockImplementation((message: string) => {
        warnings.push(message);
      });
      const { sqlite, store } = openAttachedStore(dbPath, logger);

      expect(store.inspectTerminalTransitionJournal()).toMatchObject({
        status: 'degraded',
        readableCount: 1,
        preservedCount: 1,
        preservedRunIds: ['run-v2-future'],
        diagnostics: [{ runId: 'run-v2-future', reason: 'unsupported-schema-version' }]
      });

      const finishedTasks: string[] = [];
      const coordinator = new TerminalTransitionCoordinator(
        store,
        {
          finish: async (featureId) => {
            finishedTasks.push(featureId);
            return { ok: true };
          }
        },
        {
          record: async () => ({ outcome: 'recorded' as const })
        },
        logger
      );
      await coordinator.replay();

      // Readable sibling cleared after replay; future entry remains preserved.
      expect(store.getTerminalTransitionIntents()).toEqual({});
      expect(warnings.some((line) => line.includes('run-v2-future') && line.includes('unsupported-schema-version'))).toBe(
        true
      );

      // Independent healthy sibling write + clear on another run.
      await store.setTerminalTransitionIntent('run-v3', makeIntent('run-v3', 'task-v3', 300));
      expect(Object.keys(store.getTerminalTransitionIntents())).toEqual(['run-v3']);
      await store.setTerminalTransitionIntent('run-v3', null);
      expect(store.getTerminalTransitionIntents()).toEqual({});
      sqlite.close();
    }

    // Reopen #2: primary + read-only views and raw SQLite row all retain `run-v2-future` intact.
    {
      const row = readRawJournalRow(dbPath);
      expect(row).toBeDefined();
      expect(JSON.parse(row!.payload_json)).toEqual({ 'run-v2-future': futureEntry });

      const logger = new SanitizedLogger();
      const { sqlite, store } = openAttachedStore(dbPath, logger);
      expect(store.getTerminalTransitionIntents()).toEqual({});
      expect(store.inspectTerminalTransitionJournal()).toMatchObject({
        status: 'degraded',
        readableCount: 0,
        preservedCount: 1,
        preservedRunIds: ['run-v2-future']
      });
      sqlite.close();

      // Read-only snapshot view also detects the preserved future entry.
      const roMemento = createSwitchableOperationalMemento(createMemoryMemento(), logger);
      expect(roMemento.attachReadOnlySnapshotIfPresent(dbPath, SCOPE_ID)).toBe(true);
      const roStore = new WorkspaceStateStore(roMemento, logger);
      expect(roStore.inspectTerminalTransitionJournal()).toMatchObject({
        status: 'degraded',
        preservedCount: 1,
        preservedRunIds: ['run-v2-future']
      });
    }
  });

  it('refuses journal writes and replay on a corrupt SQLite JSON envelope and preserves raw bytes and revision across double reopen', async () => {
    const dbPath = await makeDbPath();
    const corruptBytes = '{not-valid-json-settlement-journal';
    let originalRevision = 0;

    {
      const logger = new SanitizedLogger();
      const { sqlite, store } = openAttachedStore(dbPath, logger);
      await store.setTerminalTransitionIntent('run-seed', makeIntent('run-seed', 'task-seed', 10));
      sqlite.writerConnection.run(
        `UPDATE operational_kv_documents SET payload_json = ?, payload_bytes = ? WHERE doc_namespace = ? AND doc_key = ?`,
        corruptBytes,
        Buffer.byteLength(corruptBytes, 'utf8'),
        SCOPE_ID,
        KEYS.terminalTransitionIntent
      );
      sqlite.close();
      originalRevision = readRawJournalRow(dbPath)!.revision;
    }

    // Reopen #1: primary detects unreadable envelope, warns during replay, and refuses new writes.
    {
      const warnings: string[] = [];
      const logger = new SanitizedLogger();
      vi.spyOn(logger, 'warn').mockImplementation((message: string) => {
        warnings.push(message);
      });
      const { sqlite, store } = openAttachedStore(dbPath, logger);

      expect(store.getTerminalTransitionIntents()).toEqual({});
      expect(store.inspectTerminalTransitionJournal()).toMatchObject({
        status: 'unreadable-envelope',
        envelopeReason: 'corrupt-envelope'
      });

      const finish = vi.fn(async () => ({ ok: true }));
      const coordinator = new TerminalTransitionCoordinator(
        store,
        { finish },
        { record: async () => ({ outcome: 'recorded' as const }) },
        logger
      );
      await coordinator.replay();
      expect(finish).not.toHaveBeenCalled();
      expect(warnings.some((line) => line.includes('unreadable') && line.includes('preserved in place'))).toBe(true);

      await expect(
        store.setTerminalTransitionIntent('run-healthy', makeIntent('run-healthy', 'task-healthy', 20))
      ).rejects.toMatchObject({ reason: 'terminal-journal-corrupt' });
      sqlite.close();
    }

    // Reopen #2: original corrupt SQLite bytes and revision remain untouched; read-only view also flags unreadable.
    {
      const row = readRawJournalRow(dbPath);
      expect(row).toEqual({ payload_json: corruptBytes, revision: originalRevision });

      const logger = new SanitizedLogger();
      const roMemento = createSwitchableOperationalMemento(createMemoryMemento(), logger);
      expect(roMemento.attachReadOnlySnapshotIfPresent(dbPath, SCOPE_ID)).toBe(true);
      const roStore = new WorkspaceStateStore(roMemento, logger);
      expect(roStore.inspectTerminalTransitionJournal()).toMatchObject({
        status: 'unreadable-envelope',
        envelopeReason: 'corrupt-envelope'
      });
    }
  });

  it('refuses writes on an unsupported top-level single-intent envelope (schemaVersion: 2) and preserves original SQLite bytes across double reopen', async () => {
    const dbPath = await makeDbPath();
    const futureEnvelope = JSON.stringify({
      schemaVersion: 2,
      run: { id: 'run-top-v2' },
      createdAt: 1_700_000_010_000
    });
    let originalRevision = 0;

    {
      const logger = new SanitizedLogger();
      const { sqlite, store } = openAttachedStore(dbPath, logger);
      await store.setTerminalTransitionIntent('run-seed', makeIntent('run-seed', 'task-seed', 10));
      sqlite.writerConnection.run(
        `UPDATE operational_kv_documents SET payload_json = ?, payload_bytes = ? WHERE doc_namespace = ? AND doc_key = ?`,
        futureEnvelope,
        Buffer.byteLength(futureEnvelope, 'utf8'),
        SCOPE_ID,
        KEYS.terminalTransitionIntent
      );
      sqlite.close();
      originalRevision = readRawJournalRow(dbPath)!.revision;
    }

    for (let reopen = 0; reopen < 2; reopen += 1) {
      const logger = new SanitizedLogger();
      const { sqlite, store } = openAttachedStore(dbPath, logger);
      expect(store.inspectTerminalTransitionJournal()).toMatchObject({
        status: 'unreadable-envelope',
        envelopeReason: 'unsupported-envelope-version'
      });
      await expect(
        store.setTerminalTransitionIntent('run-new', makeIntent('run-new', 'task-new', 20))
      ).rejects.toMatchObject({ reason: 'terminal-journal-corrupt' });
      sqlite.close();
      expect(readRawJournalRow(dbPath)).toEqual({
        payload_json: futureEnvelope,
        revision: originalRevision
      });
    }
  });
});

