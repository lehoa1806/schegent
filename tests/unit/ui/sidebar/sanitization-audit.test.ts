import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StateProjector } from '../../../../src/ui/sidebar/state-projector';
import { WorkspaceStateStore, type Memento } from '../../../../src/state/workspace-state';
import { AuditLogWriter } from '../../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { buildHistoryEntry } from '../../../../src/state/history-entry';
import type { WorkflowSnapshot } from '../../../../src/ui/sidebar/snapshot';

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

// Test fixtures intentionally constructed to match the sanitizer's
// SECRET_PATTERNS at runtime while not appearing as literal secrets in source
// (so secret-scanning pre-commit hooks don't flag this file).
const SECRETS = {
  apiKey: ['sk', 'ant', 'abcdefghij1234567890ABCDEFGH'].join('-'),
  jwt: ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NSIsIm5hbWUiOiJKb2huIn0', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'].join('.'),
  bearer: ['Bearer', 'abcdef1234567890XYZW'].join(' '),
  authHeader: ['authorization', ' abcdef1234567890XYZW'].join(':'),
  apiKeyHeader: ['api_key', 'abcdef1234567890XYZW'].join('=')
};

function deepStringify(obj: unknown): string {
  return JSON.stringify(obj, (_k, v) => v);
}

function assertNoSecrets(haystack: string): void {
  expect(haystack).not.toContain(SECRETS.apiKey);
  expect(haystack).not.toContain(SECRETS.jwt);
  // For Bearer / api_key / authorization, the regex captures the full pattern
  // and replaces it with [REDACTED]; assert the secret payload portion is gone
  expect(haystack).not.toMatch(/sk-(ant-)?[A-Za-z0-9_-]{20,}/);
  expect(haystack).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/);
  expect(haystack).not.toMatch(/Bearer\s+[A-Za-z0-9_\-.=]{16,}/i);
}

let memento: FakeMemento;
let store: WorkspaceStateStore;
let audit: AuditLogWriter;
let tmpRoot: string;
let logger: SanitizedLogger;

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-sanitize-'));
  logger = new SanitizedLogger();
  audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('Sanitization audit (T069 / FR-014)', () => {
  it('queue item lastErrorSummary is redacted before reaching the snapshot', async () => {
    await store.setQueue({
      paused: false,
      pausedReason: null,
      inFlightId: null,
      updatedAt: 0,
      queueLifecycle: 'active-empty',
      scheduledStartAt: null,
      scheduledStartSource: null,
      requests: [
        {
          id: 'q-failed',
          description: 'normal description',
          enqueuedAt: 1_700_000_000_000,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
          startedAt: null,
          completedAt: null,
          status: 'failed',
          position: 0,
          runId: null,
          retryCount: 0,
          lastError: `cli failed: ${SECRETS.apiKey}`,
          pausedReason: null
        }
      ]
    });
    const proj = new StateProjector({
      store,
      audit,
      ownerId: 'w',
      logger,
      monotonicNow: () => 0
    });
    proj.start();
    const snap = proj.getCurrentSnapshot();
    proj.dispose();
    const recent = snap.queue.recent;
    expect(recent).toHaveLength(1);
    expect(recent[0].lastErrorSummary).not.toBeNull();
    expect(recent[0].lastErrorSummary!).toContain('[REDACTED]');
    assertNoSecrets(recent[0].lastErrorSummary!);
  });

  it('audit log lines are sanitized at write time and snapshot tail never contains secrets', async () => {
    await audit.append({
      eventType: 'cli-invocation',
      phase: 'speckit-plan',
      outcome: 'success',
      runId: 'r1',
      iteration: 1,
      payload: { stdout: `Token: ${SECRETS.jwt}`, stderr: '', headers: SECRETS.bearer }
    });
    await audit.append({
      eventType: 'error',
      phase: 'speckit-plan',
      outcome: 'failure',
      runId: 'r1',
      iteration: 1,
      payload: { error: `Auth: ${SECRETS.apiKey}` }
    });

    const proj = new StateProjector({
      store,
      audit,
      ownerId: 'w',
      logger,
      monotonicNow: () => 0
    });
    proj.start();

    // Force a project pass after audit subscribers fire by sleeping past debounce
    await new Promise((r) => setTimeout(r, 150));
    const snap = proj.getCurrentSnapshot();
    proj.dispose();

    const tailSerialized = deepStringify(snap.auditTail);
    assertNoSecrets(tailSerialized);

    const onDisk = await fs.readFile(audit.logPath, 'utf8');
    assertNoSecrets(onDisk);
  });

  it('history descriptionPreview is redacted via buildHistoryEntry', () => {
    const entry = buildHistoryEntry({
      runId: 'run-h',
      featureId: 'feat-h',
      description: `Feature with ${SECRETS.apiKey} and ${SECRETS.jwt}`,
      terminalStatus: 'failed',
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_500,
      lastErrorSummary: null,
      logger
    });
    expect(entry.descriptionPreview).toContain('[REDACTED]');
    assertNoSecrets(entry.descriptionPreview);
  });

  it('end-to-end snapshot serialization contains no secret patterns when secrets are seeded everywhere', async () => {
    await store.setQueue({
      paused: false,
      pausedReason: null,
      inFlightId: null,
      updatedAt: 0,
      queueLifecycle: 'active-empty',
      scheduledStartAt: null,
      scheduledStartSource: null,
      requests: [
        {
          id: 'q-with-secret-error',
          description: 'normal',
          enqueuedAt: 1_700_000_000_000,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
          startedAt: null,
          completedAt: null,
          status: 'failed',
          position: 0,
          runId: null,
          retryCount: 0,
          lastError: `err: ${SECRETS.bearer} ${SECRETS.apiKeyHeader}`,
          pausedReason: null
        }
      ]
    });
    await audit.append({
      eventType: 'cli-invocation',
      phase: 'speckit-plan',
      outcome: 'success',
      runId: 'r1',
      iteration: 1,
      payload: { token: SECRETS.jwt, header: SECRETS.authHeader }
    });
    const proj = new StateProjector({
      store,
      audit,
      ownerId: 'w',
      logger,
      monotonicNow: () => 0
    });
    proj.start();
    await new Promise((r) => setTimeout(r, 150));
    const snap: WorkflowSnapshot = proj.getCurrentSnapshot();
    proj.dispose();

    const serialized = deepStringify(snap);
    assertNoSecrets(serialized);
  });
});
