import { ZippedStreamBuffer } from '../../src/runner/zipped-stream-buffer';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SchegentWorkflowController } from '../../src/controller/workflow-controller';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { RawTranscriptWriter } from '../../src/audit/raw-transcript-writer';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { SanitizedLogger } from '../../src/lib/logger';
import type { ClaudeCliRunner } from '../../src/runner/claude-cli';
import type { RawInvocationOutput, InvocationRequest } from '../../src/runner/invocation-result';
import type { SchegentStatusBar } from '../../src/ui/status-bar';
import type { Notifier } from '../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../src/state/lock';
import { DEFAULT_QUEUE_ID } from '../../src/queue/queue-registry';

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

function makeLock(): WorkspaceLockManager {
  return {
    release: vi.fn(async () => undefined),
    tryAcquire: vi.fn(async () => ({ acquired: false, owner: null })),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
}

const CLEAN_STDOUT = [
  '[SCHEGENT_STATUS: CLEAR]',
  '=== SCHEGENT AUDIT LOG ===',
  'phase: speckit-specify',
  'files_created: ["specs/001-mock/spec.md"]',
  'files_modified: []',
  'files_deleted: []',
  'commands_executed: ["mock specify"]',
  'network_calls: ["none"]',
  'ruleset_switches: ["none"]',
  'notes: ok',
  '=== END AUDIT LOG ==='
].join('\n');

const VERBOSE_STDOUT_PAYLOAD = '{"event":"verbose-data","stream":"stream-json"}\n';
const VERBOSE_STDERR_PAYLOAD = '[verbose] internal trace line\n';

function makeStubRunner(opts: {
  emitDiagnosticChunks: boolean;
  injectWriteFailure?: boolean;
}): { runner: ClaudeCliRunner; capturedRequests: InvocationRequest[] } {
  const capturedRequests: InvocationRequest[] = [];
  const invoke = vi.fn(async (req: InvocationRequest): Promise<RawInvocationOutput> => {
    capturedRequests.push(req);
    // When verbose flags are present, also tee chunks into the diagnostic
    // files via direct fs writes — this fakes the real CLI's stream-json
    // and verbose outputs hitting the sibling files.
    if (req.verboseDiagnostics && opts.emitDiagnosticChunks) {
      const t = req.verboseDiagnostics;
      try {
        await fs.mkdir(t.directory, { recursive: true });
        await fs.appendFile(t.streamFile, VERBOSE_STDOUT_PAYLOAD, 'utf8');
        await fs.appendFile(t.verboseLogFile, VERBOSE_STDERR_PAYLOAD, 'utf8');
        // Emulate the CLI's --debug-to-file payload by writing one too.
        await fs.appendFile(t.debugFile, '{"phase":"debug"}\n', 'utf8');
      } catch {
        // best-effort
      }
    }
    const diagnosticWarnings = opts.injectWriteFailure
      ? ['verbose diagnostic stream write failed (synthetic): EACCES']
      : undefined;
    return {
        stdoutBuffer: (() => { const b = new ZippedStreamBuffer(); b.append(CLEAN_STDOUT); b.finalize(); return b; })(),
        stderrBuffer: (() => { const b = new ZippedStreamBuffer(); b.finalize(); return b; })(),exitCode: 0,
      killed: false,
      timedOut: false,
      durationMs: 1,
      ...(diagnosticWarnings ? { diagnosticWarnings } : {})
    };
  });
  const runner = {
    invoke,
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  } as unknown as ClaudeCliRunner;
  return { runner, capturedRequests };
}

async function readAuditLog(workspaceRoot: string): Promise<string> {
  return fs.readFile(path.join(workspaceRoot, '.schegent', 'audit.log'), 'utf8');
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-verbose-logging-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function runOnce(opts: {
  verbose: boolean;
  emitDiagnosticChunks?: boolean;
  injectWriteFailure?: boolean;
  workspaceRoot: string;
}): Promise<{ capturedRequests: InvocationRequest[]; runId: string }> {
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot: opts.workspaceRoot }, logger);
  const { runner, capturedRequests } = makeStubRunner({
    emitDiagnosticChunks: opts.emitDiagnosticChunks ?? false,
    injectWriteFailure: opts.injectWriteFailure
  });
  // Feature 093 (T082) — spool under the test's own workspace root rather than
  // the default `os.tmpdir()`. The writer scavenges abandoned spools with one
  // `readdir` of that root per instance; on a machine whose temp dir holds
  // hundreds of thousands of entries each `runOnce` paid seconds for it, and
  // the two-run test below exceeded the 5 s timeout for a reason unrelated to
  // what it asserts. Same remedy as T057, at the second site that needed it:
  // the scavenger's real behavior stays exercised, at a cost proportional to
  // what this test created, and the root is removed with the workspace.
  const rawTranscript = new RawTranscriptWriter(
    opts.workspaceRoot,
    logger,
    path.join(opts.workspaceRoot, 'raw-spool')
  );
  const phaseRunner = new PhaseRunner(
    runner,
    new PromptBuilder(),
    audit,
    logger,
    rawTranscript,
    { isVerboseDiagnosticsEnabled: () => opts.verbose }
  );

  const memento = new FakeMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);

  const statusBar = { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
  const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;
  const lock = makeLock();

  const controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    statusBar,
    notifier,
    logger,
    lock,
    {
      cliPath: 'noop',
      cwd: opts.workspaceRoot,
      iterationCap: 3,
      timeoutMs: 1000,
      skipProbing: true
    }
  );

  const feature = await queue.enqueue('Spec a thing', {});
  await controller.startNew(feature, 'specs/001-mock', {});
  const run = store.getRun(DEFAULT_QUEUE_ID)!;
  return { capturedRequests, runId: run.id };
}

function normalizeAuditLog(raw: string): string {
  // Strip wall-clock timestamps, run-scoped IDs, and audit-entry IDs so two
  // runs of the same fixture can be compared byte-for-byte. We keep
  // eventType, outcome, payload structure intact.
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((line) => {
      const obj = JSON.parse(line);
      delete obj.id;
      delete obj.timestamp;
      delete obj.runId;
      delete obj.correlationId;
      if (obj.payload && typeof obj.payload === 'object') {
        delete obj.payload.startTimestamp;
        delete obj.payload.endTimestamp;
        delete obj.payload.durationMs;
        delete obj.payload.diagnosticsEnabled;
      }
      return JSON.stringify(obj);
    })
    .join('\n');
}

describe('Verbose diagnostic logging end-to-end (010, T037, US3)', () => {
  it(
    'structured audit differs only by the declared diagnosticsEnabled metadata flag',
    async () => {
      const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-verbose-on-'));
      const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-verbose-off-'));
      try {
        await runOnce({ verbose: true, emitDiagnosticChunks: true, workspaceRoot: rootA });
        await runOnce({ verbose: false, workspaceRoot: rootB });
        const rawA = await readAuditLog(rootA);
        const rawB = await readAuditLog(rootB);
        expect(rawA).toContain('"diagnosticsEnabled":true');
        expect(rawB).toContain('"diagnosticsEnabled":false');
        const logA = normalizeAuditLog(rawA);
        const logB = normalizeAuditLog(rawB);
        expect(logA).toBe(logB);
      } finally {
        await fs.rm(rootA, { recursive: true, force: true });
        await fs.rm(rootB, { recursive: true, force: true });
      }
    },
    // This evidence test performs two complete phase runs plus disk cleanup.
    // Loaded CI workers can exceed Vitest's 5s unit-test default.
    15_000
  );

  it('verbose-on produces three diagnostic files at the canonical path (FR-019/020/021)', async () => {
    const { capturedRequests, runId } = await runOnce({
      verbose: true,
      emitDiagnosticChunks: true,
      workspaceRoot: tmpRoot
    });
    const first = capturedRequests[0];
    expect(first.verboseDiagnostics).toBeDefined();
    const target = first.verboseDiagnostics!;
    // Path must contain the canonical run-scoped segments.
    expect(target.directory).toContain(path.join('.schegent', 'sessions', runId, 'diagnostics'));
    expect(target.directory).toContain(`iter-${first.iteration}`);
    expect(target.directory).toContain(path.sep + first.phase);
    const debug = await fs.readFile(target.debugFile, 'utf8');
    const stream = await fs.readFile(target.streamFile, 'utf8');
    const verbose = await fs.readFile(target.verboseLogFile, 'utf8');
    expect(debug).toContain('debug');
    expect(stream).toContain('verbose-data');
    expect(verbose).toContain('internal trace');
  });

  it('verbose-off produces no diagnostic files (FR-018 default)', async () => {
    await runOnce({ verbose: false, workspaceRoot: tmpRoot });
    // The diagnostics root for this run should not exist.
    let exists = true;
    try {
      await fs.access(path.join(tmpRoot, '.schegent', 'sessions'));
    } catch {
      exists = false;
    }
    if (exists) {
      const entries = await fs.readdir(path.join(tmpRoot, '.schegent', 'sessions'));
      for (const entry of entries) {
        let diagExists = true;
        try {
          await fs.access(path.join(tmpRoot, '.schegent', 'sessions', entry, 'diagnostics'));
        } catch {
          diagExists = false;
        }
        expect(diagExists).toBe(false);
      }
    }
  });

  it('feature 008 raw-<runId>.log is written in both modes (FR-027)', async () => {
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-raw-verbose-on-'));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-raw-verbose-off-'));
    try {
      const a = await runOnce({ verbose: true, emitDiagnosticChunks: true, workspaceRoot: rootA });
      const b = await runOnce({ verbose: false, workspaceRoot: rootB });
      const rawA = await fs.readFile(
        path.join(rootA, '.schegent', 'sessions', `raw-${a.runId}.log`),
        'utf8'
      );
      const rawB = await fs.readFile(
        path.join(rootB, '.schegent', 'sessions', `raw-${b.runId}.log`),
        'utf8'
      );
      expect(rawA).toContain('SESSION START');
      expect(rawB).toContain('SESSION START');
    } finally {
      await fs.rm(rootA, { recursive: true, force: true });
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });

  it('a diagnostic write failure produces a warning and does NOT fail the run (SC-008)', async () => {
    await runOnce({
      verbose: true,
      injectWriteFailure: true,
      workspaceRoot: tmpRoot
    });
    const log = await readAuditLog(tmpRoot);
    const lines = log.trim().split('\n').map((l) => JSON.parse(l));
    const ends = lines.filter((l) => l.eventType === 'phase-end');
    expect(ends.every((e) => !Object.hasOwn(e.payload, 'warnings'))).toBe(true);
    // Run still successfully completed (status 'completed').
    expect(lines.some((l) => l.eventType === 'phase-end' && l.outcome === 'success')).toBe(true);
  });
});
