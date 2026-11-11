import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AcpBackedRunner,
  AcpProfileMismatchError,
  type AcpRunnerObservationEvent
} from '../../../src/runner/acp-backed-runner';
import type { BackendRunner } from '../../../src/contracts/backend-runner';
import { AcpAuthorityGate } from '../../../src/services/containment-qualification/acp-authority-gate';

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

describe('AcpBackedRunner (FR-R6-F13-C & F09-FR-17)', () => {
  it('executes a full ACP turn over stdio, suppresses history-replay side effects, and never bills occupancy as tokens', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'schegent-acp-runner-'));
    try {
      const mockAcpAgentPath = join(tempDir, 'mock-agy-acp.mjs');
      writeFileSync(
        mockAcpAgentPath,
        `#!/usr/bin/env node
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
`,
        'utf8'
      );
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
        onAcpObservation: (ev) => observations.push(ev)
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
});
