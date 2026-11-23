/**
 * FR-R7-14 (14-04) — Cross-process ACP provider session continuity and fail-closed refusal
 * against TWO sequential real `dist/acp-stdio-bridge.js` subprocesses per bridged backend
 * (`claude` and `codex`) backed by schema-9 SQLite `operational_kv_documents`.
 *
 * Covers:
 * (a) Turn 1 -> bridge exit -> fresh runner/store -> Turn 2 receives original Claude `session_id`
 *     (`--resume`) or Codex `thread_id` (`exec resume`) across two real bridge processes;
 * (b) Mismatched workspace root refuses before spawning any bridge or CLI child;
 * (c) Missing/unmapped, ephemeral, cross-backend, or omitted `isContinue` session IDs refuse
 *     before spawn, and direct replacement-bridge `session/load` without `_meta.providerSessionId`
 *     rejects with JSON-RPC `-32602`;
 * (d) Same-process multi-turn control succeeds and same-process `session/load` rejects cwd mismatch;
 * (e) Incomplete-turn continuation via `PhaseRunner` + `dispatchResumingIncompleteTurns` resumes
 *     the original provider conversation cleanly when a provider ID was observed, and refuses
 *     cleanly before spawn when no provider ID was emitted.
 */
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuditEntry } from '../../src/audit/audit-entry';
import type { AuditLogWriter } from '../../src/audit/audit-log-writer';
import type { BackendRunner } from '../../src/contracts/backend-runner';
import type { PhaseDef } from '../../src/config/pipeline-config';
import { dispatchResumingIncompleteTurns } from '../../src/controller/incomplete-turn-resume';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { SanitizedLogger } from '../../src/lib/logger';
import { AcpBackedRunner } from '../../src/runner/acp-backed-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { openAcpConnection } from '../../src/services/acp-runtime/acp-client';
import { createSqliteAcpDurableRuntimeStore } from '../../src/services/acp-runtime/acp-durable-runtime-store';
import { getBuiltinAcpProfile, resolveAcpProfileLaunch } from '../../src/services/acp-runtime/profiles';
import { spawnStdioTransport } from '../../src/services/acp-runtime/stdio-transport';
import { AcpAuthorityGate } from '../../src/services/containment-qualification/acp-authority-gate';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../src/services/sqlite-store';
import { removeTempRoot } from '../temp-root-cleanup';

const BUILT_BRIDGE_PATH = path.resolve(__dirname, '..', '..', 'dist', 'acp-stdio-bridge.js');
const QUALIFIED_PLATFORM = { os: 'darwin', arch: 'arm64', locality: 'local' } as const;
const WAIT_MS = 20_000;

const CLEAN_CONTRACT_BLOCK = [
  '=== SCHEGENT AUDIT LOG ===',
  'phase: implement',
  'files_created: []',
  'files_modified: []',
  'files_deleted: []',
  'commands_executed: []',
  'network_calls: []',
  'ruleset_switches: []',
  'notes: finished in foreground',
  '=== END AUDIT LOG ===',
  '[SCHEGENT_STATUS: DONE]'
].join('\n');

interface CliInvocationRecord {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly stdin: string;
}

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!;
    await removeTempRoot(dir);
  }
});

function makeNeverInnerRunner(): BackendRunner {
  return {
    hasActiveProcess: false,
    async invoke() {
      throw new Error('CLI fallback must never be called when ACP dispatch is active');
    },
    cancelActive: () => false,
    close() {
      // noop
    },
    settleTeardowns: async () => []
  };
}

function makeTrustedGate(): AcpAuthorityGate {
  return new AcpAuthorityGate({
    isWorkspaceTrusted: () => true,
    holdsPrimacy: () => true,
    currentOwnershipGeneration: () => 1
  });
}

function makeAuditWriter(): AuditLogWriter {
  let seq = 0;
  return {
    append: async (entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> => {
      seq += 1;
      return { id: `audit-${seq}`, timestamp: '2026-11-23T00:00:00.000Z', ...entry };
    },
    logPath: '/tmp/.schegent/audit.log'
  } as unknown as AuditLogWriter;
}

async function readInvocationLog(logPath: string): Promise<CliInvocationRecord[]> {
  const raw = await readFile(logPath, 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CliInvocationRecord);
}

async function writeFakeClaudeCli(
  cliPath: string,
  logPath: string,
  options: { readonly providerSessionId?: string | null; readonly incompleteFirstTurn?: boolean } = {}
): Promise<void> {
  const providerId = options.providerSessionId === undefined ? 'claude-prov-conv-42' : options.providerSessionId;
  const incompleteFirstTurn = options.incompleteFirstTurn === true;
  const script = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const logPath = ${JSON.stringify(logPath)};
const providerId = ${JSON.stringify(providerId)};
const incompleteFirstTurn = ${JSON.stringify(incompleteFirstTurn)};
const cleanBlock = ${JSON.stringify(CLEAN_CONTRACT_BLOCK)};
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  const existing = readFileSync(logPath, 'utf8').trim().split('\\n').filter(Boolean);
  appendFileSync(logPath, JSON.stringify({ argv, cwd: process.cwd(), stdin }) + '\\n', 'utf8');
  const isFirst = existing.length === 0;
  if (providerId !== null) {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: providerId }) + '\\n');
  }
  const text = incompleteFirstTurn && isFirst
    ? 'Still working without contract block.'
    : (incompleteFirstTurn ? cleanBlock : 'Claude reply ok');
  process.stdout.write(JSON.stringify({
    type: 'assistant',
    ...(providerId !== null ? { session_id: providerId } : {}),
    message: { content: [{ type: 'text', text }] }
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'result',
    ...(providerId !== null ? { session_id: providerId } : {}),
    stop_reason: 'end_turn',
    usage: { input_tokens: 15, output_tokens: 7 }
  }) + '\\n');
});
`;
  await writeFile(cliPath, script, 'utf8');
  await chmod(cliPath, 0o755);
}

async function writeFakeCodexCli(
  cliPath: string,
  logPath: string,
  options: { readonly providerSessionId?: string | null; readonly incompleteFirstTurn?: boolean } = {}
): Promise<void> {
  const providerId = options.providerSessionId === undefined ? 'codex-thread-99' : options.providerSessionId;
  const incompleteFirstTurn = options.incompleteFirstTurn === true;
  const script = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const logPath = ${JSON.stringify(logPath)};
const providerId = ${JSON.stringify(providerId)};
const incompleteFirstTurn = ${JSON.stringify(incompleteFirstTurn)};
const cleanBlock = ${JSON.stringify(CLEAN_CONTRACT_BLOCK)};
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  const existing = readFileSync(logPath, 'utf8').trim().split('\\n').filter(Boolean);
  appendFileSync(logPath, JSON.stringify({ argv, cwd: process.cwd(), stdin }) + '\\n', 'utf8');
  const isFirst = existing.length === 0;
  if (providerId !== null && !argv.includes('resume')) {
    process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: providerId }) + '\\n');
  }
  const text = incompleteFirstTurn && isFirst
    ? 'Still working without contract block.'
    : (incompleteFirstTurn ? cleanBlock : 'Codex reply ok');
  process.stdout.write(JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_1', type: 'agent_message', text }
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 20, output_tokens: 10 }
  }) + '\\n');
});
`;
  await writeFile(cliPath, script, 'utf8');
  await chmod(cliPath, 0o755);
}

describe('FR-R7-14 (14-04) — cross-process ACP bridge session continuity and fail-closed refusal', () => {
  it.each([
    ['claude', 'claude-prov-conv-42'],
    ['codex', 'codex-thread-99']
  ] as const)(
    '%s: resumes original provider conversation across two sequential dist/acp-stdio-bridge.js processes and refuses mismatched root / missing / ephemeral / cross-backend bindings before spawn',
    async (backend, expectedProviderId) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `schegent-1404-${backend}-`));
      tempRoots.push(root);
      const workspaceDir = path.join(root, 'workspace-a');
      const otherWorkspaceDir = path.join(root, 'workspace-b');
      await mkdir(workspaceDir, { recursive: true });
      await mkdir(otherWorkspaceDir, { recursive: true });

      const dbPath = path.join(root, 'schegent-state.db');
      const logPath = path.join(root, `${backend}-invocations.jsonl`);
      await writeFile(logPath, '', 'utf8');
      const cliPath = path.join(root, `fake-${backend}.mjs`);
      if (backend === 'claude') {
        await writeFakeClaudeCli(cliPath, logPath, { providerSessionId: expectedProviderId });
      } else {
        await writeFakeCodexCli(cliPath, logPath, { providerSessionId: expectedProviderId });
      }

      // Host 1 (Bridge Process #1): fresh turn mints a persisted handle bound in SQLite.
      const conn1 = new NodeSqliteConnection({ databasePath: dbPath });
      let turn1PersistedHandle: string | undefined;
      try {
        SchemaBootstrapService.bootstrapAndMigrate(conn1, () => 1_700_000_000_000);
        const durable1 = createSqliteAcpDurableRuntimeStore(conn1, 'scope-1404');
        const runner1 = new AcpBackedRunner({
          kind: backend,
          inner: makeNeverInnerRunner(),
          bridgeScriptPath: BUILT_BRIDGE_PATH,
          authorityGate: makeTrustedGate(),
          primaryWorkspaceRoot: workspaceDir,
          sessionBindingStore: durable1.sessionBindings,
          allocateConnectionGeneration: () => durable1.allocateConnectionGeneration(),
          platform: QUALIFIED_PLATFORM
        });

        const turn1 = await runner1.invoke({
          cliPath,
          cwd: workspaceDir,
          prompt: 'Turn 1 initial prompt',
          phase: 'implement',
          iteration: 1,
          timeoutMs: 10_000,
          runId: 'run-1404-1'
        });

        expect(turn1.exitCode).toBe(0);
        expect(turn1.sawTerminalResult).toBe(true);
        expect(turn1.cliSessionId).toBeDefined();
        expect(turn1.cliSessionId).toMatch(new RegExp(`^acp-sess-${backend}-`));
        expect(turn1.cliSessionId).not.toBe(`acp-${backend}-session-1`);
        expect(turn1.cliSessionId).not.toBe(expectedProviderId);
        turn1PersistedHandle = turn1.cliSessionId;
      } finally {
        conn1.close();
      }

      const afterTurn1 = await readInvocationLog(logPath);
      expect(afterTurn1).toHaveLength(1);
      if (backend === 'claude') {
        expect(afterTurn1[0]!.argv).not.toContain('--resume');
      } else {
        expect(afterTurn1[0]!.argv).not.toContain('resume');
      }

      // Host 2 (Bridge Process #2): fresh SQLite connection + fresh runner resolves binding and resumes.
      const conn2 = new NodeSqliteConnection({ databasePath: dbPath });
      try {
        const durable2 = createSqliteAcpDurableRuntimeStore(conn2, 'scope-1404');
        const runner2 = new AcpBackedRunner({
          kind: backend,
          inner: makeNeverInnerRunner(),
          bridgeScriptPath: BUILT_BRIDGE_PATH,
          authorityGate: makeTrustedGate(),
          primaryWorkspaceRoot: workspaceDir,
          sessionBindingStore: durable2.sessionBindings,
          allocateConnectionGeneration: () => durable2.allocateConnectionGeneration(),
          platform: QUALIFIED_PLATFORM
        });

        const persistedHandle = turn1PersistedHandle!;
        // (a) Turn 2 on matching workspace root receives original provider session/thread ID.
        const turn2 = await runner2.invoke({
          cliPath,
          cwd: workspaceDir,
          prompt: 'Turn 2 cross-process continuation',
          phase: 'implement',
          iteration: 1,
          timeoutMs: 10_000,
          runId: 'run-1404-1',
          isContinue: true,
          resumeSessionId: persistedHandle
        });
        expect(turn2.exitCode).toBe(0);
        expect(turn2.sawTerminalResult).toBe(true);
        expect(turn2.cliSessionId).toBe(persistedHandle);

        const afterTurn2 = await readInvocationLog(logPath);
        expect(afterTurn2).toHaveLength(2);
        if (backend === 'claude') {
          const resumeIdx = afterTurn2[1]!.argv.indexOf('--resume');
          expect(resumeIdx).toBeGreaterThanOrEqual(0);
          expect(afterTurn2[1]!.argv[resumeIdx + 1]).toBe(expectedProviderId);
        } else {
          expect(afterTurn2[1]!.argv.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
          expect(afterTurn2[1]!.argv).toContain(expectedProviderId);
        }

        // (b) Mismatched workspace root refuses BEFORE spawning any bridge or CLI child.
        let bridgeLaunched = false;
        const spyRunner = new AcpBackedRunner({
          kind: backend,
          inner: makeNeverInnerRunner(),
          bridgeScriptPath: BUILT_BRIDGE_PATH,
          authorityGate: makeTrustedGate(),
          primaryWorkspaceRoot: workspaceDir,
          sessionBindingStore: durable2.sessionBindings,
          platform: QUALIFIED_PLATFORM,
          launchTransport: () => {
            bridgeLaunched = true;
            throw new Error('bridge must never spawn on unrecoverable resume');
          }
        });

        const wrongRoot = await spyRunner.invoke({
          cliPath,
          cwd: otherWorkspaceDir,
          prompt: 'Wrong workspace resume',
          phase: 'implement',
          iteration: 1,
          timeoutMs: 10_000,
          runId: 'run-1404-wrong-root',
          isContinue: true,
          resumeSessionId: persistedHandle
        });
        expect(wrongRoot.exitCode).toBe(1);
        expect(wrongRoot.diagnosticWarnings).toContain('acp-session-resume-unrecoverable:workspace-root-mismatch');
        expect(bridgeLaunched).toBe(false);

        // (c1) Unmapped/missing binding refuses before spawn.
        const missingBinding = await spyRunner.invoke({
          cliPath,
          cwd: workspaceDir,
          prompt: 'Missing binding resume',
          phase: 'implement',
          iteration: 1,
          timeoutMs: 10_000,
          runId: 'run-1404-missing',
          isContinue: true,
          resumeSessionId: `acp-sess-${backend}-does-not-exist`
        });
        expect(missingBinding.exitCode).toBe(1);
        expect(missingBinding.diagnosticWarnings).toContain('acp-session-resume-unrecoverable:binding-missing');
        expect(bridgeLaunched).toBe(false);

        // (c2) Ephemeral bridge session ID refuses before spawn.
        const ephemeralAttempt = await spyRunner.invoke({
          cliPath,
          cwd: workspaceDir,
          prompt: 'Ephemeral ID resume',
          phase: 'implement',
          iteration: 1,
          timeoutMs: 10_000,
          runId: 'run-1404-ephemeral',
          isContinue: true,
          resumeSessionId: `acp-${backend}-session-1`
        });
        expect(ephemeralAttempt.exitCode).toBe(1);
        expect(ephemeralAttempt.diagnosticWarnings).toContain('acp-session-resume-unrecoverable:ephemeral-session-id');
        expect(bridgeLaunched).toBe(false);

        // (c3) Missing resumeSessionId on isContinue refuses before spawn.
        const missingId = await spyRunner.invoke({
          cliPath,
          cwd: workspaceDir,
          prompt: 'Omitted ID resume',
          phase: 'implement',
          iteration: 1,
          timeoutMs: 10_000,
          runId: 'run-1404-omitted',
          isContinue: true
        });
        expect(missingId.exitCode).toBe(1);
        expect(missingId.diagnosticWarnings).toContain('acp-session-resume-unrecoverable:missing-session-id');
        expect(bridgeLaunched).toBe(false);

        // (c4) Cross-backend handle reuse refuses before spawn.
        const otherBackend = backend === 'claude' ? 'codex' : 'claude';
        const crossBackendRunner = new AcpBackedRunner({
          kind: otherBackend,
          inner: makeNeverInnerRunner(),
          bridgeScriptPath: BUILT_BRIDGE_PATH,
          authorityGate: makeTrustedGate(),
          primaryWorkspaceRoot: workspaceDir,
          sessionBindingStore: durable2.sessionBindings,
          platform: QUALIFIED_PLATFORM,
          launchTransport: () => {
            bridgeLaunched = true;
            throw new Error('bridge must never spawn on cross-backend handle');
          }
        });
        const crossBackend = await crossBackendRunner.invoke({
          cliPath,
          cwd: workspaceDir,
          prompt: 'Cross backend resume',
          phase: 'implement',
          iteration: 1,
          timeoutMs: 10_000,
          runId: 'run-1404-cross',
          sessionReuse: true,
          resumeSessionId: persistedHandle
        });
        expect(crossBackend.exitCode).toBe(1);
        expect(crossBackend.diagnosticWarnings).toContain('acp-session-resume-unrecoverable:backend-mismatch');
        expect(bridgeLaunched).toBe(false);

        // Confirm zero extra CLI invocations occurred across all refusals.
        expect(await readInvocationLog(logPath)).toHaveLength(2);
      } finally {
        conn2.close();
      }
    },
    WAIT_MS
  );

  it('enforces same-process control and fail-closed replacement-bridge session/load directly on dist/acp-stdio-bridge.js', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'schegent-1404-direct-'));
    tempRoots.push(root);
    const wsA = path.join(root, 'ws-a');
    const wsB = path.join(root, 'ws-b');
    await mkdir(wsA, { recursive: true });
    await mkdir(wsB, { recursive: true });
    const logPath = path.join(root, 'direct-claude.jsonl');
    await writeFile(logPath, '', 'utf8');
    const cliPath = path.join(root, 'fake-claude.mjs');
    await writeFakeClaudeCli(cliPath, logPath, { providerSessionId: 'claude-direct-77' });

    const env = { HOME: root, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
    const launch = resolveAcpProfileLaunch({
      kind: 'claude',
      resolvedCliPath: cliPath,
      cwd: wsA,
      env,
      bridgeScriptPath: BUILT_BRIDGE_PATH
    });

    // (d) Same-process control: Prompt 1 captures providerSessionId; Prompt 2 auto-resumes;
    // replacement bridge rejects missing/ephemeral `_meta.providerSessionId` with -32602.
    const opened1 = await openAcpConnection({
      profile: getBuiltinAcpProfile('claude', { platform: QUALIFIED_PLATFORM }),
      generation: 1,
      launch: () => spawnStdioTransport(launch)
    });
    expect(opened1.ok).toBe(true);
    if (!opened1.ok) return;
    try {
      const created = await opened1.connection.newSession(wsA);
      expect(created).toEqual({ ok: true, sessionId: 'acp-claude-session-1' });
      if (!created.ok) return;

      const p1 = await opened1.connection.prompt({
        sessionId: created.sessionId,
        attemptId: 'att-direct-1',
        rootId: 'run-direct-1',
        blocks: [{ type: 'text', text: 'First same-process turn' }]
      });
      expect(p1.kind).toBe('completed');
      expect(opened1.connection.providerSessionIdOf(created.sessionId)).toBe('claude-direct-77');

      const p2 = await opened1.connection.prompt({
        sessionId: created.sessionId,
        attemptId: 'att-direct-2',
        rootId: 'run-direct-1',
        blocks: [{ type: 'text', text: 'Second same-process turn' }]
      });
      expect(p2.kind).toBe('completed');
    } finally {
      await opened1.connection.close();
    }

    const calls = await readInvocationLog(logPath);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.argv).not.toContain('--resume');
    expect(calls[1]!.argv).toContain('--resume');
    expect(calls[1]!.argv).toContain('claude-direct-77');

    // Replacement bridge refuses session/load with missing or ephemeral `_meta.providerSessionId`.
    const opened2 = await openAcpConnection({
      profile: getBuiltinAcpProfile('claude', { platform: QUALIFIED_PLATFORM }),
      generation: 2,
      launch: () => spawnStdioTransport(launch)
    });
    expect(opened2.ok).toBe(true);
    if (!opened2.ok) return;
    try {
      const missingMeta = await opened2.connection.loadSession('acp-claude-session-1', wsA, { mayLoad: true });
      expect(missingMeta).toEqual({ ok: false, reason: 'rejected', code: -32602 });

      const ephemeralMeta = await opened2.connection.loadSession('acp-sess-claude-fake', wsA, {
        mayLoad: true,
        providerSessionId: 'acp-claude-session-1'
      });
      expect(ephemeralMeta).toEqual({ ok: false, reason: 'rejected', code: -32602 });
    } finally {
      await opened2.connection.close();
    }
    expect(await readInvocationLog(logPath)).toHaveLength(2);
  }, WAIT_MS);

  it('(e) incomplete-turn continuation resumes real Claude bridge with persisted handle and refuses cleanly when provider emitted no session ID', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'schegent-1404-incomplete-'));
    tempRoots.push(root);
    const ws = path.join(root, 'workspace');
    await mkdir(ws, { recursive: true });
    const dbPath = path.join(root, 'schegent-state.db');

    const phaseDef: PhaseDef = {
      id: 'implement',
      name: 'Implement',
      version: 1,
      runner: 'claude',
      instruction: 'Complete the task.'
    };

    // Case 1: Provider emits `session_id` on incomplete Turn 1 -> Turn 2 resumes via real bridge #2.
    const okLog = path.join(root, 'incomplete-ok.jsonl');
    await writeFile(okLog, '', 'utf8');
    const okCli = path.join(root, 'fake-claude-incomplete-ok.mjs');
    await writeFakeClaudeCli(okCli, okLog, { providerSessionId: 'claude-incomplete-prov-1', incompleteFirstTurn: true });

    const conn = new NodeSqliteConnection({ databasePath: dbPath });
    try {
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => 1_700_000_000_000);
      const durable = createSqliteAcpDurableRuntimeStore(conn, 'scope-incomplete');
      const acpRunner = new AcpBackedRunner({
        kind: 'claude',
        inner: makeNeverInnerRunner(),
        bridgeScriptPath: BUILT_BRIDGE_PATH,
        authorityGate: makeTrustedGate(),
        primaryWorkspaceRoot: ws,
        sessionBindingStore: durable.sessionBindings,
        allocateConnectionGeneration: () => durable.allocateConnectionGeneration(),
        platform: QUALIFIED_PLATFORM
      });
      const phaseRunner = new PhaseRunner(acpRunner, new PromptBuilder(), makeAuditWriter(), new SanitizedLogger());
      const okOutput = await dispatchResumingIncompleteTurns(
        phaseRunner,
        {
          phase: 'implement',
          phaseDef,
          pipelineId: 'test-pipeline',
          iteration: 1,
          iterationCap: 3,
          featureDescription: 'finish work',
          featureDir: null,
          cliPath: okCli,
          cwd: ws,
          timeoutMs: 10_000,
          runId: 'run-inc-ok'
        },
        () => undefined
      );
      expect(okOutput.outcome).toBe('clean');
      expect(okOutput.cliSessionId).toMatch(/^acp-sess-claude-/);

      const okCalls = await readInvocationLog(okLog);
      expect(okCalls).toHaveLength(2);
      expect(okCalls[0]!.argv).not.toContain('--resume');
      expect(okCalls[1]!.argv).toContain('--resume');
      expect(okCalls[1]!.argv).toContain('claude-incomplete-prov-1');
      expect(okCalls[1]!.stdin).toContain('CONTINUATION NOTE:');

      // Case 2: Provider omits `session_id` on incomplete Turn 1 -> Turn 2 refuses before spawn!
      const noIdLog = path.join(root, 'incomplete-noid.jsonl');
      await writeFile(noIdLog, '', 'utf8');
      const noIdCli = path.join(root, 'fake-claude-incomplete-noid.mjs');
      await writeFakeClaudeCli(noIdCli, noIdLog, { providerSessionId: null, incompleteFirstTurn: true });

      const noIdOutput = await dispatchResumingIncompleteTurns(
        phaseRunner,
        {
          phase: 'implement',
          phaseDef,
          pipelineId: 'test-pipeline',
          iteration: 1,
          iterationCap: 3,
          featureDescription: 'finish work without session id',
          featureDir: null,
          cliPath: noIdCli,
          cwd: ws,
          timeoutMs: 10_000,
          runId: 'run-inc-noid'
        },
        () => undefined
      );
      expect(noIdOutput.outcome).not.toBe('clean');
      expect(noIdOutput.exitCode).toBe(1);
      // Only Turn 1 ran; Turn 2 refused before spawning a replacement bridge/CLI!
      expect(await readInvocationLog(noIdLog)).toHaveLength(1);
    } finally {
      conn.close();
    }
  }, WAIT_MS);

  it('rejects option-shaped providerSessionId values before CLI launch (prevents flag injection)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'schegent-1404-flag-'));
    tempRoots.push(root);
    const ws = path.join(root, 'ws');
    await mkdir(ws, { recursive: true });
    const dbPath = path.join(root, 'state.db');
    const logPath = path.join(root, 'claude-flag.jsonl');
    await writeFile(logPath, '', 'utf8');
    const cliPath = path.join(root, 'fake-claude-flag.mjs');
    await writeFakeClaudeCli(cliPath, logPath, {
      providerSessionId: '--dangerously-skip-permissions'
    });

    const conn = new NodeSqliteConnection({ databasePath: dbPath });
    try {
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => 1_700_000_000_000);
      const durable = createSqliteAcpDurableRuntimeStore(conn, 'scope-1404-flag');
      const runner = new AcpBackedRunner({
        kind: 'claude',
        inner: makeNeverInnerRunner(),
        bridgeScriptPath: BUILT_BRIDGE_PATH,
        authorityGate: makeTrustedGate(),
        primaryWorkspaceRoot: ws,
        sessionBindingStore: durable.sessionBindings,
        allocateConnectionGeneration: () => durable.allocateConnectionGeneration(),
        platform: QUALIFIED_PLATFORM
      });

      // Turn 1 emits a flag-shaped provider session_id -> bridge/client/store must NOT persist it.
      const turn1 = await runner.invoke({
        cliPath,
        cwd: ws,
        prompt: 'Turn 1 hostile id',
        phase: 'implement',
        iteration: 1,
        timeoutMs: 10_000,
        runId: 'run-flag-1'
      });
      expect(turn1.exitCode).toBe(0);
      expect(turn1.cliSessionId).toBeUndefined();

      // Even if someone tampers a binding row directly in SQLite, getBinding() refuses it and resume refuses before spawn.
      conn.run(
        `INSERT OR REPLACE INTO operational_kv_documents (
          doc_namespace, doc_key, revision, schema_version, payload_json, payload_bytes, is_terminal, updated_at_ms
        ) VALUES (?, ?, 1, 1, ?, 128, 0, ?)`,
        'acp-session-bindings:scope-1404-flag',
        'acp-sess-claude-tampered',
        JSON.stringify({
          schemaVersion: 1,
          persistedSessionId: 'acp-sess-claude-tampered',
          backend: 'claude',
          workspaceRoot: ws,
          providerSessionId: '-c=sandbox_mode=danger-full-access',
          updatedAtMs: 1_700_000_000_000
        }),
        1_700_000_000_000
      );
      expect(durable.sessionBindings.getBinding('acp-sess-claude-tampered')).toBeNull();
      const resumed = await runner.invoke({
        cliPath,
        cwd: ws,
        prompt: 'Turn 2 tampered resume',
        phase: 'implement',
        iteration: 1,
        timeoutMs: 10_000,
        runId: 'run-flag-2',
        isContinue: true,
        resumeSessionId: 'acp-sess-claude-tampered'
      });
      expect(resumed.exitCode).toBe(1);
      expect(resumed.diagnosticWarnings).toContain('acp-session-resume-unrecoverable:binding-missing');
      expect(await readInvocationLog(logPath)).toHaveLength(1);
    } finally {
      conn.close();
    }
  }, WAIT_MS);
});
