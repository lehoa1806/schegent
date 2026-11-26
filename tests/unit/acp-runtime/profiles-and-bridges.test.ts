/**
 * FR-R6-F13 (F13-B; FR-001..FR-008, FR-014..FR-019, F13-AC-01, F13-AC-02, F13-AC-06, F13-AC-08) —
 * built-in ACP profiles (`agy-acp-native`, `claude-acp-bridge`, `codex-acp-bridge`), maintained
 * stdio bridges, and credential-free local binary handshake qualification on `darwin/arm64`.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertFreshBuiltBridgeIdentity } from '../../helpers/verify-built-bridge';

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
  type ManagedCliChild,
  type StdioLaunch
} from '../../../src/services/acp-runtime';
import { classifyHostLocality } from '../../../src/services/acp-runtime/profiles';
import type { NativeReviewInvocation } from '../../../src/runner/native-review-launch';
import {
  boundRawInputForFrame,
  chunkTextForFrame,
  formatBridgeCostAmount
} from '../../../src/services/acp-runtime/bridges/acp-stdio-bridge-helpers';

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
  spawnChild: (input: StdioLaunch) => ManagedCliChild,
  nativeReview?: NativeReviewInvocation
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
      ...(nativeReview !== undefined ? { nativeReview } : {}),
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

  it('FR-R7-14 (14-11): classifies host locality and refuses remote darwin/arm64 profiles prior to launch', async () => {
    expect(classifyHostLocality(undefined)).toBe('local');
    expect(classifyHostLocality('')).toBe('local');
    expect(classifyHostLocality('   ')).toBe('local');
    expect(classifyHostLocality('ssh-remote')).toBe('remote');
    expect(classifyHostLocality('dev-container')).toBe('remote');

    expect(acpQualificationForPlatform({ os: 'darwin', arch: 'arm64', locality: 'local' })).toBe('qualified');
    expect(acpQualificationForPlatform({ os: 'darwin', arch: 'arm64', locality: 'remote' })).toBe('unqualified');

    const remoteProfile = getBuiltinAcpProfile('claude', {
      platform: { os: 'darwin', arch: 'arm64', locality: 'remote' }
    });
    expect(remoteProfile.qualification).toBe('unqualified');

    let launched = false;
    const refused = await openAcpConnection({
      profile: remoteProfile,
      generation: 1,
      launch: () => {
        launched = true;
        throw new Error('must not launch remote darwin/arm64 profile');
      }
    });
    expect(refused).toEqual({ ok: false, refusal: 'profile-unqualified' });
    expect(launched).toBe(false);
  });

  it('parses bridge CLI argv strictly and keeps secrets out of argv on resolveAcpProfileLaunch', () => {
    const env = {
      ANTHROPIC_API_KEY: 'sk-ant-fake-secret',
      PATH: '/usr/bin',
      NODE_OPTIONS: '--require=/tmp/evil.js',
      NODE_COMPILE_CACHE: '/tmp/evil-cache',
      LD_PRELOAD: '/tmp/evil.so',
      LD_LIBRARY_PATH: '/tmp/evil-lib',
      LD_AUDIT: '/tmp/evil-audit.so',
      OPENSSL_CONF: '/tmp/evil-openssl.cnf',
      OPENSSL_MODULES: '/tmp/evil-modules',
      OPENSSL_ENGINES: '/tmp/evil-engines',
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corporate-ca.pem'
    };
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
    expect(claudeLaunch.env['NODE_OPTIONS']).toBeUndefined();
    expect(claudeLaunch.env['NODE_COMPILE_CACHE']).toBeUndefined();
    expect(claudeLaunch.env['LD_PRELOAD']).toBeUndefined();
    expect(claudeLaunch.env['LD_LIBRARY_PATH']).toBeUndefined();
    expect(claudeLaunch.env['LD_AUDIT']).toBeUndefined();
    expect(claudeLaunch.env['OPENSSL_CONF']).toBeUndefined();
    expect(claudeLaunch.env['OPENSSL_MODULES']).toBeUndefined();
    expect(claudeLaunch.env['OPENSSL_ENGINES']).toBeUndefined();
    expect(claudeLaunch.env['DYLD_INSERT_LIBRARIES']).toBeUndefined();
    expect(claudeLaunch.env['NODE_EXTRA_CA_CERTS']).toBe('/etc/ssl/corporate-ca.pem');

    // Byte-aware outbound framing: 350 KiB of ASCII control escapes (6x JSON expansion -> ~2.1 MiB)
    // splits into <= 1 MiB JSON-encoded chunks; oversized rawInput is bounded; sub-microdollar
    // positive costs preserve precision or fail closed instead of collapsing to '0'.
    const escapedFlood = '\u001b'.repeat(350_000);
    const chunks = chunkTextForFrame(escapedFlood);
    expect(chunks.length).toBeGreaterThan(1);
    for (const part of chunks) {
      expect(Buffer.byteLength(JSON.stringify(part), 'utf8')).toBeLessThanOrEqual(1024 * 1024);
    }
    expect(chunks.join('')).toBe(escapedFlood);
    expect(boundRawInputForFrame({ blob: 'a'.repeat(600 * 1024) })).toMatchObject({ _truncated: true });
    expect(formatBridgeCostAmount(0)).toBe('0');
    expect(formatBridgeCostAmount(1e-7)).toBe('0.0000001');
    expect(formatBridgeCostAmount(1e-20)).toBeUndefined();
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
    expect(opened.connection.providerSessionIdOf(sessionRes.sessionId)).toBe('claude-prov-sess-99');
    await opened.connection.close();
  });

  it('FR-R7-14 (14-04): rejects replacement-bridge session/load without valid non-ephemeral _meta.providerSessionId and binds valid _meta.providerSessionId', async () => {
    const capturedArgs: (readonly string[])[] = [];
    const makeSpawn = () => (launch: StdioLaunch): ManagedCliChild => {
      capturedArgs.push(launch.args);
      const stdoutListeners: ((chunk: Uint8Array) => void)[] = [];
      let resolveExit: (val: { code: number | null; signal: null; launchFailed: boolean }) => void = () => undefined;
      const exited = new Promise<{ code: number | null; signal: null; launchFailed: boolean }>((res) => {
        resolveExit = res;
      });
      return {
        pid: 55555,
        exited,
        writeStdin: () => true,
        endStdin() {
          queueMicrotask(() => {
            const lines =
              [
                JSON.stringify({ type: 'result', session_id: 'claude-real-prov-7', stop_reason: 'end_turn' })
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
    };

    const transport = createInMemoryBridgeTransport('claude', makeSpawn());
    const opened = await openAcpConnection({
      profile: getBuiltinAcpProfile('claude', { platform: { os: 'darwin', arch: 'arm64' } }),
      generation: 2,
      launch: () => transport
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      // Missing _meta.providerSessionId rejects with -32602.
      expect(await opened.connection.loadSession('acp-claude-session-1', '/workspace', { mayLoad: true })).toEqual({
        ok: false,
        reason: 'rejected',
        code: -32602
      });
      // Ephemeral _meta.providerSessionId rejects with -32602.
      expect(
        await opened.connection.loadSession('acp-sess-claude-abc', '/workspace', {
          mayLoad: true,
          providerSessionId: 'acp-claude-session-1'
        })
      ).toEqual({
        ok: false,
        reason: 'rejected',
        code: -32602
      });
      expect(capturedArgs).toHaveLength(0);

      // Valid non-ephemeral _meta.providerSessionId succeeds and drives --resume <id>.
      expect(
        await opened.connection.loadSession('acp-sess-claude-abc', '/workspace', {
          mayLoad: true,
          providerSessionId: 'claude-real-prov-7'
        })
      ).toEqual({ ok: true, sessionId: 'acp-sess-claude-abc' });
      const res = await opened.connection.prompt({
        sessionId: 'acp-sess-claude-abc',
        attemptId: 'att-resumed',
        rootId: 'run-resumed',
        blocks: [{ type: 'text', text: 'Continue work' }]
      });
      expect(res.kind).toBe('completed');
      expect(capturedArgs).toHaveLength(1);
      expect(capturedArgs[0]).toContain('--resume');
      expect(capturedArgs[0]).toContain('claude-real-prov-7');
    } finally {
      await opened.connection.close();
    }
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

  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const builtBridgePath = path.resolve(repoRoot, 'dist', 'acp-stdio-bridge.js');
  const isQualifiedMacArm64 = process.platform === 'darwin' && process.arch === 'arm64';

  it.skipIf(!isQualifiedMacArm64)(
    'spawns bundled dist/acp-stdio-bridge.js subprocess and completes credential-free handshake + synthetic CLI turn',
    async () => {
      assertFreshBuiltBridgeIdentity(repoRoot);
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

describe('native review subprocess dispatch', () => {
  const mergeBase = 'a'.repeat(40);

  async function reviewTurn(
    backend: 'claude' | 'codex',
    review: NativeReviewInvocation,
    prompt: string,
    output: string,
    exitCode = 0
  ) {
    const invocations: Array<{ launch: StdioLaunch; stdin: string }> = [];
    const observations: AcpObservation[] = [];
    const transport = createInMemoryBridgeTransport(backend, (launch) => {
      const invocation = { launch, stdin: '' };
      invocations.push(invocation);
      const listeners: ((bytes: Uint8Array) => void)[] = [];
      let finish!: (exit: { code: number | null; signal: null; launchFailed: boolean }) => void;
      const exited = new Promise<{ code: number | null; signal: null; launchFailed: boolean }>((resolveExit) => {
        finish = resolveExit;
      });
      return {
        pid: 12345,
        exited,
        writeStdin(text) {
          invocation.stdin += text;
          return true;
        },
        endStdin() {
          queueMicrotask(() => {
            const bytes = new TextEncoder().encode(output);
            for (const notify of listeners) notify(bytes);
            finish({ code: exitCode, signal: null, launchFailed: false });
          });
        },
        onStdout: (fn) => listeners.push(fn),
        onStderr: () => undefined,
        isProcessTreeGone: () => true,
        terminate: async () => finish({ code: null, signal: null, launchFailed: false })
      };
    }, review);
    const opened = await openAcpConnection({
      profile: getBuiltinAcpProfile(backend, { platform: { os: 'darwin', arch: 'arm64' } }),
      generation: 1,
      launch: () => transport,
      onObservation: (observation) => observations.push(observation)
    });
    if (!opened.ok) throw new Error('Bridge connection failed.');
    try {
      const session = await opened.connection.newSession('/workspace/target');
      if (!session.ok) throw new Error('Bridge session failed.');
      const outcome = await opened.connection.prompt({
        sessionId: session.sessionId,
        attemptId: 'review-attempt',
        rootId: 'review-run',
        blocks: [{ type: 'text', text: prompt }]
      });
      expect(invocations).toHaveLength(1);
      return { outcome, invocation: invocations[0]!, observations };
    } finally {
      await opened.connection.close();
    }
  }

  it('executes the Codex review subcommand with a read-only sandbox', async () => {
    const report = 'One correctness finding at src/a.ts:7.';
    const result = await reviewTurn('codex', { kind: 'code', mergeBase }, 'Review this Git scope.', [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: report } }),
      JSON.stringify({ type: 'turn.completed' })
    ].join('\n'));
    expect(result.outcome).toMatchObject({ kind: 'completed', stopReason: 'end_turn' });
    expect(result.invocation.launch).toMatchObject({ command: '/usr/local/bin/codex', cwd: '/workspace/target' });
    expect(result.invocation.launch.args).toEqual([
      'exec', '--json', '--sandbox', 'read-only', '--model', 'codex-test-model', 'review', '-'
    ]);
    expect(result.invocation.stdin).toBe('Review this Git scope.\n');
    expect(JSON.stringify(result.observations)).toContain(report);
  });

  it.each([
    ['code', '/code-review --max-findings all Scope information'],
    ['security', '/security-review']
  ] as const)('passes the Claude %s slash command as the first headless input', async (kind, command) => {
    const result = await reviewTurn('claude', { kind, mergeBase }, command, [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Review complete.' }] } }),
      JSON.stringify({ type: 'result', stop_reason: 'end_turn' })
    ].join('\n'));
    expect(result.outcome).toMatchObject({ kind: 'completed', stopReason: 'end_turn' });
    expect(result.invocation.launch.args).toContain('-p');
    expect(result.invocation.launch.args).not.toContain('--resume');
    expect(result.invocation.stdin).toBe(command + '\n');
  });

  function scanOutput(status: string, baseRevision: string) {
    return JSON.stringify({
      ok: true,
      data: {
        manifest: { scan: { status, target: { kind: 'git_diff', baseRevision } } },
        findings: { findings: [{
          title: 'Missing input bound',
          summary: 'A configuration value exceeds the documented bound.',
          severity: { level: 'medium' },
          locations: [{ path: 'src/a.ts', startLine: 7 }],
          remediation: 'Validate the configured range.',
          codeEvidence: [{ code: 'raw evidence omitted' }]
        }] }
      }
    });
  }

  function createFakeScannerExecutable(): { readonly resolvedScannerPath: string; readonly resolvedScannerSha256: string } {
    const dir = makeTempDir('schegent-fake-scanner-');
    const file = path.join(dir, 'codex-security');
    const body = '#!/usr/bin/env node\nprocess.exit(0);\n';
    fs.writeFileSync(file, body, { mode: 0o755 });
    const resolvedScannerPath = fs.realpathSync(file);
    const resolvedScannerSha256 = createHash('sha256').update(body).digest('hex');
    return { resolvedScannerPath, resolvedScannerSha256 };
  }

  it('runs the scanner in the target via exact host-resolved path + SHA-256 and returns only the report fields used for repair', async () => {
    const scanner = createFakeScannerExecutable();
    const result = await reviewTurn(
      'codex',
      { kind: 'security', mergeBase, excludedPaths: ['vendor/private'], ...scanner },
      'This prompt must stay out of the scanner argv.',
      scanOutput('completed', mergeBase)
    );
    expect(result.outcome).toMatchObject({ kind: 'completed', stopReason: 'end_turn' });
    const { launch, stdin } = result.invocation;
    expect(launch.command).toBe(scanner.resolvedScannerPath);
    expect(launch.cwd).toBe('/workspace/target');
    expect(launch.args.slice(0, 5)).toEqual(['scan', '.', '--working-tree', '--base', mergeBase]);
    expect(launch.args).toEqual(expect.arrayContaining([
      '--full-output', '--patch=false', '--create-pr=false', '--validate=false', '--exclude-path=vendor/private'
    ]));
    expect(stdin).toBe('');
    const scratch = path.dirname(launch.args.at(-1)!);
    expect(fs.existsSync(scratch)).toBe(false);
    const messages = JSON.stringify(result.observations);
    expect(messages).toContain('Missing input bound');
    expect(messages).toContain('src/a.ts');
    expect(messages).not.toContain('raw evidence omitted');
  });

  it.each([
    ['failed scan', scanOutput('failed', mergeBase), 0],
    ['different base', scanOutput('completed', 'b'.repeat(40)), 0],
    ['failed process', scanOutput('completed', mergeBase), 2],
    ['malformed output', '{"ok":true}', 0]
  ] as const)('refuses %s before it can become repair input', async (_label, report, exitCode) => {
    const scanner = createFakeScannerExecutable();
    const result = await reviewTurn('codex', { kind: 'security', mergeBase, ...scanner }, 'Scan.', report, exitCode);
    expect(result.outcome.kind).not.toBe('completed');
    expect(JSON.stringify(result.observations)).not.toContain('Missing input bound');
  });

  it('keeps the scan recipe closed across the bridge CLI argv boundary and requires scanner path + SHA-256', () => {
    const scanner = createFakeScannerExecutable();
    const launch = resolveAcpProfileLaunch({
      kind: 'codex', resolvedCliPath: 'codex', cwd: '/workspace', env: {},
      nativeReview: { kind: 'security', mergeBase, excludedPaths: ['vendor/lib'], ...scanner }
    });
    const argv = launch.args.slice(1);
    expect(parseBridgeCliArgv(argv, {})?.nativeReview).toEqual({
      kind: 'security', mergeBase, excludedPaths: ['vendor/lib'], ...scanner
    });
    expect(parseBridgeCliArgv([...argv, '--review-exclude', '../outside'], {})).toBeNull();
    expect(parseBridgeCliArgv([...argv, '--native-review', 'exec'], {})).toBeNull();
    expect(parseBridgeCliArgv([...argv, '--review-base', '--arbitrary'], {})).toBeNull();
    expect(parseBridgeCliArgv(argv.filter((a) => a !== '--scanner-sha256' && a !== scanner.resolvedScannerSha256), {})).toBeNull();
  });
});
