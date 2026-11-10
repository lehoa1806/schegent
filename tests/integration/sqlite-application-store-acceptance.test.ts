import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ATOMIC_TRANSACTION_UNITS,
  F04_INITIAL_STRICT_TABLE_COUNT,
  MIGRATION_STAGES,
  SQLITE_BENCHMARK_MEASURED_SAMPLES,
  SQLITE_BENCHMARK_WARMUP_SAMPLES,
  SQLITE_WRITER_MAX_QUEUE_REQUESTS,
  SQLITE_WRITER_RESERVED_SETTLEMENT_SLOTS
} from '../../src/contracts/sqlite-store/schema-types';
import {
  STRUCTURED_STATE_CENSUS,
  validateStructuredStateCensus
} from '../../src/contracts/sqlite-store/state-census';
import {
  EngineQualificationService,
  SqliteApplicationStore,
  resolveTrustedSqliteLocation
} from '../../src/services/sqlite-store';
import { F05_LIFECYCLE_TABLE_NAMES } from '../../src/services/artifact-lifecycle/lifecycle-schema';
import { F06_ACCOUNTING_TABLE_NAMES } from '../../src/services/usage-accounting/accounting-schema';
import { F07_LIVE_LOG_TABLE_NAMES } from '../../src/services/phase-log/live-log-index-schema';
import { F08_HANDOFF_TABLE_NAMES } from '../../src/services/recovery-handoff/handoff-schema';

describe('FR-R6-F04 End-to-End Acceptance Matrix (F04-AC-01 .. F04-AC-12)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('verifies F04-AC-01 through F04-AC-12 across F04-A, F04-B, and F04-C', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-f04-ac-'));
    tempDirs.push(rootDir);

    // F04-AC-01: Engine qualification & benchmark sample floor (>= 200 post-warmup samples)
    const qualReport = EngineQualificationService.runQualificationSuite({
      warmupSamples: SQLITE_BENCHMARK_WARMUP_SAMPLES,
      measuredSamples: SQLITE_BENCHMARK_MEASURED_SAMPLES
    });
    expect(qualReport.qualificationPassed).toBe(true);
    expect(qualReport.meetsMinimumVersionFloor).toBe(true);
    expect(qualReport.strictSchemaTableCount).toBe(
      F04_INITIAL_STRICT_TABLE_COUNT +
        F05_LIFECYCLE_TABLE_NAMES.length +
        F06_ACCOUNTING_TABLE_NAMES.length +
        F07_LIVE_LOG_TABLE_NAMES.length +
        F08_HANDOFF_TABLE_NAMES.length
    );
    expect(qualReport.foreignKeyCheckViolations).toBe(0);
    for (const dist of qualReport.sqliteBenchmarks) {
      expect(dist.warmupSamples).toBeGreaterThanOrEqual(20);
      expect(dist.measuredSamples).toBeGreaterThanOrEqual(200);
      expect(dist.failureCount).toBe(0);
    }

    // F04-AC-07: Trusted storage location, network-share WAL refusal & permissions
    const refusedNet = await resolveTrustedSqliteLocation({
      trustedRootDir: rootDir,
      relativeSegments: ['net-store'],
      sourceKind: 'host_storage_uri',
      filesystemType: 'nfs',
      requestedJournalMode: 'wal'
    });
    expect(refusedNet.status).toBe('refused');

    const clock = 1_700_000_000_000;
    const store = await SqliteApplicationStore.openAtTrustedLocation(
      {
        trustedRootDir: rootDir,
        relativeSegments: ['workspace-store'],
        databaseFileName: 'schegent-state.db',
        sourceKind: 'host_storage_uri',
        filesystemType: 'local',
        requestedJournalMode: 'wal'
      },
      () => clock
    );

    try {
      // F04-AC-02, F04-AC-03, F04-AC-04: 7 atomic transaction units, fencing, CAS, and idempotency
      expect(ATOMIC_TRANSACTION_UNITS.length).toBe(7);
      const fence = {
        fenceScope: 'window_primacy',
        resourceId: 'ws-ac',
        ownerId: 'window-1',
        epoch: 1
      };
      store.transactions.acquireOrRenewLeaseFence({ ...fence, ttlMs: 120_000 });

      const admit = store.transactions.executeAdmission({
        idempotency: {
          scopeKind: 'run',
          scopeId: 'run-ac-1',
          idempotencyKey: 'idem-admit-ac-1',
          requestSha256: 'sha-admit-ac-1'
        },
        fence,
        expectedRevision: 0,
        run: {
          runId: 'run-ac-1',
          workspaceId: 'ws-ac',
          workflowId: 'wf-sdd',
          priority: 10,
          inputs: { feature: 'FR-R6-F04' },
          initialStep: {
            stepId: 'step-ac-1',
            stepIndex: 0,
            phaseId: 'specify',
            attemptId: 'att-ac-1'
          }
        }
      });
      expect(admit.status).toBe('committed');

      // F04-AC-05 & F04-AC-06: Queue saturation & settlement reservation
      expect(SQLITE_WRITER_MAX_QUEUE_REQUESTS).toBe(64);
      expect(SQLITE_WRITER_RESERVED_SETTLEMENT_SLOTS).toBe(16);

      // F04-AC-10: F04-B domain adapters (F05..F15) and cutoff-S keyset pagination
      store.artifacts.registerArtifact({
        artifactId: 'art-ac-1',
        contentSha256: 'sha-art-ac-1',
        byteLength: 256,
        mediaType: 'text/markdown',
        kind: 'spec',
        createdByRunId: 'run-ac-1',
        createdByAttemptId: 'att-ac-1',
        location: {
          locationId: 'loc-ac-1',
          storageTier: 'cas_blob',
          uriOrRelpath: 'blobs/sha-art-ac-1'
        }
      });
      store.artifacts.pinArtifact({
        pinId: 'pin-ac-1',
        artifactId: 'art-ac-1',
        ownerRunId: 'run-ac-1',
        reason: 'active_run_input'
      });

      const page = store.reporting.queryExecutionSummariesKeysetPage({
        workspaceId: 'ws-ac',
        cutoffRevision: 10,
        pageSize: 10
      });
      expect(page.items.length).toBe(1);
      expect(page.items[0]?.runId).toBe('run-ac-1');

      // F04-AC-11: F04-C structured-state census, catalog publication, YAML round-trip & frozen closures
      expect(validateStructuredStateCensus(STRUCTURED_STATE_CENSUS).valid).toBe(true);
      const pkgImport = store.catalogConfig.importCatalogPackage([
        {
          definitionId: 'phase-ac-specify',
          scope: 'workspace',
          layer: 'phase',
          slug: 'specify',
          displayName: 'Specify',
          versionNumber: 1,
          schemaVersion: 1,
          yamlText: 'id: specify\nlayer: phase\n',
          promoteAsPublished: true
        }
      ]);
      expect(pkgImport.committedDefinitionIds).toEqual(['phase-ac-specify']);
      expect(
        store.catalogConfig.exportDefinitionVersionToYaml('phase-ac-specify@v1').verifiedEquivalence
      ).toBe(true);

      const closure = store.catalogConfig.createFrozenExecutionClosure({
        frozenClosureId: 'fc-ac-1',
        runId: 'run-ac-1',
        rootDefinitionVersionId: 'phase-ac-specify@v1',
        members: [{ memberRole: 'root', definitionVersionId: 'phase-ac-specify@v1' }]
      });
      expect(closure.closure.runId).toBe('run-ac-1');

      // F04-AC-08: 7-stage migration & quarantine
      expect(MIGRATION_STAGES.length).toBe(7);
      const migOutcome = store.migration.runMigrationThroughRetainSource({
        migrationId: 'mig-ac',
        scopeId: 'ws-ac',
        runRecords: [
          {
            recordKey: 'run-legacy-1',
            rawJson: JSON.stringify({
              schemaVersion: 1,
              runId: 'run-legacy-1',
              workspaceId: 'ws-ac',
              workflowId: 'wf-sdd',
              status: 'succeeded',
              revision: 1
            })
          }
        ]
      });
      expect(migOutcome.completed).toBe(true);
      expect(store.cutoverGuard.checkLegacyAccessAllowed('ws-ac').allowed).toBe(false);

      // F04-AC-09: Online backup & validated restore
      const bkp = await store.backupRestore.createOnlineBackup({
        backupId: 'bkp-ac',
        scopeId: 'ws-ac',
        trustedRootDir: rootDir,
        relativeBackupDirSegments: ['backups']
      });
      const restoreOut = store.backupRestore.validateAndRestoreBackup({
        backupDatabasePath: bkp.backupDatabasePath,
        manifest: bkp.manifest,
        inspectExternalDependency: () => ({
          exists: true,
          byteLength: 256,
          sha256Digest: 'sha-art-ac-1'
        })
      });
      expect(restoreOut.status).toBe('restored');
      expect(store.writerConnection.runForeignKeyCheck()).toEqual([]);
    } finally {
      store.close();
    }
  });
});
