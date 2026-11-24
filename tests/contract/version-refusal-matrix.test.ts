/**
 * FR-R7-18 (`N07`, FR-008, SC-007, Contract 5) — Version compatibility & typed refusal matrix.
 *
 * Verifies unsupported and malformed versions across all six core version families
 * (plus the legacy string workspace state version and audit checkpoint version):
 *   1. Inbound Sidebar IPC (`validateInboundMessage`, `SIDEBAR_IPC_SCHEMA_VERSION = 3`)
 *   2. Host `WorkflowSnapshot` transport guard (`SnapshotTransport` / `isWorkflowSnapshot`, `SCHEMA_VERSION = 4`)
 *   3. Workspace state numeric version (`assertPersistedVersionSupported` / `WorkspaceStateStore.initialize`, `STATE_SCHEMA_VERSION = 15`)
 *   4. Workspace state legacy string version (`WorkspaceStateStore.initialize`, `SCHEMA_VERSION = '1.0.0'`)
 *   5. SQLite operational store bootstrap (`SchemaBootstrapService.bootstrapAndMigrate`, `SQLITE_SCHEMA_CURRENT_VERSION = 9`, `SQLITE_MIN_READER_VERSION = 9`)
 *   6. Process-YAML exchange (`parseWorkflowPackage`, `validatePhaseDocument`, `parseModelCatalogDocument`, `preflightProcessDocument`, `PHASE_YAML_API_VERSION = 'schegent/v1'`)
 *   7. Audit log & checkpoint (`parseAuditLogLineDetailed`, `readSpendReplay`, `parseCheckpoint`, `classifyLoss`, `AUDIT_SCHEMA_VERSION = 3`)
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  checkpointKey,
  classifyLoss,
  parseCheckpoint
} from '../../src/audit/audit-checkpoint';
import { AUDIT_SCHEMA_VERSION } from '../../src/contracts/audit-events';
import { validateInboundMessage } from '../../src/contracts/runtime-validators';
import {
  CMD_OPEN_DASHBOARD,
  SIDEBAR_IPC_SCHEMA_VERSION
} from '../../src/contracts/sidebar-ipc';
import {
  SQLITE_MIN_READER_VERSION,
  SQLITE_SCHEMA_CURRENT_VERSION
} from '../../src/contracts/sqlite-store/schema-types';
import { STATE_SCHEMA_VERSION } from '../../src/contracts/state-schema';
import { SanitizedLogger } from '../../src/lib/logger';
import { parseAuditLogLineDetailed } from '../../src/parser/audit-log-parser';
import { parseModelCatalogDocument } from '../../src/services/process-yaml/model-catalog-yaml-mapper';
import { validatePhaseDocument } from '../../src/services/process-yaml/phase-yaml-validator';
import { preflightProcessDocument } from '../../src/services/process-yaml/preflight-service';
import { PHASE_YAML_API_VERSION } from '../../src/services/process-yaml/types';
import { parseWorkflowPackage } from '../../src/services/process-yaml/workflow-document';
import { parseDocumentText } from '../../src/services/process-yaml/yaml-parser';
import { readSpendReplay } from '../../src/services/spend-bound-replay';
import {
  SchemaBootstrapService,
  SqliteUnsupportedSchemaError
} from '../../src/services/sqlite-store/schema-bootstrap';
import { NodeSqliteConnection } from '../../src/services/sqlite-store/sqlite-driver';
import { assertPersistedVersionSupported } from '../../src/state/queue-state-migrator';
import {
  KEYS,
  SCHEMA_VERSION as LEGACY_STATE_SCHEMA_VERSION,
  UnsupportedStateSchemaVersionError,
  WorkspaceStateStore,
  type Memento
} from '../../src/state/workspace-state';
import {
  buildIdleSnapshot,
  SCHEMA_VERSION as SNAPSHOT_SCHEMA_VERSION
} from '../../src/ui/sidebar/snapshot';
import { SnapshotTransport } from '../../src/ui/sidebar/snapshot-transport';

function createMemoryMemento(initial: Readonly<Record<string, unknown>> = {}): Memento {
  const map = new Map<string, unknown>(Object.entries(initial));
  return {
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    }
  };
}

function parseMappingOrThrow(yaml: string) {
  const parsed = parseDocumentText(yaml);
  if (!parsed.ok) {
    throw new Error(`unexpected parse refusal: ${parsed.refusal.code}: ${parsed.refusal.message}`);
  }
  return parsed.node;
}

describe('FR-R7-18 N07 — version refusal matrix across all six core version families', () => {
  describe('1. Inbound Sidebar IPC (SIDEBAR_IPC_SCHEMA_VERSION)', () => {
    it('accepts omitted schemaVersion and explicit current schemaVersion', () => {
      const omitted = validateInboundMessage({
        type: CMD_OPEN_DASHBOARD,
        correlationId: 'corr-omitted'
      });
      expect(omitted.ok).toBe(true);

      const matching = validateInboundMessage({
        type: CMD_OPEN_DASHBOARD,
        correlationId: 'corr-match',
        schemaVersion: SIDEBAR_IPC_SCHEMA_VERSION
      });
      expect(matching.ok).toBe(true);
    });

    it.each([
      ['future integer', SIDEBAR_IPC_SCHEMA_VERSION + 1],
      ['older integer', SIDEBAR_IPC_SCHEMA_VERSION - 1],
      ['stringified current', String(SIDEBAR_IPC_SCHEMA_VERSION)],
      ['null', null],
      ['object', {}]
    ] as const)('refuses explicit mismatched schemaVersion (%s) with typed code', (_label, version) => {
      const result = validateInboundMessage({
        type: CMD_OPEN_DASHBOARD,
        correlationId: 'corr-bad-version',
        schemaVersion: version
      });
      expect(result).toEqual({
        ok: false,
        code: 'unsupported-ipc-schema-version',
        reason: 'unsupported-ipc-schema-version',
        type: CMD_OPEN_DASHBOARD,
        correlationId: 'corr-bad-version'
      });
    });
  });

  describe('2. Host WorkflowSnapshot guard (SnapshotTransport / isWorkflowSnapshot)', () => {
    it('accepts schemaVersion = 4 and tracks baseline for routine diff suppression', () => {
      const transport = new SnapshotTransport();
      const snapshot = buildIdleSnapshot({ isPrimary: true });
      expect(snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);

      const first = transport.preparePost(snapshot);
      expect(first.sync).toEqual({ mode: 'full', revision: 1 });
      expect(transport.lastRevision).toBe(1);

      const second = transport.preparePost(snapshot);
      expect(second.sync.mode).toBe('routine');
      expect(second.sync.revision).toBe(2);
      expect(second.sync.baseRevision).toBe(1);
      expect(second.sync.omittedSlices?.length).toBeGreaterThan(0);
    });

    it.each([
      ['older numeric (3)', SNAPSHOT_SCHEMA_VERSION - 1],
      ['future numeric (5)', SNAPSHOT_SCHEMA_VERSION + 1],
      ['stringified ("4")', String(SNAPSHOT_SCHEMA_VERSION)],
      ['undefined', undefined],
      ['null', null]
    ] as const)('rejects non-matching snapshot schemaVersion (%s) without establishing baseline', (_label, badVersion) => {
      const transport = new SnapshotTransport();
      const valid = buildIdleSnapshot({ isPrimary: true });
      const candidate = { ...valid, schemaVersion: badVersion };

      const first = transport.preparePost(candidate);
      expect(first.sync).toEqual({ mode: 'full', revision: 1 });
      // `isWorkflowSnapshot` returned false, so no baseline revision is recorded.
      expect(transport.lastRevision).toBeNull();

      const second = transport.preparePost(candidate);
      expect(second.sync).toEqual({ mode: 'full', revision: 2 });
      expect(transport.lastRevision).toBeNull();
    });
  });

  describe('3. Workspace state numeric version (STATE_SCHEMA_VERSION)', () => {
    it('accepts undefined and supported numeric versions (0..STATE_SCHEMA_VERSION)', async () => {
      expect(() => assertPersistedVersionSupported(undefined)).not.toThrow();
      expect(() => assertPersistedVersionSupported(0)).not.toThrow();
      expect(() => assertPersistedVersionSupported(STATE_SCHEMA_VERSION)).not.toThrow();

      const store = new WorkspaceStateStore(
        createMemoryMemento({
          [KEYS.schemaVersion]: LEGACY_STATE_SCHEMA_VERSION,
          [KEYS.schemaVersionNumeric]: STATE_SCHEMA_VERSION
        })
      );
      await expect(store.initialize()).resolves.toBeDefined();
    });

    it.each([STATE_SCHEMA_VERSION + 1, STATE_SCHEMA_VERSION + 100])(
      'throws UnsupportedStateSchemaVersionError (UNSUPPORTED_NUMERIC_STATE_VERSION) for future %d',
      async (futureVersion) => {
        try {
          assertPersistedVersionSupported(futureVersion);
          expect.unreachable('expected assertPersistedVersionSupported to throw');
        } catch (err) {
          expect(err).toBeInstanceOf(UnsupportedStateSchemaVersionError);
          const typed = err as UnsupportedStateSchemaVersionError;
          expect(typed.code).toBe('UNSUPPORTED_NUMERIC_STATE_VERSION');
          expect(typed.persistedVersion).toBe(futureVersion);
          expect(typed.supportedVersion).toBe(STATE_SCHEMA_VERSION);
        }

        const store = new WorkspaceStateStore(
          createMemoryMemento({ [KEYS.schemaVersionNumeric]: futureVersion })
        );
        await expect(store.initialize()).rejects.toMatchObject({
          name: 'UnsupportedStateSchemaVersionError',
          code: 'UNSUPPORTED_NUMERIC_STATE_VERSION',
          persistedVersion: futureVersion
        });
      }
    );

    it.each([
      ['string "15"', String(STATE_SCHEMA_VERSION)],
      ['negative integer', -1],
      ['NaN', Number.NaN],
      ['non-integer float', 1.5],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['null', null],
      ['object', {}]
    ] as const)(
      'throws UnsupportedStateSchemaVersionError (MALFORMED_NUMERIC_STATE_VERSION) for %s',
      async (_label, malformed) => {
        try {
          assertPersistedVersionSupported(malformed);
          expect.unreachable('expected assertPersistedVersionSupported to throw');
        } catch (err) {
          expect(err).toBeInstanceOf(UnsupportedStateSchemaVersionError);
          const typed = err as UnsupportedStateSchemaVersionError;
          expect(typed.code).toBe('MALFORMED_NUMERIC_STATE_VERSION');
          expect(typed.supportedVersion).toBe(STATE_SCHEMA_VERSION);
        }

        const store = new WorkspaceStateStore(
          createMemoryMemento({ [KEYS.schemaVersionNumeric]: malformed })
        );
        await expect(store.initialize()).rejects.toMatchObject({
          name: 'UnsupportedStateSchemaVersionError',
          code: 'MALFORMED_NUMERIC_STATE_VERSION'
        });
      }
    );
  });

  describe('4. Workspace state legacy string version (SCHEMA_VERSION)', () => {
    it.each(['2.0.0', '0.9.0', '99.0.0'])(
      'throws UnsupportedStateSchemaVersionError (UNSUPPORTED_LEGACY_STATE_VERSION) for major mismatch %s',
      async (badLegacy) => {
        const store = new WorkspaceStateStore(
          createMemoryMemento({
            [KEYS.schemaVersion]: badLegacy,
            [KEYS.schemaVersionNumeric]: STATE_SCHEMA_VERSION
          })
        );
        await expect(store.initialize()).rejects.toMatchObject({
          name: 'UnsupportedStateSchemaVersionError',
          code: 'UNSUPPORTED_LEGACY_STATE_VERSION',
          persistedVersion: badLegacy,
          supportedVersion: LEGACY_STATE_SCHEMA_VERSION
        });
      }
    );

    it.each([
      ['number 15', 15],
      ['object with secret', { token: 'sk-ant-api03-secret-must-not-leak' }],
      ['null', null],
      ['boolean true', true],
      ['array []', []],
      ['extra segment 1.0.0.evil', '1.0.0.evil'],
      ['major-only 1', '1'],
      ['two-part 1.0', '1.0'],
      ['non-numeric minor 1.foo.bar', '1.foo.bar'],
      ['prerelease suffix 1.0.0-extra', '1.0.0-extra'],
      ['secret-bearing string', '1.0.0-secret=sk-ant-api03-leak']
    ] as const)(
      'throws UnsupportedStateSchemaVersionError (MALFORMED_LEGACY_STATE_VERSION) without leaking raw payload for %s',
      async (_label, corrupted) => {
        const store = new WorkspaceStateStore(
          createMemoryMemento({
            [KEYS.schemaVersion]: corrupted,
            [KEYS.schemaVersionNumeric]: STATE_SCHEMA_VERSION
          })
        );
        try {
          await store.initialize();
          expect.unreachable('expected store.initialize() to reject');
        } catch (err) {
          expect(err).not.toBeInstanceOf(TypeError);
          expect(err).toBeInstanceOf(UnsupportedStateSchemaVersionError);
          const typed = err as UnsupportedStateSchemaVersionError;
          expect(typed.code).toBe('MALFORMED_LEGACY_STATE_VERSION');
          expect(typed.supportedVersion).toBe(LEGACY_STATE_SCHEMA_VERSION);
          expect(typed.message).not.toContain('sk-ant-api03');
          expect(typed.message).not.toContain('evil');
        }
      }
    );

    it('does not interpolate raw persisted secrets into MALFORMED_NUMERIC_STATE_VERSION Error.message', async () => {
      const store = new WorkspaceStateStore(
        createMemoryMemento({
          [KEYS.schemaVersionNumeric]: { leaked: 'ghp_1234567890secretToken' }
        })
      );
      await expect(store.initialize()).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(UnsupportedStateSchemaVersionError);
        const typed = err as UnsupportedStateSchemaVersionError;
        expect(typed.code).toBe('MALFORMED_NUMERIC_STATE_VERSION');
        expect(typed.message).not.toContain('ghp_1234567890secretToken');
        return true;
      });
    });
  });

  describe('5. SQLite operational store bootstrap (SchemaBootstrapService)', () => {
    function openBootstrappedMemoryDb(): NodeSqliteConnection {
      const conn = new NodeSqliteConnection({ databasePath: ':memory:' });
      const result = SchemaBootstrapService.bootstrapAndMigrate(conn);
      expect(result.schemaVersion).toBe(SQLITE_SCHEMA_CURRENT_VERSION);
      return conn;
    }

    it('refuses min_reader_version > supported max with UNSUPPORTED_MIN_READER_VERSION', () => {
      const conn = openBootstrappedMemoryDb();
      try {
        conn.run(
          `UPDATE schema_meta SET meta_value = ? WHERE meta_key = 'min_reader_version'`,
          String(SQLITE_MIN_READER_VERSION + 1)
        );
        try {
          SchemaBootstrapService.bootstrapAndMigrate(conn);
          expect.unreachable('expected bootstrapAndMigrate to throw');
        } catch (err) {
          expect(err).toBeInstanceOf(SqliteUnsupportedSchemaError);
          const typed = err as SqliteUnsupportedSchemaError;
          expect(typed.code).toBe('UNSUPPORTED_MIN_READER_VERSION');
          expect(typed.recordedVersion).toBe(SQLITE_MIN_READER_VERSION + 1);
          expect(typed.maxSupportedVersion).toBe(SQLITE_SCHEMA_CURRENT_VERSION);
          expect(typed.message).toMatch(/^UNSUPPORTED_MIN_READER_VERSION:/);
        }
      } finally {
        conn.close();
      }
    });

    it('refuses unreadable min_reader_version with UNSUPPORTED_MIN_READER_VERSION', () => {
      const conn = openBootstrappedMemoryDb();
      try {
        conn.run(
          `UPDATE schema_meta SET meta_value = 'abc' WHERE meta_key = 'min_reader_version'`
        );
        try {
          SchemaBootstrapService.bootstrapAndMigrate(conn);
          expect.unreachable('expected bootstrapAndMigrate to throw');
        } catch (err) {
          expect(err).toBeInstanceOf(SqliteUnsupportedSchemaError);
          const typed = err as SqliteUnsupportedSchemaError;
          expect(typed.code).toBe('UNSUPPORTED_MIN_READER_VERSION');
          expect(typed.recordedVersion).toBeNull();
          expect(typed.message).toMatch(/^UNSUPPORTED_MIN_READER_VERSION:/);
        }
      } finally {
        conn.close();
      }
    });

    it('refuses schema_version > supported max with UNSUPPORTED_FUTURE_SCHEMA_VERSION', () => {
      const conn = openBootstrappedMemoryDb();
      try {
        conn.run(
          `UPDATE schema_meta SET meta_value = ? WHERE meta_key = 'schema_version'`,
          String(SQLITE_SCHEMA_CURRENT_VERSION + 1)
        );
        try {
          SchemaBootstrapService.bootstrapAndMigrate(conn);
          expect.unreachable('expected bootstrapAndMigrate to throw');
        } catch (err) {
          expect(err).toBeInstanceOf(SqliteUnsupportedSchemaError);
          const typed = err as SqliteUnsupportedSchemaError;
          expect(typed.code).toBe('UNSUPPORTED_FUTURE_SCHEMA_VERSION');
          expect(typed.recordedVersion).toBe(SQLITE_SCHEMA_CURRENT_VERSION + 1);
          expect(typed.maxSupportedVersion).toBe(SQLITE_SCHEMA_CURRENT_VERSION);
          expect(typed.message).toMatch(/^UNSUPPORTED_FUTURE_SCHEMA_VERSION:/);
        }
      } finally {
        conn.close();
      }
    });

    it('refuses unreadable schema_version with UNSUPPORTED_FUTURE_SCHEMA_VERSION', () => {
      const conn = openBootstrappedMemoryDb();
      try {
        conn.run(
          `UPDATE schema_meta SET meta_value = 'not-a-number' WHERE meta_key = 'schema_version'`
        );
        try {
          SchemaBootstrapService.bootstrapAndMigrate(conn);
          expect.unreachable('expected bootstrapAndMigrate to throw');
        } catch (err) {
          expect(err).toBeInstanceOf(SqliteUnsupportedSchemaError);
          const typed = err as SqliteUnsupportedSchemaError;
          expect(typed.code).toBe('UNSUPPORTED_FUTURE_SCHEMA_VERSION');
          expect(typed.recordedVersion).toBeNull();
          expect(typed.message).toMatch(/^UNSUPPORTED_FUTURE_SCHEMA_VERSION:/);
        }
      } finally {
        conn.close();
      }
    });

    it('refuses applied migration row past supported max with UNSUPPORTED_FUTURE_SCHEMA_VERSION', () => {
      const conn = openBootstrappedMemoryDb();
      try {
        conn.run(
          `INSERT INTO schema_migrations (version, name, checksum_sha256, applied_at_ms) VALUES (?, ?, ?, ?)`,
          SQLITE_SCHEMA_CURRENT_VERSION + 1,
          '010_future_migration',
          'deadbeef',
          Date.now()
        );
        try {
          SchemaBootstrapService.bootstrapAndMigrate(conn);
          expect.unreachable('expected bootstrapAndMigrate to throw');
        } catch (err) {
          expect(err).toBeInstanceOf(SqliteUnsupportedSchemaError);
          const typed = err as SqliteUnsupportedSchemaError;
          expect(typed.code).toBe('UNSUPPORTED_FUTURE_SCHEMA_VERSION');
          expect(typed.recordedVersion).toBe(SQLITE_SCHEMA_CURRENT_VERSION + 1);
          expect(typed.message).toMatch(/^UNSUPPORTED_FUTURE_SCHEMA_VERSION:/);
        }
      } finally {
        conn.close();
      }
    });
  });

  describe('6. Process-YAML exchange (PHASE_YAML_API_VERSION = schegent/v1)', () => {
    it('refuses missing and unsupported apiVersion on Workflow, Phase, and ModelCatalog', async () => {
      expect(PHASE_YAML_API_VERSION).toBe('schegent/v1');

      const wfMissing = parseWorkflowPackage(parseMappingOrThrow('kind: Workflow\nmetadata:\n  id: demo\n'));
      expect(wfMissing.ok).toBe(false);
      if (!wfMissing.ok) expect(wfMissing.refusal.code).toBe('unsupported-version');

      const wfFuture = parseWorkflowPackage(
        parseMappingOrThrow('apiVersion: schegent/v2\nkind: Workflow\nmetadata:\n  id: demo\n')
      );
      expect(wfFuture.ok).toBe(false);
      if (!wfFuture.ok) expect(wfFuture.refusal.code).toBe('unsupported-version');

      const phaseMissing = validatePhaseDocument(parseMappingOrThrow('kind: Phase\nmetadata:\n  phaseId: demo\n'));
      expect(phaseMissing.ok).toBe(false);
      if (!phaseMissing.ok && phaseMissing.kind === 'document') {
        expect(phaseMissing.refusal.code).toBe('unsupported-version');
      } else {
        expect.unreachable('expected document-level refusal for missing phase apiVersion');
      }

      const phaseFuture = validatePhaseDocument(
        parseMappingOrThrow('apiVersion: schegent/v2\nkind: Phase\nmetadata:\n  phaseId: demo\n')
      );
      expect(phaseFuture.ok).toBe(false);
      if (!phaseFuture.ok && phaseFuture.kind === 'document') {
        expect(phaseFuture.refusal.code).toBe('unsupported-version');
      } else {
        expect.unreachable('expected document-level refusal for unsupported phase apiVersion');
      }

      const mcMissing = parseModelCatalogDocument(parseMappingOrThrow('kind: ModelCatalog\n'));
      expect(mcMissing.ok).toBe(false);
      if (!mcMissing.ok) expect(mcMissing.refusal.code).toBe('unsupported-version');

      const mcFuture = parseModelCatalogDocument(
        parseMappingOrThrow('apiVersion: schegent/v2\nkind: ModelCatalog\n')
      );
      expect(mcFuture.ok).toBe(false);
      if (!mcFuture.ok) expect(mcFuture.refusal.code).toBe('unsupported-version');

      // End-to-end preflight refusal for unsupported apiVersion
      const preflight = await preflightProcessDocument(
        {
          logger: {
            sanitize: (v) => v,
            warn: () => undefined
          }
        },
        {
          bytes: new TextEncoder().encode('apiVersion: schegent/v2\nkind: Workflow\n')
        }
      );
      expect(preflight.outcome).toBe('refused');
      if (preflight.outcome === 'refused') {
        expect(preflight.refusal.code).toBe('unsupported-version');
      }
    });
  });

  describe('7. Audit log envelope & checkpoint version handling', () => {
    it('parseAuditLogLineDetailed warns and preserves rows with schemaVersion > AUDIT_SCHEMA_VERSION', () => {
      const futureSchema = AUDIT_SCHEMA_VERSION + 96;
      const line = JSON.stringify({
        id: 'audit-1',
        timestamp: '2026-11-24T00:00:00.000Z',
        runId: 'run-future-audit',
        phase: 'implement',
        iteration: 1,
        eventType: 'phase-end',
        outcome: 'success',
        payload: { metrics: { costUsd: 0.42 } },
        schemaVersion: futureSchema
      });

      const result = parseAuditLogLineDetailed(line);
      expect(result.entry).not.toBeNull();
      expect(result.entry?.schemaVersion).toBe(futureSchema);
      expect(result.warning).toContain(`schemaVersion ${futureSchema} exceeds runtime ${AUDIT_SCHEMA_VERSION}`);
    });

    it('readSpendReplay marks a run spanning a future-schema phase-end row as incomplete (unknown-row-schema)', async () => {
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-version-matrix-'));
      try {
        const auditDir = path.join(tmpRoot, '.schegent');
        await fs.mkdir(auditDir, { recursive: true });
        const startedAt = Date.parse('2026-11-24T00:00:00.000Z');
        const rows = [
          JSON.stringify({
            id: 'prior-row',
            timestamp: '2026-11-23T23:59:00.000Z',
            runId: 'run-other',
            phase: 'plan',
            iteration: 1,
            eventType: 'phase-end',
            outcome: 'success',
            payload: {},
            schemaVersion: AUDIT_SCHEMA_VERSION
          }),
          JSON.stringify({
            id: 'future-row',
            timestamp: '2026-11-24T00:01:00.000Z',
            runId: 'run-target',
            phase: 'implement',
            iteration: 1,
            eventType: 'phase-end',
            outcome: 'success',
            payload: { metrics: { costUsd: 1.25 } },
            schemaVersion: AUDIT_SCHEMA_VERSION + 96
          })
        ];
        await fs.writeFile(path.join(auditDir, 'audit.log'), `${rows.join('\n')}\n`, 'utf8');

        const replay = await readSpendReplay(tmpRoot, new SanitizedLogger(), [
          { runId: 'run-target', startedAt }
        ]);
        expect(replay.rows).toHaveLength(1);
        expect(replay.completeness.get('run-target')).toEqual({
          kind: 'incomplete',
          reason: 'unknown-row-schema'
        });
      } finally {
        await fs.rm(tmpRoot, { recursive: true, force: true });
      }
    });

    it('audit-checkpoint refuses unknown checkpoint versions with typed version-unknown / checkpoint-version-unknown', () => {
      const key = checkpointKey('/workspace/demo');

      const futureCheckpoint = parseCheckpoint(
        JSON.stringify({
          version: 2,
          workspaceKey: key,
          state: 'active',
          origin: 'new',
          headDigest: 'abc',
          position: 1,
          establishedAtMs: 1000,
          updatedAtMs: 2000
        }),
        key
      );
      expect(futureCheckpoint).toEqual({ status: 'unreadable', reason: 'version-unknown' });
      expect(classifyLoss(futureCheckpoint, null)).toEqual({
        state: 'not-performed',
        reason: 'checkpoint-version-unknown'
      });

      const nonNumericVersion = parseCheckpoint(
        JSON.stringify({
          version: '1',
          workspaceKey: key
        }),
        key
      );
      expect(nonNumericVersion).toEqual({ status: 'unreadable', reason: 'corrupt' });
      expect(classifyLoss(nonNumericVersion, null)).toEqual({
        state: 'not-performed',
        reason: 'checkpoint-unreadable'
      });
    });
  });
});
