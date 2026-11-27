/**
 * FR-R8-02 (02-01) — end-to-end ACP usage propagation, spend bounds, reopen replay, and
 * `strict-usd` pre-admission across all three backends (`claude`, `codex`, `agy`).
 *
 * Drives real fake CLIs through `AcpBackedRunner` (bundled `dist/acp-stdio-bridge.js` for
 * `claude` & `codex`; native ACP stdio for `agy`) -> `PhaseRunner` -> `AuditLogWriter` ->
 * `SpendBoundWatcher` -> `readSpendReplay` and verifies:
 *   1. Measured positive tokens and Claude USD flow truthfully through ACP to `phase-end` and
 *      trigger resumable spend-bound pauses (including Claude cumulative session baseline subtraction).
 *   2. Genuine `0` tokens / `0` USD are preserved distinctly from absent usage (`trustFor` remains
 *      `'enforced'`, zero unmeasurable notice).
 *   3. Absent, malformed/invalid, and context-only (`used`/`size` without `_meta.billableTokens`)
 *      ACP updates NEVER fabricate `0`, mark `not-trustworthy`, and emit 1 notice per run per unit.
 *   4. Mixed measured + unmeasured phases treat totals below cap as lower-bound `incomplete`
 *      (`missing-usage`, never `within`), persist across reopen via `readSpendReplay`, and still
 *      pause if the measured lower bound crosses the cap.
 *   5. Connected-workflow `strict-usd` pre-admission refuses unpriced/token-only attempts as
 *      `spend-unverifiable` rather than coercing them to `$0` verified USD.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { OWNER_FOR_TESTS } from '../../src/audit/audit-write-authority';
import type { BackendRunner } from '../../src/contracts/backend-runner';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { SanitizedLogger } from '../../src/lib/logger';
import { AcpBackedRunner } from '../../src/runner/acp-backed-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import {
  accumulateSpend,
  evaluateSpend,
  NO_SPEND_OBSERVED
} from '../../src/services/spend-bound';
import { readSpendReplay } from '../../src/services/spend-bound-replay';
import { createSpendBoundWatcher } from '../../src/services/spend-bound-watcher';
import {
  checkStrictUsdAdmission,
  createEmptyRootUsageRollup
} from '../../src/services/workflow-execution/control-usage-accounting';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../src/services/sqlite-store';
import { PhaseEndCorrelator } from '../../src/services/usage-accounting/phase-end-ingestion';
import { createUsageAccountingService } from '../../src/services/usage-accounting/usage-accounting-service';
import { WORKFLOW_CONTROL_SCHEMA_VERSION } from '../../src/contracts/workflow-controls';
import { assertFreshBuiltBridgeIdentity } from '../helpers/verify-built-bridge';
import type { WorkflowRun } from '../../src/state/workflow-run';

const BRIDGE_BUNDLE = resolve(__dirname, '..', '..', 'dist', 'acp-stdio-bridge.js');
const QUALIFIED_PLATFORM = { os: 'darwin' as const, arch: 'arm64' as const, locality: 'local' as const };

const CLEAN_MODEL_TEXT = [
  'Work completed.',
  '=== SCHEGENT AUDIT LOG ===',
  'files_created: []',
  'files_modified: []',
  'files_deleted: []',
  'commands_executed: []',
  'metrics: {}',
  '=== END AUDIT LOG ===',
  '[SCHEGENT_STATUS: CLEAR]'
].join('\n');

function makeStubInner(): BackendRunner {
  return {
    hasActiveProcess: false,
    invoke: async () => {
      throw new Error('legacy inner runner must not execute');
    },
    cancelActive: () => false,
    settleTeardowns: async () => [],
    close: () => undefined
  };
}

function writeExecutable(filePath: string, content: string): void {
  writeFileSync(filePath, content, 'utf8');
  chmodSync(filePath, 0o755);
}

function makeFakeClaudeCli(scriptPath: string): void {
  writeExecutable(
    scriptPath,
    `#!/usr/bin/env node
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  const mode = prompt.includes('MODE:ZERO') ? 'zero'
    : prompt.includes('MODE:ABSENT') ? 'absent'
    : prompt.includes('MODE:PARTIAL_INVALID') ? 'partial-invalid'
    : prompt.includes('MODE:FAIL_AFTER_COST') ? 'fail-after-cost'
    : prompt.includes('MODE:INVALID') ? 'invalid'
    : prompt.includes('MODE:TURN2') ? 'turn2'
    : 'measured';
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const msg = {
    type: 'assistant',
    session_id: sessionId,
    message: { content: [{ type: 'text', text: ${JSON.stringify(CLEAN_MODEL_TEXT)} }] }
  };
  process.stdout.write(JSON.stringify(msg) + '\\n');
  if (mode === 'measured') {
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', session_id: sessionId,
      total_cost_usd: 0.40,
      usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 50 }
    }) + '\\n');
  } else if (mode === 'turn2') {
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', session_id: sessionId,
      total_cost_usd: 0.95,
      usage: { input_tokens: 900, output_tokens: 200 }
    }) + '\\n');
  } else if (mode === 'zero') {
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', session_id: sessionId,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 }
    }) + '\\n');
  } else if (mode === 'partial-invalid') {
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', session_id: sessionId,
      total_cost_usd: 0.25,
      usage: { input_tokens: 500, output_tokens: -1 }
    }) + '\\n');
  } else if (mode === 'fail-after-cost') {
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', session_id: sessionId,
      total_cost_usd: 0.75,
      usage: { input_tokens: 300, output_tokens: 100 }
    }) + '\\n');
    process.exit(1);
  } else if (mode === 'invalid') {
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', session_id: sessionId,
      total_cost_usd: -5,
      usage: { input_tokens: -1, output_tokens: 'bad' }
    }) + '\\n');
  } else {
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', session_id: sessionId
    }) + '\\n');
  }
  process.exit(0);
});
`
  );
}

function makeFakeCodexCli(scriptPath: string): void {
  writeExecutable(
    scriptPath,
    `#!/usr/bin/env node
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  const mode = prompt.includes('MODE:ZERO') ? 'zero'
    : prompt.includes('MODE:ABSENT') ? 'absent'
    : prompt.includes('MODE:PARTIAL') ? 'partial'
    : prompt.includes('MODE:HIGH') ? 'high'
    : 'measured';
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thr_1234567890' }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: ${JSON.stringify(CLEAN_MODEL_TEXT)} }
  }) + '\\n');
  if (mode === 'measured') {
    process.stdout.write(JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 400, output_tokens: 100, cached_input_tokens: 25 }
    }) + '\\n');
  } else if (mode === 'partial') {
    process.stdout.write(JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 400 }
    }) + '\\n');
  } else if (mode === 'high') {
    process.stdout.write(JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 800, output_tokens: 200 }
    }) + '\\n');
  } else if (mode === 'zero') {
    process.stdout.write(JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 0, output_tokens: 0 }
    }) + '\\n');
  } else {
    process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');
  }
  process.exit(0);
});
`
  );
}

function makeFakeAgyAcpCli(scriptPath: string): void {
  writeExecutable(
    scriptPath,
    `#!/usr/bin/env node
import * as readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  const msg = JSON.parse(t);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'agy-mock', version: '1.5.12' }, agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } } } });
  } else if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'agy-sess-1' } });
  } else if (msg.method === 'session/prompt') {
    const text = (msg.params?.prompt ?? []).map((b) => b.text ?? '').join('\\n');
    const mode = text.includes('MODE:CONTEXT_ONLY') ? 'context-only'
      : text.includes('MODE:ZERO') ? 'zero'
      : text.includes('MODE:CLEAN_NO_CACHE') ? 'clean-no-cache'
      : 'measured';
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: msg.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ${JSON.stringify(CLEAN_MODEL_TEXT)} } }
      }
    });
    if (mode === 'context-only') {
      // Context window occupancy ONLY (used/size), NO _meta.billableTokens!
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: msg.params.sessionId,
          update: { sessionUpdate: 'usage_update', used: 95_000, size: 200_000 }
        }
      });
    } else if (mode === 'zero') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: msg.params.sessionId,
          update: { sessionUpdate: 'usage_update', used: 1000, size: 200_000, _meta: { billableTokens: { inputTokens: 0, outputTokens: 0 } } }
        }
      });
    } else if (mode === 'clean-no-cache') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: msg.params.sessionId,
          update: { sessionUpdate: 'usage_update', used: 12000, size: 200_000, _meta: { billableTokens: { inputTokens: 700, outputTokens: 250 } } }
        }
      });
    } else {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: msg.params.sessionId,
          update: { sessionUpdate: 'usage_update', used: 12000, size: 200_000, _meta: { billableTokens: { inputTokens: 700, outputTokens: 250, cacheReadInputTokens: 40 } } }
        }
      });
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`
  );
}

function makeRun(runId: string, backend: 'claude' | 'codex' | 'agy', startedAt: number): WorkflowRun {
  return {
    id: runId,
    featureId: `feat-${runId}`,
    status: 'running',
    currentPhase: 'implement',
    currentIteration: 1,
    startedAt,
    manualPauseAt: null,
    manualPauseCause: null,
    phasesCompleted: [],
    phaseOverrides: [],
    pendingRetryAt: null,
    pendingRetryCause: null,
    pipeline: {
      id: 'pipe-1',
      name: 'Pipe',
      version: 1,
      phases: [
        {
          id: 'implement',
          name: 'Implement',
          order: 1,
          runner: backend,
          instruction: 'run'
        }
      ]
    }
  } as unknown as WorkflowRun;
}

describe('FR-R8-02 (02-01) — ACP billable usage propagation and spend-bound enforcement', () => {
  it('propagates real Claude USD (with session baseline subtraction), distinguishes genuine 0 from absent/invalid, and pauses on USD threshold crossing', async () => {
    expect(existsSync(BRIDGE_BUNDLE)).toBe(true);
    assertFreshBuiltBridgeIdentity(resolve(__dirname, '..', '..'));
    const root = mkdtempSync(join(tmpdir(), 'schegent-usage-claude-'));
    try {
      const cliPath = join(root, 'fake-claude');
      makeFakeClaudeCli(cliPath);
      const logger = new SanitizedLogger();
      const auditWriter = new AuditLogWriter(
        {
          workspaceRoot: root,
          rotationSizeBytes: 5 * 1024 * 1024,
          rotationMaxAgeMs: 86_400_000,
          retentionMaxArchives: 3,
          retentionMaxArchiveAgeMs: 86_400_000,
          authority: OWNER_FOR_TESTS
        },
        logger
      );

      const claudeAcp = new AcpBackedRunner({
        kind: 'claude',
        inner: makeStubInner(),
        bridgeScriptPath: BRIDGE_BUNDLE,
        primaryWorkspaceRoot: root,
        platform: QUALIFIED_PLATFORM
      });
      const phaseRunner = new PhaseRunner({ runner: claudeAcp, promptBuilder: new PromptBuilder(), auditWriter, logger });

      const startedAt = Date.now() - 1_000;
      const runMeasured = makeRun('run-claude-measured', 'claude', startedAt);
      const runZero = makeRun('run-claude-zero', 'claude', startedAt);
      const runUnmeasured = makeRun('run-claude-unmeasured', 'claude', startedAt);
      const runs = new Map<string, WorkflowRun>([
        [runMeasured.id, runMeasured],
        [runZero.id, runZero],
        [runUnmeasured.id, runUnmeasured]
      ]);
      const pauses: Array<{ queueId: string; run: WorkflowRun }> = [];
      const notices: string[] = [];

      const watcher = createSpendBoundWatcher({
        config: () => ({ limitUsd: 0.80, limitTokens: null }),
        findRunById: (id) => {
          const r = runs.get(id);
          return r ? { queueId: 'q1', run: r } : null;
        },
        pause: async (queueId, run) => {
          pauses.push({ queueId, run });
          runs.set(run.id, run);
        },
        notify: (m) => notices.push(m),
        logger,
        now: () => Date.now()
      });
      auditWriter.subscribe((entry) => watcher.onAuditEntry(entry));

      // Turn 1: fresh session, $0.40 USD + 1200/300 tokens -> below $0.80 cap, enforced!
      const out1 = await phaseRunner.run({
        runId: runMeasured.id,
        phase: 'implement',
        iteration: 1,
        iterationCap: 5,
        featureDir: root,
        featureDescription: 'MODE:MEASURED',
        cliPath,
        cwd: root,
        timeoutMs: 15_000,
        phaseDef: { id: 'implement', name: 'Implement', runner: 'claude', instruction: 'run' }
      });
      expect(out1.outcome).toBe('clean');
      expect(out1.cliSessionCostUsd).toBeCloseTo(0.40, 5);
      await new Promise((r) => setTimeout(r, 20));
      expect(watcher.observedFor(runMeasured.id).costUsd).toBeCloseTo(0.40, 5);
      expect(watcher.observedFor(runMeasured.id).totalTokens).toBe(1550);
      expect(watcher.trustFor(runMeasured.id, 'usd')).toBe('enforced');
      expect(pauses).toHaveLength(0);

      // Turn 2: resumed session, cumulative $0.95 -> delta $0.55 -> run total $0.95 >= $0.80 -> PAUSE!
      const out2 = await phaseRunner.run({
        runId: runMeasured.id,
        phase: 'implement',
        iteration: 2,
        iterationCap: 5,
        featureDir: root,
        featureDescription: 'MODE:TURN2',
        cliPath,
        cwd: root,
        timeoutMs: 15_000,
        sessionReuse: true,
        ...(out1.cliSessionId !== undefined ? { resumeSessionId: out1.cliSessionId } : {}),
        ...(out1.cliSessionCostUsd !== undefined ? { resumeSessionCostUsd: out1.cliSessionCostUsd } : {}),
        phaseDef: { id: 'implement', name: 'Implement', runner: 'claude', instruction: 'run' }
      });
      expect(out2.outcome).toBe('clean');
      await new Promise((r) => setTimeout(r, 20));
      expect(watcher.observedFor(runMeasured.id).costUsd).toBeCloseTo(0.95, 5);
      expect(pauses).toHaveLength(1);
      expect(pauses[0]?.run.manualPauseCause).toBe('spend-bound-reached');
      expect(pauses[0]?.run.status).toBe('running');

      // Failed turn after emitting cost MUST NOT advance session cost ledger baseline!
      const failedCostOut = await phaseRunner.run({
        runId: runMeasured.id,
        phase: 'implement',
        iteration: 3,
        iterationCap: 5,
        featureDir: root,
        featureDescription: 'MODE:FAIL_AFTER_COST',
        cliPath,
        cwd: root,
        timeoutMs: 15_000,
        sessionReuse: true,
        ...(out1.cliSessionId !== undefined ? { resumeSessionId: out1.cliSessionId } : {}),
        ...(out1.cliSessionCostUsd !== undefined ? { resumeSessionCostUsd: out1.cliSessionCostUsd } : {}),
        phaseDef: { id: 'implement', name: 'Implement', runner: 'claude', instruction: 'run' }
      });
      expect(failedCostOut.outcome).toBe('failed');
      // Session cost stays at 0.95 from turn 2, never corrupted by failed turn's 0.75!
      expect(failedCostOut.cliSessionCostUsd).toBeCloseTo(0.95, 5);

      // Partial-invalid tokens (`input_tokens: 500, output_tokens: -1`) MUST reject the entire
      // billableTokens object rather than partially billing 500!
      const runPartialInvalid = makeRun('run-claude-partial-invalid', 'claude', startedAt);
      runs.set(runPartialInvalid.id, runPartialInvalid);
      await phaseRunner.run({
        runId: runPartialInvalid.id,
        phase: 'implement',
        iteration: 1,
        iterationCap: 5,
        featureDir: root,
        featureDescription: 'MODE:PARTIAL_INVALID',
        cliPath,
        cwd: root,
        timeoutMs: 15_000,
        phaseDef: { id: 'implement', name: 'Implement', runner: 'claude', instruction: 'run' }
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(watcher.observedFor(runPartialInvalid.id).totalTokens).toBeUndefined();
      expect(watcher.observedFor(runPartialInvalid.id).missingTokenRows).toBe(true);

      // Genuine 0 USD / 0 tokens -> remains enforced, zero unmeasurable notice!
      await phaseRunner.run({
        runId: runZero.id,
        phase: 'implement',
        iteration: 1,
        iterationCap: 5,
        featureDir: root,
        featureDescription: 'MODE:ZERO',
        cliPath,
        cwd: root,
        timeoutMs: 15_000,
        phaseDef: { id: 'implement', name: 'Implement', runner: 'claude', instruction: 'run' }
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(watcher.observedFor(runZero.id).costUsd).toBe(0);
      expect(watcher.observedFor(runZero.id).missingUsdRows).not.toBe(true);
      expect(watcher.trustFor(runZero.id, 'usd')).toBe('enforced');

      // Absent & invalid usage -> NEVER coerced to 0, marked not-trustworthy, exactly ONE notice!
      const noticesBefore = notices.length;
      await phaseRunner.run({
        runId: runUnmeasured.id,
        phase: 'implement',
        iteration: 1,
        iterationCap: 5,
        featureDir: root,
        featureDescription: 'MODE:ABSENT',
        cliPath,
        cwd: root,
        timeoutMs: 15_000,
        phaseDef: { id: 'implement', name: 'Implement', runner: 'claude', instruction: 'run' }
      });
      await phaseRunner.run({
        runId: runUnmeasured.id,
        phase: 'implement',
        iteration: 2,
        iterationCap: 5,
        featureDir: root,
        featureDescription: 'MODE:INVALID',
        cliPath,
        cwd: root,
        timeoutMs: 15_000,
        phaseDef: { id: 'implement', name: 'Implement', runner: 'claude', instruction: 'run' }
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(watcher.observedFor(runUnmeasured.id).costUsd).toBeUndefined();
      expect(watcher.observedFor(runUnmeasured.id).missingUsdRows).toBe(true);
      expect(watcher.trustFor(runUnmeasured.id, 'usd')).toBe('not-trustworthy');
      expect(notices.length - noticesBefore).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);

  it('handles Codex mixed measured+unmeasured turns (lower-bound incomplete below cap, pause on crossing, preserved across reopen) and Agy context-only vs measured billableTokens', async () => {
    const root = mkdtempSync(join(tmpdir(), 'schegent-usage-codex-agy-'));
    try {
      const codexCli = join(root, 'fake-codex');
      const agyCli = join(root, 'fake-agy.mjs');
      makeFakeCodexCli(codexCli);
      makeFakeAgyAcpCli(agyCli);

      const logger = new SanitizedLogger();
      const auditWriter = new AuditLogWriter(
        {
          workspaceRoot: root,
          rotationSizeBytes: 5 * 1024 * 1024,
          rotationMaxAgeMs: 86_400_000,
          retentionMaxArchives: 3,
          retentionMaxArchiveAgeMs: 86_400_000,
          authority: OWNER_FOR_TESTS
        },
        logger
      );

      const codexAcp = new AcpBackedRunner({
        kind: 'codex',
        inner: makeStubInner(),
        bridgeScriptPath: BRIDGE_BUNDLE,
        primaryWorkspaceRoot: root,
        platform: QUALIFIED_PLATFORM
      });
      const agyAcp = new AcpBackedRunner({
        kind: 'agy',
        inner: makeStubInner(),
        primaryWorkspaceRoot: root,
        platform: QUALIFIED_PLATFORM
      });
      const codexPhaseRunner = new PhaseRunner({ runner: codexAcp, promptBuilder: new PromptBuilder(), auditWriter, logger });
      const agyPhaseRunner = new PhaseRunner({ runner: agyAcp, promptBuilder: new PromptBuilder(), auditWriter, logger });

      // Add an anchor entry BEFORE the run's startedAt so `readSpendReplay` bounds the run cleanly.
      await auditWriter.append({
        runId: 'anchor-run',
        phase: 'anchor',
        iteration: 1,
        eventType: 'warning',
        outcome: 'info',
        payload: { reasonCode: 'anchor' }
      });
      await new Promise((r) => setTimeout(r, 15));
      const startedAt = Date.now();

      const runCodex = makeRun('run-codex-mixed', 'codex', startedAt);
      const runAgyCtx = makeRun('run-agy-context-only', 'agy', startedAt);
      const runAgyMeasured = makeRun('run-agy-measured', 'agy', startedAt);
      const runs = new Map<string, WorkflowRun>([
        [runCodex.id, runCodex],
        [runAgyCtx.id, runAgyCtx],
        [runAgyMeasured.id, runAgyMeasured]
      ]);
      const pauses: Array<{ runId: string; cause: string | null }> = [];
      const notices: string[] = [];

      // Wire real SQLite F06 UsageAccountingService alongside SpendBoundWatcher to prove
      // measured (`known`), mixed (`partial`), and context-only (`unknown`) completeness!
      const nowUtc = new Date().toISOString();
      const sqliteConn = new NodeSqliteConnection({ databasePath: ':memory:' });
      SchemaBootstrapService.bootstrapAndMigrate(sqliteConn, () => Date.parse(nowUtc));
      const accounting = createUsageAccountingService({
        conn: sqliteConn,
        nowUtc: () => nowUtc,
        monotonicMs: () => 1,
        workspaceId: 'ws-usage-test'
      });
      const correlator = new PhaseEndCorrelator();

      const watcher = createSpendBoundWatcher({
        config: () => ({ limitUsd: null, limitTokens: 1_200 }),
        findRunById: (id) => {
          const r = runs.get(id);
          return r ? { queueId: 'q1', run: r } : null;
        },
        pause: async (_q, run) => {
          pauses.push({ runId: run.id, cause: run.manualPauseCause });
          runs.set(run.id, run);
        },
        notify: (m) => notices.push(m),
        logger,
        now: () => Date.now()
      });
      auditWriter.subscribe((entry) => {
        watcher.onAuditEntry(entry);
        const snap = correlator.observe(entry);
        if (snap !== undefined) accounting.ingestPhaseEnd(snap);
      });

      // Codex turn 1: measured 400 input (including 25 cached subset) + 100 output = 500 tokens!
      await codexPhaseRunner.run({
        runId: runCodex.id,
        phase: 'implement',
        iteration: 1,
        iterationCap: 5,
        featureDir: root,
        featureDescription: 'MODE:MEASURED',
        cliPath: codexCli,
        cwd: root,
        timeoutMs: 15_000,
        phaseDef: { id: 'implement', name: 'Implement', runner: 'codex', instruction: 'run' }
      });
      await new Promise((r) => setTimeout(r, 20));
      // Principal review Finding 3: Codex cached_input_tokens (25) is a subset of input_tokens (400),
      // so total MUST be 500 (within 510), NEVER double-counted as 525!
      const afterTurn1 = watcher.observedFor(runCodex.id);
      expect(afterTurn1.totalTokens).toBe(500);
      expect(evaluateSpend(afterTurn1, { limitUsd: null, limitTokens: 510 }, 'tokens')).toEqual({
        kind: 'within'
      });

      // Codex turn 2: absent usage -> mixed run MUST be incomplete (`missing-usage`), NEVER `within`!
      await codexPhaseRunner.run({
        runId: runCodex.id,
        phase: 'implement',
        iteration: 2,
        iterationCap: 5,
        featureDir: root,
        featureDescription: 'MODE:ABSENT',
        cliPath: codexCli,
        cwd: root,
        timeoutMs: 15_000,
        phaseDef: { id: 'implement', name: 'Implement', runner: 'codex', instruction: 'run' }
      });
      await new Promise((r) => setTimeout(r, 20));
      const mixedTotal = watcher.observedFor(runCodex.id);
      expect(mixedTotal.totalTokens).toBe(500);
      expect(mixedTotal.missingTokenRows).toBe(true);
      expect(watcher.trustFor(runCodex.id, 'tokens')).toBe('not-trustworthy');
      const mixedVerdict = evaluateSpend(mixedTotal, { limitUsd: null, limitTokens: 1_200 }, 'tokens');
      expect(mixedVerdict.kind).toBe('incomplete');
      if (mixedVerdict.kind === 'incomplete') {
        expect(mixedVerdict.reason).toBe('missing-usage');
      }
      expect(pauses).toHaveLength(0);

      // Simulate host reopen via `readSpendReplay`: backend-qualified total (500) and incompleteness MUST match live!
      const replay = await readSpendReplay(root, logger, [{ runId: runCodex.id, startedAt }]);
      let replayedTotal = NO_SPEND_OBSERVED;
      for (const row of replay.rows) {
        if (row.runId === runCodex.id) {
          replayedTotal = accumulateSpend(replayedTotal, row.payload, row.id, {
            backend: replay.backendByRowId?.get(row.id) ?? 'codex'
          });
        }
      }
      expect(replayedTotal.totalTokens).toBe(500);
      expect(replayedTotal.missingTokenRows).toBe(true);
      expect(evaluateSpend(replayedTotal, { limitUsd: null, limitTokens: 1_200 }, 'tokens').kind).toBe(
        'incomplete'
      );

      // Codex turn 3: measured 1000 tokens -> lower bound 1500 >= 1200 -> MUST STILL PAUSE!
      await codexPhaseRunner.run({
        runId: runCodex.id,
        phase: 'implement',
        iteration: 3,
        iterationCap: 5,
        featureDir: root,
        featureDescription: 'MODE:HIGH',
        cliPath: codexCli,
        cwd: root,
        timeoutMs: 15_000,
        phaseDef: { id: 'implement', name: 'Implement', runner: 'codex', instruction: 'run' }
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(pauses).toEqual([{ runId: runCodex.id, cause: 'spend-bound-reached' }]);

      // Codex partial turn (input_tokens: 400 only, no output_tokens) -> MUST be `incomplete`, NEVER `within`!
      const runCodexPartial = makeRun('run-codex-partial', 'codex', startedAt);
      runs.set(runCodexPartial.id, runCodexPartial);
      await codexPhaseRunner.run({
        runId: runCodexPartial.id,
        phase: 'implement',
        iteration: 1,
        iterationCap: 5,
        featureDir: root,
        featureDescription: 'MODE:PARTIAL',
        cliPath: codexCli,
        cwd: root,
        timeoutMs: 15_000,
        phaseDef: { id: 'implement', name: 'Implement', runner: 'codex', instruction: 'run' }
      });
      await new Promise((r) => setTimeout(r, 20));
      const partialTotal = watcher.observedFor(runCodexPartial.id);
      expect(partialTotal.totalTokens).toBe(400);
      expect(partialTotal.missingTokenRows).toBe(true);
      expect(evaluateSpend(partialTotal, { limitUsd: null, limitTokens: 510 }, 'tokens')).toEqual({
        kind: 'incomplete',
        denomination: 'tokens',
        reason: 'missing-usage'
      });

      // Agy context-only (`used: 95000`, NO `billableTokens`) -> NEVER billed as 95000 or 0!
      const agyCtxOut = await agyPhaseRunner.run({
        runId: runAgyCtx.id,
        phase: 'implement',
        iteration: 1,
        iterationCap: 5,
        featureDir: root,
        featureDescription: 'MODE:CONTEXT_ONLY',
        cliPath: agyCli,
        cwd: root,
        timeoutMs: 15_000,
        phaseDef: { id: 'implement', name: 'Implement', runner: 'agy', instruction: 'run' }
      });
      expect(agyCtxOut.outcome).toBe('clean');
      // Agy measured with ambiguous cache (`inputTokens: 700, outputTokens: 250, cacheReadInputTokens: 40`,
      // cacheRelation: 'unknown') -> confirmed lower bound 950, marked `not-trustworthy` below limit!
      const agyMeasuredOut = await agyPhaseRunner.run({
        runId: runAgyMeasured.id,
        phase: 'implement',
        iteration: 1,
        iterationCap: 5,
        featureDir: root,
        featureDescription: 'MODE:MEASURED',
        cliPath: agyCli,
        cwd: root,
        timeoutMs: 15_000,
        phaseDef: { id: 'implement', name: 'Implement', runner: 'agy', instruction: 'run' }
      });
      expect(agyMeasuredOut.outcome).toBe('clean');
      // Agy measured without ambiguous cache (`700 + 250 = 950`) -> enforced complete!
      const runAgyClean = makeRun('run-agy-clean', 'agy', startedAt);
      runs.set(runAgyClean.id, runAgyClean);
      const agyCleanOut = await agyPhaseRunner.run({
        runId: runAgyClean.id,
        phase: 'implement',
        iteration: 1,
        iterationCap: 5,
        featureDir: root,
        featureDescription: 'MODE:CLEAN_NO_CACHE',
        cliPath: agyCli,
        cwd: root,
        timeoutMs: 15_000,
        phaseDef: { id: 'implement', name: 'Implement', runner: 'agy', instruction: 'run' }
      });
      expect(agyCleanOut.outcome).toBe('clean');
      await new Promise((r) => setTimeout(r, 20));
      expect(watcher.observedFor(runAgyCtx.id).totalTokens).toBeUndefined();
      expect(watcher.trustFor(runAgyCtx.id, 'tokens')).toBe('not-trustworthy');
      expect(watcher.observedFor(runAgyMeasured.id).totalTokens).toBe(950);
      expect(watcher.trustFor(runAgyMeasured.id, 'tokens')).toBe('not-trustworthy');
      expect(watcher.observedFor(runAgyClean.id).totalTokens).toBe(950);
      expect(watcher.trustFor(runAgyClean.id, 'tokens')).toBe('enforced');

      // Verify F06 SQLite usage-accounting completeness across measured (`known`), mixed (`partial`),
      // and context-only (`unknown`) runs!
      const from = new Date(Date.now() - 3_600_000).toISOString();
      const to = new Date(Date.now() + 3_600_000).toISOString();
      const completenessFor = (rootId: string): string | undefined => {
        const res = accounting.query({ groupBy: ['backend'], rootIds: [rootId], from, to });
        expect(res.ok, `query ${rootId}`).toBe(true);
        if (!res.ok) return undefined;
        return res.value.rows[0]?.measures.find((m) => m.measure === 'input_tokens')?.completeness;
      };
      expect(completenessFor(runCodex.id)).toBe('partial');
      expect(completenessFor(runAgyCtx.id)).toBe('unknown');
      expect(completenessFor(runAgyMeasured.id)).toBe('known');
      sqliteConn.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);

  it('refuses strict-usd pre-dispatch admission on unpriced/token-only attempts instead of coercing to $0 verified USD', () => {
    const budget = {
      version: WORKFLOW_CONTROL_SCHEMA_VERSION,
      budgetMode: 'strict-usd' as const,
      maxMicrousd: 1_000_000,
      maxPhaseAttempts: 10,
      maxWallClockMs: 60_000
    };
    const emptyRollup = createEmptyRootUsageRollup();

    // Unpriced next operation (no verified USD upper bound) MUST refuse with spend-unverifiable!
    const unpricedNext = checkStrictUsdAdmission({
      rootBudget: budget,
      rollup: emptyRollup,
      upperBoundMicrousd: undefined,
      upperBoundQuality: 'unavailable'
    });
    expect(unpricedNext.allowed).toBe(false);
    if (!unpricedNext.allowed) {
      expect(unpricedNext.pauseReason).toBe('spend-unverifiable');
    }

    // Prior unpriced/token-only attempt (unpricedAttemptCount > 0) MUST refuse with spend-unverifiable!
    const afterUnpriced = checkStrictUsdAdmission({
      rootBudget: budget,
      rollup: { ...emptyRollup, unpricedAttemptCount: 1 },
      upperBoundMicrousd: 100_000,
      upperBoundQuality: 'verified'
    });
    expect(afterUnpriced.allowed).toBe(false);
    if (!afterUnpriced.allowed) {
      expect(afterUnpriced.pauseReason).toBe('spend-unverifiable');
    }
  });
});
