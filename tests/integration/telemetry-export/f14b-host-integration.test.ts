/**
 * FR-R6-F14 (F14-B) — End-to-end host & headless integration suite covering
 * F14-AC-01 through F14-AC-10:
 *   - F14-AC-01: Disabled by default (zero spool files/requests) & user-scope opt-in + SecretStorage
 *   - F14-AC-02: Accepted F06 SQLite observation, outcome & correction mapping (units/provenance/nulls)
 *   - F14-AC-03: Duplicated ACP-derived exports leave local F06 SQLite totals unchanged
 *   - F14-AC-04: Seeded secrets/paths excluded + 1,001 distinct attribute sets durable overflow + content preview
 *   - F14-AC-05: Broken/slow destination retries, spools to governed 0o600 files (32 MiB cap), local F06 intact
 *   - F14-AC-06: Disable/revocation cancels sends & shutdown finishes within 250 ms budget
 *   - F14-AC-07: Host & headless entry parity with zero editor imports
 *   - F14-AC-08: Export-only scope (no inbound listener even when ACP cost is missing/unknown)
 *   - F14-AC-09: Malicious remote acknowledgement body cannot insert local usage or mutate SQLite execution state
 *   - F14-AC-10: Crash/restart durable spool reconciliation + stale authorization generation cannot send queued copies
 */
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';

import {
  TELEMETRY_EXPORT_BOUNDS,
  TELEMETRY_MAPPING_REVISION,
  TELEMETRY_SOURCE_SCHEMA,
  type ResolvedDestination,
  type TelemetrySecretPort,
  type TransportRequest,
  type TransportResult
} from '../../../src/contracts/telemetry-export';
import {
  buildTelemetryExportPreview,
  createTelemetryHostService,
  normalizeAcceptedObservationFromSqlite
} from '../../../src/headless/telemetry-export-api';
import { SqliteApplicationStore } from '../../../src/services/sqlite-store';
import { sanitizeDimension } from '../../../src/services/usage-accounting/dimension-sanitizer';
import { createUsageAccountingService } from '../../../src/services/usage-accounting/usage-accounting-service';

const tempDirs: string[] = [];

async function makeTempStorageRoot(label: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `schegent-f14b-${label}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }
});

function createMemorySecretPort(
  entries: Readonly<Record<string, string | undefined>>,
  available = true
): TelemetrySecretPort {
  return {
    availability: () => (available ? 'available' : 'unavailable'),
    async read(ref: string): Promise<string | null> {
      const val = entries[ref];
      return typeof val === 'string' && val.length > 0 ? val : null;
    }
  };
}

describe('FR-R6-F14-B Optional OpenTelemetry Host & Headless Integration (F14-AC-01..F14-AC-10)', () => {
  it('F14-AC-01 & F14-AC-08: disabled by default creates zero spool files or requests, refuses workspace-scoped profiles, and starts no listener when ACP cost is unknown', async () => {
    const storageRoot = await makeTempStorageRoot('ac01');
    const sqliteStore = new SqliteApplicationStore({
      databasePath: path.join(storageRoot, 'state.sqlite'),
      journalMode: 'wal'
    });
    try {
      let transportCalls = 0;
      const host = createTelemetryHostService({
        sqliteStore,
        storageRoot,
        secrets: createMemorySecretPort({ 'otel-token': 'Bearer secret-token-value' }),
        isWorkspaceTrusted: () => true,
        transport: {
          async send(): Promise<TransportResult> {
            transportCalls += 1;
            return {
              kind: 'response',
              statusCode: 200,
              retryAfterSeconds: null,
              body: new Uint8Array(0),
              bodyTruncated: false
            };
          }
        }
      });

      // Default disabled state
      const initialEval = host.configureFromUserSettings({
        enabled: false,
        endpoint: 'http://127.0.0.1:4318/v1/metrics',
        protocol: 'otlp-http-json',
        allowPlaintextLoopback: true,
        credentialSecretKey: '',
        credentialHeaderName: 'Authorization',
        contentPolicy: 'metadata-only'
      });
      expect(initialEval).toEqual({ kind: 'disabled' });
      expect(host.getStatus().health.state).toBe('disabled');

      const accounting = createUsageAccountingService({
        conn: sqliteStore.writerConnection,
        nowUtc: () => '2026-11-12T00:00:00.000Z',
        monotonicMs: () => 100,
        workspaceId: 'ws-ac01'
      });
      const ingested = accounting.ingestObservation({
        producerNamespace: 'acp-runtime',
        source: 'acp-runtime',
        sourceKind: 'acp-usage-update',
        sourceIdentity: 'turn-1',
        observationRevision: 1,
        rootId: 'run-1',
        attemptId: 'att-1',
        invocationOrdinal: 0,
        counterScope: 'invocation-delta',
        adapterVersion: '1.0.0',
        dimensions: {
          backend: 'claude',
          modelRequested: 'claude-sonnet-4-5',
          modelReported: 'claude-sonnet-4-5'
        },
        eventUtc: '2026-11-12T00:00:00.000Z',
        observedUtc: '2026-11-12T00:00:00.000Z',
        measures: [
          {
            measure: 'input_tokens',
            quantity: 500,
            unit: 'count',
            completeness: 'known',
            provenance: 'provider-reported'
          },
          {
            measure: 'cost',
            quantity: null,
            unit: 'USD',
            completeness: 'unknown',
            provenance: 'provider-reported',
            unknownReason: 'provider-omitted'
          }
        ]
      });
      expect(ingested.ok).toBe(true);
      if (ingested.ok) {
        host.offerAcceptedObservationById(ingested.value.observationId);
      }
      host.flush();
      expect(transportCalls).toBe(0);

      // Zero spool directory created when disabled (F14-NFR-05).
      await expect(fsp.stat(path.join(storageRoot, 'telemetry-spool'))).rejects.toThrow();

      // Workspace-scoped profile is refused even when enabled (F14-FR-02).
      const wsEval = host.configureFromRawProfiles([
        {
          id: 'ws-hijack',
          revision: 1,
          enabled: true,
          scope: 'workspace',
          protocol: 'otlp-http-json',
          signals: ['metrics'],
          contentPolicy: 'metadata-only',
          endpoint: 'http://127.0.0.1:4318/v1/metrics',
          allowPlaintextLoopback: true,
          credential: null
        }
      ]);
      expect(wsEval).toEqual({ kind: 'refused', reason: 'scope-not-authorized' });
      expect(transportCalls).toBe(0);
    } finally {
      sqliteStore.close();
    }
  });

  it('F14-AC-02, F14-AC-03, F14-AC-07 & F14-AC-09: exports accepted SQLite usage/outcome/correction over real loopback HTTP with SecretStorage header, preserves unknown cost, deduplicates copies, and ignores malicious remote responses', async () => {
    const storageRoot = await makeTempStorageRoot('ac02');
    const sqliteStore = new SqliteApplicationStore({
      databasePath: path.join(storageRoot, 'state.sqlite'),
      journalMode: 'wal'
    });

    const receivedBodies: string[] = [];
    const receivedAuthHeaders: Array<string | undefined> = [];
    const server = http.createServer((req, res) => {
      receivedAuthHeaders.push(req.headers.authorization);
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        receivedBodies.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        // Malicious acknowledgement attempting to inject usage or query state (F14-AC-09).
        res.end(
          JSON.stringify({
            partialSuccess: { rejectedDataPoints: '0' },
            injectObservation: { observationId: 'evil-obs', tokens: 99999999 },
            sql: 'DROP TABLE accounting_observations'
          })
        );
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

    try {
      const accounting = createUsageAccountingService({
        conn: sqliteStore.writerConnection,
        nowUtc: () => '2026-11-12T00:00:00.000Z',
        monotonicMs: () => 200,
        workspaceId: 'ws-ac02'
      });

      const secretValue = 'Bearer super-secret-credential-98765';
      const host = createTelemetryHostService({
        sqliteStore,
        storageRoot,
        secrets: createMemorySecretPort({ 'collector-key': secretValue }),
        isWorkspaceTrusted: () => true,
        serviceVersion: '0.2.0'
      });

      const authEval = host.configureFromUserSettings({
        enabled: true,
        endpoint: `http://127.0.0.1:${String(port)}/v1/metrics`,
        protocol: 'otlp-http-json',
        allowPlaintextLoopback: true,
        credentialSecretKey: 'collector-key',
        credentialHeaderName: 'Authorization',
        contentPolicy: 'metadata-only'
      });
      expect(authEval.kind).toBe('authorized');

      const obsRes = accounting.ingestObservation({
        producerNamespace: 'acp-runtime',
        source: 'acp-runtime',
        sourceKind: 'acp-usage-update',
        sourceIdentity: 'secret-prompt:/Users/alice/private-repo/secret.ts',
        observationRevision: 1,
        rootId: 'run-secret-id',
        attemptId: 'attempt-secret-id',
        invocationOrdinal: 0,
        counterScope: 'invocation-delta',
        adapterVersion: '1.0.0',
        dimensions: {
          backend: 'claude',
          modelRequested: 'claude-sonnet-4-5',
          modelReported: 'claude-sonnet-4-5'
        },
        eventUtc: '2026-11-12T00:00:00.000Z',
        observedUtc: '2026-11-12T00:00:00.000Z',
        measures: [
          {
            measure: 'input_tokens',
            quantity: 1200,
            unit: 'count',
            completeness: 'known',
            provenance: 'provider-reported'
          },
          {
            measure: 'cost',
            quantity: null,
            unit: 'USD',
            completeness: 'unknown',
            provenance: 'provider-reported',
            unknownReason: 'provider-omitted'
          }
        ]
      });
      expect(obsRes.ok).toBe(true);
      const obsId = obsRes.ok ? obsRes.value.observationId : '';

      // Headless normalization parity check (F14-AC-07).
      const normalized = normalizeAcceptedObservationFromSqlite(sqliteStore, obsId);
      expect(normalized).not.toBeNull();
      expect(JSON.stringify(normalized)).not.toContain('/Users/alice');
      expect(JSON.stringify(normalized)).not.toContain('run-secret-id');
      expect(JSON.stringify(normalized)).not.toContain('attempt-secret-id');

      const firstOffer = host.offerAcceptedObservationById(obsId);
      expect(firstOffer).toEqual({ accepted: 1, duplicate: 0, refused: 0 });

      // Duplicate offer of the same accepted source observation is deduplicated via SQLite ledger (F14-AC-03).
      const dupOffer = host.offerAcceptedObservationById(obsId);
      expect(dupOffer).toEqual({ accepted: 0, duplicate: 1, refused: 0 });

      // Outcome + correction offers (F14-AC-02).
      accounting.recordAttemptOutcome({ attemptId: 'attempt-secret-id', outcome: 'succeeded' });
      expect(
        host.offerAcceptedAttemptOutcome({
          attemptId: 'attempt-secret-id',
          outcome: 'succeeded',
          durationMs: 350,
          revision: 1
        }).accepted
      ).toBe(1);

      const corr = accounting.applyCorrection({
        targetObservationId: obsId,
        measure: 'input_tokens',
        replacementQuantity: 1300,
        unit: 'count',
        reasonCode: 'provider-reconciled',
        actor: 'operator'
      });
      expect(corr.ok).toBe(true);
      if (corr.ok) {
        expect(
          host.offerAcceptedCorrection({
            correctionId: corr.value.correctionId,
            previousQuantity: 1200
          }).accepted
        ).toBe(1);
      }

      host.flush();
      await host.idle();

      expect(receivedBodies.length).toBe(1);
      expect(receivedAuthHeaders[0]).toBe(secretValue);
      const sentBody = receivedBodies[0] ?? '';
      expect(sentBody).toContain('gen_ai.client.token.usage');
      expect(sentBody).not.toContain(secretValue);
      expect(sentBody).not.toContain('/Users/alice');
      expect(sentBody).not.toContain('attempt-secret-id');

      // Malicious remote response did not alter authoritative local F06 SQLite records (F14-AC-09).
      const obsCount = Number(
        sqliteStore.writerConnection.scalar(`SELECT COUNT(*) FROM accounting_observations`) ?? 0
      );
      expect(obsCount).toBe(1);
      expect(host.getStatus().health.acknowledgedBatches).toBe(1);
      expect(host.getStatus().mappingRevision).toBe(TELEMETRY_MAPPING_REVISION);

      await host.shutdown();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      sqliteStore.close();
    }
  });

  it('F14-AC-04: enforces 1,000 attribute-set cap (999 ordinary + 1 overflow), persists cardinality dictionary in SQLite, and previews explicit content-export refusal', async () => {
    const storageRoot = await makeTempStorageRoot('ac04');
    const sqliteStore = new SqliteApplicationStore({
      databasePath: path.join(storageRoot, 'state.sqlite'),
      journalMode: 'wal'
    });
    try {
      const preview = buildTelemetryExportPreview(
        {
          enabled: true,
          endpoint: 'http://127.0.0.1:4318/v1/metrics',
          protocol: 'otlp-http-json',
          allowPlaintextLoopback: true,
          credentialSecretKey: '',
          credentialHeaderName: 'Authorization',
          contentPolicy: 'content'
        },
        { workspaceTrusted: true, secretStore: 'available' }
      );
      expect(preview.effectiveStatus).toBe('refused');
      expect(preview.refusalReason).toBe('content-export-unsupported');
      expect(preview.contentExportSupported).toBe(false);
      expect(preview.redactionLimitsDisclosure).toContain('risk reduction');

      const payloads: string[] = [];
      const host = createTelemetryHostService({
        sqliteStore,
        storageRoot,
        secrets: null,
        isWorkspaceTrusted: () => true,
        transport: {
          async send(req: TransportRequest): Promise<TransportResult> {
            payloads.push(Buffer.from(req.body).toString('utf8'));
            return {
              kind: 'response',
              statusCode: 200,
              retryAfterSeconds: null,
              body: new Uint8Array(0),
              bodyTruncated: false
            };
          }
        }
      });

      host.configureFromUserSettings({
        enabled: true,
        endpoint: 'http://127.0.0.1:4318/v1/metrics',
        protocol: 'otlp-http-json',
        allowPlaintextLoopback: true,
        credentialSecretKey: '',
        credentialHeaderName: 'Authorization',
        contentPolicy: 'metadata-only'
      });

      // Offer 1,001 distinct model attribute sets (F14-AC-04, F14-NFR-07).
      const records = Array.from({ length: 1_001 }, (_, idx) => ({
        sourceSchema: TELEMETRY_SOURCE_SCHEMA,
        kind: 'usage' as const,
        sourceId: `card-rec-${String(idx + 1)}`,
        sourceRevision: 1,
        backend: 'claude',
        modelRequested: `claude-model-${String(idx + 1)}`,
        modelReported: `claude-model-${String(idx + 1)}`,
        measures: [
          {
            measure: 'input_tokens' as const,
            quantity: '10',
            unit: 'count',
            completeness: 'known' as const,
            provenance: 'provider-reported' as const,
            cacheRelation: null
          }
        ]
      }));

      const res = host.offerRecords(records);
      expect(res.accepted).toBe(1_001);
      host.flush();
      await host.idle();

      const status = host.getStatus();
      expect(status.health.coverage.overflow).toBeGreaterThanOrEqual(2);
      expect(
        host.ledger.cardinalitySetCount({
          profileId: 'user-default',
          instrument: 'token-usage'
        })
      ).toBe(TELEMETRY_EXPORT_BOUNDS.attributeSetsMax - 1);
      expect(payloads.join('\n')).toContain('otel.metric.overflow');
      await host.shutdown();
    } finally {
      sqliteStore.close();
    }
  });

  it('F14-AC-05, F14-AC-06 & F14-AC-10: spools retry-exhausted batches as private 0o600 files, respects 250 ms shutdown budget, reconciles crash orphans, and refuses stale authorization on replay', async () => {
    const storageRoot = await makeTempStorageRoot('ac05-ac10');
    const dbPath = path.join(storageRoot, 'state.sqlite');
    let sqliteStore = new SqliteApplicationStore({
      databasePath: dbPath,
      journalMode: 'wal'
    });

    try {
      let now = Date.now() - 120_000;
      const pendingTimers: Array<() => void> = [];
      let shouldFail = true;
      let postRevocationSends = 0;

      const host = createTelemetryHostService({
        sqliteStore,
        storageRoot,
        secrets: null,
        isWorkspaceTrusted: () => true,
        clock: { now: () => now },
        timers: {
          set: (cb) => {
            pendingTimers.push(cb);
            return pendingTimers.length;
          },
          clear: () => undefined
        },
        random: () => 0.5,
        transport: {
          async send(): Promise<TransportResult> {
            if (!shouldFail) {
              postRevocationSends += 1;
              return {
                kind: 'response',
                statusCode: 200,
                retryAfterSeconds: null,
                body: new Uint8Array(0),
                bodyTruncated: false
              };
            }
            return { kind: 'failure', errorClass: 'network' };
          }
        }
      });

      host.configureFromUserSettings({
        enabled: true,
        endpoint: 'http://127.0.0.1:4318/v1/metrics',
        protocol: 'otlp-http-json',
        allowPlaintextLoopback: true,
        credentialSecretKey: '',
        credentialHeaderName: 'Authorization',
        contentPolicy: 'metadata-only'
      });

      host.offerRecords([
        {
          sourceSchema: TELEMETRY_SOURCE_SCHEMA,
          kind: 'operation',
          sourceId: 'op-fail-1',
          sourceRevision: 1,
          backend: 'codex',
          modelRequested: 'gpt-5',
          modelReported: 'gpt-5',
          durationMs: 120,
          outcome: 'succeeded'
        }
      ]);
      host.flush();

      // Advance clock past retry budget (30s) and fire retry timer so batch exhausts retries and spools to disk.
      await new Promise<void>((r) => setImmediate(r));
      now += TELEMETRY_EXPORT_BOUNDS.retryBudgetMs + 5_000;
      while (pendingTimers.length > 0) {
        const cb = pendingTimers.shift();
        cb?.();
        await new Promise<void>((r) => setImmediate(r));
      }
      // idle() waits for the unawaited spool itself; a fixed 20 ms wait read 0 under load (Linux leg).
      await host.idle();

      expect(host.spool.stats().spooledBatches).toBe(1);
      const spoolDir = path.join(storageRoot, 'telemetry-spool');
      const spoolFiles = await fsp.readdir(spoolDir);
      expect(spoolFiles.length).toBe(1);
      const st = await fsp.stat(path.join(spoolDir, spoolFiles[0]!));
      expect(st.mode & 0o077).toBe(0);

      // Seed an orphan crash file with no SQLite row (F14-AC-10).
      await fsp.writeFile(path.join(spoolDir, 'orphan-crash.json'), '{"orphan":true}', {
        mode: 0o600
      });

      // Verify shutdown completes within 250 ms budget (F14-AC-06, F14-NFR-04).
      const t0 = performance.now();
      await host.shutdown();
      expect(performance.now() - t0).toBeLessThanOrEqual(TELEMETRY_EXPORT_BOUNDS.shutdownBudgetMs);
      sqliteStore.close();

      // Reopen store after simulated crash and configure a DIFFERENT endpoint (authorization generation bumps).
      sqliteStore = new SqliteApplicationStore({
        databasePath: dbPath,
        journalMode: 'wal'
      });
      shouldFail = false;

      const reopened = createTelemetryHostService({
        sqliteStore,
        storageRoot,
        secrets: null,
        isWorkspaceTrusted: () => true,
        transport: {
          async send(): Promise<TransportResult> {
            postRevocationSends += 1;
            return {
              kind: 'response',
              statusCode: 200,
              retryAfterSeconds: null,
              body: new Uint8Array(0),
              bodyTruncated: false
            };
          }
        }
      });

      reopened.configureFromUserSettings({
        enabled: true,
        endpoint: 'http://127.0.0.1:4319/v1/metrics',
        protocol: 'otlp-http-json',
        allowPlaintextLoopback: true,
        credentialSecretKey: '',
        credentialHeaderName: 'Authorization',
        contentPolicy: 'metadata-only',
        profileRevision: 2
      });

      const reconciled = await reopened.reconcileAndReplaySpool();
      // Stale authorization generation cannot send queued copies (F14-AC-10)!
      expect(postRevocationSends).toBe(0);
      expect(reconciled.replayed).toBe(0);
      expect(reopened.spool.stats().spooledBatches).toBe(0);
      const remainingFiles = await fsp.readdir(spoolDir);
      expect(remainingFiles).toEqual([]);

      await reopened.shutdown();
    } finally {
      sqliteStore.close();
    }
  });
});

describe('a spool that outlives its database (review gap closure, 2026-11-12)', () => {
  const DESTINATION: ResolvedDestination = {
    profileId: 'spool-close-profile',
    profileRevision: 1,
    endpoint: 'http://127.0.0.1:4318/v1/metrics',
    plaintextLoopback: true,
    credential: null
  };
  const SPOOL_DIR_NAME = 'telemetry-spool';

  async function spoolFiles(storageRoot: string): Promise<string[]> {
    return fsp.readdir(path.join(storageRoot, SPOOL_DIR_NAME)).catch(() => []);
  }

  it('resolves as not spooled, and writes nothing, when the store is already closed', async () => {
    const storageRoot = await makeTempStorageRoot('spool-closed');
    const sqliteStore = new SqliteApplicationStore({
      databasePath: path.join(storageRoot, 'state.sqlite'),
      journalMode: 'wal'
    });
    const host = createTelemetryHostService({
      sqliteStore,
      storageRoot,
      secrets: null,
      isWorkspaceTrusted: () => true
    });
    sqliteStore.close();

    await expect(
      host.spool.spoolBatch({
        batchId: 'closed-before',
        destination: DESTINATION,
        authorizationGeneration: 1,
        body: new Uint8Array([1, 2, 3])
      })
    ).resolves.toEqual({ spooled: false, droppedBatchIds: ['closed-before'] });
    expect(await spoolFiles(storageRoot)).toEqual([]);
  });

  it('resolves as not spooled, and removes its file, when the store closes while the file is written', async () => {
    const storageRoot = await makeTempStorageRoot('spool-closing');
    const sqliteStore = new SqliteApplicationStore({
      databasePath: path.join(storageRoot, 'state.sqlite'),
      journalMode: 'wal'
    });
    const host = createTelemetryHostService({
      sqliteStore,
      storageRoot,
      secrets: null,
      isWorkspaceTrusted: () => true
    });

    const pending = host.spool.spoolBatch({
      batchId: 'closed-during',
      destination: DESTINATION,
      authorizationGeneration: 1,
      body: new Uint8Array([1, 2, 3])
    });
    // The spool has read its ledger and is now awaiting the file open: the window the Linux leg hit.
    sqliteStore.close();

    await expect(pending).resolves.toEqual({ spooled: false, droppedBatchIds: ['closed-during'] });
    expect(await spoolFiles(storageRoot)).toEqual([]);
  });

  it('reports a failed spool through the side-effect reporter, and idle() waits for it', async () => {
    const storageRoot = await makeTempStorageRoot('spool-reported');
    const sqliteStore = new SqliteApplicationStore({
      databasePath: path.join(storageRoot, 'state.sqlite'),
      journalMode: 'wal'
    });
    const realConnection = sqliteStore.writerConnection;
    const leakedPath = '/Users/someone/private/state.sqlite';
    const failingConnection = new Proxy(realConnection, {
      get(target, key) {
        if (key === 'run') {
          return (sql: string, ...params: unknown[]): unknown => {
            if (sql.includes('INSERT INTO telemetry_spool_batches')) {
              throw new Error(`disk I/O error at ${leakedPath}`);
            }
            return (target.run as (s: string, ...p: unknown[]) => unknown).call(target, sql, ...params);
          };
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      }
    });
    const storeView = new Proxy(sqliteStore, {
      get(target, key) {
        if (key === 'writerConnection') return failingConnection;
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      }
    });
    const reports: Array<{ readonly operation: string; readonly thrown: unknown }> = [];

    try {
      let now = Date.now() - 120_000;
      const pendingTimers: Array<() => void> = [];
      const host = createTelemetryHostService({
        sqliteStore: storeView,
        storageRoot,
        secrets: null,
        isWorkspaceTrusted: () => true,
        clock: { now: () => now },
        timers: {
          set: (cb) => {
            pendingTimers.push(cb);
            return pendingTimers.length;
          },
          clear: () => undefined
        },
        random: () => 0.5,
        transport: {
          async send(): Promise<TransportResult> {
            return { kind: 'failure', errorClass: 'network' };
          }
        },
        reportSideEffectFailure: (operation, thrown) => {
          reports.push({ operation, thrown });
        }
      });
      host.configureFromUserSettings({
        enabled: true,
        endpoint: DESTINATION.endpoint,
        protocol: 'otlp-http-json',
        allowPlaintextLoopback: true,
        credentialSecretKey: '',
        credentialHeaderName: 'Authorization',
        contentPolicy: 'metadata-only'
      });
      host.offerRecords([
        {
          sourceSchema: TELEMETRY_SOURCE_SCHEMA,
          kind: 'operation',
          sourceId: 'op-spool-report',
          sourceRevision: 1,
          backend: 'codex',
          modelRequested: 'gpt-5',
          modelReported: 'gpt-5',
          durationMs: 120,
          outcome: 'succeeded'
        }
      ]);
      host.flush();
      await new Promise<void>((r) => setImmediate(r));
      now += TELEMETRY_EXPORT_BOUNDS.retryBudgetMs + 5_000;
      while (pendingTimers.length > 0) {
        pendingTimers.shift()?.();
        await new Promise<void>((r) => setImmediate(r));
      }

      await host.idle();

      expect(reports.map((r) => r.operation)).toEqual(['telemetry-spool']);
      expect(host.spool.stats().spooledBatches).toBe(0);
      expect(await spoolFiles(storageRoot)).toEqual([]);
      await host.shutdown();
    } finally {
      sqliteStore.close();
    }
  });
});

describe('FR-R7-17 (R7-17-06): refusal parity, metrics-only wire, dimension isolation, fault safety & replay authorization', () => {
  interface ParsedOtlpMetric {
    readonly name: string;
    readonly unit?: string;
    readonly sum?: {
      readonly dataPoints: readonly {
        readonly attributes?: readonly { readonly key: string; readonly value?: { readonly stringValue?: string; readonly boolValue?: boolean } }[];
        readonly asInt?: string;
        readonly asDouble?: number;
      }[];
    };
    readonly histogram?: {
      readonly dataPoints: readonly {
        readonly attributes?: readonly { readonly key: string; readonly value?: { readonly stringValue?: string; readonly boolValue?: boolean } }[];
      }[];
    };
  }

  interface ParsedOtlpPayload {
    readonly resourceMetrics: readonly {
      readonly scopeMetrics: readonly {
        readonly metrics: readonly ParsedOtlpMetric[];
      }[];
    }[];
  }

  async function spoolDirFiles(storageRoot: string): Promise<string[]> {
    return fsp.readdir(path.join(storageRoot, 'telemetry-spool')).catch(() => []);
  }

  async function spoolOneBatchAndShutdown(params: {
    readonly storageRoot: string;
    readonly dbPath: string;
    readonly settings: Parameters<ReturnType<typeof createTelemetryHostService>['configureFromUserSettings']>[0];
    readonly secrets?: TelemetrySecretPort | null;
    readonly batchCount?: number;
  }): Promise<{ readonly generation: number }> {
    const sqliteStore = new SqliteApplicationStore({
      databasePath: params.dbPath,
      journalMode: 'wal'
    });
    try {
      let now = Date.now() - 120_000;
      const pendingTimers: Array<() => void> = [];
      const host = createTelemetryHostService({
        sqliteStore,
        storageRoot: params.storageRoot,
        secrets: params.secrets ?? null,
        isWorkspaceTrusted: () => true,
        clock: { now: () => now },
        timers: {
          set: (cb) => {
            pendingTimers.push(cb);
            return pendingTimers.length;
          },
          clear: () => undefined
        },
        random: () => 0.5,
        transport: {
          async send(): Promise<TransportResult> {
            return { kind: 'failure', errorClass: 'network' };
          }
        }
      });

      const evalRes = host.configureFromUserSettings(params.settings);
      expect(evalRes.kind).toBe('authorized');
      const count = params.batchCount ?? 1;
      for (let i = 0; i < count; i += 1) {
        host.offerRecords([
          {
            sourceSchema: TELEMETRY_SOURCE_SCHEMA,
            kind: 'operation',
            sourceId: `spool-seed-${String(i + 1)}`,
            sourceRevision: 1,
            backend: 'codex',
            modelRequested: 'gpt-5',
            modelReported: 'gpt-5',
            durationMs: 120 + i,
            outcome: 'succeeded'
          }
        ]);
        host.flush();
        await new Promise<void>((r) => setImmediate(r));
        now += TELEMETRY_EXPORT_BOUNDS.retryBudgetMs + 5_000;
        while (pendingTimers.length > 0) {
          pendingTimers.shift()?.();
          await new Promise<void>((r) => setImmediate(r));
        }
        await host.idle();
      }
      expect(host.spool.stats().spooledBatches).toBe(count);
      const generation = host.getStatus().authorizationGeneration;
      await host.shutdown();
      return { generation };
    } finally {
      sqliteStore.close();
    }
  }

  it('refuses contentPolicy: content initially and revokes active delivery + spooled batches when switched mid-session', async () => {
    const storageRoot = await makeTempStorageRoot('content-refusal');
    const sqliteStore = new SqliteApplicationStore({
      databasePath: path.join(storageRoot, 'state.sqlite'),
      journalMode: 'wal'
    });
    try {
      let sends = 0;
      let abortedInFlight = false;
      let now = 1_700_000_000_000;
      const pendingTimers: Array<() => void> = [];
      let hangNext = false;

      const host = createTelemetryHostService({
        sqliteStore,
        storageRoot,
        secrets: null,
        isWorkspaceTrusted: () => true,
        clock: { now: () => now },
        timers: {
          set: (cb) => {
            pendingTimers.push(cb);
            return pendingTimers.length;
          },
          clear: () => undefined
        },
        random: () => 0.5,
        transport: {
          send(req: TransportRequest): Promise<TransportResult> {
            sends += 1;
            if (hangNext) {
              return new Promise((resolve) => {
                req.signal.addEventListener(
                  'abort',
                  () => {
                    abortedInFlight = true;
                    resolve({ kind: 'failure', errorClass: 'aborted' });
                  },
                  { once: true }
                );
              });
            }
            return Promise.resolve({ kind: 'failure', errorClass: 'network' });
          }
        }
      });

      // Initial configuration with contentPolicy: 'content' is refused with zero sends and zero spool files.
      const refused = host.configureFromUserSettings({
        enabled: true,
        endpoint: 'http://127.0.0.1:4318/v1/metrics',
        protocol: 'otlp-http-json',
        allowPlaintextLoopback: true,
        credentialSecretKey: '',
        credentialHeaderName: 'Authorization',
        contentPolicy: 'content'
      });
      expect(refused).toEqual({ kind: 'refused', reason: 'content-export-unsupported' });
      const refusedStatus = host.getStatus();
      expect(refusedStatus.preview).toMatchObject({
        contentExportSupported: false,
        effectiveStatus: 'refused',
        refusalReason: 'content-export-unsupported',
        requestedContentPolicy: 'content'
      });
      expect(
        host.offerRecords([
          {
            sourceSchema: TELEMETRY_SOURCE_SCHEMA,
            kind: 'operation',
            sourceId: 'refused-initial',
            sourceRevision: 1,
            backend: 'claude',
            modelRequested: 'claude-sonnet-4-5',
            modelReported: 'claude-sonnet-4-5',
            durationMs: 42,
            outcome: 'succeeded'
          }
        ])
      ).toEqual({ accepted: 0, duplicate: 0, refused: 1 });
      host.flush();
      await host.idle();
      expect(sends).toBe(0);
      expect(await spoolDirFiles(storageRoot)).toEqual([]);

      // Authorize metadata-only, spool 1 batch, then start an in-flight batch and switch to contentPolicy: 'content'.
      const authEval = host.configureFromUserSettings({
        enabled: true,
        endpoint: 'http://127.0.0.1:4318/v1/metrics',
        protocol: 'otlp-http-json',
        allowPlaintextLoopback: true,
        credentialSecretKey: '',
        credentialHeaderName: 'Authorization',
        contentPolicy: 'metadata-only'
      });
      expect(authEval.kind).toBe('authorized');
      const genBeforeSwitch = host.getStatus().authorizationGeneration;

      host.offerRecords([
        {
          sourceSchema: TELEMETRY_SOURCE_SCHEMA,
          kind: 'operation',
          sourceId: 'mid-switch-spool',
          sourceRevision: 1,
          backend: 'claude',
          modelRequested: 'claude-sonnet-4-5',
          modelReported: 'claude-sonnet-4-5',
          durationMs: 100,
          outcome: 'succeeded'
        }
      ]);
      host.flush();
      await new Promise<void>((r) => setImmediate(r));
      now += TELEMETRY_EXPORT_BOUNDS.retryBudgetMs + 5_000;
      while (pendingTimers.length > 0) {
        pendingTimers.shift()?.();
        await new Promise<void>((r) => setImmediate(r));
      }
      await host.idle();
      expect(host.spool.stats().spooledBatches).toBe(1);

      // Start an in-flight request, then switch mid-session to contentPolicy: 'content'.
      hangNext = true;
      host.offerRecords([
        {
          sourceSchema: TELEMETRY_SOURCE_SCHEMA,
          kind: 'operation',
          sourceId: 'mid-switch-inflight',
          sourceRevision: 1,
          backend: 'claude',
          modelRequested: 'claude-sonnet-4-5',
          modelReported: 'claude-sonnet-4-5',
          durationMs: 110,
          outcome: 'succeeded'
        }
      ]);
      host.flush();
      await new Promise<void>((r) => setImmediate(r));
      const sendsBeforeSwitch = sends;

      const switchedEval = host.configureFromUserSettings({
        enabled: true,
        endpoint: 'http://127.0.0.1:4318/v1/metrics',
        protocol: 'otlp-http-json',
        allowPlaintextLoopback: true,
        credentialSecretKey: '',
        credentialHeaderName: 'Authorization',
        contentPolicy: 'content'
      });
      expect(switchedEval).toEqual({ kind: 'refused', reason: 'content-export-unsupported' });
      await host.idle();

      expect(abortedInFlight).toBe(true);
      expect(host.getStatus().authorizationGeneration).toBeGreaterThan(genBeforeSwitch);
      expect(host.getStatus().preview).toMatchObject({
        contentExportSupported: false,
        effectiveStatus: 'refused',
        refusalReason: 'content-export-unsupported',
        requestedContentPolicy: 'content'
      });
      expect(host.spool.stats().spooledBatches).toBe(0);
      expect(await spoolDirFiles(storageRoot)).toEqual([]);
      expect(sends).toBe(sendsBeforeSwitch);

      await host.shutdown();
    } finally {
      sqliteStore.close();
    }
  });

  it('exports strictly resourceMetrics OTLP JSON with unknown cost as missing, zero content, and refuses non-metrics/protocols/untrusted/unavailable-secrets', async () => {
    const storageRoot = await makeTempStorageRoot('metrics-only-wire');
    const sqliteStore = new SqliteApplicationStore({
      databasePath: path.join(storageRoot, 'state.sqlite'),
      journalMode: 'wal'
    });
    const receivedBodies: string[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        receivedBodies.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    const endpoint = `http://127.0.0.1:${String(port)}/v1/metrics`;

    try {
      let trusted = true;
      let secretStoreAvailable = true;
      const host = createTelemetryHostService({
        sqliteStore,
        storageRoot,
        secrets: {
          availability: () => (secretStoreAvailable ? 'available' : 'unavailable'),
          async read(ref) {
            return ref === 'valid-key' ? 'synthetic-header-token' : null;
          }
        },
        isWorkspaceTrusted: () => trusted,
        serviceVersion: '0.2.0'
      });

      // Refuse non-metrics signals, unsupported protocols, untrusted workspace, and unavailable secret store with 0 sends.
      expect(
        host.configureFromRawProfiles([
          {
            id: 'p-traces',
            revision: 1,
            enabled: true,
            scope: 'user',
            protocol: 'otlp-http-json',
            signals: ['traces'],
            contentPolicy: 'metadata-only',
            endpoint,
            allowPlaintextLoopback: true,
            credential: null
          }
        ])
      ).toEqual({ kind: 'refused', reason: 'signal-unsupported' });
      expect(
        host.configureFromRawProfiles([
          {
            id: 'p-logs',
            revision: 1,
            enabled: true,
            scope: 'user',
            protocol: 'otlp-http-json',
            signals: ['logs'],
            contentPolicy: 'metadata-only',
            endpoint,
            allowPlaintextLoopback: true,
            credential: null
          }
        ])
      ).toEqual({ kind: 'refused', reason: 'signal-unsupported' });
      expect(
        host.configureFromUserSettings({
          enabled: true,
          endpoint,
          protocol: 'otlp-http-protobuf',
          allowPlaintextLoopback: true,
          credentialSecretKey: '',
          credentialHeaderName: 'Authorization',
          contentPolicy: 'metadata-only'
        })
      ).toEqual({ kind: 'refused', reason: 'protocol-unsupported' });
      expect(
        host.configureFromUserSettings({
          enabled: true,
          endpoint,
          protocol: 'otlp-grpc',
          allowPlaintextLoopback: true,
          credentialSecretKey: '',
          credentialHeaderName: 'Authorization',
          contentPolicy: 'metadata-only'
        })
      ).toEqual({ kind: 'refused', reason: 'protocol-unsupported' });

      trusted = false;
      expect(
        host.configureFromUserSettings({
          enabled: true,
          endpoint,
          protocol: 'otlp-http-json',
          allowPlaintextLoopback: true,
          credentialSecretKey: '',
          credentialHeaderName: 'Authorization',
          contentPolicy: 'metadata-only'
        })
      ).toEqual({ kind: 'refused', reason: 'workspace-untrusted' });
      trusted = true;

      secretStoreAvailable = false;
      expect(
        host.configureFromUserSettings({
          enabled: true,
          endpoint,
          protocol: 'otlp-http-json',
          allowPlaintextLoopback: true,
          credentialSecretKey: 'valid-key',
          credentialHeaderName: 'Authorization',
          contentPolicy: 'metadata-only'
        })
      ).toEqual({ kind: 'refused', reason: 'secret-store-unavailable' });
      secretStoreAvailable = true;

      expect(receivedBodies).toHaveLength(0);
      expect(await spoolDirFiles(storageRoot)).toEqual([]);

      // Now opt in cleanly with metadata-only metrics and verify parsed OTLP JSON wire structure.
      expect(
        host.configureFromUserSettings({
          enabled: true,
          endpoint,
          protocol: 'otlp-http-json',
          allowPlaintextLoopback: true,
          credentialSecretKey: 'valid-key',
          credentialHeaderName: 'Authorization',
          contentPolicy: 'metadata-only'
        }).kind
      ).toBe('authorized');

      const accounting = createUsageAccountingService({
        conn: sqliteStore.writerConnection,
        nowUtc: () => '2026-11-23T10:00:00.000Z',
        monotonicMs: () => 500,
        workspaceId: 'ws-metrics-only'
      });

      const obs = accounting.ingestObservation({
        producerNamespace: 'acp-runtime',
        source: 'acp-runtime',
        sourceKind: 'acp-usage-update',
        sourceIdentity: 'PROMPT_BODY_MARKER_DO_NOT_EXPORT:/Users/dev/private/file.ts',
        observationRevision: 1,
        rootId: 'run-metrics-only',
        attemptId: 'att-metrics-only',
        invocationOrdinal: 0,
        counterScope: 'invocation-delta',
        adapterVersion: '1.0.0',
        dimensions: {
          backend: 'claude',
          modelRequested: 'claude-sonnet-4-5',
          modelReported: 'claude-sonnet-4-5'
        },
        eventUtc: '2026-11-23T10:00:00.000Z',
        observedUtc: '2026-11-23T10:00:00.000Z',
        measures: [
          {
            measure: 'input_tokens',
            quantity: 700,
            unit: 'count',
            completeness: 'known',
            provenance: 'provider-reported'
          },
          {
            measure: 'cost',
            quantity: null,
            unit: 'USD',
            completeness: 'unknown',
            provenance: 'provider-reported',
            unknownReason: 'provider-omitted'
          }
        ]
      });
      expect(obs.ok).toBe(true);
      const obsId = obs.ok ? obs.value.observationId : '';
      expect(host.offerAcceptedObservationById(obsId).accepted).toBe(1);

      accounting.recordAttemptOutcome({ attemptId: 'att-metrics-only', outcome: 'succeeded' });
      expect(
        host.offerAcceptedAttemptOutcome({
          attemptId: 'att-metrics-only',
          outcome: 'succeeded',
          durationMs: 420,
          revision: 1
        }).accepted
      ).toBe(1);

      const corr = accounting.applyCorrection({
        targetObservationId: obsId,
        measure: 'input_tokens',
        replacementQuantity: 750,
        unit: 'count',
        reasonCode: 'provider-reconciled',
        actor: 'operator'
      });
      expect(corr.ok).toBe(true);
      if (corr.ok) {
        expect(
          host.offerAcceptedCorrection({
            correctionId: corr.value.correctionId,
            previousQuantity: 700
          }).accepted
        ).toBe(1);
      }

      host.flush();
      await host.idle();

      expect(receivedBodies).toHaveLength(1);
      const rawWire = receivedBodies[0]!;
      const parsed = JSON.parse(rawWire) as ParsedOtlpPayload;
      expect(Object.keys(parsed)).toEqual(['resourceMetrics']);
      expect('resourceSpans' in parsed).toBe(false);
      expect('resourceLogs' in parsed).toBe(false);

      const metrics = parsed.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? [];
      const names = new Set(metrics.map((m) => m.name));
      expect(names.has('gen_ai.client.token.usage')).toBe(true);
      expect(names.has('gen_ai.client.operation.duration')).toBe(true);
      expect(names.has('schegent.usage.token_adjustment')).toBe(true);
      expect(names.has('schegent.export.coverage')).toBe(true);
      // Unknown cost MUST NOT be emitted as 0 on schegent.usage.cost — it is recorded as `missing` on coverage.
      expect(names.has('schegent.usage.cost')).toBe(false);
      const coverage = metrics.find((m) => m.name === 'schegent.export.coverage');
      const missingPoint = coverage?.sum?.dataPoints.find((dp) =>
        dp.attributes?.some((a) => a.key === 'schegent.export.outcome' && a.value?.stringValue === 'missing')
      );
      expect(missingPoint).toBeDefined();
      expect(Number(missingPoint?.asInt ?? '0')).toBeGreaterThanOrEqual(1);

      expect(rawWire).not.toContain('PROMPT_BODY_MARKER_DO_NOT_EXPORT');
      expect(rawWire).not.toContain('/Users/dev/private/file.ts');
      expect(rawWire).not.toContain('synthetic-header-token');

      await host.shutdown();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      sqliteStore.close();
    }
  });

  it('excludes plausible pattern-valid Run/attempt/session/workspace/phase/workflow IDs from wire, health, receipts, spool, and sanitizes durable cardinality sets', async () => {
    const storageRoot = await makeTempStorageRoot('dimension-isolation');
    const sqliteStore = new SqliteApplicationStore({
      databasePath: path.join(storageRoot, 'state.sqlite'),
      journalMode: 'wal'
    });
    const sentPayloads: string[] = [];

    try {
      const seededIds = {
        rootId: 'run-20261123-001',
        attemptId: 'att-20261123-001',
        providerSessionId: 'sess-20261123-abc',
        workspaceId: 'ws-20261123-01',
        phaseId: 'phase-impl-01',
        workflowRevision: 'wf-rev-42',
        producerEventId: 'evt-20261123-01',
        acpSessionId: 'acp-sess-20261123',
        turnId: 'turn-20261123-01'
      } as const;

      // Positive control: prove sanitizeDimension's pattern rule ALONE would NOT block any of these bounded IDs!
      for (const id of Object.values(seededIds)) {
        expect(sanitizeDimension('model', id), `model pattern positive control for ${id}`).toEqual({ value: id });
        expect(sanitizeDimension('backend', id), `backend pattern positive control for ${id}`).toEqual({ value: id });
      }

      const host = createTelemetryHostService({
        sqliteStore,
        storageRoot,
        secrets: null,
        isWorkspaceTrusted: () => true,
        transport: {
          async send(req: TransportRequest): Promise<TransportResult> {
            sentPayloads.push(Buffer.from(req.body).toString('utf8'));
            return {
              kind: 'response',
              statusCode: 200,
              retryAfterSeconds: null,
              body: new Uint8Array(0),
              bodyTruncated: false
            };
          }
        }
      });

      expect(
        host.configureFromUserSettings({
          enabled: true,
          endpoint: 'http://127.0.0.1:4318/v1/metrics',
          protocol: 'otlp-http-json',
          allowPlaintextLoopback: true,
          credentialSecretKey: '',
          credentialHeaderName: 'Authorization',
          contentPolicy: 'metadata-only'
        }).kind
      ).toBe('authorized');

      const accounting = createUsageAccountingService({
        conn: sqliteStore.writerConnection,
        nowUtc: () => '2026-11-23T11:00:00.000Z',
        monotonicMs: () => 1_000,
        workspaceId: seededIds.workspaceId
      });

      // 1. SQLite observation ingestion with all seeded IDs.
      const obs = accounting.ingestObservation({
        producerNamespace: 'acp-runtime',
        source: 'acp-runtime',
        sourceKind: 'acp-usage-update',
        sourceIdentity: seededIds.producerEventId,
        observationRevision: 1,
        rootId: seededIds.rootId,
        attemptId: seededIds.attemptId,
        invocationOrdinal: 0,
        counterScope: 'invocation-delta',
        adapterVersion: '1.0.0',
        dimensions: {
          backend: 'claude',
          modelRequested: 'claude-sonnet-4-5',
          modelReported: 'claude-sonnet-4-5',
          providerSessionId: seededIds.providerSessionId,
          phaseId: seededIds.phaseId,
          workflowRevision: seededIds.workflowRevision
        },
        eventUtc: '2026-11-23T11:00:00.000Z',
        observedUtc: '2026-11-23T11:00:00.000Z',
        measures: [
          {
            measure: 'input_tokens',
            quantity: 320,
            unit: 'count',
            completeness: 'known',
            provenance: 'provider-reported'
          }
        ]
      });
      expect(obs.ok).toBe(true);
      if (obs.ok) expect(host.offerAcceptedObservationById(obs.value.observationId).accepted).toBe(1);

      // 2. ACP usage update ingestion with seeded ACP session/turn/event IDs.
      const acpObs = accounting.ingestAcpUsageUpdate(
        {
          profileId: 'claude-acp-bridge',
          acpSessionId: seededIds.acpSessionId,
          connectionGeneration: 1,
          turnId: seededIds.turnId,
          hostReceiveSeq: 1,
          eventUtc: '2026-11-23T11:00:01.000Z',
          replayed: false,
          providerSessionId: seededIds.providerSessionId,
          producerEventId: seededIds.producerEventId,
          used: 1200,
          size: 200_000,
          cost: { amount: '0.025', currency: 'USD' },
          hasQualifiedSessionBaseline: true
        },
        {
          profileId: 'claude-acp-bridge',
          acpSessionId: seededIds.acpSessionId,
          connectionGeneration: 1,
          turnId: seededIds.turnId,
          rootId: seededIds.rootId,
          attemptId: seededIds.attemptId
        }
      );
      expect(acpObs.ok).toBe(true);
      if (acpObs.ok) expect(host.offerAcceptedObservationById(acpObs.value.observationId).accepted).toBe(1);

      // 3. Phase-end observation ingestion with seeded runId/phase/attemptId.
      const phaseEndObs = accounting.ingestPhaseEnd({
        runId: seededIds.rootId,
        phase: seededIds.phaseId,
        iteration: 1,
        timestamp: '2026-11-23T11:00:02.000Z',
        attemptId: seededIds.attemptId,
        backend: 'codex',
        model: 'gpt-5',
        outcome: 'succeeded',
        usage: {
          inputTokens: { kind: 'present', value: 400 },
          outputTokens: { kind: 'present', value: 150 },
          cacheReadInputTokens: { kind: 'absent' },
          cacheCreationInputTokens: { kind: 'absent' },
          costUsd: { kind: 'absent' }
        },
        costBaseline: null
      });
      expect(phaseEndObs.ok).toBe(true);
      if (phaseEndObs.ok) expect(host.offerAcceptedObservationById(phaseEndObs.value.observationId).accepted).toBe(1);

      // 4. Attempt outcome + correction ingestion.
      accounting.recordAttemptOutcome({ attemptId: seededIds.attemptId, outcome: 'succeeded' });
      expect(
        host.offerAcceptedAttemptOutcome({
          attemptId: seededIds.attemptId,
          outcome: 'succeeded',
          durationMs: 250,
          revision: 1
        }).accepted
      ).toBe(1);

      if (obs.ok) {
        const corr = accounting.applyCorrection({
          targetObservationId: obs.value.observationId,
          measure: 'input_tokens',
          replacementQuantity: 350,
          unit: 'count',
          reasonCode: 'provider-reconciled',
          actor: 'operator'
        });
        expect(corr.ok).toBe(true);
        if (corr.ok) {
          expect(
            host.offerAcceptedCorrection({
              correctionId: corr.value.correctionId,
              previousQuantity: 320
            }).accepted
          ).toBe(1);
        }
      }

      // 5. Raw offerRecords with an unsanitized path/free-text dimension MUST NOT enter SQLite telemetry_cardinality_sets.
      const rawUnsanitized = '/Users/alice/private-repo/secret-config.ts';
      host.offerRecords([
        {
          sourceSchema: TELEMETRY_SOURCE_SCHEMA,
          kind: 'operation',
          sourceId: 'unsanitized-dim-rec',
          sourceRevision: 1,
          backend: rawUnsanitized,
          modelRequested: rawUnsanitized,
          modelReported: rawUnsanitized,
          durationMs: 50,
          outcome: 'succeeded'
        }
      ]);

      host.flush();
      await host.idle();

      expect(sentPayloads.length).toBeGreaterThanOrEqual(1);
      const wireText = sentPayloads.join('\n');
      const cardinalityRows = sqliteStore.writerConnection.all<{ attribute_value: string }>(
        `SELECT attribute_value FROM telemetry_cardinality_sets`
      );
      const cardinalityText = JSON.stringify(cardinalityRows);
      const surfaceText = JSON.stringify([
        wireText,
        host.getStatus(),
        host.ledger.receipts(),
        host.ledger.dispositions(),
        cardinalityRows
      ]);

      // Zero seeded Run/attempt/session/workspace/phase/workflow/event/turn IDs anywhere!
      for (const id of Object.values(seededIds)) {
        expect(surfaceText, `seeded ID ${id} must not leak`).not.toContain(id);
      }
      // Raw unsanitized dimension string never entered wire OR SQLite telemetry_cardinality_sets.
      expect(wireText).not.toContain(rawUnsanitized);
      expect(cardinalityText).not.toContain(rawUnsanitized);

      // Actual backend and model dimensions ARE present on the wire.
      expect(wireText).toContain('claude-sonnet-4-5');
      expect(wireText).toContain('gpt-5');
      expect(wireText).toContain('"claude"');
      expect(wireText).toContain('"codex"');

      await host.shutdown();
    } finally {
      sqliteStore.close();
    }
  });

  it('produces zero unhandled rejections when host clock, timers, or replay credentials fault', async () => {
    const storageRoot = await makeTempStorageRoot('host-faults');
    const dbPath = path.join(storageRoot, 'state.sqlite');
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);

    const baseSettings = {
      enabled: true,
      endpoint: 'http://127.0.0.1:4318/v1/metrics',
      protocol: 'otlp-http-json' as const,
      allowPlaintextLoopback: true,
      credentialSecretKey: 'cred-key',
      credentialHeaderName: 'x-export-credential',
      contentPolicy: 'metadata-only' as const
    };

    try {
      await spoolOneBatchAndShutdown({
        storageRoot,
        dbPath,
        settings: baseSettings,
        secrets: createMemorySecretPort({ 'cred-key': 'synthetic-good-token' })
      });

      const sqliteStore = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
      try {
        let replaySends = 0;
        const host = createTelemetryHostService({
          sqliteStore,
          storageRoot,
          // Return an invalid CRLF header value during replay to verify isHeaderValue enforcement!
          secrets: createMemorySecretPort({ 'cred-key': 'bad-token\r\nx-injected: 1' }),
          isWorkspaceTrusted: () => true,
          clock: {
            now() {
              throw new Error('synthetic host clock fault');
            }
          },
          timers: {
            set() {
              throw new Error('synthetic host timer.set fault');
            },
            clear() {
              throw new Error('synthetic host timer.clear fault');
            }
          },
          random() {
            throw new Error('synthetic host random fault');
          },
          transport: {
            async send(): Promise<TransportResult> {
              replaySends += 1;
              return { kind: 'failure', errorClass: 'network' };
            }
          }
        });

        expect(() => host.configureFromUserSettings(baseSettings)).not.toThrow();
        const replayResult = await host.reconcileAndReplaySpool();
        expect(replaySends).toBe(0);
        expect(replayResult.replayed).toBe(0);
        expect(replayResult.dropped).toBe(1);
        expect(host.spool.stats().spooledBatches).toBe(0);

        // Also offer a live batch with throwing clock/timers/random and verify zero unhandled rejections.
        expect(() => {
          host.offerRecords([
            {
              sourceSchema: TELEMETRY_SOURCE_SCHEMA,
              kind: 'operation',
              sourceId: 'host-fault-live-1',
              sourceRevision: 1,
              backend: 'claude',
              modelRequested: 'claude-sonnet-4-5',
              modelReported: 'claude-sonnet-4-5',
              durationMs: 25,
              outcome: 'succeeded'
            }
          ]);
          host.flush();
        }).not.toThrow();
        await host.idle();
        await expect(host.shutdown()).resolves.toBeUndefined();
      } finally {
        sqliteStore.close();
      }

      await new Promise<void>((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('replays spooled batch ONCE on restart with identical authorization (positive control)', async () => {
    const storageRoot = await makeTempStorageRoot('replay-same-auth');
    const dbPath = path.join(storageRoot, 'state.sqlite');
    const receivedHeaders: Array<string | undefined> = [];
    const receivedBodies: string[] = [];
    const server = http.createServer((req, res) => {
      receivedHeaders.push(req.headers['x-export-credential'] as string | undefined);
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        receivedBodies.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

    const settings = {
      enabled: true,
      endpoint: `http://127.0.0.1:${String(port)}/v1/metrics`,
      protocol: 'otlp-http-json' as const,
      allowPlaintextLoopback: true,
      credentialSecretKey: 'same-cred-key',
      credentialHeaderName: 'x-export-credential',
      contentPolicy: 'metadata-only' as const,
      profileRevision: 1
    };

    try {
      const { generation: initialGen } = await spoolOneBatchAndShutdown({
        storageRoot,
        dbPath,
        settings,
        secrets: createMemorySecretPort({ 'same-cred-key': 'synthetic-replay-token' })
      });

      const sqliteStore = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
      try {
        const reopened = createTelemetryHostService({
          sqliteStore,
          storageRoot,
          secrets: createMemorySecretPort({ 'same-cred-key': 'synthetic-replay-token' }),
          isWorkspaceTrusted: () => true
        });
        expect(reopened.configureFromUserSettings(settings).kind).toBe('authorized');
        // Exact same destination preserves authorizationGeneration!
        expect(reopened.getStatus().authorizationGeneration).toBe(initialGen);

        const firstReplay = await reopened.reconcileAndReplaySpool();
        expect(firstReplay).toEqual({ replayed: 1, acknowledged: 1, dropped: 0, expired: 0 });
        expect(receivedBodies).toHaveLength(1);
        expect(receivedHeaders[0]).toBe('synthetic-replay-token');
        expect(reopened.spool.stats().spooledBatches).toBe(0);
        expect(await spoolDirFiles(storageRoot)).toEqual([]);

        // A second replay sends nothing.
        const secondReplay = await reopened.reconcileAndReplaySpool();
        expect(secondReplay).toEqual({ replayed: 0, acknowledged: 0, dropped: 0, expired: 0 });
        expect(receivedBodies).toHaveLength(1);

        await reopened.shutdown();
      } finally {
        sqliteStore.close();
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    [
      'different endpoint (same profileRevision: 1)',
      { endpoint: 'http://127.0.0.1:4319/v1/metrics' },
      true
    ],
    [
      'different credentialSecretKey (same endpoint & profileRevision: 1)',
      { credentialSecretKey: 'other-cred-key' },
      true
    ],
    [
      'different credentialHeaderName (same endpoint, key & profileRevision: 1)',
      { credentialHeaderName: 'x-other-header' },
      true
    ],
    [
      'different profileRevision',
      { profileRevision: 2 },
      true
    ],
    [
      'disabled',
      { enabled: false },
      true
    ],
    [
      'untrusted workspace',
      {},
      false
    ]
  ] as const)(
    'drops spooled batch with 0 post-revocation sends on restart with %s (negative control)',
    async (_label, overrideSettings, trustedOnReopen) => {
      const storageRoot = await makeTempStorageRoot('replay-diff-auth');
      const dbPath = path.join(storageRoot, 'state.sqlite');
      const initialSettings = {
        enabled: true,
        endpoint: 'http://127.0.0.1:4318/v1/metrics',
        protocol: 'otlp-http-json' as const,
        allowPlaintextLoopback: true,
        credentialSecretKey: 'orig-cred-key',
        credentialHeaderName: 'x-export-credential',
        contentPolicy: 'metadata-only' as const,
        profileRevision: 1
      };

      const { generation: initialGen } = await spoolOneBatchAndShutdown({
        storageRoot,
        dbPath,
        settings: initialSettings,
        secrets: createMemorySecretPort({ 'orig-cred-key': 'synthetic-token-a', 'other-cred-key': 'synthetic-token-b' })
      });

      const sqliteStore = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
      try {
        let postRevocationSends = 0;
        const reopened = createTelemetryHostService({
          sqliteStore,
          storageRoot,
          secrets: createMemorySecretPort({ 'orig-cred-key': 'synthetic-token-a', 'other-cred-key': 'synthetic-token-b' }),
          isWorkspaceTrusted: () => trustedOnReopen,
          transport: {
            async send(): Promise<TransportResult> {
              postRevocationSends += 1;
              return {
                kind: 'response',
                statusCode: 200,
                retryAfterSeconds: null,
                body: new Uint8Array(0),
                bodyTruncated: false
              };
            }
          }
        });

        reopened.configureFromUserSettings({ ...initialSettings, ...overrideSettings });
        expect(reopened.getStatus().authorizationGeneration).toBeGreaterThan(initialGen);

        const reconciled = await reopened.reconcileAndReplaySpool();
        expect(reconciled.replayed).toBe(0);
        expect(reconciled.dropped).toBeGreaterThanOrEqual(1);
        expect(postRevocationSends).toBe(0);
        expect(reopened.spool.stats().spooledBatches).toBe(0);
        expect(await spoolDirFiles(storageRoot)).toEqual([]);

        await reopened.shutdown();
      } finally {
        sqliteStore.close();
      }
    }
  );

  it('aborts in-flight live send and drops queued + spooled batches on host.disable(), enabled: false, and untrusted workspace', async () => {
    for (const mode of ['disable', 'enabled-false', 'untrusted'] as const) {
      const storageRoot = await makeTempStorageRoot(`revoke-${mode}`);
      const dbPath = path.join(storageRoot, 'state.sqlite');
      const settings = {
        enabled: true,
        endpoint: 'http://127.0.0.1:4318/v1/metrics',
        protocol: 'otlp-http-json' as const,
        allowPlaintextLoopback: true,
        credentialSecretKey: '',
        credentialHeaderName: 'Authorization',
        contentPolicy: 'metadata-only' as const
      };
      await spoolOneBatchAndShutdown({ storageRoot, dbPath, settings });

      const sqliteStore = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
      try {
        let trusted = true;
        let inFlightAborted = false;
        let sendCount = 0;
        const host = createTelemetryHostService({
          sqliteStore,
          storageRoot,
          secrets: null,
          isWorkspaceTrusted: () => trusted,
          transport: {
            send(req: TransportRequest): Promise<TransportResult> {
              sendCount += 1;
              return new Promise((resolve) => {
                req.signal.addEventListener(
                  'abort',
                  () => {
                    inFlightAborted = true;
                    resolve({ kind: 'failure', errorClass: 'aborted' });
                  },
                  { once: true }
                );
              });
            }
          }
        });

        expect(host.configureFromUserSettings(settings).kind).toBe('authorized');
        host.offerRecords([
          {
            sourceSchema: TELEMETRY_SOURCE_SCHEMA,
            kind: 'operation',
            sourceId: `live-in-flight-${mode}`,
            sourceRevision: 1,
            backend: 'claude',
            modelRequested: 'claude-sonnet-4-5',
            modelReported: 'claude-sonnet-4-5',
            durationMs: 100,
            outcome: 'succeeded'
          }
        ]);
        host.flush();
        await new Promise<void>((r) => setImmediate(r));
        expect(sendCount).toBe(1);

        // Queue a second batch behind the in-flight request.
        host.offerRecords([
          {
            sourceSchema: TELEMETRY_SOURCE_SCHEMA,
            kind: 'operation',
            sourceId: `live-queued-${mode}`,
            sourceRevision: 1,
            backend: 'claude',
            modelRequested: 'claude-sonnet-4-5',
            modelReported: 'claude-sonnet-4-5',
            durationMs: 100,
            outcome: 'succeeded'
          }
        ]);
        host.flush();

        if (mode === 'disable') {
          host.disable();
        } else if (mode === 'enabled-false') {
          host.configureFromUserSettings({ ...settings, enabled: false });
        } else {
          trusted = false;
          host.configureFromUserSettings(settings);
        }
        await host.idle();

        expect(inFlightAborted).toBe(true);
        expect(sendCount).toBe(1);
        expect(host.spool.stats().spooledBatches).toBe(0);
        expect(await spoolDirFiles(storageRoot)).toEqual([]);
        await host.shutdown();
      } finally {
        sqliteStore.close();
      }
    }
  });

  it.each(['disable', 'reconfigure'] as const)(
    'aborts in-flight batch 1 and never sends batch 2 during reconcileAndReplaySpool() when %s fires mid-replay',
    async (action) => {
      const storageRoot = await makeTempStorageRoot(`mid-replay-${action}`);
      const dbPath = path.join(storageRoot, 'state.sqlite');
      const settings = {
        enabled: true,
        endpoint: 'http://127.0.0.1:4318/v1/metrics',
        protocol: 'otlp-http-json' as const,
        allowPlaintextLoopback: true,
        credentialSecretKey: '',
        credentialHeaderName: 'Authorization',
        contentPolicy: 'metadata-only' as const,
        profileRevision: 1
      };

      await spoolOneBatchAndShutdown({ storageRoot, dbPath, settings, batchCount: 2 });

      const sqliteStore = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
      try {
        let sentCount = 0;
        let batch1Aborted = false;
        let resolveBatch1Arrived: (() => void) | null = null;
        const batch1Arrived = new Promise<void>((resolve) => {
          resolveBatch1Arrived = resolve;
        });

        const reopened = createTelemetryHostService({
          sqliteStore,
          storageRoot,
          secrets: null,
          isWorkspaceTrusted: () => true,
          transport: {
            send(req: TransportRequest): Promise<TransportResult> {
              sentCount += 1;
              if (sentCount === 1) {
                resolveBatch1Arrived?.();
                return new Promise((resolve) => {
                  const finishAbort = (): void => {
                    batch1Aborted = true;
                    resolve({ kind: 'failure', errorClass: 'aborted' });
                  };
                  if (req.signal.aborted) finishAbort();
                  else req.signal.addEventListener('abort', finishAbort, { once: true });
                });
              }
              return Promise.resolve({
                kind: 'response',
                statusCode: 200,
                retryAfterSeconds: null,
                body: new Uint8Array(0),
                bodyTruncated: false
              });
            }
          }
        });

        expect(reopened.configureFromUserSettings(settings).kind).toBe('authorized');
        const replayPromise = reopened.reconcileAndReplaySpool();

        // Wait until batch 1 is in flight, then revoke mid-replay.
        await batch1Arrived;
        if (action === 'disable') {
          reopened.disable();
        } else {
          reopened.configureFromUserSettings({
            ...settings,
            endpoint: 'http://127.0.0.1:4399/v1/metrics'
          });
        }

        const replayResult = await replayPromise;
        await reopened.idle();

        expect(batch1Aborted).toBe(true);
        // Batch 2 MUST NEVER be sent!
        expect(sentCount).toBe(1);
        expect(replayResult.acknowledged).toBe(0);
        expect(replayResult.dropped).toBe(2);
        const dispositions = reopened.ledger.dispositions();
        expect(dispositions).toHaveLength(2);
        expect(new Set(dispositions.map((d) => d.batchId)).size).toBe(2);
        expect(dispositions.every((d) => d.state === 'dropped')).toBe(true);
        expect(reopened.spool.stats().spooledBatches).toBe(0);
        expect(await spoolDirFiles(storageRoot)).toEqual([]);

        await reopened.shutdown();
      } finally {
        sqliteStore.close();
      }
    }
  );

  it('CR-313-2 / SR-313-1: fails closed on upgrade from a pre-fingerprint SQLite store with legacy spooled batches while keeping fresh enablement at generation 1', async () => {
    // 1. Fresh DB with empty spool stays at generation 1 on first-time enablement.
    const freshRoot = await makeTempStorageRoot('fresh-gen1');
    const freshStore = new SqliteApplicationStore({
      databasePath: path.join(freshRoot, 'state.sqlite'),
      journalMode: 'wal'
    });
    try {
      const freshHost = createTelemetryHostService({
        sqliteStore: freshStore,
        storageRoot: freshRoot,
        secrets: null,
        isWorkspaceTrusted: () => true
      });
      const evalFresh = freshHost.configureFromUserSettings({
        enabled: true,
        endpoint: 'http://127.0.0.1:4318/v1/metrics',
        protocol: 'otlp-http-json',
        allowPlaintextLoopback: true,
        credentialSecretKey: '',
        credentialHeaderName: 'Authorization',
        contentPolicy: 'metadata-only',
        profileRevision: 1
      });
      expect(evalFresh.kind).toBe('authorized');
      expect(freshHost.getStatus().authorizationGeneration).toBe(1);
      await freshHost.shutdown();
    } finally {
      freshStore.close();
    }

    // 2. Legacy pre-fingerprint DB containing a spooled batch MUST bump generation and drop it.
    const storageRoot = await makeTempStorageRoot('legacy-pre-fp');
    const dbPath = path.join(storageRoot, 'state.sqlite');
    const endpointASettings = {
      enabled: true,
      endpoint: 'http://127.0.0.1:4318/v1/metrics',
      protocol: 'otlp-http-json' as const,
      allowPlaintextLoopback: true,
      credentialSecretKey: '',
      credentialHeaderName: 'Authorization',
      contentPolicy: 'metadata-only' as const,
      profileRevision: 1
    };

    const { generation: initialGen } = await spoolOneBatchAndShutdown({
      storageRoot,
      dbPath,
      settings: endpointASettings
    });

    const sqliteStore = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    try {
      // Simulate upgrade from a pre-fingerprint schema: delete the fingerprint KV row while leaving the spooled batch.
      sqliteStore.writerConnection.run(
        `DELETE FROM operational_kv_documents
         WHERE doc_namespace = 'telemetry-export' AND doc_key = 'telemetry-authorization-fingerprint'`
      );
      const remainingSpoolRows = Number(
        sqliteStore.writerConnection.scalar(`SELECT COUNT(*) FROM telemetry_spool_batches`) ?? 0
      );
      expect(remainingSpoolRows).toBe(1);

      let sendsToEndpointB = 0;
      const reopened = createTelemetryHostService({
        sqliteStore,
        storageRoot,
        secrets: null,
        isWorkspaceTrusted: () => true,
        transport: {
          async send(): Promise<TransportResult> {
            sendsToEndpointB += 1;
            return {
              kind: 'response',
              statusCode: 200,
              retryAfterSeconds: null,
              body: new Uint8Array(0),
              bodyTruncated: false
            };
          }
        }
      });

      const evalB = reopened.configureFromUserSettings({
        ...endpointASettings,
        endpoint: 'http://127.0.0.1:4399/v1/metrics'
      });
      expect(evalB.kind).toBe('authorized');
      expect(reopened.getStatus().authorizationGeneration).toBeGreaterThan(initialGen);

      const replay = await reopened.reconcileAndReplaySpool();
      expect(replay.replayed).toBe(0);
      expect(replay.acknowledged).toBe(0);
      expect(replay.dropped).toBe(1);
      expect(sendsToEndpointB).toBe(0);
      expect(reopened.spool.stats().spooledBatches).toBe(0);
      expect(await spoolDirFiles(storageRoot)).toEqual([]);

      await reopened.shutdown();
    } finally {
      sqliteStore.close();
    }
  });

  it.each(['disable', 'shutdown'] as const)(
    'SR-313-2: overlapping reconcileAndReplaySpool() calls never duplicate sends and %s aborts the in-flight request',
    async (action) => {
      const storageRoot = await makeTempStorageRoot(`overlap-replay-${action}`);
      const dbPath = path.join(storageRoot, 'state.sqlite');
      const settings = {
        enabled: true,
        endpoint: 'http://127.0.0.1:4318/v1/metrics',
        protocol: 'otlp-http-json' as const,
        allowPlaintextLoopback: true,
        credentialSecretKey: '',
        credentialHeaderName: 'Authorization',
        contentPolicy: 'metadata-only' as const,
        profileRevision: 1
      };

      await spoolOneBatchAndShutdown({ storageRoot, dbPath, settings, batchCount: 2 });

      const sqliteStore = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
      try {
        let sendCount = 0;
        let abortedCount = 0;
        let resolveFirstArrived: (() => void) | null = null;
        const firstArrived = new Promise<void>((resolve) => {
          resolveFirstArrived = resolve;
        });

        const host = createTelemetryHostService({
          sqliteStore,
          storageRoot,
          secrets: null,
          isWorkspaceTrusted: () => true,
          transport: {
            send(req: TransportRequest): Promise<TransportResult> {
              sendCount += 1;
              if (sendCount === 1) {
                resolveFirstArrived?.();
              }
              return new Promise((resolve) => {
                const finishAbort = (): void => {
                  abortedCount += 1;
                  resolve({ kind: 'failure', errorClass: 'aborted' });
                };
                if (req.signal.aborted) finishAbort();
                else req.signal.addEventListener('abort', finishAbort, { once: true });
              });
            }
          }
        });

        expect(host.configureFromUserSettings(settings).kind).toBe('authorized');

        const p1 = host.reconcileAndReplaySpool();
        await firstArrived;
        // Launch a second overlapping replay while net.send is pending.
        const p2 = host.reconcileAndReplaySpool();
        await new Promise<void>((r) => setImmediate(r));

        // Zero duplicate batch sends while overlapping.
        expect(sendCount).toBe(1);

        if (action === 'disable') {
          host.disable();
        } else {
          await host.shutdown();
        }

        const [r1, r2] = await Promise.all([p1, p2]);
        await host.idle();

        expect(sendCount).toBe(1);
        expect(abortedCount).toBe(1);
        expect(r1.acknowledged).toBe(0);
        expect(r2.acknowledged).toBe(0);
        expect(r1.dropped).toBe(2);
        expect(host.spool.stats().spooledBatches).toBe(0);
        expect(await spoolDirFiles(storageRoot)).toEqual([]);

        if (action === 'disable') {
          await host.shutdown();
        }
      } finally {
        sqliteStore.close();
      }
    }
  );

  it('SR-313-2: overlapping reconcileAndReplaySpool() calls deliver each spooled batch exactly once on success', async () => {
    const storageRoot = await makeTempStorageRoot('overlap-replay-ok');
    const dbPath = path.join(storageRoot, 'state.sqlite');
    const settings = {
      enabled: true,
      endpoint: 'http://127.0.0.1:4318/v1/metrics',
      protocol: 'otlp-http-json' as const,
      allowPlaintextLoopback: true,
      credentialSecretKey: '',
      credentialHeaderName: 'Authorization',
      contentPolicy: 'metadata-only' as const,
      profileRevision: 1
    };

    await spoolOneBatchAndShutdown({ storageRoot, dbPath, settings, batchCount: 2 });

    const sqliteStore = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });
    try {
      let sendCount = 0;
      let releaseFirst = (): void => undefined;
      let resolveFirstArrived = (): void => undefined;
      const firstArrived = new Promise<void>((resolve) => {
        resolveFirstArrived = resolve;
      });

      const host = createTelemetryHostService({
        sqliteStore,
        storageRoot,
        secrets: null,
        isWorkspaceTrusted: () => true,
        transport: {
          send(): Promise<TransportResult> {
            sendCount += 1;
            const okRes: TransportResult = {
              kind: 'response',
              statusCode: 200,
              retryAfterSeconds: null,
              body: new Uint8Array(0),
              bodyTruncated: false
            };
            if (sendCount === 1) {
              resolveFirstArrived();
              return new Promise((resolve) => {
                releaseFirst = () => resolve(okRes);
              });
            }
            return Promise.resolve(okRes);
          }
        }
      });

      expect(host.configureFromUserSettings(settings).kind).toBe('authorized');
      const p1 = host.reconcileAndReplaySpool();
      await firstArrived;
      const p2 = host.reconcileAndReplaySpool();
      await new Promise<void>((r) => setImmediate(r));
      expect(sendCount).toBe(1);

      releaseFirst();
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(sendCount).toBe(2);
      expect(r1).toEqual({ replayed: 2, acknowledged: 2, dropped: 0, expired: 0 });
      expect(r2).toEqual({ replayed: 2, acknowledged: 2, dropped: 0, expired: 0 });
      expect(host.spool.stats().spooledBatches).toBe(0);

      await host.shutdown();
    } finally {
      sqliteStore.close();
    }
  });

  it('CR-313-3: offerRecords guards non-array input without throwing and malformed/unsupported-schema records do not consume telemetry_cardinality_sets rows', async () => {
    const storageRoot = await makeTempStorageRoot('offer-guard-card');
    const sqliteStore = new SqliteApplicationStore({
      databasePath: path.join(storageRoot, 'state.sqlite'),
      journalMode: 'wal'
    });
    try {
      const host = createTelemetryHostService({
        sqliteStore,
        storageRoot,
        secrets: null,
        isWorkspaceTrusted: () => true,
        transport: {
          async send(): Promise<TransportResult> {
            return {
              kind: 'response',
              statusCode: 200,
              retryAfterSeconds: null,
              body: new Uint8Array(0),
              bodyTruncated: false
            };
          }
        }
      });

      expect(
        host.configureFromUserSettings({
          enabled: true,
          endpoint: 'http://127.0.0.1:4318/v1/metrics',
          protocol: 'otlp-http-json',
          allowPlaintextLoopback: true,
          credentialSecretKey: '',
          credentialHeaderName: 'Authorization',
          contentPolicy: 'metadata-only'
        }).kind
      ).toBe('authorized');

      // Non-array inputs must not throw.
      expect(() => host.offerRecords(null as unknown as readonly unknown[])).not.toThrow();
      expect(host.offerRecords(null as unknown as readonly unknown[])).toEqual({
        accepted: 0,
        duplicate: 0,
        refused: 0
      });
      expect(host.offerRecords(undefined as unknown as readonly unknown[])).toEqual({
        accepted: 0,
        duplicate: 0,
        refused: 0
      });

      // Malformed and unsupported-schema records must be refused and consume zero cardinality rows.
      const invalidBatch: unknown[] = [
        null,
        'not-an-object',
        {
          sourceSchema: TELEMETRY_SOURCE_SCHEMA + 99,
          kind: 'usage',
          sourceId: 'unsupported-schema-1',
          sourceRevision: 1,
          backend: 'claude',
          modelRequested: 'bad-schema-model-1',
          modelReported: 'bad-schema-model-1',
          measures: []
        },
        {
          sourceSchema: TELEMETRY_SOURCE_SCHEMA,
          kind: 'usage',
          sourceId: '',
          sourceRevision: 1,
          backend: 'claude',
          modelRequested: 'empty-source-id-model',
          modelReported: 'empty-source-id-model',
          measures: []
        },
        {
          sourceSchema: TELEMETRY_SOURCE_SCHEMA,
          kind: 'operation',
          sourceId: 'bad-outcome-1',
          sourceRevision: 1,
          backend: 'claude',
          modelRequested: 'bad-outcome-model',
          modelReported: 'bad-outcome-model',
          durationMs: -5,
          outcome: 'not-a-valid-outcome'
        }
      ];

      expect(host.offerRecords(invalidBatch)).toEqual({
        accepted: 0,
        duplicate: 0,
        refused: invalidBatch.length
      });
      const totalCardRowsAfterInvalid = Number(
        sqliteStore.writerConnection.scalar(`SELECT COUNT(*) FROM telemetry_cardinality_sets`) ?? 0
      );
      expect(totalCardRowsAfterInvalid).toBe(0);

      // Even in a mixed batch with one valid record, only the valid record enters telemetry_cardinality_sets.
      const mixedResult = host.offerRecords([
        ...invalidBatch,
        {
          sourceSchema: TELEMETRY_SOURCE_SCHEMA,
          kind: 'operation',
          sourceId: 'valid-mixed-1',
          sourceRevision: 1,
          backend: 'claude',
          modelRequested: 'claude-sonnet-4-5',
          modelReported: 'claude-sonnet-4-5',
          durationMs: 42,
          outcome: 'succeeded'
        }
      ]);
      expect(mixedResult).toEqual({
        accepted: 1,
        duplicate: 0,
        refused: invalidBatch.length
      });
      const totalCardRowsAfterMixed = Number(
        sqliteStore.writerConnection.scalar(`SELECT COUNT(*) FROM telemetry_cardinality_sets`) ?? 0
      );
      expect(totalCardRowsAfterMixed).toBe(1);
      expect(
        host.ledger.cardinalitySetCount({
          profileId: 'user-default',
          instrument: 'operation-duration'
        })
      ).toBe(1);
      expect(
        host.ledger.cardinalitySetCount({
          profileId: 'user-default',
          instrument: 'token-usage'
        })
      ).toBe(0);

      await host.shutdown();
    } finally {
      sqliteStore.close();
    }
  });

  it('SR-313-3: clamps arbitrary, secret-marker, and bidi contentPolicy values to invalid in preview and host status', async () => {
    const storageRoot = await makeTempStorageRoot('content-policy-clamp');
    const sqliteStore = new SqliteApplicationStore({
      databasePath: path.join(storageRoot, 'state.sqlite'),
      journalMode: 'wal'
    });
    const untrustedPolicy = 'synthetic-secret-marker\u202e<script>alert(1)</script>';
    try {
      const preview = buildTelemetryExportPreview(
        {
          enabled: true,
          endpoint: 'http://127.0.0.1:4318/v1/metrics',
          protocol: 'otlp-http-json',
          allowPlaintextLoopback: true,
          credentialSecretKey: '',
          credentialHeaderName: 'Authorization',
          contentPolicy: untrustedPolicy
        },
        { workspaceTrusted: true, secretStore: 'available' }
      );
      expect(preview.requestedContentPolicy).toBe('invalid');
      expect(preview.effectiveStatus).toBe('refused');
      expect(JSON.stringify(preview)).not.toContain('synthetic-secret-marker');
      expect(JSON.stringify(preview)).not.toContain('\u202e');

      const host = createTelemetryHostService({
        sqliteStore,
        storageRoot,
        secrets: null,
        isWorkspaceTrusted: () => true
      });

      const evalFromSettings = host.configureFromUserSettings({
        enabled: true,
        endpoint: 'http://127.0.0.1:4318/v1/metrics',
        protocol: 'otlp-http-json',
        allowPlaintextLoopback: true,
        credentialSecretKey: '',
        credentialHeaderName: 'Authorization',
        contentPolicy: untrustedPolicy
      });
      expect(evalFromSettings.kind).toBe('refused');
      const statusFromSettings = host.getStatus();
      expect(statusFromSettings.preview.requestedContentPolicy).toBe('invalid');
      expect(JSON.stringify(statusFromSettings)).not.toContain('synthetic-secret-marker');
      expect(JSON.stringify(statusFromSettings)).not.toContain('\u202e');

      host.configureFromRawProfiles([], untrustedPolicy);
      const statusFromRaw = host.getStatus();
      expect(statusFromRaw.preview.requestedContentPolicy).toBe('invalid');
      expect(JSON.stringify(statusFromRaw)).not.toContain('synthetic-secret-marker');

      await host.shutdown();
    } finally {
      sqliteStore.close();
    }
  });
});
