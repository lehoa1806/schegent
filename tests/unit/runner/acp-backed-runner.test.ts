import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AcpBackedRunner,
  AcpProfileMismatchError,
  type AcpRunnerObservationEvent
} from '../../../src/runner/acp-backed-runner';
import type { BackendRunner, MonitorSidecarEvent } from '../../../src/contracts/backend-runner';
import { composeVerboseDiagnosticPath } from '../../../src/audit/verbose-diagnostic-path';
import { AcpAuthorityGate } from '../../../src/services/containment-qualification/acp-authority-gate';

const QUALIFIED_PLATFORM = { os: 'darwin', arch: 'arm64' } as const;
const UNQUALIFIED_PLATFORM = { os: 'linux', arch: 'x64' } as const;

function makeDummyInnerRunner(kind: 'claude' | 'codex' | 'agy'): BackendRunner & { cliCalled: boolean } {
  const runner: BackendRunner & { cliCalled: boolean } = {
    cliCalled: false,
    hasActiveProcess: false,
    async invoke() {
      runner.cliCalled = true;
      throw new Error('CLI fallback must NEVER be called when ACP dispatch is wired');
    },
    cancelActive() {
      return false;
    },
    close() {},
    async settleTeardowns() {
      return [];
    }
  };
  void kind;
  return runner;
}

/** A stdio ACP agent that answers one turn: a message chunk, a usage update, `end_turn`. */
const MOCK_AGY_ACP_AGENT = `#!/usr/bin/env node
import * as readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'agy-mock', version: '1.5.5' },
        agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } }
      }
    });
  } else if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-live-001' } });
  } else if (msg.method === 'session/prompt') {
    // 1. Live assistant chunk
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-live-001',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Phase completed cleanly.' }
        }
      }
    });
    // 2. ACP usage_update carrying context occupancy (used/size) and monetary cost
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-live-001',
        update: {
          sessionUpdate: 'usage_update',
          used: 4200,
          size: 128000,
          cost: { amount: 0.0125, currency: 'USD' }
        }
      }
    });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`;

describe('AcpBackedRunner (FR-R6-F13-C & F09-FR-17)', () => {
  it('executes a full ACP turn over stdio, suppresses history-replay side effects, and never bills occupancy as tokens', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'schegent-acp-runner-'));
    try {
      const mockAcpAgentPath = join(tempDir, 'mock-agy-acp.mjs');
      writeFileSync(mockAcpAgentPath, MOCK_AGY_ACP_AGENT, 'utf8');
      chmodSync(mockAcpAgentPath, 0o755);

      const inner = makeDummyInnerRunner('agy');
      const observations: AcpRunnerObservationEvent[] = [];
      const gate = new AcpAuthorityGate({
        isWorkspaceTrusted: () => true,
        holdsPrimacy: () => true,
        currentOwnershipGeneration: () => 1
      });

      const runner = new AcpBackedRunner({
        kind: 'agy',
        inner,
        readConfiguredProfile: () => 'agy-acp-native',
        authorityGate: gate,
        primaryWorkspaceRoot: tempDir,
        onAcpObservation: (ev) => observations.push(ev),
        // Review gap GC-18 — the turn under test needs a qualified profile, and only darwin/arm64
        // is qualified (profiles.ts). Pinned, so the turn runs on the Linux leg and on any Mac.
        platform: QUALIFIED_PLATFORM
      });

      const result = await runner.invoke({
        cliPath: mockAcpAgentPath,
        cwd: tempDir,
        prompt: 'Run phase',
        phase: 'implement',
        iteration: 1,
        timeoutMs: 10_000,
        runId: 'run-acp-001'
      });

      expect(inner.cliCalled).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.command).toBe('acp:agy-acp-native');
      expect(result.sawTerminalResult).toBe(true);
      expect(result.cliSessionId).toBe('sess-live-001');
      expect([...result.stdoutBuffer.decompressStream()].join('')).toContain('Phase completed cleanly.');
      expect(observations.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Review gap GC-08 follow-up (2026-11-12) — a session waits for an authoritative primacy verdict
  // before it registers its scope, so no callback is judged on a stand-in. A refused verdict ends the
  // attempt before its prompt is sent.
  it('ends the attempt before its prompt when ownership cannot be verified', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'schegent-acp-runner-'));
    try {
      const mockAcpAgentPath = join(tempDir, 'mock-agy-acp.mjs');
      writeFileSync(mockAcpAgentPath, MOCK_AGY_ACP_AGENT, 'utf8');
      chmodSync(mockAcpAgentPath, 0o755);
      const observations: AcpRunnerObservationEvent[] = [];
      let primed = 0;
      const runner = new AcpBackedRunner({
        kind: 'agy',
        inner: makeDummyInnerRunner('agy'),
        readConfiguredProfile: () => 'agy-acp-native',
        authorityGate: new AcpAuthorityGate({
          isWorkspaceTrusted: () => true,
          holdsPrimacy: () => true,
          currentOwnershipGeneration: () => 1
        }),
        primeAuthority: async () => {
          primed += 1;
          return false;
        },
        primaryWorkspaceRoot: tempDir,
        onAcpObservation: (ev) => observations.push(ev),
        platform: QUALIFIED_PLATFORM
      });

      const result = await runner.invoke({
        cliPath: mockAcpAgentPath,
        cwd: tempDir,
        prompt: 'Run phase',
        phase: 'implement',
        iteration: 1,
        timeoutMs: 10_000,
        runId: 'run-acp-002'
      });

      expect(primed).toBe(1);
      expect(result.exitCode).toBe(1);
      expect(result.diagnosticWarnings).toContain('acp-ownership-unverified');
      expect([...result.stdoutBuffer.decompressStream()].join('')).not.toContain('Phase completed cleanly.');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed with AcpProfileMismatchError without falling back to CLI runner when profile mismatches backend', async () => {
    const inner = makeDummyInnerRunner('claude');
    const runner = new AcpBackedRunner({
      kind: 'claude',
      inner,
      readConfiguredProfile: () => 'agy-acp-native'
    });

    await expect(
      runner.invoke({
        cliPath: process.execPath,
        cwd: process.cwd(),
        prompt: 'test',
        phase: 'specify',
        iteration: 1,
        timeoutMs: 5_000,
        runId: 'run-mismatch-001'
      })
    ).rejects.toBeInstanceOf(AcpProfileMismatchError);
    expect(inner.cliCalled).toBe(false);
  });

  it('refuses an unqualified platform before spawning anything (FR-015)', async () => {
    // Review gap GC-18 — what the Linux leg showed the full turn doing when nothing pinned the
    // platform. The launcher records whether a transport was ever asked for.
    const inner = makeDummyInnerRunner('agy');
    let launched = false;
    const runner = new AcpBackedRunner({
      kind: 'agy',
      inner,
      readConfiguredProfile: () => 'agy-acp-native',
      platform: UNQUALIFIED_PLATFORM,
      launchTransport: () => {
        launched = true;
        throw new Error('an unqualified profile must be refused before launch');
      }
    });

    const result = await runner.invoke({
      cliPath: process.execPath,
      cwd: process.cwd(),
      prompt: 'test',
      phase: 'implement',
      iteration: 1,
      timeoutMs: 5_000,
      runId: 'run-unqualified-001'
    });

    expect(launched).toBe(false);
    expect(inner.cliCalled).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.diagnosticWarnings).toContain('acp-open-refused:profile-unqualified');
  });

  it('tees coalesced ACP display events to verboseDiagnostics stream.jsonl (0600 in 0700 dir), sets diagnosticsCaptured, emits monitor chunks on tool/plan/status, and excludes history replay (BUG-004, FR-002a, FR-012b)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'schegent-acp-verbose-'));
    try {
      const mockAgentScript = `#!/usr/bin/env node
import * as readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'agy-mock', version: '1.5.12' },
        agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } }
      }
    });
  } else if (msg.method === 'session/load') {
    // Replayed history while session/load is outstanding (origin === 'history')
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: msg.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'HISTORICAL_REPLAY_MUST_NOT_APPEAR' }
        }
      }
    });
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId;
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Checking ' } }
      }
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'files...' } }
      }
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: 'plan',
          entries: [{ content: 'Inspect runner', status: 'in_progress' }]
        }
      }
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'read_file',
          rawInput: { path: 'README.md' }
        }
      }
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'ok' } }]
        }
      }
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '\`security:' }
        }
      }
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'secrets\` passed.' }
        }
      }
    });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`;
      const mockPath = join(tempDir, 'mock-agy-verbose.mjs');
      writeFileSync(mockPath, mockAgentScript, 'utf8');
      chmodSync(mockPath, 0o755);

      const monitorEvents: MonitorSidecarEvent[] = [];
      const runner = new AcpBackedRunner({
        kind: 'agy',
        inner: makeDummyInnerRunner('agy'),
        monitorHook: (ev) => monitorEvents.push(ev),
        readConfiguredProfile: () => 'agy-acp-native',
        authorityGate: new AcpAuthorityGate({
          isWorkspaceTrusted: () => true,
          holdsPrimacy: () => true,
          currentOwnershipGeneration: () => 1
        }),
        primaryWorkspaceRoot: tempDir,
        platform: QUALIFIED_PLATFORM
      });

      const verboseDiagnostics = composeVerboseDiagnosticPath({
        workspaceRoot: tempDir,
        runId: 'run-agy-verbose-001',
        pipelineId: 'agy-speckit-auto',
        phaseId: 'agy-speckit-auto',
        iterationN: 1
      });

      const result = await runner.invoke({
        cliPath: mockPath,
        cwd: tempDir,
        prompt: 'Run agy phase',
        phase: 'agy-speckit-auto',
        iteration: 1,
        timeoutMs: 10_000,
        runId: 'run-agy-verbose-001',
        isContinue: true,
        resumeSessionId: 'sess-prior-001',
        resumeSessionOrigin: 'acp',
        verboseDiagnostics
      });

      expect(result.exitCode).toBe(0);
      expect(result.diagnosticsCaptured).toBe(true);
      expect(existsSync(verboseDiagnostics.streamFile)).toBe(true);

      if (process.platform !== 'win32') {
        expect(statSync(verboseDiagnostics.directory).mode & 0o777).toBe(0o700);
        expect(statSync(verboseDiagnostics.streamFile).mode & 0o777).toBe(0o600);
      }

      const rawStream = readFileSync(verboseDiagnostics.streamFile, 'utf8');
      expect(rawStream).not.toContain('HISTORICAL_REPLAY_MUST_NOT_APPEAR');
      expect(rawStream).toContain('`security:secrets` passed.');

      const parsedRows = rawStream
        .trim()
        .split('\n')
        .map((row) => JSON.parse(row) as Record<string, unknown>);
      // Expect: 1 coalesced acp-status + 1 acp-plan + 1 tool_use + 1 tool_result + 1 coalesced assistant + 1 agy result = 6 rows.
      expect(parsedRows).toHaveLength(6);

      const stdoutChunks = monitorEvents.filter((ev) => ev.kind === 'stdout-chunk');
      expect(stdoutChunks.length).toBeGreaterThanOrEqual(6);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports acpTurnSettled and backgroundWorkOpenAtResult across unclosed tool calls, async delegation tools, background handoff results, clean tools, and refusal (BUG-001, FR-005a)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'schegent-acp-open-work-'));
    try {
      const mockAgentScript = `#!/usr/bin/env node
import * as readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'agy-mock', version: '1.5.12' },
        agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } }
      }
    });
  } else if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-open-work-001' } });
  } else if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId;
    const mode = msg.params.prompt?.[0]?.text ?? '';
    if (mode === 'unclosed-tools') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-cmd-1',
            title: 'run_command',
            rawInput: { CommandLine: 'npm test' }
          }
        }
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-sched-1',
            title: 'Run schedule',
            rawInput: { DurationSeconds: 30 }
          }
        }
      });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    } else if (mode === 'subagent-delegated') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-sub-1',
            title: 'invoke_subagent',
            rawInput: { TypeName: 'research', Role: 'Verifier', Prompt: 'Check tests' }
          }
        }
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-sub-1',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: '{"conversationId":"conv-1"}' } }]
          }
        }
      });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    } else if (mode === 'background-handoff-result') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-bg-1',
            title: 'run_command',
            rawInput: { CommandLine: 'npm run build' }
          }
        }
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-bg-1',
            status: 'completed',
            content: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: 'Tool is running as a background task with task id: task-12'
                }
              }
            ]
          }
        }
      });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    } else if (mode === 'clean-tools') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-read-1',
            title: 'read_file',
            rawInput: { Path: 'README.md' }
          }
        }
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-read-1',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'ok' } }]
          }
        }
      });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    } else if (mode === 'refusal') {
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'refusal' } });
    }
  }
});
`;
      const mockPath = join(tempDir, 'mock-agy-open-work.mjs');
      writeFileSync(mockPath, mockAgentScript, 'utf8');
      chmodSync(mockPath, 0o755);

      const runner = new AcpBackedRunner({
        kind: 'agy',
        inner: makeDummyInnerRunner('agy'),
        readConfiguredProfile: () => 'agy-acp-native',
        authorityGate: new AcpAuthorityGate({
          isWorkspaceTrusted: () => true,
          holdsPrimacy: () => true,
          currentOwnershipGeneration: () => 1
        }),
        primaryWorkspaceRoot: tempDir,
        platform: QUALIFIED_PLATFORM
      });

      const runMode = async (prompt: string) =>
        runner.invoke({
          cliPath: mockPath,
          cwd: tempDir,
          prompt,
          phase: 'agy-speckit-auto',
          iteration: 1,
          timeoutMs: 10_000,
          runId: 'run-open-work-001'
        });

      const unclosed = await runMode('unclosed-tools');
      expect(unclosed.exitCode).toBe(0);
      expect(unclosed.acpTurnSettled).toBe(true);
      expect(unclosed.backgroundWorkOpenAtResult).toBe(true);
      expect('completedAwaitingExit' in unclosed).toBe(false);

      const subagent = await runMode('subagent-delegated');
      expect(subagent.exitCode).toBe(0);
      expect(subagent.acpTurnSettled).toBe(true);
      expect(subagent.backgroundWorkOpenAtResult).toBe(true);

      const bgHandoff = await runMode('background-handoff-result');
      expect(bgHandoff.exitCode).toBe(0);
      expect(bgHandoff.acpTurnSettled).toBe(true);
      expect(bgHandoff.backgroundWorkOpenAtResult).toBe(true);

      const cleanTools = await runMode('clean-tools');
      expect(cleanTools.exitCode).toBe(0);
      expect(cleanTools.acpTurnSettled).toBe(true);
      expect('backgroundWorkOpenAtResult' in cleanTools).toBe(false);

      const refused = await runMode('refusal');
      expect(refused.exitCode).toBe(0);
      expect('acpTurnSettled' in refused).toBe(false);
      expect('backgroundWorkOpenAtResult' in refused).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('loads sessionRoots-owned ACP sessions when resumeSessionOrigin is omitted on the same cwd, while opening session/new for legacy-cli, unknown IDs, or cross-lane cwd mismatch (BUG-001, FR-008, F13-FR-21, F10-FR-19)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'schegent-acp-session-load-'));
    try {
      const otherDir = join(tempDir, 'other-lane');
      mkdirSync(otherDir, { recursive: true });
      const rpcLogPath = join(tempDir, 'rpc-methods.log');
      writeFileSync(rpcLogPath, '', 'utf8');

      const mockAgentScript = `#!/usr/bin/env node
import * as readline from 'node:readline';
import { appendFileSync } from 'node:fs';

const logPath = ${JSON.stringify(rpcLogPath)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'agy-mock', version: '1.5.12' },
        agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } }
      }
    });
  } else if (msg.method === 'session/new') {
    appendFileSync(logPath, 'session/new\\n', 'utf8');
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-owned-001' } });
  } else if (msg.method === 'session/load') {
    appendFileSync(logPath, 'session/load:' + msg.params.sessionId + '\\n', 'utf8');
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`;
      const mockPath = join(tempDir, 'mock-agy-session-load.mjs');
      writeFileSync(mockPath, mockAgentScript, 'utf8');
      chmodSync(mockPath, 0o755);

      const runner = new AcpBackedRunner({
        kind: 'agy',
        inner: makeDummyInnerRunner('agy'),
        readConfiguredProfile: () => 'agy-acp-native',
        authorityGate: new AcpAuthorityGate({
          isWorkspaceTrusted: () => true,
          holdsPrimacy: () => true,
          currentOwnershipGeneration: () => 1
        }),
        primaryWorkspaceRoot: tempDir,
        platform: QUALIFIED_PLATFORM
      });

      // 1. Fresh Turn 1 registers 'sess-owned-001' -> tempDir in sessionRoots.
      const turn1 = await runner.invoke({
        cliPath: mockPath,
        cwd: tempDir,
        prompt: 'Turn 1',
        phase: 'agy-speckit-auto',
        iteration: 1,
        timeoutMs: 10_000,
        runId: 'run-session-load-001'
      });
      expect(turn1.cliSessionId).toBe('sess-owned-001');

      // 2. Immediate continuation with omitted resumeSessionOrigin on same cwd -> session/load.
      const turn2 = await runner.invoke({
        cliPath: mockPath,
        cwd: tempDir,
        prompt: 'Turn 2 continue',
        phase: 'agy-speckit-auto',
        iteration: 1,
        timeoutMs: 10_000,
        runId: 'run-session-load-001',
        isContinue: true,
        resumeSessionId: 'sess-owned-001'
      });
      expect(turn2.cliSessionId).toBe('sess-owned-001');

      // 3. Session reuse with omitted resumeSessionOrigin on same cwd -> session/load.
      const turn3 = await runner.invoke({
        cliPath: mockPath,
        cwd: tempDir,
        prompt: 'Turn 3 reuse',
        phase: 'agy-speckit-auto',
        iteration: 2,
        timeoutMs: 10_000,
        runId: 'run-session-load-001',
        sessionReuse: true,
        resumeSessionId: 'sess-owned-001'
      });
      expect(turn3.cliSessionId).toBe('sess-owned-001');

      // 4. Explicit legacy-cli origin -> refuses load, opens session/new (F13-FR-21).
      await runner.invoke({
        cliPath: mockPath,
        cwd: tempDir,
        prompt: 'Turn 4 legacy-cli',
        phase: 'agy-speckit-auto',
        iteration: 1,
        timeoutMs: 10_000,
        runId: 'run-session-load-001',
        isContinue: true,
        resumeSessionId: 'sess-owned-001',
        resumeSessionOrigin: 'legacy-cli'
      });

      // 5. Unknown pre-cutover resumeSessionId with omitted origin -> opens session/new (F13-FR-21).
      await runner.invoke({
        cliPath: mockPath,
        cwd: tempDir,
        prompt: 'Turn 5 unknown session',
        phase: 'agy-speckit-auto',
        iteration: 1,
        timeoutMs: 10_000,
        runId: 'run-session-load-001',
        isContinue: true,
        resumeSessionId: 'sess-precutover-unknown'
      });

      // 6. Cross-lane cwd mismatch -> opens session/new + warning (F10-FR-19).
      const turn6 = await runner.invoke({
        cliPath: mockPath,
        cwd: otherDir,
        prompt: 'Turn 6 cross-lane',
        phase: 'agy-speckit-auto',
        iteration: 1,
        timeoutMs: 10_000,
        runId: 'run-session-load-001',
        isContinue: true,
        resumeSessionId: 'sess-owned-001'
      });
      expect(turn6.diagnosticWarnings).toContain('acp-session-rebind-fresh-root');

      const rpcCalls = readFileSync(rpcLogPath, 'utf8').trim().split('\n');
      expect(rpcCalls).toEqual([
        'session/new',
        'session/load:sess-owned-001',
        'session/load:sess-owned-001',
        'session/new',
        'session/new',
        'session/new'
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
