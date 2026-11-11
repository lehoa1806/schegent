/**
 * FR-R6-F13 (F13-B; FR-001..FR-008, FR-014..FR-019, F13-AC-01, F13-AC-02, F13-AC-06, F13-AC-08) —
 * built-in ACP profiles (`agy-acp-native`, `claude-acp-bridge`, `codex-acp-bridge`), maintained
 * stdio bridges, and credential-free local binary handshake qualification on `darwin/arm64`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { AcpObservation, AcpTransport } from '../../../src/contracts/acp-runtime';
import {
  ACP_PROFILE_IDS,
  acpQualificationForPlatform,
  getBuiltinAcpProfile,
  listBuiltinAcpProfiles,
  openAcpConnection,
  parseBridgeCliArgv,
  resolveAcpProfileLaunch,
  spawnStdioTransport,
  startAcpStdioBridgeServer,
  type ManagedCliChild
} from '../../../src/services/acp-runtime';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Connects `openAcpConnection` in-memory to `startAcpStdioBridgeServer` over paired byte pipes. */
function createInMemoryBridgeTransport(
  backend: 'claude' | 'codex',
  spawnChild: (input: { command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }) => ManagedCliChild
): AcpTransport {
  const stdoutListeners: ((chunk: Uint8Array) => void)[] = [];
  const stderrListeners: ((chunk: Uint8Array) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  const stdinListeners: ((chunk: Uint8Array) => void)[] = [];
  const stdinCloseListeners: (() => void)[] = [];

  const server = startAcpStdioBridgeServer(
    {
      backend,
      cliPath: `/usr/local/bin/${backend}`,
      permissionFlags: backend === 'claude' ? ['--dangerously-skip-permissions'] : ['--sandbox', 'workspace-write'],
      model: `${backend}-test-model`,
      env: { PATH: '/usr/bin:/bin' },
      spawnChild
    },
    {
      onStdin: (fn) => stdinListeners.push(fn),
      onStdinClose: (fn) => stdinCloseListeners.push(fn),
      writeStdout: (line) => {
        const bytes = new TextEncoder().encode(line);
        for (const fn of stdoutListeners) fn(bytes);
      },
      writeStderr: (text) => {
        const bytes = new TextEncoder().encode(text);
        for (const fn of stderrListeners) fn(bytes);
      }
    }
  );

  return {
    write(line: string) {
      const bytes = new TextEncoder().encode(line);
      for (const fn of stdinListeners) fn(bytes);
    },
    onStdout: (fn) => stdoutListeners.push(fn),
    onStderr: (fn) => stderrListeners.push(fn),
    onClose: (fn) => closeListeners.push(fn),
    async close() {
      for (const fn of stdinCloseListeners) fn();
      await server.close();
      for (const fn of closeListeners) fn();
    }
  };
}

describe('FR-R6-F13 (F13-B) — built-in ACP profiles and platform qualification', () => {
  it('qualifies all three built-in profiles on darwin/arm64 and marks unverified platforms unqualified', () => {
    expect(acpQualificationForPlatform({ os: 'darwin', arch: 'arm64' })).toBe('qualified');
    expect(acpQualificationForPlatform({ os: 'linux', arch: 'x64' })).toBe('unqualified');
    expect(acpQualificationForPlatform({ os: 'win32', arch: 'x64' })).toBe('unqualified');

    const darwinProfiles = listBuiltinAcpProfiles({ os: 'darwin', arch: 'arm64' });
    expect(darwinProfiles.map((p) => p.profileId)).toEqual([
      ACP_PROFILE_IDS.claude,
      ACP_PROFILE_IDS.codex,
      ACP_PROFILE_IDS.agy
    ]);
    for (const profile of darwinProfiles) {
      expect(profile.qualification).toBe('qualified');
    }

    const linuxClaude = getBuiltinAcpProfile('claude', { platform: { os: 'linux', arch: 'x64' } });
    expect(linuxClaude.qualification).toBe('unqualified');
  });

  it('refuses to launch an unqualified platform profile without invoking the transport launcher', async () => {
    let launched = false;
    const result = await openAcpConnection({
      profile: getBuiltinAcpProfile('codex', { platform: { os: 'linux', arch: 'x64' } }),
      generation: 1,
      launch: () => {
        launched = true;
        throw new Error('must not launch');
      }
    });
    expect(result).toEqual({ ok: false, refusal: 'profile-unqualified' });
    expect(launched).toBe(false);
  });

  it('parses bridge CLI argv strictly and keeps secrets out of argv on resolveAcpProfileLaunch', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-fake-secret', PATH: '/usr/bin' };
    const claudeLaunch = resolveAcpProfileLaunch({
      kind: 'claude',
      resolvedCliPath: '/opt/bin/claude',
      cwd: '/tmp/ws',
      env,
      model: 'claude-sonnet-4-6',
      effort: 'high',
      bridgeScriptPath: '/opt/schegent/dist/acp-stdio-bridge.js'
    });
    expect(claudeLaunch.args).not.toContain('sk-ant-fake-secret');
    const parsed = parseBridgeCliArgv(claudeLaunch.args.slice(1), env);
    expect(parsed?.backend).toBe('claude');
    expect(parsed?.cliPath).toBe('/opt/bin/claude');
    expect(parsed?.permissionFlags).toEqual(['--dangerously-skip-permissions']);
    expect(parsed?.model).toBe('claude-sonnet-4-6');
    expect(parsed?.effort).toBe('high');

    const agyLaunch = resolveAcpProfileLaunch({
      kind: 'agy',
      resolvedCliPath: '/opt/bin/agy',
      cwd: '/tmp/ws',
      env
    });
    expect(agyLaunch.command).toBe('/opt/bin/agy');
    expect(agyLaunch.args).toEqual(['acp', '--stdio', '--disable-telemetry', '--dangerously-skip-permissions']);
  });
});

describe('FR-R6-F13 (F13-B) — maintained Claude and Codex ACP stdio bridges', () => {
  it('streams Claude stream-json assistant/tool/usage events and preserves distinct providerSessionId across prompts', async () => {
    const capturedLaunches: { args: readonly string[]; stdin: string }[] = [];
    const observations: AcpObservation[] = [];

    const transport = createInMemoryBridgeTransport('claude', (launch) => {
      const record = { args: launch.args, stdin: '' };
      capturedLaunches.push(record);
      const stdoutListeners: ((chunk: Uint8Array) => void)[] = [];
      let resolveExit: (val: { code: number | null; signal: null; launchFailed: boolean }) => void = () => undefined;
      const exited = new Promise<{ code: number | null; signal: null; launchFailed: boolean }>((res) => {
        resolveExit = res;
      });
      return {
        pid: 12345,
        exited,
        writeStdin(text: string) {
          record.stdin += text;
          return true;
        },
        endStdin() {
          queueMicrotask(() => {
            const lines = [
              JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-prov-sess-99' }),
              JSON.stringify({
                type: 'assistant',
                message: {
                  content: [
                    { type: 'thinking', thinking: 'Checking spec...' },
                    { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'README.md' } },
                    { type: 'text', text: 'Phase output ready.' }
                  ]
                }
              }),
              JSON.stringify({
                type: 'user',
                message: {
                  content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }]
                }
              }),
              JSON.stringify({
                type: 'result',
                session_id: 'claude-prov-sess-99',
                stop_reason: 'end_turn',
                total_cost_usd: 0.0125,
                usage: { input_tokens: 120, output_tokens: 45 }
              })
            ].join('\n') + '\n';
            const bytes = new TextEncoder().encode(lines);
            for (const fn of stdoutListeners) fn(bytes);
            resolveExit({ code: 0, signal: null, launchFailed: false });
          });
        },
        onStdout: (fn) => stdoutListeners.push(fn),
        onStderr: () => undefined,
        isProcessTreeGone: () => true,
        terminate: async () => resolveExit({ code: null, signal: null, launchFailed: false })
      };
    });

    const opened = await openAcpConnection({
      profile: getBuiltinAcpProfile('claude', { platform: { os: 'darwin', arch: 'arm64' }, model: 'claude-sonnet-4-6' }),
      generation: 1,
      launch: () => transport,
      verifyResourceLink: (uri) => uri.startsWith('file:///workspace/'),
      onObservation: (obs) => observations.push(obs)
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const sessionRes = await opened.connection.newSession('/workspace');
    expect(sessionRes.ok).toBe(true);
    if (!sessionRes.ok) return;
    // ACP session id is bridge-scoped, distinct from underlying provider session id
    expect(sessionRes.sessionId).toBe('acp-claude-session-1');

    const prompt1 = await opened.connection.prompt({
      sessionId: sessionRes.sessionId,
      attemptId: 'att-101',
      rootId: 'run-101',
      blocks: [
        { type: 'text', text: 'Execute specify phase.' },
        { type: 'embedded-resource', uri: 'schegent://handoff/spec', text: '# Spec body', mimeType: 'text/markdown' },
        { type: 'resource-link', uri: 'file:///workspace/README.md', name: 'README.md' }
      ]
    });
    expect(prompt1).toEqual({
      kind: 'completed',
      turnId: 'turn-1-1',
      stopReason: 'end_turn',
      hostValidationRequired: true
    });
    expect(capturedLaunches[0]?.args).not.toContain('--resume');
    expect(capturedLaunches[0]?.stdin).toContain('<embedded-resource uri="schegent://handoff/spec"');

    // Second prompt on same ACP session automatically uses captured providerSessionId ('claude-prov-sess-99')
    const prompt2 = await opened.connection.prompt({
      sessionId: sessionRes.sessionId,
      attemptId: 'att-102',
      rootId: 'run-101',
      blocks: [{ type: 'text', text: 'Follow up.' }]
    });
    expect(prompt2.kind).toBe('completed');
    expect(capturedLaunches[1]?.args).toContain('--resume');
    expect(capturedLaunches[1]?.args).toContain('claude-prov-sess-99');

    expect(observations.some((o) => o.kind === 'display' && o.event.kind === 'tool-call')).toBe(true);
    expect(observations.some((o) => o.kind === 'usage')).toBe(true);
    await opened.connection.close();
  });

  it('streams Codex JSONL events and handles protocol cancellation cleanly', async () => {
    let terminateCalled = false;
    const transport = createInMemoryBridgeTransport('codex', (launch) => {
      const stdoutListeners: ((chunk: Uint8Array) => void)[] = [];
      let resolveExit: (val: { code: number | null; signal: NodeJS.Signals | null; launchFailed: boolean }) => void =
        () => undefined;
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; launchFailed: boolean }>(
        (res) => {
          resolveExit = res;
        }
      );
      const isCancelCase = launch.args.includes('thread-prev-1');
      return {
        pid: 23456,
        exited,
        writeStdin: () => true,
        endStdin() {
          if (isCancelCase) return; // stays open until cancelled
          queueMicrotask(() => {
            const lines = [
              JSON.stringify({ type: 'thread.started', thread_id: 'thread-prev-1' }),
              JSON.stringify({
                type: 'item.completed',
                item: { id: 'item_1', type: 'agent_message', text: 'Codex completed task.' }
              }),
              JSON.stringify({
                type: 'turn.completed',
                usage: { input_tokens: 80, output_tokens: 20 }
              })
            ].join('\n') + '\n';
            const bytes = new TextEncoder().encode(lines);
            for (const fn of stdoutListeners) fn(bytes);
            resolveExit({ code: 0, signal: null, launchFailed: false });
          });
        },
        onStdout: (fn) => stdoutListeners.push(fn),
        onStderr: () => undefined,
        isProcessTreeGone: () => true,
        async terminate() {
          terminateCalled = true;
          resolveExit({ code: null, signal: 'SIGTERM', launchFailed: false });
        }
      };
    });

    const opened = await openAcpConnection({
      profile: getBuiltinAcpProfile('codex', { platform: { os: 'darwin', arch: 'arm64' } }),
      generation: 1,
      launch: () => transport
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const session = await opened.connection.newSession('/workspace');
    expect(session.ok).toBe(true);
    if (!session.ok) return;

    const first = await opened.connection.prompt({
      sessionId: session.sessionId,
      attemptId: 'att-codex-1',
      rootId: 'run-codex-1',
      blocks: [{ type: 'text', text: 'First turn' }]
    });
    expect(first.kind).toBe('completed');

    const secondPromise = opened.connection.prompt({
      sessionId: session.sessionId,
      attemptId: 'att-codex-2',
      rootId: 'run-codex-1',
      blocks: [{ type: 'text', text: 'Hung turn' }]
    });
    opened.connection.cancel(session.sessionId);
    const second = await secondPromise;
    expect(second).toEqual({
      kind: 'cancelled',
      turnId: 'turn-1-2',
      hostValidationRequired: true
    });
    expect(terminateCalled).toBe(true);
    await opened.connection.close();
  });
});

describe('FR-R6-F13 (F13-B) — credential-free local real-binary handshake on darwin/arm64', () => {
  const agyPath = '/Users/hoale1806/.local/bin/agy';
  const hasLocalAgy = process.platform === 'darwin' && process.arch === 'arm64' && fs.existsSync(agyPath);

  it.skipIf(!hasLocalAgy)(
    'completes credential-free ACP v1 initialize handshake with real local agy acp --stdio',
    async () => {
      const isolatedHome = makeTempDir('schegent-agy-acp-home-');
      const launch = resolveAcpProfileLaunch({
        kind: 'agy',
        resolvedCliPath: agyPath,
        cwd: isolatedHome,
        env: {
          HOME: isolatedHome,
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/Users/hoale1806/.local/bin'
        }
      });
      const opened = await openAcpConnection({
        profile: getBuiltinAcpProfile('agy', { platform: { os: 'darwin', arch: 'arm64' } }),
        generation: 1,
        launch: () => spawnStdioTransport(launch)
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      try {
        const projection = opened.connection.describe();
        expect(projection.state).toBe('ready');
        expect(projection.qualification).toBe('qualified');
        expect(projection.capabilities?.protocolVersion).toBe(1);
        expect(projection.capabilities?.loadSession).toBe(true);
        expect(projection.capabilities?.embeddedContext).toBe(true);
      } finally {
        await opened.connection.close();
      }
    }
  );

  const builtBridgePath = path.resolve(__dirname, '..', '..', '..', 'dist', 'acp-stdio-bridge.js');
  const hasBuiltBridge = process.platform === 'darwin' && process.arch === 'arm64' && fs.existsSync(builtBridgePath);

  it.skipIf(!hasBuiltBridge)(
    'spawns bundled dist/acp-stdio-bridge.js subprocess and completes credential-free handshake + synthetic CLI turn',
    async () => {
      const workDir = makeTempDir('schegent-bridge-subproc-');
      const fakeClaudePath = path.join(workDir, 'fake-claude.mjs');
      fs.writeFileSync(
        fakeClaudePath,
        [
          '#!/usr/bin/env node',
          'process.stdin.resume();',
          'process.stdin.on("end", () => {',
          '  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "prov-subproc-1" }) + "\\n");',
          '  process.stdout.write(JSON.stringify({ type: "result", session_id: "prov-subproc-1", stop_reason: "end_turn", result: "ok from subprocess", usage: { input_tokens: 10, output_tokens: 5 } }) + "\\n");',
          '});'
        ].join('\n'),
        { mode: 0o755 }
      );

      const launch = resolveAcpProfileLaunch({
        kind: 'claude',
        resolvedCliPath: fakeClaudePath,
        cwd: workDir,
        env: { HOME: workDir, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
        bridgeScriptPath: builtBridgePath
      });

      const opened = await openAcpConnection({
        profile: getBuiltinAcpProfile('claude', { platform: { os: 'darwin', arch: 'arm64' } }),
        generation: 1,
        launch: () => spawnStdioTransport(launch)
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      try {
        const sess = await opened.connection.newSession(workDir);
        expect(sess.ok).toBe(true);
        if (!sess.ok) return;
        const turn = await opened.connection.prompt({
          sessionId: sess.sessionId,
          attemptId: 'att-subproc-1',
          rootId: 'run-subproc-1',
          blocks: [{ type: 'text', text: 'hello bridge' }]
        });
        expect(turn).toEqual({
          kind: 'completed',
          turnId: 'turn-1-1',
          stopReason: 'end_turn',
          hostValidationRequired: true
        });
      } finally {
        await opened.connection.close();
      }
    }
  );
});
