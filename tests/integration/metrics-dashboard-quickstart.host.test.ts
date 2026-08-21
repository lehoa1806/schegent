import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';
import { handler as readMetricsHandler } from '../../src/ui/sidebar/commands/cmd-read-metrics';
import { readMetrics } from '../../src/metrics/metrics-service';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../src/lib/logger';
import { CMD_READ_METRICS } from '../../src/contracts/sidebar-ipc';
import type { CommandAckMessage, ReadMetricsCommand } from '../../src/contracts/sidebar-ipc';
import type { AuditEntry } from '../../src/audit/audit-entry';
import type { HandlerContext } from '../../src/ui/sidebar/commands/handler-contract';
import type { RouterDeps } from '../../src/ui/sidebar/commands/router-types';

const EXTENSION_ID = 'schegent.schegent';

// specs/073-metrics-dashboard/quickstart.md "Non-functional checks" — the
// automatable subset. Run against the real Extension Development Host so
// `cmd-read-metrics.ts` and `readMetrics()` execute unmocked. Each workspace
// root is an isolated tmpdir (readMetrics/the handler take a plain path
// string and never touch vscode.workspace), so this never risks the real
// repo's .schegent/audit.log.
//
// NOT covered here (left to the manual quickstart pass, T037): SC-006/
// FR-021's screen-reader / accessibility-tree spot-check — that is a human
// sensory judgment call with no automation harness in this repo, and adding
// one would be speculative scaffolding beyond this task's scope.
export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `extension '${EXTENSION_ID}' not found in test host`);
  await ext.activate();

  await verifyNoMutationAndAdoptionEvent();
  await verifyPerformance();
}

function makeTestContext(workspaceRoot: string): {
  ctx: HandlerContext;
  acks: CommandAckMessage[];
  sessionId: string;
} {
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot }, logger);
  const acks: CommandAckMessage[] = [];
  const sessionId = `host-test-session-${randomUUID()}`;
  const ctx: HandlerContext = {
    deps: {
      logger,
      audit: { append: (entry: Parameters<AuditLogWriter['append']>[0]) => audit.append(entry) },
      metricsService: {
        read: (req: Parameters<typeof readMetrics>[1]) => readMetrics(workspaceRoot, req, logger)
      },
      sessionId,
      metricsViewOpenedState: { emitted: false },
      // FR-R3-024 (FR-008a) — the handler's gate fails closed on an absent
      // callback; this host fixture stands in for the primary window.
      isPrimary: () => true
    } as unknown as RouterDeps,
    postAck: async (msg) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'host-test-correlation'
  };
  return { ctx, acks, sessionId };
}

function readMetricsCommand(correlationId: string): ReadMetricsCommand {
  return { type: CMD_READ_METRICS, correlationId, payload: {} };
}

// FR-018 (no mutation) + FR-022/SC-008 (adoption event).
async function verifyNoMutationAndAdoptionEvent(): Promise<void> {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-metrics-nomutation-'));
  try {
    const schegentDir = path.join(workspaceRoot, '.schegent');
    assert.ok(!fs.existsSync(schegentDir), 'precondition: fresh workspace must not already have .schegent/');

    const { ctx, acks, sessionId } = makeTestContext(workspaceRoot);
    const command = readMetricsCommand(ctx.correlationId);

    await readMetricsHandler(ctx, command);
    await readMetricsHandler(ctx, command);
    await readMetricsHandler(ctx, command);

    assert.equal(acks.length, 3, `expected exactly 3 acks, got ${acks.length}`);
    for (const a of acks) {
      assert.equal(a.status, 'accepted', `expected every ack accepted, got status ${a.status}`);
    }

    // No workflow/task/queue state file appears alongside the audit log —
    // only the writer's own audit.log and its one-time .gitignore self-ignore
    // (schegent-gitignore.ts) are expected under .schegent/.
    const entries = fs.readdirSync(schegentDir, { withFileTypes: true });
    const names = entries.map((e) => e.name).sort();
    assert.deepEqual(
      names,
      ['.gitignore', 'audit.log'],
      `FR-018: unexpected .schegent/ entries after 3 read-only dispatches: ${JSON.stringify(names)}`
    );
    assert.ok(
      entries.every((e) => e.isFile()),
      'FR-018: expected only flat files under .schegent/, no subdirectories'
    );

    const lines = fs
      .readFileSync(path.join(schegentDir, 'audit.log'), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    assert.equal(
      lines.length,
      1,
      `FR-022/SC-008: expected exactly one audit entry across 3 dispatches, got ${lines.length}`
    );

    const entry = JSON.parse(lines[0]!) as AuditEntry;
    assert.equal(entry.eventType, 'metrics-view-opened');
    assert.deepEqual(Object.keys(entry.payload).sort(), ['sessionId']);
    assert.equal(entry.payload.sessionId, sessionId);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

// Comfortably below audit-log-writer.ts's 5 MiB rotation threshold so the
// dispatch below cannot trip maybeRotate() and silently rotate the fixture
// away before readMetrics() scans it, while still matching quickstart.md's
// "around 5 MB" sizing intent.
const TARGET_FIXTURE_BYTES = 4.5 * 1024 * 1024;
const FIXTURE_BASE_MS = Date.parse('2026-01-01T00:00:00.000Z');
const FIRST_OPEN_BUDGET_MS = 500;
const REFRESH_BUDGET_MS = 100;

function fixtureTaskLines(n: number): string[] {
  const runId = `host-perf-run-${n}`;
  const t0 = FIXTURE_BASE_MS + n * 4000;
  const started: AuditEntry = {
    id: `${runId}-started`,
    timestamp: new Date(t0).toISOString(),
    runId,
    phase: 'speckit-specify',
    iteration: 0,
    eventType: 'task-execution-started',
    outcome: 'info',
    payload: { taskId: runId, runId, queueId: 'default', pipelineId: 'default', isResume: false }
  };
  const phaseStartEntry: AuditEntry = {
    id: `${runId}-phase-start`,
    timestamp: new Date(t0 + 1000).toISOString(),
    runId,
    phase: 'speckit-plan',
    iteration: 1,
    eventType: 'phase-start',
    outcome: 'info',
    payload: { pipelineId: 'default', phaseId: 'speckit-plan' }
  };
  const phaseEndEntry: AuditEntry = {
    id: `${runId}-phase-end`,
    timestamp: new Date(t0 + 2000).toISOString(),
    runId,
    phase: 'speckit-plan',
    iteration: 1,
    eventType: 'phase-end',
    outcome: 'success',
    payload: { pipelineId: 'default', phaseId: 'speckit-plan', outcome: 'clean', totalCostUsd: 0.05 }
  };
  const ended: AuditEntry = {
    id: `${runId}-ended`,
    timestamp: new Date(t0 + 3000).toISOString(),
    runId,
    phase: 'done',
    iteration: 0,
    eventType: 'task-execution-ended',
    outcome: 'success',
    payload: {
      taskId: runId,
      runId,
      terminalStatus: 'completed',
      durationMs: 3000,
      phasesTotal: 1,
      phasesCompleted: 1,
      phasesSkipped: 0
    }
  };
  return [started, phaseStartEntry, phaseEndEntry, ended].map((e) => JSON.stringify(e));
}

function writeFixtureAuditLog(auditLogPath: string): number {
  const chunks: string[] = [];
  let bytes = 0;
  let n = 0;
  while (bytes < TARGET_FIXTURE_BYTES) {
    for (const l of fixtureTaskLines(n)) {
      chunks.push(l);
      bytes += Buffer.byteLength(l, 'utf8') + 1;
    }
    n += 1;
  }
  const content = `${chunks.join('\n')}\n`;
  fs.writeFileSync(auditLogPath, content, 'utf8');
  return Buffer.byteLength(content, 'utf8');
}

// SC-002 (first open) / SC-003 (refresh). Measures host-side derivation
// (dispatch through the real cmd-read-metrics handler into readMetrics())
// only — it excludes webview render and the postMessage round-trip, so a
// pass here is necessary but not sufficient for the full end-to-end budget.
async function verifyPerformance(): Promise<void> {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-metrics-perf-'));
  try {
    const schegentDir = path.join(workspaceRoot, '.schegent');
    fs.mkdirSync(schegentDir, { recursive: true });
    const fixtureBytes = writeFixtureAuditLog(path.join(schegentDir, 'audit.log'));

    const { ctx, acks } = makeTestContext(workspaceRoot);
    const command = readMetricsCommand(ctx.correlationId);

    const firstOpenStart = performance.now();
    await readMetricsHandler(ctx, command);
    const firstOpenMs = performance.now() - firstOpenStart;

    // Second dispatch on the same ctx: metricsViewOpenedState.emitted is now
    // true, so the handler takes the no-new-audit-write path — the same
    // shape as a same-session "refresh" per contracts/metrics-view-opened-event.md.
    const refreshStart = performance.now();
    await readMetricsHandler(ctx, command);
    const refreshMs = performance.now() - refreshStart;

    assert.equal(acks.length, 2, `expected exactly 2 acks, got ${acks.length}`);
    for (const a of acks) {
      assert.equal(a.status, 'accepted', `expected every ack accepted, got status ${a.status}`);
    }

    const fixtureMb = (fixtureBytes / (1024 * 1024)).toFixed(2);
    console.log(
      `[metrics-dashboard perf] ${fixtureMb}MB fixture — first-open dispatch: ${firstOpenMs.toFixed(1)}ms ` +
        `(SC-002 budget ${FIRST_OPEN_BUDGET_MS}ms), refresh dispatch: ${refreshMs.toFixed(1)}ms ` +
        `(SC-003 budget ${REFRESH_BUDGET_MS}ms; the metrics service reuses its per-workspace ` +
        `offset cache, so this refresh scans only bytes appended since the first open). ` +
        `Figures are host-side derivation only; they exclude webview render and the postMessage round-trip.`
    );

    assert.ok(
      firstOpenMs < FIRST_OPEN_BUDGET_MS,
      `SC-002: first-open dispatch over a ${fixtureMb}MB fixture took ${firstOpenMs.toFixed(1)}ms, ` +
        `exceeding the ${FIRST_OPEN_BUDGET_MS}ms budget`
    );
    assert.ok(
      refreshMs < REFRESH_BUDGET_MS,
      `SC-003: refresh dispatch over a ${fixtureMb}MB fixture took ${refreshMs.toFixed(1)}ms, ` +
        `exceeding the ${REFRESH_BUDGET_MS}ms budget`
    );
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}
