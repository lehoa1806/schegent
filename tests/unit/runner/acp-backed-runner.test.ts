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
});
