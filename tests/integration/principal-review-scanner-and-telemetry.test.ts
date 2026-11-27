import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { projectAuditPayload } from '../../src/audit/audit-payload';
import { SanitizedLogger } from '../../src/lib/logger';
import { parseAuditLogLineDetailed } from '../../src/parser/audit-log-parser';
import { countsOnlyAuditExport } from '../../src/services/audit-export/counts-only-export';
import {
  runGrantNativeReviewScanner,
  runRevokeNativeReviewScanner
} from '../../src/commands/native-review-scanner-consent';
import {
  runClearTelemetryCredential,
  runSetTelemetryCredential
} from '../../src/commands/telemetry-credential';
import { ALLOW_UNCONTAINED_SCANNER_SETTING, resolveUncontainedScannerGrant } from '../../src/services/backend-containment-policy';
import { wireContainmentAdmission } from '../../src/activation/containment-admission-wiring';
import { resolveProcessEnvironmentPolicy } from '../../src/contracts/process-environment-policy';
import { createTelemetryHostService } from '../../src/services/telemetry-host/telemetry-host-service';
import { SqliteApplicationStore } from '../../src/services/sqlite-store';
import type { AcceptanceMementoPort } from '../../src/services/containment-qualification/acceptance-bindings';
import type { ExportSourceRecord } from '../../src/contracts/telemetry-export';
import { TELEMETRY_SOURCE_SCHEMA } from '../../src/contracts/telemetry-export';
import type { UncontainedConsentConfig } from '../../src/services/uncontained-grant-writer';

function createMemoryMemento(): AcceptanceMementoPort {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      if (value === undefined) data.delete(key);
      else data.set(key, value);
    }
  };
}

function createMemoryConfig(): UncontainedConsentConfig & { raw(): Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      values.set(key, value);
    },
    raw: () => values
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Principal Review Findings 5 & 6 — installed scanner consent and OTLP credential lifecycle', () => {
  it('Finding 5: codex-security stays fail-closed with 0 spawns until explicitly granted, admits once bound, and refuses with 0 spawns after revocation', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'schegent-f5-scanner-'));
    tempDirs.push(binDir);
    const scannerExe = join(binDir, 'codex-security');
    writeFileSync(scannerExe, '#!/bin/sh\necho "codex-security 0.9.1"\n', 'utf8');
    chmodSync(scannerExe, 0o755);

    const memento = createMemoryMemento();
    const config = createMemoryConfig();
    const logs: string[] = [];
    const logger = {
      info: (line: string) => logs.push(`INFO:${line}`),
      warn: (line: string) => logs.push(`WARN:${line}`)
    };
    let versionProbes = 0;

    const admission = wireContainmentAdmission({
      memento,
      logger,
      isTrusted: () => true,
      hasPrimacy: async () => true,
      environmentPolicy: resolveProcessEnvironmentPolicy({
        inheritEnvironment: true,
        mode: 'allowlist',
        allowlist: []
      }),
      granted: () => new Set(['codex']), // Granting `codex` alone must NEVER admit `codex-security`.
      grantedScanners: () =>
        resolveUncontainedScannerGrant(config.get<unknown>(ALLOW_UNCONTAINED_SCANNER_SETTING)).granted,
      observeVersion: async () => '0.117.0',
      observeScannerVersion: async () => {
        versionProbes += 1;
        return 'codex-security 0.9.1';
      }
    });

    const scannerEnv = { PATH: binDir };

    // 1. Default clean profile: refused BEFORE any `--version` spawn (0 spawns).
    await expect(
      admission.spawnGate.admitWithDecision!('codex', {
        runId: 'run-default',
        cliPath: 'codex',
        review: { kind: 'security' },
        env: scannerEnv
      })
    ).rejects.toThrow();
    expect(versionProbes).toBe(0);

    // 2. Operator invokes Grant Native Review Scanner and confirms modal.
    const modalPrompts: { summary: string; detail: string; label: string }[] = [];
    const notices: string[] = [];
    const ui = {
      confirmModal: async (summary: string, detail: string, label: string) => {
        modalPrompts.push({ summary, detail, label });
        return true;
      },
      info: (msg: string) => notices.push(`info:${msg}`),
      warn: (msg: string) => notices.push(`warn:${msg}`),
      error: (msg: string) => notices.push(`error:${msg}`)
    };

    const auditDir = mkdtempSync(join(tmpdir(), 'schegent-f5-audit-'));
    tempDirs.push(auditDir);
    const auditWriter = new AuditLogWriter({ workspaceRoot: auditDir }, new SanitizedLogger([]));

    const consentPort = {
      inspectScannerForConsent: (scanner: 'codex-security') =>
        admission.inspectScannerForConsent(scanner, scannerEnv),
      recordScannerAcceptance: admission.recordScannerAcceptance,
      revokeScannerAcceptance: admission.revokeScannerAcceptance,
      readScannerBinding: admission.readScannerBinding
    };

    const grantResult = await runGrantNativeReviewScanner({
      config,
      consent: consentPort,
      ui,
      logger,
      auditWriter
    });
    expect(grantResult.outcome).toBe('granted');
    expect(modalPrompts).toHaveLength(1);
    expect(modalPrompts[0]!.detail).toContain('mechanism: none');
    expect(modalPrompts[0]!.detail).toContain(ALLOW_UNCONTAINED_SCANNER_SETTING);
    expect(config.get(ALLOW_UNCONTAINED_SCANNER_SETTING)).toEqual(['codex-security']);
    expect(admission.readScannerBinding('codex-security')).not.toBeNull();
    expect(versionProbes).toBe(1); // Only the explicit consent inspection probed `--version`.

    // 3. Now admission succeeds for that exact binary and fingerprint.
    const decision = await admission.spawnGate.admitWithDecision!('codex', {
      runId: 'run-granted',
      cliPath: 'codex',
      review: { kind: 'security' },
      env: scannerEnv
    });
    expect(decision.executableTarget).toBe('codex-security');
    expect(decision.containmentPosture).toBe('accepted-uncontained');
    expect(versionProbes).toBe(2);

    // 4. Operator invokes Revoke Native Review Scanner: setting + workspace binding are cleared.
    const revokeResult = await runRevokeNativeReviewScanner({
      config,
      consent: {
        inspectScannerForConsent: (scanner) => admission.inspectScannerForConsent(scanner, scannerEnv),
        recordScannerAcceptance: admission.recordScannerAcceptance,
        revokeScannerAcceptance: admission.revokeScannerAcceptance,
        readScannerBinding: admission.readScannerBinding
      },
      ui,
      logger,
      auditWriter
    });
    expect(revokeResult).toEqual({
      outcome: 'revoked',
      scanner: 'codex-security',
      removedSetting: true,
      clearedBinding: true
    });
    expect(config.get(ALLOW_UNCONTAINED_SCANNER_SETTING)).toEqual([]);
    expect(admission.readScannerBinding('codex-security')).toBeNull();

    // 5. Subsequent admission fails closed with ZERO additional spawns.
    const probesBeforeRefusal = versionProbes;
    await expect(
      admission.spawnGate.admitWithDecision!('codex', {
        runId: 'run-revoked',
        cliPath: 'codex',
        review: { kind: 'security' },
        env: scannerEnv
      })
    ).rejects.toThrow();
    expect(versionProbes).toBe(probesBeforeRefusal);

    // Raw paths must never be written to logs or structured audit entries, AND every audit row
    // MUST parse cleanly via `parseAuditLogLineDetailed` and survive `countsOnlyAuditExport`!
    expect(logs.join('\n')).not.toContain(binDir);
    const auditText = readFileSync(join(auditDir, '.schegent', 'audit.log'), 'utf8');
    expect(auditText).not.toContain(binDir);
    const parsedDetailed = auditText
      .trim()
      .split('\n')
      .map((line) => parseAuditLogLineDetailed(line));
    expect(parsedDetailed.every((r) => r.entry !== null && r.warning === undefined)).toBe(true);
    const auditEntries = parsedDetailed.map((r) => r.entry!);
    expect(auditEntries.map((e) => e.eventType)).toEqual([
      'scanner-consent-changed',
      'scanner-consent-changed'
    ]);
    expect(auditEntries[0]!.payload).toMatchObject({
      scanner: 'codex-security',
      action: 'granted',
      fingerprintDigestPrefix: expect.stringMatching(/^[0-9a-f]{16}$/)
    });
    expect(auditEntries[1]!.payload).toEqual({
      scanner: 'codex-security',
      action: 'revoked',
      removedSetting: true,
      clearedBinding: true
    });
    const countsExport = countsOnlyAuditExport(auditText);
    expect(countsExport.included).toBe(2);
    expect(countsExport.omitted).toBe(0);
    const exportedRows = countsExport.text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { eventType: string; payload: Record<string, unknown> });
    expect(exportedRows[0]!.payload).toMatchObject({ scanner: 'codex-security', action: 'granted' });
    expect(exportedRows[1]!.payload).toEqual({
      scanner: 'codex-security',
      action: 'revoked',
      removedSetting: true,
      clearedBinding: true
    });

    // Fail-closed partial revocation: even when global config.update throws (e.g. read-only
    // settings.json), workspace binding IS still cleared so admission immediately fails closed.
    await runGrantNativeReviewScanner({
      config,
      consent: consentPort,
      ui: { confirmModal: async () => true, info: () => {}, warn: () => {}, error: () => {} },
      logger,
      auditWriter
    });
    expect(admission.readScannerBinding('codex-security')).not.toBeNull();
    const throwingGlobalConfig: UncontainedConsentConfig = {
      get: <T>(k: string) => config.get<T>(k),
      update: async () => {
        throw new Error('EROFS: read-only settings.json');
      }
    };
    const partialRevoke = await runRevokeNativeReviewScanner({
      config: throwingGlobalConfig,
      consent: consentPort,
      ui: { confirmModal: async () => true, info: () => {}, warn: () => {}, error: () => {} },
      logger,
      auditWriter
    });
    expect(partialRevoke.outcome).toBe('write-failed');
    expect(admission.readScannerBinding('codex-security')).toBeNull();

    // Post-modal primacy loss refuses grant with zero persisted mutations.
    await config.update(ALLOW_UNCONTAINED_SCANNER_SETTING, [], 1);
    const lostPrimacyGrant = await runGrantNativeReviewScanner({
      config,
      consent: consentPort,
      ui: { confirmModal: async () => true, info: () => {}, warn: () => {}, error: () => {} },
      logger,
      auditWriter,
      isWorkspaceTrusted: () => true,
      hasPrimacy: () => false
    });
    expect(lostPrimacyGrant.outcome).toBe('denied');
    expect(admission.readScannerBinding('codex-security')).toBeNull();
    expect(config.get(ALLOW_UNCONTAINED_SCANNER_SETTING)).toEqual([]);

    expect(() =>
      projectAuditPayload('scanner-consent-changed', {
        scanner: 'codex-security',
        action: 'granted',
        path: scannerExe
      })
    ).toThrow(/malformed-scanner-consent-changed/);
  });

  it('Finding 6: OTLP credential set -> rotate -> clear invalidates exporter cache live without reload and never logs secrets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'schegent-f6-telemetry-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'state.db');
    const sqliteStore = new SqliteApplicationStore({ databasePath: dbPath, journalMode: 'wal' });

    const receivedAuthHeaders: (string | undefined)[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      receivedAuthHeaders.push(req.headers['authorization']);
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end('{}');
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    const endpoint = `http://127.0.0.1:${port}/v1/metrics`;

    const secretMap = new Map<string, string>();
    const logs: string[] = [];
    const logger = {
      info: (line: string) => logs.push(line),
      warn: (line: string) => logs.push(line)
    };

    const telemetryHost = createTelemetryHostService({
      sqliteStore,
      storageRoot: dir,
      secrets: {
        availability: () => 'available',
        read: async (ref) => secretMap.get(ref) ?? null
      },
      isWorkspaceTrusted: () => true,
      serviceVersion: '0.2.0'
    });

    const SECRET_KEY = 'schegent.otlp.auth';
    const SECRET_V1 = 'Bearer super-secret-token-v1';
    const SECRET_V2 = 'Bearer rotated-secret-token-v2';

    const makeRecord = (id: string): ExportSourceRecord => ({
      sourceSchema: TELEMETRY_SOURCE_SCHEMA,
      kind: 'operation',
      sourceId: id,
      sourceRevision: 1,
      backend: 'claude',
      modelRequested: 'claude-sonnet',
      modelReported: 'claude-sonnet',
      durationMs: 120,
      outcome: 'succeeded'
    });

    try {
      const evaluation = telemetryHost.configureFromUserSettings({
        enabled: true,
        endpoint,
        protocol: 'otlp-http-json',
        allowPlaintextLoopback: true,
        credentialSecretKey: SECRET_KEY,
        credentialHeaderName: 'Authorization',
        contentPolicy: 'metadata-only'
      });
      expect(evaluation.kind).toBe('authorized');

      // 1. Before storing the secret, delivery drops with `credential-unavailable` (and caches failure).
      telemetryHost.offerRecords([makeRecord('op-1')]);
      telemetryHost.flush();
      await telemetryHost.idle();
      expect(receivedAuthHeaders).toEqual([]);
      expect(telemetryHost.getStatus().health.dropReasons['credential-unavailable']).toBe(1);

      const secretPort = {
        store: async (k: string, v: string) => {
          secretMap.set(k, v);
        },
        delete: async (k: string) => {
          secretMap.delete(k);
        }
      };

      const makeUi = (valueToReturn: string) => ({
        promptSecretKey: async (opts: { readonly value: string }) => opts.value,
        promptSecretValue: async () => valueToReturn,
        confirmModal: async () => true,
        info: () => {},
        warn: () => {},
        error: () => {}
      });

      const auditWriter = new AuditLogWriter({ workspaceRoot: dir }, new SanitizedLogger([]));

      // 2. Store V1 via command: invalidates cached failure immediately -> next batch delivers with V1!
      const setV1 = await runSetTelemetryCredential({
        secrets: secretPort,
        readConfiguredSecretKey: () => SECRET_KEY,
        invalidateTelemetryCredential: (ref) => telemetryHost.invalidateCredential(ref),
        ui: makeUi(SECRET_V1),
        logger,
        auditWriter
      });
      expect(setV1).toEqual({
        outcome: 'stored',
        secretKey: SECRET_KEY,
        matchesConfiguredKey: true
      });

      telemetryHost.offerRecords([makeRecord('op-2')]);
      telemetryHost.flush();
      await telemetryHost.idle();
      expect(receivedAuthHeaders).toEqual([SECRET_V1]);

      // 3. Rotate to V2 via command: invalidates cached V1 -> next batch sends V2 without reload!
      const setV2 = await runSetTelemetryCredential({
        secrets: secretPort,
        readConfiguredSecretKey: () => SECRET_KEY,
        invalidateTelemetryCredential: (ref) => telemetryHost.invalidateCredential(ref),
        ui: makeUi(SECRET_V2),
        logger,
        auditWriter
      });
      expect(setV2.outcome).toBe('stored');

      telemetryHost.offerRecords([makeRecord('op-3')]);
      telemetryHost.flush();
      await telemetryHost.idle();
      expect(receivedAuthHeaders).toEqual([SECRET_V1, SECRET_V2]);

      // 4. Clear secret via command: invalidates cached V2 -> next batch drops with `credential-unavailable`!
      const cleared = await runClearTelemetryCredential({
        secrets: secretPort,
        readConfiguredSecretKey: () => SECRET_KEY,
        invalidateTelemetryCredential: (ref) => telemetryHost.invalidateCredential(ref),
        ui: makeUi(''),
        logger,
        auditWriter
      });
      expect(cleared).toEqual({ outcome: 'cleared', secretKey: SECRET_KEY });

      telemetryHost.offerRecords([makeRecord('op-4')]);
      telemetryHost.flush();
      await telemetryHost.idle();
      expect(receivedAuthHeaders).toEqual([SECRET_V1, SECRET_V2]);
      expect(telemetryHost.getStatus().health.dropReasons['credential-unavailable']).toBe(2);

      // Secret values and raw key names must NEVER appear in logs or audit rows, AND every audit
      // row MUST parse cleanly via `parseAuditLogLineDetailed` and survive `countsOnlyAuditExport`!
      const combinedLogs = logs.join('\n');
      expect(combinedLogs).not.toContain(SECRET_V1);
      expect(combinedLogs).not.toContain(SECRET_V2);
      const auditText = readFileSync(join(dir, '.schegent', 'audit.log'), 'utf8');
      expect(auditText).not.toContain(SECRET_V1);
      expect(auditText).not.toContain(SECRET_V2);
      expect(auditText).not.toContain(SECRET_KEY);
      const parsedDetailed = auditText
        .trim()
        .split('\n')
        .map((line) => parseAuditLogLineDetailed(line));
      expect(parsedDetailed.every((r) => r.entry !== null && r.warning === undefined)).toBe(true);
      const auditEntries = parsedDetailed.map((r) => r.entry!);
      expect(auditEntries.map((e) => e.eventType)).toEqual([
        'telemetry-credential-changed',
        'telemetry-credential-changed',
        'telemetry-credential-changed'
      ]);
      const digestPrefix = auditEntries[0]!.payload['secretKeyDigestPrefix'];
      expect(digestPrefix).toMatch(/^[0-9a-f]{16}$/);
      expect(auditEntries[0]!.payload).toEqual({
        action: 'stored',
        secretKeyDigestPrefix: digestPrefix,
        matchesConfiguredKey: true
      });
      expect(auditEntries[1]!.payload).toEqual({
        action: 'stored',
        secretKeyDigestPrefix: digestPrefix,
        matchesConfiguredKey: true
      });
      expect(auditEntries[2]!.payload).toEqual({
        action: 'cleared',
        secretKeyDigestPrefix: digestPrefix
      });
      const countsExport = countsOnlyAuditExport(auditText);
      expect(countsExport.included).toBe(3);
      expect(countsExport.omitted).toBe(0);

      // Namespace protection & prompt transparency: non-telemetry `schegent.*` keys are refused,
      // and password/clear prompts explicitly name the target `secretKey`.
      const reservedKeyAttempt = await runSetTelemetryCredential(
        {
          secrets: secretPort,
          readConfiguredSecretKey: () => SECRET_KEY,
          invalidateTelemetryCredential: (ref) => telemetryHost.invalidateCredential(ref),
          ui: makeUi('Bearer nope'),
          logger,
          auditWriter
        },
        'schegent.internal.auth'
      );
      expect(reservedKeyAttempt).toEqual({ outcome: 'invalid-input', field: 'secretKey' });

      let seenValuePrompt = '';
      let seenClearModal = '';
      await runSetTelemetryCredential(
        {
          secrets: secretPort,
          readConfiguredSecretKey: () => SECRET_KEY,
          invalidateTelemetryCredential: (ref) => telemetryHost.invalidateCredential(ref),
          ui: {
            ...makeUi('Bearer visible-key-check'),
            promptSecretValue: async (opts) => {
              seenValuePrompt = opts.prompt;
              return undefined;
            }
          },
          logger,
          auditWriter
        },
        SECRET_KEY
      );
      expect(seenValuePrompt).toContain(SECRET_KEY);

      await runClearTelemetryCredential(
        {
          secrets: secretPort,
          readConfiguredSecretKey: () => SECRET_KEY,
          invalidateTelemetryCredential: (ref) => telemetryHost.invalidateCredential(ref),
          ui: {
            ...makeUi(''),
            confirmModal: async (summary) => {
              seenClearModal = summary;
              return false;
            }
          },
          logger,
          auditWriter
        },
        SECRET_KEY
      );
      expect(seenClearModal).toContain(SECRET_KEY);

      expect(() =>
        projectAuditPayload('telemetry-credential-changed', {
          action: 'stored',
          secretKeyDigestPrefix: digestPrefix,
          secretValue: SECRET_V1
        })
      ).toThrow(/malformed-telemetry-credential-changed/);
    } finally {
      await telemetryHost.shutdown();
      sqliteStore.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
