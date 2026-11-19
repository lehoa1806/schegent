import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeVerboseDiagnosticPath } from '../../src/audit/verbose-diagnostic-path';
import type { BackendRunner } from '../../src/contracts/backend-runner';
import { AcpBackedRunner } from '../../src/runner/acp-backed-runner';
import { AcpAuthorityGate } from '../../src/services/containment-qualification/acp-authority-gate';
import { createPhaseLogService } from '../../src/services/phase-log/phase-log-service';
import { PhaseLogTailSession, type LiveLogBatchItem } from '../../src/services/phase-log/phase-log-tail-session';
import { removeTempRoot } from '../temp-root-cleanup';

const QUALIFIED_PLATFORM = { os: 'darwin', arch: 'arm64' } as const;

function makeNeverInnerRunner(): BackendRunner {
  return {
    hasActiveProcess: false,
    async invoke() {
      throw new Error('inner CLI runner must not be invoked under ACP dispatch');
    },
    cancelActive() {
      return false;
    },
    close() {},
    async settleTeardowns() {
      return [];
    }
  };
}

const STREAMING_AGY_ACP_AGENT = `#!/usr/bin/env node
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
        agentInfo: { name: 'Antigravity ACP Server', version: '1.5.12' },
        agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } }
      }
    });
  } else if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'agy-sess-100' } });
  } else if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId;
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Analyzing ' } }
      }
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'bug report...' } }
      }
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: 'plan',
          entries: [
            { content: 'Verify ACP tee', status: 'completed' },
            { content: 'Verify tail parity', status: 'in_progress' }
          ]
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
          toolCallId: 'call-agy-1',
          title: 'read_file',
          rawInput: { Path: '/workspace/spec.md' }
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
          toolCallId: 'call-agy-1',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'Read 120 lines' } }]
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
          content: { type: 'text', text: 'All checks pass.\\n\\n\`security:' }
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
          content: { type: 'text', text: 'secrets\` verified.' }
        }
      }
    });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`;

describe('Feature 020 BUG-004 (T088, FR-002a, FR-012b, SC-012) — ACP agy Phase Log capture and tail parity', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-acp-phaselog-'));
  });

  afterEach(async () => {
    await removeTempRoot(workspaceRoot);
  });

  it('captures coalesced agy-acp-native events to stream.jsonl and serves identical entries through PhaseLogService and PhaseLogTailSession', async () => {
    const agentPath = path.join(workspaceRoot, 'mock-agy-acp-server.mjs');
    await fs.writeFile(agentPath, STREAMING_AGY_ACP_AGENT, 'utf8');
    await fs.chmod(agentPath, 0o755);

    const runId = 'run-agy-e2e-001';
    const taskId = 'task-agy-e2e-001';
    const phaseId = 'agy-speckit-auto';
    const verboseDiagnostics = composeVerboseDiagnosticPath({
      workspaceRoot,
      runId,
      pipelineId: phaseId,
      phaseId,
      iterationN: 1
    });

    const runner = new AcpBackedRunner({
      kind: 'agy',
      inner: makeNeverInnerRunner(),
      readConfiguredProfile: () => 'agy-acp-native',
      authorityGate: new AcpAuthorityGate({
        isWorkspaceTrusted: () => true,
        holdsPrimacy: () => true,
        currentOwnershipGeneration: () => 1
      }),
      primaryWorkspaceRoot: workspaceRoot,
      platform: QUALIFIED_PLATFORM
    });

    const output = await runner.invoke({
      cliPath: agentPath,
      cwd: workspaceRoot,
      prompt: 'Run /speckit-auto',
      phase: phaseId,
      iteration: 1,
      timeoutMs: 10_000,
      runId,
      verboseDiagnostics
    });

    expect(output.exitCode).toBe(0);
    expect(output.diagnosticsCaptured).toBe(true);

    const service = createPhaseLogService({
      workspaceRoot,
      sanitize: (s) => s,
      readVerboseSetting: () => true,
      getSnapshot: () => ({
        queues: [
          {
            queueId: 'q-non-default',
            tasks: [{ id: taskId, status: 'completed', currentPhase: null, currentPipelineId: phaseId }]
          }
        ],
        history: [{ runId, queueId: 'q-non-default' }],
        availablePipelines: [],
        availablePhases: [{ id: phaseId }]
      }),
      resolveRunId: (id) => (id === taskId ? runId : null)
    });

    const readRes = await service.read({
      selection: {
        queueId: 'q-non-default',
        taskId,
        pipelineId: phaseId,
        phaseId,
        iterationN: null
      }
    });

    expect(readRes.outcome).toBe('success');
    if (readRes.outcome !== 'success') return;
    expect(readRes.manifest.verboseDiagnosticsState).toEqual({ kind: 'entries-present' });
    expect(readRes.manifest.iterations).toEqual([1]);

    const summary = readRes.manifest.entries.map((entry) => ({
      kind: entry.kind,
      body: entry.body
    }));
    expect(summary).toEqual([
      {
        kind: 'system',
        body: { systemSubtype: 'acp-status', systemSummary: 'Analyzing bug report...' }
      },
      {
        kind: 'system',
        body: {
          systemSubtype: 'acp-plan',
          systemSummary: '[completed] Verify ACP tee\n[in_progress] Verify tail parity'
        }
      },
      {
        kind: 'tool-use',
        body: {
          toolName: 'read_file',
          toolInput: '{"Path":"/workspace/spec.md"}',
          toolArguments: { Path: '/workspace/spec.md' }
        }
      },
      {
        kind: 'tool-result',
        body: { toolResult: 'Read 120 lines', isError: false }
      },
      {
        kind: 'assistant-text',
        body: { text: 'All checks pass.\n\n' }
      },
      {
        kind: 'assistant-text',
        body: { text: '`security:secrets` verified.' }
      },
      {
        kind: 'result',
        body: expect.objectContaining({
          resultSummary: expect.stringContaining('session_id=agy-sess-100')
        })
      }
    ]);

    const pushed: LiveLogBatchItem[] = [];
    const tail = new PhaseLogTailSession({
      sessionId: 'tail-agy-e2e',
      workspaceRoot,
      filePath: verboseDiagnostics.streamFile,
      selection: {
        queueId: 'q-non-default',
        taskId: runId,
        pipelineId: phaseId,
        phaseId,
        iterationN: 1
      },
      postBatch: (batch) => {
        pushed.push(...batch.entries);
        return true;
      },
      sanitize: (s) => s,
      caps: { perFieldBytes: 65536 }
    });

    await tail.start();
    tail.ack({ batchSeq: 0 });
    await tail.tick();

    expect(pushed.map((item) => ({ kind: item.entry.kind, body: item.entry.body }))).toEqual(summary);
  });
});

