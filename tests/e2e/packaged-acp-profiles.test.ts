/**
 * FR-R8-02 (02-05) — real-process E2E verification across the packaged ACP runtime profiles:
 *   - `claude-acp-bridge` via bundled `dist/acp-stdio-bridge.js`
 *   - `codex-acp-bridge` via bundled `dist/acp-stdio-bridge.js`
 *   - `agy-acp-native` via real ACP stdio subprocess
 *
 * SCOPE & OFFLINE BOUNDARY DISCLOSURE:
 *   This suite exercises real host-to-bridge-to-child process execution using deterministic local
 *   stub CLIs pinned to the behavior-eval manifest digest (`tests/evals/fixtures/backend-behavior/
 *   manifest.json`) and `PROMPT_COMPOSITION_VERSION`. It verifies real transport framing, usage
 *   accounting, terminal reconciliation, output/resource-link containment, webview CSP/trust
 *   boundaries, and `codex-security` standalone refusal/consent behavior WITHOUT requiring remote
 *   paid LLM credentials or network access. Live vendor model quality and paid API behavior remain
 *   explicitly out of scope of offline CI.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { wireContainmentAdmission } from '../../src/activation/containment-admission-wiring';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { OWNER_FOR_TESTS } from '../../src/audit/audit-write-authority';
import { BACKEND_DESCRIPTORS } from '../../src/contracts/backend-descriptors';
import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../../src/contracts/backend-kinds';
import type { BackendRunner } from '../../src/contracts/backend-runner';
import type { ReviewScannerId } from '../../src/contracts/containment-qualification';
import { validateInboundMessage } from '../../src/contracts/runtime-validators';
import { invokeNativeReviewer } from '../../src/controller/native-review';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { SanitizedLogger } from '../../src/lib/logger';
import { AcpBackedRunner } from '../../src/runner/acp-backed-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { PROMPT_COMPOSITION_VERSION } from '../../src/runner/prompt-identity';
import { SpawnGatedRunner } from '../../src/runner/spawn-gated-runner';
import { AcpAuthorityGate } from '../../src/services/containment-qualification/acp-authority-gate';
import { CapabilityNotEnforceableError } from '../../src/services/capability-refusal';
import { ContainmentAdmissionRefusedError } from '../../src/services/containment-qualification/admission-refusal';
import { unwrapStreamJson } from '../../src/parser/stream-json-unwrapper';
import type { AcceptanceMementoPort } from '../../src/services/containment-qualification/acceptance-bindings';
import { buildCspMeta } from '../../src/ui/sidebar/csp';
import { assertFreshBuiltBridgeIdentity } from '../helpers/verify-built-bridge';

const REPO_ROOT = resolve(__dirname, '..', '..');
const BRIDGE_BUNDLE = resolve(REPO_ROOT, 'dist', 'acp-stdio-bridge.js');
const MANIFEST_PATH = resolve(__dirname, '..', 'evals', 'fixtures', 'backend-behavior', 'manifest.json');
const QUALIFIED_PLATFORM = { os: 'darwin' as const, arch: 'arm64' as const, locality: 'local' as const };

const FOUR_TASKS = [
  'read-only-inspect',
  'scoped-file-create',
  'targeted-edit',
  'injection-refusal'
] as const;

class InMemoryMemento implements AcceptanceMementoPort {
  private readonly store = new Map<string, unknown>();
  public get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }
  public async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.store.delete(key);
    else this.store.set(key, value);
  }
}

function makeStubInner(): BackendRunner {
  return {
    hasActiveProcess: false,
    invoke: async () => {
      throw new Error('legacy direct-CLI runner must not run in packaged ACP E2E');
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

function cleanAuditText(summary: string): string {
  return [
    summary,
    '=== SCHEGENT AUDIT LOG ===',
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: []',
    'metrics: {}',
    '=== END AUDIT LOG ===',
    '[SCHEGENT_STATUS: CLEAR]'
  ].join('\n');
}

function makePackagedClaudeStub(scriptPath: string): void {
  writeExecutable(
    scriptPath,
    `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  const neg = (prompt.match(/NEGATIVE:([a-z0-9_-]+)/i) ?? [])[1] ?? null;
  const task = (prompt.match(/TASK_ID:([a-z0-9_-]+)/i) ?? [])[1] ?? 'read-only-inspect';
  if (neg === null) {
    if (task === 'scoped-file-create') {
      mkdirSync(join(process.cwd(), 'src'), { recursive: true });
      writeFileSync(join(process.cwd(), 'src', 'generated-claude.ts'), 'export const createdBy = "claude";\\n', 'utf8');
    } else if (task === 'targeted-edit') {
      const target = join(process.cwd(), 'src', 'target.ts');
      writeFileSync(target, readFileSync(target, 'utf8').replace('original', 'edited-by-claude'), 'utf8');
    }
  }
  const text = ${JSON.stringify(cleanAuditText('PACKAGED_CLAUDE_OK'))}.replace('PACKAGED_CLAUDE_OK', 'PACKAGED_CLAUDE_OK:' + task);
  process.stdout.write(JSON.stringify({
    type: 'assistant',
    session_id: '22222222-2222-4222-8222-222222222222',
    message: { content: [{ type: 'text', text }] }
  }) + '\\n');
  if (neg === 'missing-terminal') { process.exit(0); }
  if (neg === 'contradictory-exit') {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.05, usage: { input_tokens: 50, output_tokens: 20 } }) + '\\n');
    process.exit(1);
  }
  if (neg === 'refusal') {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', stop_reason: 'refusal' }) + '\\n');
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: '22222222-2222-4222-8222-222222222222',
    total_cost_usd: 0.12,
    usage: { input_tokens: 150, output_tokens: 45 }
  }) + '\\n');
  process.exit(0);
});
`
  );
}

function makePackagedCodexStub(scriptPath: string): void {
  writeExecutable(
    scriptPath,
    `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.163.0\\n');
  process.exit(0);
}
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  const neg = (prompt.match(/NEGATIVE:([a-z0-9_-]+)/i) ?? [])[1] ?? null;
  const task = (prompt.match(/TASK_ID:([a-z0-9_-]+)/i) ?? [])[1] ?? 'read-only-inspect';
  if (neg === null) {
    if (task === 'scoped-file-create') {
      mkdirSync(join(process.cwd(), 'src'), { recursive: true });
      writeFileSync(join(process.cwd(), 'src', 'generated-codex.ts'), 'export const createdBy = "codex";\\n', 'utf8');
    } else if (task === 'targeted-edit') {
      const target = join(process.cwd(), 'src', 'target.ts');
      writeFileSync(target, readFileSync(target, 'utf8').replace('original', 'edited-by-codex'), 'utf8');
    }
  }
  const text = ${JSON.stringify(cleanAuditText('PACKAGED_CODEX_OK'))}.replace('PACKAGED_CODEX_OK', 'PACKAGED_CODEX_OK:' + task);
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thr_e2e_001' }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text }
  }) + '\\n');
  if (neg === 'missing-terminal') { process.exit(0); }
  if (neg === 'duplicate-terminal') {
    process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 80, output_tokens: 30 } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 80, output_tokens: 30 } }) + '\\n');
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 120, output_tokens: 40 }
  }) + '\\n');
  process.exit(0);
});
`
  );
}

function makePackagedAgyStub(scriptPath: string): void {
  writeExecutable(
    scriptPath,
    `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
let sessionCwd = process.cwd();
let pendingPrompt = null;
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  if (msg.id === 'perm-req-1' && pendingPrompt !== null) {
    const allowed = msg.result?.outcome?.outcome === 'selected' && msg.result?.outcome?.optionId === 'allow_once';
    const promptId = pendingPrompt.id;
    const sessId = pendingPrompt.sessionId;
    pendingPrompt = null;
    if (allowed) {
      writeFileSync(join(sessionCwd, 'forbidden-permission-write.txt'), 'breach\\n', 'utf8');
    }
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sessId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: ${JSON.stringify(cleanAuditText('PACKAGED_AGY_PERM'))}.replace('PACKAGED_AGY_PERM', allowed ? 'PERM_ALLOWED' : 'PERM_DENIED') }
        }
      }
    });
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    return;
  }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'agy-e2e', version: '1.5.12' },
        agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } }
      }
    });
  } else if (msg.method === 'session/new') {
    if (typeof msg.params?.cwd === 'string') sessionCwd = msg.params.cwd;
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'agy-e2e-session-1' } });
  } else if (msg.method === 'session/prompt') {
    const prompt = (msg.params?.prompt ?? []).map((b) => b.text ?? '').join('\\n');
    const neg = (prompt.match(/NEGATIVE:([a-z0-9_-]+)/i) ?? [])[1] ?? null;
    const task = (prompt.match(/TASK_ID:([a-z0-9_-]+)/i) ?? [])[1] ?? 'read-only-inspect';
    if (neg === 'forbidden-permission') {
      pendingPrompt = { id: msg.id, sessionId: msg.params.sessionId };
      // Emit a display marker first so the host test can simulate mid-turn primacy loss right before callback!
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: msg.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DROP_PRIMACY_NOW' } }
        }
      });
      setTimeout(() => {
        send({
          jsonrpc: '2.0',
          id: 'perm-req-1',
          method: 'session/request_permission',
          params: {
            sessionId: msg.params.sessionId,
            toolCall: { toolCallId: 'tc-forbidden', title: 'Write /etc/passwd', kind: 'edit', locations: [{ path: '/etc/passwd' }] },
            options: [
              { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }
            ]
          }
        });
      }, 25);
      return;
    }
    if (neg === null) {
      if (task === 'scoped-file-create') {
        mkdirSync(join(sessionCwd, 'src'), { recursive: true });
        writeFileSync(join(sessionCwd, 'src', 'generated-agy.ts'), 'export const createdBy = "agy";\\n', 'utf8');
      } else if (task === 'targeted-edit') {
        const target = join(sessionCwd, 'src', 'target.ts');
        writeFileSync(target, readFileSync(target, 'utf8').replace('original', 'edited-by-agy'), 'utf8');
      }
    }
    const text = ${JSON.stringify(cleanAuditText('PACKAGED_AGY_OK'))}.replace('PACKAGED_AGY_OK', 'PACKAGED_AGY_OK:' + task);
    if (neg === 'outside-resource-link') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: msg.params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'resource_link', uri: 'file:///etc/passwd', name: 'passwd' }
          }
        }
      });
    }
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: msg.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
      }
    });
    if (neg === 'context-only') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: msg.params.sessionId,
          update: { sessionUpdate: 'usage_update', used: 50_000, size: 200_000 }
        }
      });
    } else {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: msg.params.sessionId,
          update: {
            sessionUpdate: 'usage_update',
            used: 5_000,
            size: 200_000,
            _meta: { billableTokens: { inputTokens: 180, outputTokens: 60 } }
          }
        }
      });
    }
    if (neg === 'refusal') {
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'refusal' } });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    }
  }
});
`
  );
}

describe('FR-R8-02 (02-05) — real-process E2E across all 3 packaged ACP profiles', () => {
  it('binds fixture digest and PROMPT_COMPOSITION_VERSION, runs all 4 representative tasks + paired negative checks across Claude/Codex/Agy packaged profiles, and verifies CSP/IPC + codex-security consent gates', async () => {
    expect(existsSync(BRIDGE_BUNDLE)).toBe(true);
    assertFreshBuiltBridgeIdentity(REPO_ROOT, { checkWebview: true });
    expect(existsSync(MANIFEST_PATH)).toBe(true);
    const manifestBytes = readFileSync(MANIFEST_PATH);
    const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');
    expect(manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(PROMPT_COMPOSITION_VERSION).toBe(2);

    // Regression check: CSP stays nonce-only/strict and malformed webview IPC fails closed.
    const csp = buildCspMeta('vscode-webview://origin', 'test-nonce-123');
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(validateInboundMessage({ type: 'unknown-evil-msg' }).ok).toBe(false);

    const root = mkdtempSync(join(tmpdir(), 'schegent-packaged-e2e-'));
    try {
      const workspaceDir = join(root, 'workspace');
      const binDir = join(root, 'bin');
      mkdirSync(join(workspaceDir, 'src'), { recursive: true });
      mkdirSync(binDir, { recursive: true });

      // Initialize the disposable git checkout BEFORE running the 4 representative tasks so
      // read-only, scoped-file-create, targeted-edit, and injection-refusal verify real diffs!
      execFileSync('git', ['init', '-q'], { cwd: workspaceDir });
      execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: workspaceDir });
      execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: workspaceDir });
      writeFileSync(join(workspaceDir, 'src', 'target.ts'), 'export const value = "original";\n', 'utf8');
      writeFileSync(join(workspaceDir, '.gitignore'), '.schegent/\n', 'utf8');
      execFileSync('git', ['add', 'src/target.ts', '.gitignore'], { cwd: workspaceDir });
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: workspaceDir });
      const mergeBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspaceDir, encoding: 'utf8' }).trim();

      const claudeCli = join(binDir, 'claude');
      const codexCli = join(binDir, 'codex');
      const agyCli = join(binDir, 'agy.mjs');
      makePackagedClaudeStub(claudeCli);
      makePackagedCodexStub(codexCli);
      makePackagedAgyStub(agyCli);

      const logger = new SanitizedLogger();
      const auditWriter = new AuditLogWriter(
        {
          workspaceRoot: workspaceDir,
          rotationSizeBytes: 5 * 1024 * 1024,
          rotationMaxAgeMs: 86_400_000,
          retentionMaxArchives: 3,
          retentionMaxArchiveAgeMs: 86_400_000,
          authority: OWNER_FOR_TESTS
        },
        logger
      );
      const phaseEndMetrics = new Map<string, Record<string, unknown>>();
      auditWriter.subscribe((entry) => {
        if (entry.eventType === 'phase-end') {
          phaseEndMetrics.set(entry.runId, entry.payload as Record<string, unknown>);
        }
      });

      let livePrimacy = true;
      const authorityGate = new AcpAuthorityGate({
        isWorkspaceTrusted: () => true,
        holdsPrimacy: () => livePrimacy,
        verifyPrimacy: async () => livePrimacy,
        currentOwnershipGeneration: () => 1
      });

      const runners: Record<BackendRunnerKind, AcpBackedRunner> = {
        claude: new AcpBackedRunner({
          kind: 'claude',
          inner: makeStubInner(),
          bridgeScriptPath: BRIDGE_BUNDLE,
          authorityGate,
          primaryWorkspaceRoot: workspaceDir,
          platform: QUALIFIED_PLATFORM
        }),
        codex: new AcpBackedRunner({
          kind: 'codex',
          inner: makeStubInner(),
          bridgeScriptPath: BRIDGE_BUNDLE,
          authorityGate,
          primaryWorkspaceRoot: workspaceDir,
          platform: QUALIFIED_PLATFORM
        }),
        agy: new AcpBackedRunner({
          kind: 'agy',
          inner: makeStubInner(),
          authorityGate,
          primaryWorkspaceRoot: workspaceDir,
          platform: QUALIFIED_PLATFORM,
          onAcpObservation: (ev) => {
            if (ev.observation.kind === 'display' && ev.observation.event.kind === 'message' && (ev.observation.event.text ?? '').includes('DROP_PRIMACY_NOW')) {
              livePrimacy = false;
            }
          }
        })
      };
      const cliPaths: Record<BackendRunnerKind, string> = {
        claude: claudeCli,
        codex: codexCli,
        agy: agyCli
      };

      const phaseRunners: Record<BackendRunnerKind, PhaseRunner> = {
        claude: new PhaseRunner(runners.claude, new PromptBuilder(), auditWriter, logger),
        codex: new PhaseRunner(runners.codex, new PromptBuilder(), auditWriter, logger),
        agy: new PhaseRunner(runners.agy, new PromptBuilder(), auditWriter, logger)
      };

      // 1. All 3 advertised backends × all 4 representative tasks = 12 real-process packaged turns
      //    with real workspace git diff / file-effect assertions per task!
      const gitPorcelain = (): string =>
        execFileSync('git', ['status', '--porcelain'], { cwd: workspaceDir, encoding: 'utf8' }).trim();
      const resetCheckout = (): void => {
        execFileSync('git', ['checkout', '--', '.'], { cwd: workspaceDir });
        execFileSync('git', ['clean', '-fd'], { cwd: workspaceDir });
      };

      for (const backend of SUPPORTED_BACKENDS) {
        expect(BACKEND_DESCRIPTORS[backend].acpProfile.profileId).toBeTruthy();
        for (const taskId of FOUR_TASKS) {
          resetCheckout();
          const runId = `e2e-${backend}-${taskId}`;
          const out = await phaseRunners[backend].run({
            runId,
            phase: 'implement',
            iteration: 1,
            iterationCap: 5,
            featureDir: workspaceDir,
            featureDescription: `TASK_ID:${taskId}`,
            cliPath: cliPaths[backend],
            cwd: workspaceDir,
            timeoutMs: 15_000,
            phaseDef: {
              id: 'implement',
              name: 'Implement',
              runner: backend,
              instruction: `Run ${taskId}`
            }
          });
          expect(out.outcome, `${backend}/${taskId}`).toBe('clean');
          const status = gitPorcelain();
          if (taskId === 'read-only-inspect' || taskId === 'injection-refusal') {
            expect(status, `${backend}/${taskId} must leave zero workspace diffs`).toBe('');
          } else if (taskId === 'scoped-file-create') {
            expect(status, `${backend}/${taskId} must create scoped file`).toContain(
              `src/generated-${backend}.ts`
            );
          } else {
            expect(status, `${backend}/${taskId} must edit target file`).toContain('M src/target.ts');
            expect(readFileSync(join(workspaceDir, 'src', 'target.ts'), 'utf8')).toContain(
              `edited-by-${backend}`
            );
          }
          const endPayload = phaseEndMetrics.get(runId);
          expect(endPayload, `${backend}/${taskId} phase-end`).toBeDefined();
          const metrics = (endPayload?.metrics ?? {}) as Record<string, unknown>;
          expect(typeof metrics.inputTokens).toBe('number');
          expect(Number(metrics.inputTokens)).toBeGreaterThan(0);
          if (backend === 'claude') {
            expect(Number(metrics.totalCostUsd)).toBeCloseTo(0.12, 5);
          }
        }
      }
      resetCheckout();

      // 2. Paired negative cases across all 3 packaged profiles:
      // Claude missing terminal, contradictory exit, refusal
      for (const [neg, warn] of [
        ['missing-terminal', 'acp-missing-terminal-record'],
        ['contradictory-exit', 'acp-contradictory-exit'],
        ['refusal', 'acp-turn-refusal']
      ] as const) {
        const out = await phaseRunners.claude.run({
          runId: `e2e-claude-neg-${neg}`,
          phase: 'implement',
          iteration: 1,
          iterationCap: 5,
          featureDir: workspaceDir,
          featureDescription: `NEGATIVE:${neg}`,
          cliPath: claudeCli,
          cwd: workspaceDir,
          timeoutMs: 15_000,
          phaseDef: {
            id: 'implement',
            name: 'Implement',
            runner: 'claude',
            instruction: 'neg',
            sideEffects: 'none',
            hostVerification: 'model-token'
          }
        });
        expect(out.outcome).toBe('failed');
        expect(out.warnings).toContain(warn);
      }

      // Codex missing terminal & duplicate turn.completed
      for (const [neg, warn] of [
        ['missing-terminal', 'acp-missing-terminal-record'],
        ['duplicate-terminal', 'acp-contradictory-terminal-record']
      ] as const) {
        const out = await phaseRunners.codex.run({
          runId: `e2e-codex-neg-${neg}`,
          phase: 'implement',
          iteration: 1,
          iterationCap: 5,
          featureDir: workspaceDir,
          featureDescription: `NEGATIVE:${neg}`,
          cliPath: codexCli,
          cwd: workspaceDir,
          timeoutMs: 15_000,
          phaseDef: {
            id: 'implement',
            name: 'Implement',
            runner: 'codex',
            instruction: 'neg',
            sideEffects: 'none',
            hostVerification: 'model-token'
          }
        });
        expect(out.outcome).toBe('failed');
        expect(out.warnings).toContain(warn);
      }

      // Agy refusal + context-only usage (must NOT fabricate 0 tokens) + out-of-workspace resource_link suppression
      const agyRefusal = await phaseRunners.agy.run({
        runId: 'e2e-agy-neg-refusal',
        phase: 'implement',
        iteration: 1,
        iterationCap: 5,
        featureDir: workspaceDir,
        featureDescription: 'NEGATIVE:refusal',
        cliPath: agyCli,
        cwd: workspaceDir,
        timeoutMs: 15_000,
        phaseDef: {
          id: 'implement',
          name: 'Implement',
          runner: 'agy',
          instruction: 'neg',
          sideEffects: 'none',
          hostVerification: 'model-token'
        }
      });
      expect(agyRefusal.outcome).toBe('failed');
      expect(agyRefusal.warnings).toContain('acp-turn-refusal');

      const agyContextOnly = await phaseRunners.agy.run({
        runId: 'e2e-agy-neg-context-only',
        phase: 'implement',
        iteration: 1,
        iterationCap: 5,
        featureDir: workspaceDir,
        featureDescription: 'NEGATIVE:context-only',
        cliPath: agyCli,
        cwd: workspaceDir,
        timeoutMs: 15_000,
        phaseDef: { id: 'implement', name: 'Implement', runner: 'agy', instruction: 'neg' }
      });
      expect(agyContextOnly.outcome).toBe('clean');
      const ctxMetrics = (phaseEndMetrics.get('e2e-agy-neg-context-only')?.metrics ?? {}) as Record<string, unknown>;
      expect(ctxMetrics.inputTokens).toBeUndefined();
      expect(ctxMetrics.outputTokens).toBeUndefined();

      const agyOutsideLink = await phaseRunners.agy.run({
        runId: 'e2e-agy-neg-outside-link',
        phase: 'implement',
        iteration: 1,
        iterationCap: 5,
        featureDir: workspaceDir,
        featureDescription: 'NEGATIVE:outside-resource-link',
        cliPath: agyCli,
        cwd: workspaceDir,
        timeoutMs: 15_000,
        phaseDef: { id: 'implement', name: 'Implement', runner: 'agy', instruction: 'neg' }
      });
      expect(agyOutsideLink.stdoutSummary).not.toContain('/etc/passwd');

      // Real AcpAuthorityGate + capability enforcement:
      // (a) Unenforceable capability withholding fails closed pre-spawn (`CapabilityNotEnforceableError`).
      await expect(
        runners.agy.invoke({
          cliPath: agyCli,
          cwd: workspaceDir,
          prompt: 'read only',
          phase: 'implement',
          iteration: 1,
          timeoutMs: 15_000,
          capabilities: { capabilities: [], declaredAt: 'phase-definition' }
        })
      ).rejects.toThrow(CapabilityNotEnforceableError);

      // (b) Live mid-turn primacy loss denies `session/request_permission` via `AcpAuthorityGate`!
      const receiptsBeforePerm = authorityGate.listReceipts().length;
      const agyPermDeniedRaw = await runners.agy.invoke({
        cliPath: agyCli,
        cwd: workspaceDir,
        prompt: 'NEGATIVE:forbidden-permission',
        phase: 'implement',
        iteration: 1,
        timeoutMs: 15_000
      });
      livePrimacy = true;
      expect(unwrapStreamJson(agyPermDeniedRaw.stdoutBuffer).text).toContain('PERM_DENIED');
      expect(existsSync(join(workspaceDir, 'forbidden-permission-write.txt'))).toBe(false);
      expect(authorityGate.listReceipts().slice(receiptsBeforePerm).some((r) => r.decision === 'denied')).toBe(true);

      const outboundRefused = await runners.agy.invoke({
        cliPath: agyCli,
        cwd: workspaceDir,
        prompt: 'read outside',
        acpPromptBlocks: [{ type: 'resource-link', uri: 'file:///etc/passwd', name: 'passwd' }],
        phase: 'implement',
        iteration: 1,
        timeoutMs: 15_000
      });
      expect(outboundRefused.exitCode).toBe(1);
      expect(outboundRefused.terminalReconciliation?.status).toBe('refused');

      // 3. `codex-security` standalone scanner refusal without consent inside packaged E2E!
      const scannerPath = join(binDir, 'codex-security');
      const scannerLog = join(root, 'scanner.log');
      writeFileSync(scannerLog, '', 'utf8');
      writeExecutable(
        scannerPath,
        `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(scannerLog)}, JSON.stringify(process.argv.slice(2)) + '\\n', 'utf8');
if (process.argv.includes('--version')) { process.stdout.write('codex-security 1.0.0\\n'); process.exit(0); }
process.exit(0);
`
      );
      const wiring = wireContainmentAdmission({
        memento: new InMemoryMemento(),
        logger: { warn: () => undefined },
        isTrusted: () => true,
        hasPrimacy: async () => true,
        environmentPolicy: { mode: 'inherit', inheritProcessEnv: true },
        granted: () => new Set<BackendRunnerKind>(['codex']),
        grantedScanners: () => new Set<ReviewScannerId>(),
        observeVersion: async (p) => (p === codexCli ? '0.163.0' : '1.0.0')
      });
      const gatedCodex = new SpawnGatedRunner('codex', runners.codex, wiring.spawnGate);
      let scannerErr: unknown;
      try {
        await invokeNativeReviewer(
          (req, sink) => gatedCodex.invoke(req, sink),
          {
            runId: 'e2e-codex-security-refused',
            cliPath: codexCli,
            cwd: workspaceDir,
            prompt: 'security scan',
            phase: 'review',
            iteration: 1,
            timeoutMs: 10_000,
            env: { PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}` },
            review: { kind: 'security', mergeBase, excludedPaths: [] }
          },
          'codex',
          null,
          undefined,
          async () => undefined
        );
      } catch (err) {
        scannerErr = err;
      }
      expect(scannerErr).toBeInstanceOf(ContainmentAdmissionRefusedError);
      expect((scannerErr as ContainmentAdmissionRefusedError).scannerTarget).toBe('codex-security');
      expect((scannerErr as ContainmentAdmissionRefusedError).consentable).toBe(false);
      expect(readFileSync(scannerLog, 'utf8')).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
