/**
 * FR-R7-18 (`N02`, FR-002, SC-002) — Child-process `SIGKILL` crash worker for the
 * SQLite fault matrix.
 *
 * Arms a real `process.kill(process.pid, 'SIGKILL')` at exact statement boundaries across:
 * - All seven `AtomicTransactionUnitsService` units (pre-commit and post-commit)
 * - `BackupRestoreService.createOnlineBackup` (after destination reservation before `VACUUM INTO`,
 *   and after `VACUUM INTO` before manifest publication)
 * - `BackupRestoreService.validateAndRestoreBackupAsync` (after `DELETE` before `INSERT`,
 *   at the pre-commit ownership fence after table copy & trigger recreate, and after `COMMIT`)
 * - Uncheckpointed WAL recovery (one committed transaction + one uncommitted transaction in `-wal`)
 */

import { readFileSync } from 'node:fs';
import {
  NodeSqliteConnection,
  parseAndValidateBackupManifest,
  SqliteApplicationStore
} from '../../../../src/services/sqlite-store';

export type FaultMatrixCrashBoundary =
  | 'tx-admission-pre-commit'
  | 'tx-admission-post-commit'
  | 'tx-terminal-pre-commit'
  | 'tx-terminal-post-commit'
  | 'tx-handoff-pre-commit'
  | 'tx-handoff-post-commit'
  | 'tx-review-pre-commit'
  | 'tx-review-post-commit'
  | 'tx-usage-pre-commit'
  | 'tx-usage-post-commit'
  | 'tx-catalog-pre-commit'
  | 'tx-catalog-post-commit'
  | 'tx-retention-pre-commit'
  | 'tx-retention-post-commit'
  | 'backup-kill-after-reserve-before-vacuum'
  | 'backup-kill-after-vacuum-before-manifest'
  | 'restore-kill-after-delete-before-insert'
  | 'restore-kill-at-before-commit-fence'
  | 'restore-kill-after-commit'
  | 'wal-uncheckpointed-commit-then-uncommitted-kill';

export interface FaultMatrixWorkerPayload {
  readonly dbPath: string;
  readonly scopeId: string;
  readonly boundary: FaultMatrixCrashBoundary;
  readonly trustedRootDir?: string | undefined;
  readonly backupId?: string | undefined;
  readonly backupDatabasePath?: string | undefined;
  readonly manifestPath?: string | undefined;
}

const WORKER_NOW = 1_764_000_000_000;
const FM_FENCE = Object.freeze({
  fenceScope: 'window_primacy',
  resourceId: 'ws-fm',
  ownerId: 'window-primary',
  epoch: 1
});

function killSelf(): never {
  process.kill(process.pid, 'SIGKILL');
  // Unreachable after SIGKILL; satisfies TypeScript `never`.
  process.exit(137);
}

function runTransactionUnitCrash(dbPath: string, boundary: FaultMatrixCrashBoundary): void {
  const store = new SqliteApplicationStore({
    databasePath: dbPath,
    journalMode: 'wal',
    nowMs: () => WORKER_NOW
  });
  const conn = store.writerConnection;
  // Keep WAL frames uncheckpointed until reopen exercises WAL replay.
  conn.exec('PRAGMA wal_autocheckpoint = 0');

  const origExec = conn.exec.bind(conn);
  const origRun = conn.run.bind(conn);
  let armed = false;

  const isPostCommit = boundary.endsWith('-post-commit');

  conn.exec = ((sql: string) => {
    const res = origExec(sql);
    if (armed && isPostCommit && sql === 'COMMIT') {
      killSelf();
    }
    return res;
  }) as typeof conn.exec;

  conn.run = ((...args: Parameters<typeof conn.run>) => {
    const [sql] = args;
    const res = origRun(...args);
    if (!armed || isPostCommit) {
      return res;
    }
    if (boundary === 'tx-admission-pre-commit' && sql.includes('INSERT INTO queue_entries')) {
      killSelf();
    }
    if (boundary === 'tx-terminal-pre-commit' && sql.includes('UPDATE queue_entries SET state =')) {
      killSelf();
    }
    if (boundary === 'tx-handoff-pre-commit' && sql.includes('INSERT INTO handoffs (')) {
      killSelf();
    }
    if (boundary === 'tx-review-pre-commit' && sql.includes('INSERT INTO findings (')) {
      killSelf();
    }
    if (
      boundary === 'tx-usage-pre-commit' &&
      sql.includes('INSERT INTO usage_accounting_applications (')
    ) {
      killSelf();
    }
    if (boundary === 'tx-catalog-pre-commit' && sql.includes('INSERT INTO catalog_heads (')) {
      killSelf();
    }
    if (
      boundary === 'tx-retention-pre-commit' &&
      sql.includes("UPDATE artifact_availability SET state = 'evicted'")
    ) {
      killSelf();
    }
    return res;
  }) as typeof conn.run;

  armed = true;
  let outcome: unknown;

  if (boundary === 'tx-admission-pre-commit' || boundary === 'tx-admission-post-commit') {
    outcome = store.transactions.executeAdmission({
      idempotency: {
        scopeKind: 'run',
        scopeId: 'run-fm-1',
        idempotencyKey: 'fm-admit-1',
        requestSha256: 'sha-fm-admit-1'
      },
      fence: FM_FENCE,
      expectedRevision: 0,
      run: {
        runId: 'run-fm-1',
        workspaceId: 'ws-fm',
        workflowId: 'wf-fm',
        priority: 5,
        inputs: { prompt: 'fault-matrix-admission' },
        initialStep: {
          stepId: 'step-fm-1',
          stepIndex: 0,
          phaseId: 'specify',
          attemptId: 'att-fm-1'
        }
      }
    });
  } else if (boundary === 'tx-terminal-pre-commit' || boundary === 'tx-terminal-post-commit') {
    outcome = store.transactions.executeTerminalAcceptance({
      idempotency: {
        scopeKind: 'run',
        scopeId: 'run-fm-1',
        idempotencyKey: 'fm-term-1',
        requestSha256: 'sha-fm-term-1'
      },
      fence: FM_FENCE,
      expectedRevision: 1,
      settlement: {
        runId: 'run-fm-1',
        terminalStatus: 'succeeded',
        terminalReason: 'workflow_completed',
        stepSettlement: {
          stepId: 'step-fm-1',
          status: 'succeeded',
          attemptId: 'att-fm-1',
          attemptStatus: 'succeeded',
          exitCode: 0
        }
      }
    });
  } else if (boundary === 'tx-handoff-pre-commit' || boundary === 'tx-handoff-post-commit') {
    outcome = store.transactions.executeHandoffAcceptance({
      idempotency: {
        scopeKind: 'handoff',
        scopeId: 'ho-fm-1',
        idempotencyKey: 'fm-ho-1',
        requestSha256: 'sha-fm-ho-1'
      },
      fence: FM_FENCE,
      expectedRevision: 1,
      handoff: {
        runId: 'run-fm-1',
        resultId: 'res-fm-1',
        stepId: 'step-fm-1',
        attemptId: 'att-fm-1',
        schemaId: 'spec-output-v1',
        values: [
          {
            fieldPath: 'specPath',
            valueType: 'artifact_ref',
            valueText: 'art-fm-1',
            artifactId: 'art-fm-1'
          }
        ],
        handoffId: 'ho-fm-1',
        toStepId: 'step-fm-2',
        envelopeId: 'env-fm-1',
        envelopeDigestSha256: 'sha-env-fm-1',
        bindings: [
          {
            paramName: 'spec',
            boundValueJson: '"art-fm-1"',
            sourceFieldPath: 'specPath'
          }
        ],
        pinArtifactIds: ['art-fm-1']
      }
    });
  } else if (boundary === 'tx-review-pre-commit' || boundary === 'tx-review-post-commit') {
    outcome = store.transactions.executeReviewAcceptance({
      idempotency: {
        scopeKind: 'review',
        scopeId: 'rl-fm-1',
        idempotencyKey: 'fm-rev-1',
        requestSha256: 'sha-fm-rev-1'
      },
      fence: FM_FENCE,
      expectedRevision: 0,
      review: {
        reviewLoopId: 'rl-fm-1',
        runId: 'run-fm-1',
        stepId: 'step-fm-1',
        iteration: 1,
        maxIterations: 3,
        loopStatus: 'converged',
        reportId: 'rep-fm-1',
        reviewerRole: 'security-reviewer',
        verdict: 'pass',
        findings: [
          {
            findingId: 'find-fm-1',
            severity: 'medium',
            category: 'code',
            filePath: 'src/index.ts',
            lineNumber: 12,
            summary: 'Resolved finding',
            status: 'fixed',
            disposition: {
              dispositionId: 'disp-fm-1',
              disposition: 'fixed',
              actorId: 'agent-1',
              rationale: 'Patched cleanly'
            },
            fixClaim: {
              claimId: 'claim-fm-1',
              claimantAttemptId: 'att-fm-1',
              commitSha: 'deadbeef',
              status: 'verified'
            }
          }
        ],
        gateUpdate: {
          gateId: 'gate-fm-1',
          gateType: 'review',
          status: 'approved',
          decidedBy: 'reviewer',
          notes: 'Approved'
        }
      }
    });
  } else if (boundary === 'tx-usage-pre-commit' || boundary === 'tx-usage-post-commit') {
    outcome = store.transactions.executeUsageCorrection({
      idempotency: {
        scopeKind: 'usage',
        scopeId: 'att-fm-1',
        idempotencyKey: 'fm-usage-1',
        requestSha256: 'sha-fm-usage-1'
      },
      expectedRevision: 0,
      usage: {
        runId: 'run-fm-1',
        stepId: 'step-fm-1',
        attemptId: 'att-fm-1',
        applicationId: 'app-fm-1',
        completeness: 'exact',
        observation: {
          observationId: 'obs-fm-1',
          provider: 'anthropic',
          modelId: 'claude-sonnet-4-5',
          inputTokens: 1_200,
          outputTokens: 400,
          cachedTokens: 100,
          costMicrodollars: 9_500,
          sourceKind: 'provider_exact'
        }
      }
    });
  } else if (boundary === 'tx-catalog-pre-commit' || boundary === 'tx-catalog-post-commit') {
    outcome = store.transactions.executeCatalogPublication({
      idempotency: {
        scopeKind: 'catalog',
        scopeId: 'def-fm-phase-1',
        idempotencyKey: 'fm-cat-1',
        requestSha256: 'sha-fm-cat-1'
      },
      expectedRevision: 0,
      publication: {
        scope: 'workspace',
        definitionId: 'def-fm-phase-1',
        layer: 'phase',
        slug: 'specify-fm',
        displayName: 'Fault Matrix Specify',
        definitionVersionId: 'def-fm-phase-1@v1',
        versionNumber: 1,
        status: 'published',
        canonicalYaml: 'id: specify-fm\nlayer: phase\n',
        digestSha256: 'sha256-specify-fm-v1',
        schemaVersion: 1,
        promoteAsPublished: true
      }
    });
  } else if (boundary === 'tx-retention-pre-commit' || boundary === 'tx-retention-post-commit') {
    outcome = store.transactions.executeRetention({
      idempotency: {
        scopeKind: 'retention',
        scopeId: 'ws-fm',
        idempotencyKey: 'fm-ret-1',
        requestSha256: 'sha-fm-ret-1'
      },
      cutoffTimestampMs: WORKER_NOW + 10_000
    });
  }

  store.close();
  throw new Error(
    `Worker did not trigger SIGKILL for ${boundary}; outcome=${JSON.stringify(outcome)}`
  );
}

async function runOnlineBackupCrash(payload: FaultMatrixWorkerPayload): Promise<void> {
  if (!payload.trustedRootDir || !payload.backupId) {
    throw new Error('backup crash requires trustedRootDir and backupId');
  }
  const store = new SqliteApplicationStore({
    databasePath: payload.dbPath,
    journalMode: 'wal',
    nowMs: () => WORKER_NOW
  });
  const conn = store.writerConnection;
  const origRun = conn.run.bind(conn);

  conn.run = ((...args: Parameters<typeof conn.run>) => {
    const [sql] = args;
    if (payload.boundary === 'backup-kill-after-reserve-before-vacuum' && sql === 'VACUUM INTO ?') {
      killSelf();
    }
    const res = origRun(...args);
    if (payload.boundary === 'backup-kill-after-vacuum-before-manifest' && sql === 'VACUUM INTO ?') {
      killSelf();
    }
    return res;
  }) as typeof conn.run;

  await store.backupRestore.createOnlineBackup({
    backupId: payload.backupId,
    scopeId: payload.scopeId,
    trustedRootDir: payload.trustedRootDir,
    relativeBackupDirSegments: ['sqlite', payload.scopeId, 'backups']
  });
  store.close();
  throw new Error(`Worker did not trigger SIGKILL for ${payload.boundary}`);
}

async function runRestoreCrash(payload: FaultMatrixWorkerPayload): Promise<void> {
  if (!payload.trustedRootDir || !payload.backupDatabasePath || !payload.manifestPath) {
    throw new Error('restore crash requires trustedRootDir, backupDatabasePath, and manifestPath');
  }
  const manifest = parseAndValidateBackupManifest(readFileSync(payload.manifestPath, 'utf8'));
  if (!manifest) {
    throw new Error('Failed to parse backup manifest in restore crash worker');
  }

  const store = new SqliteApplicationStore({
    databasePath: payload.dbPath,
    journalMode: 'wal',
    nowMs: () => WORKER_NOW
  });

  // `executeAttachedRestoreAsync` opens a dedicated `NodeSqliteConnection` on disk-backed stores,
  // so prototype interception hooks the dedicated restore connection accurately.
  const origProtoExec = NodeSqliteConnection.prototype.exec;
  const origProtoRun = NodeSqliteConnection.prototype.run;
  const restoreTxConns = new WeakSet<NodeSqliteConnection>();

  if (payload.boundary === 'restore-kill-after-delete-before-insert') {
    NodeSqliteConnection.prototype.run = function (
      this: NodeSqliteConnection,
      ...args: Parameters<NodeSqliteConnection['run']>
    ) {
      const [sql] = args;
      const res = origProtoRun.apply(this, args);
      if (sql === 'DELETE FROM main."runs"') {
        killSelf();
      }
      return res;
    };
  } else if (payload.boundary === 'restore-kill-after-commit') {
    NodeSqliteConnection.prototype.exec = function (this: NodeSqliteConnection, sql: string) {
      if (sql === 'PRAGMA defer_foreign_keys = ON') {
        restoreTxConns.add(this);
      }
      const res = origProtoExec.call(this, sql);
      if (sql === 'COMMIT' && restoreTxConns.has(this)) {
        killSelf();
      }
      return res;
    };
  }

  try {
    const outcome = await store.backupRestore.validateAndRestoreBackupAsync({
      backupDatabasePath: payload.backupDatabasePath,
      manifest,
      trustedRootDir: payload.trustedRootDir,
      fences: {
        hasPrimacy: async () => true,
        hasInFlightRun: () => false,
        beforeCommitFence: async () => {
          if (payload.boundary === 'restore-kill-at-before-commit-fence') {
            killSelf();
          }
          return true;
        }
      }
    });
    throw new Error(
      `Worker did not trigger SIGKILL for ${payload.boundary}; outcome=${JSON.stringify(outcome)}`
    );
  } finally {
    NodeSqliteConnection.prototype.exec = origProtoExec;
    NodeSqliteConnection.prototype.run = origProtoRun;
    store.close();
  }
}

function runWalUncheckpointedCrash(dbPath: string, scopeId: string): void {
  const store = new SqliteApplicationStore({
    databasePath: dbPath,
    journalMode: 'wal',
    nowMs: () => WORKER_NOW
  });
  const conn = store.writerConnection;
  conn.exec('PRAGMA wal_autocheckpoint = 0');

  // Committed transaction whose frames remain uncheckpointed in `-wal`.
  conn.exec('BEGIN IMMEDIATE');
  conn.run(
    `INSERT INTO runs (
      run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
    ) VALUES ('run-wal-committed', ?, 'wf-wal', 'succeeded', 1, ?, ?)`,
    scopeId,
    WORKER_NOW,
    WORKER_NOW
  );
  conn.run(
    `INSERT INTO operational_runs (
      scope_id, queue_id, run_id, revision, feature_id, status, current_phase,
      started_at_ms, last_transition_at_ms, failure_cause, payload_json
    ) VALUES (?, 'queue-wal', 'run-wal-committed', 1, 'feat-wal-1', 'completed', 'verify', ?, ?, NULL, ?)`,
    scopeId,
    WORKER_NOW,
    WORKER_NOW,
    JSON.stringify({ id: 'run-wal-committed', status: 'completed' })
  );
  conn.exec('COMMIT');

  // Uncommitted transaction written into `-wal` immediately before SIGKILL.
  conn.exec('BEGIN IMMEDIATE');
  conn.run(
    `INSERT INTO runs (
      run_id, workspace_id, workflow_id, status, revision, created_at_ms, updated_at_ms
    ) VALUES ('run-wal-uncommitted', ?, 'wf-wal', 'running', 1, ?, ?)`,
    scopeId,
    WORKER_NOW + 100,
    WORKER_NOW + 100
  );
  conn.run(
    `UPDATE operational_runs SET status = 'failed', revision = 2 WHERE scope_id = ? AND queue_id = 'queue-wal'`,
    scopeId
  );
  killSelf();
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw) {
    throw new Error('Usage: fault-matrix-crash-worker <jsonPayload>');
  }
  const payload = JSON.parse(raw) as FaultMatrixWorkerPayload;
  if (payload.boundary.startsWith('tx-')) {
    runTransactionUnitCrash(payload.dbPath, payload.boundary);
  } else if (payload.boundary.startsWith('backup-')) {
    await runOnlineBackupCrash(payload);
  } else if (payload.boundary.startsWith('restore-')) {
    await runRestoreCrash(payload);
  } else if (payload.boundary === 'wal-uncheckpointed-commit-then-uncommitted-kill') {
    runWalUncheckpointedCrash(payload.dbPath, payload.scopeId);
  } else {
    throw new Error(`Unknown fault-matrix boundary: ${String(payload.boundary)}`);
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(2);
});
