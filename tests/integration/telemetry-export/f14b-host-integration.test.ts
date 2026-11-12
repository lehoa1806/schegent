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
      let now = 1_700_000_000_000;
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
      await new Promise<void>((r) => setTimeout(r, 20));

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
