/**
 * FR-R8-02 (02-04) — end-to-end process-exit vs backend terminal-record reconciliation through
 * bundled `dist/acp-stdio-bridge.js` -> `AcpBackedRunner` -> `PhaseRunner` -> `AuditLogWriter`.
 *
 * Proves that a clean supported turn advances, real cancellation remains cancelled, and EVERY
 * failed, absent-terminal, contradictory-exit, duplicate/contradictory-terminal, refusal, or
 * uncertain turn fails closed even when earlier model stdout printed a valid `SCHEGENT_STATUS: CLEAR`
 * and audit block.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { OWNER_FOR_TESTS } from '../../src/audit/audit-write-authority';
import type { BackendRunner } from '../../src/contracts/backend-runner';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { PhaseSequencer } from '../../src/controller/phase-sequencer';
import { SanitizedLogger } from '../../src/lib/logger';
import { AcpBackedRunner } from '../../src/runner/acp-backed-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import type { WorkflowRun } from '../../src/state/workflow-run';
import { assertFreshBuiltBridgeIdentity } from '../helpers/verify-built-bridge';

const REPO_ROOT = resolve(__dirname, '..', '..');
const BRIDGE_BUNDLE = resolve(REPO_ROOT, 'dist', 'acp-stdio-bridge.js');
const QUALIFIED_PLATFORM = { os: 'darwin' as const, arch: 'arm64' as const, locality: 'local' as const };

const CLEAN_MODEL_TEXT = [
  'Done.',
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

function makeScenarioClaudeCli(scriptPath: string): void {
  writeExecutable(
    scriptPath,
    `#!/usr/bin/env node
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  const mode = (prompt.match(/SCENARIO:([a-z0-9_-]+)/i) ?? [])[1] ?? 'clean';
  const emitClean = () => {
    process.stdout.write(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: ${JSON.stringify(CLEAN_MODEL_TEXT)} }] }
    }) + '\\n');
  };
  if (mode === 'clean') {
    emitClean();
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5 } }) + '\\n');
    process.exit(0);
  }
  if (mode === 'exit0-no-terminal') {
    emitClean();
    process.exit(0);
  }
  if (mode === 'result-then-nonzero') {
    emitClean();
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n');
    process.exit(1);
  }
  if (mode === 'refusal') {
    emitClean();
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', stop_reason: 'refusal' }) + '\\n');
    process.exit(0);
  }
  if (mode === 'mixed-success-error') {
    emitClean();
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'late failure' }) + '\\n');
    process.exit(0);
  }
  if (mode === 'error-subtype') {
    emitClean();
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_max_turns', result: 'turn budget reached' }) + '\\n');
    process.exit(0);
  }
  if (mode === 'unknown-stop-reason') {
    emitClean();
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', stop_reason: 'tool_use' }) + '\\n');
    process.exit(0);
  }
  if (mode === 'sigkill-after-result') {
    emitClean();
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n');
    setTimeout(() => process.kill(process.pid, 'SIGKILL'), 20);
    return;
  }
  if (mode === 'sigkill-no-result') {
    emitClean();
    setTimeout(() => process.kill(process.pid, 'SIGKILL'), 20);
    return;
  }
  if (mode === 'hang-for-cancel') {
    emitClean();
    const timer = setInterval(() => {}, 1000);
    process.on('SIGTERM', () => { clearInterval(timer); process.exit(143); });
    return;
  }
  process.exit(2);
});
`
  );
}

function makeScenarioAgyCli(scriptPath: string): void {
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
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'agy-rec', version: '1.5.12' }, agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } } } });
  } else if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'agy-rec-sess-1' } });
  } else if (msg.method === 'session/prompt') {
    const prompt = (msg.params?.prompt ?? []).map((b) => b.text ?? '').join('\\n');
    const mode = (prompt.match(/SCENARIO:([a-z0-9_-]+)/i) ?? [])[1] ?? 'clean';
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: msg.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ${JSON.stringify(CLEAN_MODEL_TEXT)} } }
      }
    });
    if (mode === 'transport-drop') {
      // Emit CLEAR, then crash transport before sending prompt response -> uncertain!
      setTimeout(() => process.exit(1), 15);
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`
  );
}

function makeScenarioCodexCli(scriptPath: string): void {
  writeExecutable(
    scriptPath,
    `#!/usr/bin/env node
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  const mode = (prompt.match(/SCENARIO:([a-z0-9_-]+)/i) ?? [])[1] ?? 'clean';
  const emitClean = () => {
    process.stdout.write(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: ${JSON.stringify(CLEAN_MODEL_TEXT)} }
    }) + '\\n');
  };
  if (mode === 'clean') {
    emitClean();
    process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 10 } }) + '\\n');
    process.exit(0);
  }
  if (mode === 'exit0-no-terminal') {
    emitClean();
    process.exit(0);
  }
  if (mode === 'duplicate-turn-completed') {
    emitClean();
    process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 10 } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 10 } }) + '\\n');
    process.exit(0);
  }
  if (mode === 'completed-then-nonzero') {
    emitClean();
    process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 10 } }) + '\\n');
    process.exit(1);
  }
  process.exit(2);
});
`
  );
}

describe('FR-R8-02 (02-04) — end-to-end terminal reconciliation in PhaseRunner', () => {
  it('advances clean turns, cancels on real abort, and fails closed on every absent/contradictory/refusal scenario even when CLEAR is in stdout', async () => {
    assertFreshBuiltBridgeIdentity(REPO_ROOT);
    expect(existsSync(BRIDGE_BUNDLE)).toBe(true);
    const root = mkdtempSync(join(tmpdir(), 'schegent-reconcile-'));
    try {
      const claudeCli = join(root, 'claude-scenarios');
      const codexCli = join(root, 'codex-scenarios');
      const agyCli = join(root, 'agy-scenarios.mjs');
      makeScenarioClaudeCli(claudeCli);
      makeScenarioCodexCli(codexCli);
      makeScenarioAgyCli(agyCli);

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
      const recordedEntries: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
      auditWriter.subscribe((e) =>
        recordedEntries.push({ eventType: e.eventType, payload: e.payload as Record<string, unknown> })
      );

      const claudeAcp = new AcpBackedRunner({
        kind: 'claude',
        inner: makeStubInner(),
        bridgeScriptPath: BRIDGE_BUNDLE,
        primaryWorkspaceRoot: root,
        platform: QUALIFIED_PLATFORM
      });
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
      const claudePhaseRunner = new PhaseRunner(claudeAcp, new PromptBuilder(), auditWriter, logger);
      const codexPhaseRunner = new PhaseRunner(codexAcp, new PromptBuilder(), auditWriter, logger);
      const agyPhaseRunner = new PhaseRunner(agyAcp, new PromptBuilder(), auditWriter, logger);

      const runCase = (
        runner: 'claude' | 'codex' | 'agy',
        scenario: string,
        opts?: { readonly signal?: AbortSignal; readonly timeoutMs?: number }
      ) =>
        (runner === 'claude' ? claudePhaseRunner : runner === 'codex' ? codexPhaseRunner : agyPhaseRunner).run({
          runId: `run-${runner}-${scenario}`,
          phase: 'implement',
          iteration: 1,
          iterationCap: 5,
          featureDir: root,
          featureDescription: `SCENARIO:${scenario}`,
          cliPath: runner === 'claude' ? claudeCli : runner === 'codex' ? codexCli : agyCli,
          cwd: root,
          timeoutMs: opts?.timeoutMs ?? 15_000,
          ...(opts?.signal ? { cancellationSignal: opts.signal } : {}),
          phaseDef: {
            id: 'implement',
            name: 'Implement',
            runner,
            instruction: 'run',
            // Deliberately model-token so ONLY terminal reconciliation (not hostVerification) stops bad turns!
            sideEffects: 'none',
            hostVerification: 'model-token'
          }
        });

      const sequencer = new PhaseSequencer();
      const makeTwoPhaseRun = (runner: 'claude' | 'codex' | 'agy'): WorkflowRun =>
        ({
          id: `seq-${runner}`,
          featureId: 'feat-seq',
          status: 'running',
          currentPhase: 'implement',
          currentIteration: 1,
          startedAt: Date.now(),
          manualPauseAt: null,
          manualPauseCause: null,
          phasesCompleted: [],
          phaseOverrides: [],
          pendingRetryAt: null,
          pendingRetryCause: null,
          pipeline: {
            id: 'pipe-seq',
            name: 'Seq',
            version: 1,
            phases: [
              { id: 'implement', name: 'Implement', order: 1, runner, instruction: 'run' },
              { id: 'verify', name: 'Verify', order: 2, runner, instruction: 'verify' }
            ]
          }
        }) as unknown as WorkflowRun;

      const countNextAdvances = (
        runner: 'claude' | 'codex' | 'agy',
        output: Awaited<ReturnType<typeof runCase>>
      ): number => {
        const run = makeTwoPhaseRun(runner);
        const decision = sequencer.decideAfterPhase({
          run,
          output,
          iteration: 1,
          iterationCap: 3,
          activePhaseDef: run.pipeline!.phases[0],
          latestManualPauseAt: null,
          now: Date.now(),
          forceContinueOnRetryCapDefault: false
        });
        return decision.kind === 'advance-or-loop' && decision.transition.kind === 'advance' ? 1 : 0;
      };

      // Clean cases advance next-node count = 1!
      const claudeClean = await runCase('claude', 'clean');
      expect(claudeClean.outcome).toBe('clean');
      expect(countNextAdvances('claude', claudeClean)).toBe(1);
      const codexClean = await runCase('codex', 'clean');
      expect(codexClean.outcome).toBe('clean');
      expect(countNextAdvances('codex', codexClean)).toBe(1);
      const agyClean = await runCase('agy', 'clean');
      expect(agyClean.outcome).toBe('clean');
      expect(countNextAdvances('agy', agyClean)).toBe(1);

      // Claude negative cases — ALL print CLEAR, NONE may advance (next-node count = 0)!
      const claudeMissing = await runCase('claude', 'exit0-no-terminal');
      expect(claudeMissing.outcome).toBe('failed');
      expect(claudeMissing.terminationReason).toBe('error');
      expect(claudeMissing.warnings).toContain('acp-missing-terminal-record');
      expect(countNextAdvances('claude', claudeMissing)).toBe(0);

      const claudeContradictoryExit = await runCase('claude', 'result-then-nonzero');
      expect(claudeContradictoryExit.outcome).toBe('failed');
      expect(claudeContradictoryExit.warnings).toContain('acp-contradictory-exit');
      expect(countNextAdvances('claude', claudeContradictoryExit)).toBe(0);

      const claudeRefusal = await runCase('claude', 'refusal');
      expect(claudeRefusal.outcome).toBe('failed');
      expect(claudeRefusal.warnings).toContain('acp-turn-refusal');
      expect(countNextAdvances('claude', claudeRefusal)).toBe(0);

      const claudeMixed = await runCase('claude', 'mixed-success-error');
      expect(claudeMixed.outcome).toBe('failed');
      expect(claudeMixed.warnings).toContain('acp-contradictory-terminal-record');
      expect(countNextAdvances('claude', claudeMixed)).toBe(0);

      const claudeErrorSubtype = await runCase('claude', 'error-subtype');
      expect(claudeErrorSubtype.outcome).toBe('failed');
      expect(claudeErrorSubtype.warnings).toContain('acp-terminal-reconciliation-failed');
      expect(countNextAdvances('claude', claudeErrorSubtype)).toBe(0);

      const claudeUnknownStop = await runCase('claude', 'unknown-stop-reason');
      expect(claudeUnknownStop.outcome).toBe('failed');
      expect(claudeUnknownStop.warnings).toContain('acp-terminal-reconciliation-failed');
      expect(countNextAdvances('claude', claudeUnknownStop)).toBe(0);

      const claudeSigkillAfter = await runCase('claude', 'sigkill-after-result');
      expect(claudeSigkillAfter.outcome).toBe('failed');
      expect(claudeSigkillAfter.warnings).toContain('acp-contradictory-exit');
      expect(countNextAdvances('claude', claudeSigkillAfter)).toBe(0);

      const claudeSigkillNoResult = await runCase('claude', 'sigkill-no-result');
      expect(claudeSigkillNoResult.outcome).toBe('failed');
      expect(claudeSigkillNoResult.warnings).toContain('acp-terminal-reconciliation-failed');
      expect(countNextAdvances('claude', claudeSigkillNoResult)).toBe(0);

      // Codex negative cases — ALL print CLEAR, NONE may advance!
      const codexMissing = await runCase('codex', 'exit0-no-terminal');
      expect(codexMissing.outcome).toBe('failed');
      expect(codexMissing.warnings).toContain('acp-missing-terminal-record');
      expect(countNextAdvances('codex', codexMissing)).toBe(0);

      const codexDup = await runCase('codex', 'duplicate-turn-completed');
      expect(codexDup.outcome).toBe('failed');
      expect(codexDup.warnings).toContain('acp-contradictory-terminal-record');
      expect(countNextAdvances('codex', codexDup)).toBe(0);

      const codexContradictoryExit = await runCase('codex', 'completed-then-nonzero');
      expect(codexContradictoryExit.outcome).toBe('failed');
      expect(codexContradictoryExit.warnings).toContain('acp-contradictory-exit');
      expect(countNextAdvances('codex', codexContradictoryExit)).toBe(0);

      // Agy native ACP transport drop after printing CLEAR -> uncertain, NEVER advances!
      const agyUncertain = await runCase('agy', 'transport-drop');
      expect(agyUncertain.outcome).toBe('failed');
      expect(agyUncertain.warnings).toContain('acp-turn-uncertain');
      expect(countNextAdvances('agy', agyUncertain)).toBe(0);

      // Idle timeout while child hangs after printing CLEAR -> MUST classify as timeout, NOT cancel!
      const timedOutRun = await runCase('claude', 'hang-for-cancel', { timeoutMs: 250 });
      expect(timedOutRun.outcome).toBe('timeout');
      expect(timedOutRun.terminationReason).toBe('timeout');
      expect(countNextAdvances('claude', timedOutRun)).toBe(0);

      // Real cancellation — enters cancel arm even when exitCode is 130!
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 150);
      const cancelled = await runCase('claude', 'hang-for-cancel', { signal: ac.signal });
      expect(cancelled.outcome).toBe('failed');
      expect(cancelled.terminationReason).toBe('cancel');
      expect(countNextAdvances('claude', cancelled)).toBe(0);
      expect(recordedEntries.some((e) => e.eventType === 'cancel')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});
