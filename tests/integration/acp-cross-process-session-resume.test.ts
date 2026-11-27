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
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_k: string, def: unknown) => def,
      inspect: () => undefined
    }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined })
  },
  window: {
    showWarningMessage: vi.fn()
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath })
  }
}));

import { createSqliteCutoverCoordinator } from '../../src/activation/sqlite-cutover-wiring';
import type { AuditEntry } from '../../src/audit/audit-entry';
import type { AuditLogWriter } from '../../src/audit/audit-log-writer';
import type { BackendRunner } from '../../src/contracts/backend-runner';
import type { PhaseDef } from '../../src/config/pipeline-config';
import { dispatchResumingIncompleteTurns } from '../../src/controller/incomplete-turn-resume';
import { PhaseRunner } from '../../src/controller/phase-runner';
import { SanitizedLogger } from '../../src/lib/logger';
import { AcpBackedRunner, type AcpRunnerObservationEvent } from '../../src/runner/acp-backed-runner';
import { PromptBuilder } from '../../src/runner/prompt-builder';
import { openAcpConnection } from '../../src/services/acp-runtime/acp-client';
import { createSqliteAcpDurableRuntimeStore } from '../../src/services/acp-runtime/acp-durable-runtime-store';
import { AGENT_DISPLAY_TITLE_MAX_CHARS } from '../../src/services/acp-runtime/agent-identifier';
import { buildUsageUpdate } from '../../src/services/acp-runtime/client-guards';
import { getBuiltinAcpProfile, resolveAcpProfileLaunch } from '../../src/services/acp-runtime/profiles';
import { mapSessionUpdate } from '../../src/services/acp-runtime/session-update-mapper';
import { spawnStdioTransport } from '../../src/services/acp-runtime/stdio-transport';
import { AcpAuthorityGate } from '../../src/services/containment-qualification/acp-authority-gate';
import type { RecoveryEnvelopePort } from '../../src/services/recovery-handoff';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../src/services/sqlite-store';
import { sourceIdentityOf } from '../../src/services/usage-accounting/acp-usage-mapping';
import type { WorkspaceStateStore } from '../../src/state/workspace-state';
import { removeTempRoot } from '../temp-root-cleanup';
import { assertFreshBuiltBridgeIdentity } from '../helpers/verify-built-bridge';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUILT_BRIDGE_PATH = path.resolve(REPO_ROOT, 'dist', 'acp-stdio-bridge.js');
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
      assertFreshBuiltBridgeIdentity(REPO_ROOT);
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
      const phaseRunner = new PhaseRunner({
        runner: acpRunner,
        promptBuilder: new PromptBuilder(),
        auditWriter: makeAuditWriter(),
        logger: new SanitizedLogger()
      });
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

describe('FR-R7-17 (R7-17-04 & R7-17-05) — production ACP accounting ingestion, lifecycle observations, advertised-profile resume & permission denial', () => {
  function makeMinimalStore(): WorkspaceStateStore {
    let controlLedger: unknown;
    return {
      getRunMap: () => ({}),
      getConnectedRuns: () => ({}),
      getQueueMap: () => ({}),
      getQueueRegistry: () => ({ activeQueueId: 'default', queues: [] }),
      getRawControlLedger: () => controlLedger,
      transactControlLedger: async <T>(
        op: (raw: unknown, write: (next: unknown) => Promise<void>) => Promise<T>
      ): Promise<T> =>
        op(controlLedger, async (next) => {
          controlLedger = next;
        })
    } as unknown as WorkspaceStateStore;
  }

  function makeSpyLogger(): {
    readonly logger: SanitizedLogger;
    readonly entries: Array<{ readonly level: string; readonly msg: string; readonly meta: unknown }>;
  } {
    const entries: Array<{ readonly level: string; readonly msg: string; readonly meta: unknown }> = [];
    const realSanitizer = new SanitizedLogger();
    const logger = {
      info: (msg: string, meta?: unknown) => entries.push({ level: 'info', msg, meta }),
      warn: (msg: string, meta?: unknown) => entries.push({ level: 'warn', msg, meta }),
      error: (msg: string, meta?: unknown) => entries.push({ level: 'error', msg, meta }),
      debug: (msg: string, meta?: unknown) => entries.push({ level: 'debug', msg, meta }),
      sanitize: (text: string) => realSanitizer.sanitize(text)
    } as unknown as SanitizedLogger;
    return { logger, entries };
  }

  it('wires production recordAcpObservation into F06 SQLite accounting across valid ACP session ID shapes, shifted colons, and historical replays (R7-17-04)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'schegent-r71704-'));
    tempRoots.push(root);
    const workspaceRoot = path.join(root, 'workspace');
    const globalStorage = path.join(root, 'globalStorage', 'schegent.schegent');
    const legacyStorage = path.join(root, 'workspaceStorage', 'slot-1', 'schegent.schegent');
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(globalStorage, { recursive: true, mode: 0o700 });
    await mkdir(legacyStorage, { recursive: true, mode: 0o700 });

    const { logger } = makeSpyLogger();
    const disposables: Array<{ dispose(): void }> = [];
    const coord = createSqliteCutoverCoordinator({
      context: {
        storageUri: { fsPath: legacyStorage } as never,
        globalStorageUri: { fsPath: globalStorage } as never,
        subscriptions: []
      },
      workspaceRoot,
      store: makeMinimalStore(),
      auditWriter: {
        write: async () => undefined,
        subscribe: () => ({ dispose: () => undefined })
      } as unknown as AuditLogWriter,
      envelopes: { readEnvelope: () => null } as unknown as RecoveryEnvelopePort,
      pinnedRunIds: () => new Set(),
      logger,
      isWorkspaceTrusted: () => true,
      hasPrimacy: async () => true,
      disposables
    });

    try {
      const services = await coord.activatePrimary();
      expect(services).not.toBeNull();
      if (services === null) return;

      const conn = services.sqliteStore.writerConnection;
      const nowIso = new Date().toISOString();
      const profileId = 'claude-acp-bridge';
      const projection = {
        profileId,
        profileRevision: 1,
        profileKind: 'bridge' as const,
        qualification: 'qualified' as const,
        attribution: { provider: 'anthropic', backend: 'claude', model: 'default' },
        generation: 1,
        state: 'ready' as const,
        capabilities: {
          protocolVersion: 1 as const,
          loadSession: true,
          image: false,
          audio: false,
          embeddedContext: true,
          authMethodCount: 0
        },
        lastRefusal: null,
        lastFailure: null,
        sessionCount: 1,
        counters: {
          unknownResponses: 0,
          duplicateResponses: 0,
          staleUpdates: 0,
          ignoredUpdates: 0,
          unknownNotifications: 0,
          refusedAgentRequests: 0,
          permissionRequests: 0
        }
      };

      const emitUsageViaCutover = (params: {
        readonly acpSessionId: string;
        readonly producerEventId?: string;
        readonly attemptId: string;
        readonly turnId: string;
        readonly generation: number;
        readonly seq: number;
        readonly replayed: boolean;
        readonly used: number;
      }): void => {
        const mapped = mapSessionUpdate({
          sessionUpdate: 'usage_update',
          used: params.used,
          size: 200_000,
          ...(params.producerEventId !== undefined ? { eventId: params.producerEventId } : {})
        });
        if (mapped.kind !== 'usage') throw new Error('expected usage reading');
        const binding = {
          profileId,
          acpSessionId: params.acpSessionId,
          connectionGeneration: params.generation,
          turnId: params.turnId,
          rootId: 'run-r71704',
          attemptId: params.attemptId
        };
        const usage = buildUsageUpdate(
          {
            profileId,
            generation: params.generation,
            sessionId: params.acpSessionId,
            attribution: {
              origin: params.replayed ? 'history' : 'live',
              turnId: params.turnId,
              attemptId: params.attemptId,
              binding
            },
            hostReceiveSeq: params.seq,
            eventUtc: nowIso,
            providerSessionId: 'prov-r71704'
          },
          mapped.usage
        );
        const event: AcpRunnerObservationEvent = {
          backendKind: 'claude',
          runId: 'run-r71704',
          invocationId: `inv-${params.attemptId}`,
          attemptId: params.attemptId,
          projection: { ...projection, generation: params.generation },
          observation: {
            generation: params.generation,
            hostReceiveSeq: params.seq,
            observedAtUtc: nowIso,
            origin: params.replayed ? 'history' : 'live',
            acpSessionId: params.acpSessionId,
            turnId: params.turnId,
            attemptId: params.attemptId,
            binding,
            kind: 'usage',
            usage
          }
        };
        coord.recordAcpObservation(event);
      };

      const shapes: ReadonlyArray<readonly [string, string, number]> = [
        ['acp-session-plain', 'evt-ascii-1', 1000],
        ['session with spaces 42', 'evt space 1', 1100],
        ['ns:team/session@host:42', 'evt:sub/2@ok', 1200],
        ['long-sess-'.padEnd(256, 'a'), 'evt-long-'.padEnd(256, 'b'), 1300],
        ['세션-識別子:αβγ-'.padEnd(256, '한'), 'イベント:🚀:ok', 1400]
      ];
      let seq = 1;
      shapes.forEach(([acpSessionId, producerEventId, used], index) => {
        const attemptId = `att-r71704-${index}`;
        const turnId = `turn-r71704-${index}`;
        // First live ingestion
        emitUsageViaCutover({
          acpSessionId,
          producerEventId,
          attemptId,
          turnId,
          generation: 1,
          seq: seq++,
          replayed: false,
          used
        });
        // Replayed ingestion across a new connection generation and hostReceiveSeq -> deduplicates to 1!
        emitUsageViaCutover({
          acpSessionId,
          producerEventId,
          attemptId,
          turnId,
          generation: 2,
          seq: seq++,
          replayed: true,
          used
        });
      });

      // Shifted-colon pair: ('claude-acp-bridge', 'a:b', 'c') vs ('claude-acp-bridge', 'a', 'b:c')
      emitUsageViaCutover({
        acpSessionId: 'a:b',
        producerEventId: 'c',
        attemptId: 'att-shift-left',
        turnId: 'turn-shift-left',
        generation: 3,
        seq: seq++,
        replayed: false,
        used: 1500
      });
      emitUsageViaCutover({
        acpSessionId: 'a',
        producerEventId: 'b:c',
        attemptId: 'att-shift-right',
        turnId: 'turn-shift-right',
        generation: 3,
        seq: seq++,
        replayed: false,
        used: 1600
      });

      // Unidentifiable historical replay -> stays `historical` and never projects.
      emitUsageViaCutover({
        acpSessionId: 'history:session',
        attemptId: 'att-hist-1',
        turnId: 'turn-hist-1',
        generation: 4,
        seq: seq++,
        replayed: true,
        used: 9999
      });

      const attributedRows = conn.all<{ source_identity: string; attempt_id: string }>(
        "SELECT source_identity, attempt_id FROM accounting_observations WHERE disposition = 'accepted'"
      );
      expect(attributedRows).toHaveLength(shapes.length + 2);
      for (const row of attributedRows) {
        expect(row.source_identity).toMatch(/^acp-v1:[0-9a-f]{64}$/);
        expect(Buffer.byteLength(row.source_identity, 'utf8')).toBe(71);
      }

      const leftId = sourceIdentityOf({
        profileId,
        acpSessionId: 'a:b',
        producerEventId: 'c',
        connectionGeneration: 3,
        turnId: 'turn-shift-left',
        hostReceiveSeq: 1,
        eventUtc: nowIso,
        replayed: false,
        used: 1500,
        size: 200_000,
        hasQualifiedSessionBaseline: false
      });
      const rightId = sourceIdentityOf({
        profileId,
        acpSessionId: 'a',
        producerEventId: 'b:c',
        connectionGeneration: 3,
        turnId: 'turn-shift-right',
        hostReceiveSeq: 2,
        eventUtc: nowIso,
        replayed: false,
        used: 1600,
        size: 200_000,
        hasQualifiedSessionBaseline: false
      });
      expect(leftId).not.toBe(rightId);
      expect(attributedRows.map((r) => r.source_identity)).toContain(leftId);
      expect(attributedRows.map((r) => r.source_identity)).toContain(rightId);

      const historicalCount = Number(
        conn.scalar("SELECT COUNT(*) FROM accounting_observations WHERE disposition = 'historical'") ?? 0
      );
      expect(historicalCount).toBe(1);

      // Historical replay with used=9999 must never project into F06 queries.
      const queryRes = services.usageAccounting.query({ groupBy: ['backend'] });
      expect(queryRes.ok).toBe(true);
      if (queryRes.ok) {
        const usedTotal = queryRes.value.rows
          .flatMap((row) => row.measures)
          .find((m) => m.measure === 'context_used')?.total;
        expect(usedTotal).not.toBe('9999');
      }
    } finally {
      coord.close();
    }
  }, WAIT_MS);

  it('exercises advertised profiles (claude-acp-bridge, codex-acp-bridge, agy-acp-native) over production AcpBackedRunner + AcpAuthorityGate for session/load resume, permission policy denial, durable lifecycle observations, and hostile title sanitization (R7-17-05)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'schegent-r71705-'));
    tempRoots.push(root);
    const workspaceRoot = path.join(root, 'workspace');
    await mkdir(workspaceRoot, { recursive: true });
    const dbPath = path.join(root, 'schegent-state.db');

    const FAKE_SECRET = ['sk', 'proj', 'C'.repeat(28)].join('-');
    const HOSTILE_TITLE =
      `\u001b[31mWrite\u001b[0m \u001b]0;spoof\u0007\u202eoverride\u202c ` +
      `\u2066iso\u2069\u200e\u200f\u061c\r\nnext\u2028sep\u2029end ${FAKE_SECRET} ` +
      'X'.repeat(120_000);

    // Deterministic ACP v1 stdio agent exercising session/new, session/load, hostile tool_call,
    // hostile session/request_permission (verifying host denies with reject_once), and cancel/crash modes.
    const acpAgentPath = path.join(root, 'advertised-acp-agent.mjs');
    const agentLogPath = path.join(root, 'agent-events.jsonl');
    await writeFile(agentLogPath, '', 'utf8');
    await writeFile(
      acpAgentPath,
      `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import * as readline from 'node:readline';

const logPath = ${JSON.stringify(agentLogPath)};
const hostileTitle = ${JSON.stringify(HOSTILE_TITLE)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
let pendingPrompt = null;

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
        agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } },
        authMethods: []
      }
    });
    return;
  }
  if (msg.method === 'session/new') {
    const sid = 'acp-native-sess:alpha 1';
    appendFileSync(logPath, JSON.stringify({ event: 'session/new', sid }) + '\\n');
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: sid } });
    return;
  }
  if (msg.method === 'session/load') {
    appendFileSync(logPath, JSON.stringify({ event: 'session/load', sid: msg.params.sessionId }) + '\\n');
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId;
    const text = msg.params.prompt?.[0]?.text ?? '';
    if (text === 'CRASH_MID_TURN') {
      process.exit(1);
    }
    if (text === 'WAIT_FOR_CANCEL') {
      pendingPrompt = { id: msg.id, sid };
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working...' } } }
      });
      return;
    }
    // Emit hostile live tool_call title AND hostile permission request.
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-hostile-1',
          title: hostileTitle,
          rawInput: { path: 'src/app.ts' }
        }
      }
    });
    pendingPrompt = { id: msg.id, sid };
    send({
      jsonrpc: '2.0',
      id: 777,
      method: 'session/request_permission',
      params: {
        sessionId: sid,
        toolCall: { toolCallId: 'perm-hostile-1', title: hostileTitle },
        options: [
          { optionId: 'opt-allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'opt-deny', name: 'Deny', kind: 'reject_once' }
        ]
      }
    });
    return;
  }
  if (msg.method === 'session/cancel' && pendingPrompt !== null) {
    const p = pendingPrompt;
    pendingPrompt = null;
    send({ jsonrpc: '2.0', id: p.id, result: { stopReason: 'cancelled' } });
    return;
  }
  if (msg.id === 777 && pendingPrompt !== null) {
    appendFileSync(logPath, JSON.stringify({ event: 'permission-answer', result: msg.result }) + '\\n');
    const p = pendingPrompt;
    pendingPrompt = null;
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: p.sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'turn-complete' } } }
    });
    send({
      jsonrpc: '2.0',
      id: p.id,
      result: { stopReason: 'end_turn', _meta: { providerSessionId: 'prov-advertised-1' } }
    });
  }
});
`,
      'utf8'
    );
    await chmod(acpAgentPath, 0o755);

    const conn = new NodeSqliteConnection({ databasePath: dbPath });
    try {
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => 1_700_000_000_000);
      const durable = createSqliteAcpDurableRuntimeStore(conn, 'scope-r71705');

      const advertisedCases: ReadonlyArray<readonly ['claude' | 'codex' | 'agy', string]> = [
        ['claude', 'claude-acp-bridge'],
        ['codex', 'codex-acp-bridge'],
        ['agy', 'agy-acp-native']
      ];

      for (const [kind, expectedProfileId] of advertisedCases) {
        const { logger, entries } = makeSpyLogger();
        const observations: AcpRunnerObservationEvent[] = [];
        let ownershipGen = 1;
        let gateOwnershipGen = 1;
        const gate = new AcpAuthorityGate(
          {
            isWorkspaceTrusted: () => true,
            holdsPrimacy: () => true,
            currentOwnershipGeneration: () => gateOwnershipGen
          },
          conn
        );

        const runner = new AcpBackedRunner({
          kind,
          inner: makeNeverInnerRunner(),
          logger,
          readConfiguredProfile: () => expectedProfileId,
          authorityGate: gate,
          primaryWorkspaceRoot: workspaceRoot,
          currentOwnershipGeneration: () => ownershipGen,
          sessionBindingStore: durable.sessionBindings,
          allocateConnectionGeneration: () => durable.allocateConnectionGeneration(),
          platform: QUALIFIED_PLATFORM,
          launchTransport: () =>
            spawnStdioTransport({
              command: process.execPath,
              args: [acpAgentPath],
              cwd: workspaceRoot,
              env: {}
            }),
          onAcpObservation: (ev) => {
            observations.push(ev);
            durable.recordObservation({
              profileId: ev.projection.profileId,
              attemptId: ev.attemptId,
              observation: ev.observation
            });
            // On agy (whose CLI cannot withhold `workspace-write`), simulate mid-turn primacy
            // ownership generation shift on `turn-started` so AcpAuthorityGate deterministically
            // denies `session/request_permission` with `ownership-lost`.
            if (kind === 'agy' && ev.observation.kind === 'turn-started') {
              gateOwnershipGen = ownershipGen + 1;
            }
          }
        });

        // For claude & codex, declare capabilities withholding workspace-write and process-spawn
        // (keeping network granted so codex enforces via `--sandbox read-only`) -> `effect-not-declared`.
        // For agy, withhold process-spawn and outside-workspace-write -> ownership shift denies permission.
        const restrictedCaps =
          kind === 'agy'
            ? {
                declaredAt: 'phase-definition' as const,
                capabilities: ['network', 'workspace-write'] as const
              }
            : {
                declaredAt: 'phase-definition' as const,
                capabilities: ['network'] as const
              };
        const expectedDenyReason = kind === 'agy' ? 'ownership-lost' : 'effect-not-declared';

        const turn1 = await runner.invoke({
          cliPath: acpAgentPath,
          cwd: workspaceRoot,
          prompt: 'Turn 1 with hostile permission and tool title',
          phase: 'review',
          iteration: 1,
          timeoutMs: 10_000,
          runId: `run-r71705-${kind}`,
          attemptId: `att-${kind}-1`,
          capabilities: restrictedCaps
        });
        expect(turn1.exitCode).toBe(0);
        expect(turn1.command).toBe(`acp:${expectedProfileId}`);
        expect(turn1.cliSessionId).toBeDefined();

        // Turn 2: real session/load resume on the same advertised profile!
        ownershipGen = gateOwnershipGen;
        const turn2 = await runner.invoke({
          cliPath: acpAgentPath,
          cwd: workspaceRoot,
          prompt: 'Turn 2 resumed via session/load',
          phase: 'review',
          iteration: 2,
          timeoutMs: 10_000,
          runId: `run-r71705-${kind}`,
          attemptId: `att-${kind}-2`,
          isContinue: true,
          ...(turn1.cliSessionId !== undefined ? { resumeSessionId: turn1.cliSessionId } : {}),
          resumeSessionOrigin: 'acp',
          capabilities: restrictedCaps
        });
        expect(turn2.exitCode).toBe(0);
        expect(turn2.command).toBe(`acp:${expectedProfileId}`);

        // Verify permission-requested + permission-resolved (granted: false) observations with strict monotonic hostReceiveSeq.
        const turn1Obs = observations.filter((o) => o.attemptId === `att-${kind}-1`);
        const turn1Kinds = turn1Obs.map((o) => o.observation.kind);
        expect(turn1Kinds).toContain('permission-requested');
        expect(turn1Kinds).toContain('permission-resolved');
        const resolvedPerm = turn1Obs.find((o) => o.observation.kind === 'permission-resolved');
        expect(resolvedPerm?.observation.kind === 'permission-resolved' && resolvedPerm.observation.granted).toBe(false);
        const seqs = turn1Obs.map((o) => o.observation.hostReceiveSeq);
        for (let i = 1; i < seqs.length; i += 1) {
          expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
        }

        // Verify AcpAuthorityGate denied receipts contain zero raw hostile titles or secrets.
        const gateReceipts = gate.listReceipts();
        expect(gateReceipts.some((r) => r.decision === 'denied' && r.reasonCode === expectedDenyReason)).toBe(true);
        expect(JSON.stringify(gateReceipts)).not.toContain(FAKE_SECRET);

        // Verify diagnostic logger sanitized the hostile permission title cleanly.
        const permLogs = entries.filter((e) => e.msg.includes('permission request denied'));
        expect(permLogs.length).toBeGreaterThanOrEqual(2);
        for (const entry of permLogs) {
          const title = (entry.meta as Record<string, unknown>)['toolTitle'] as string;
          expect(typeof title).toBe('string');
          expect(title.length).toBeGreaterThan(0);
          expect(title.length).toBeLessThanOrEqual(AGENT_DISPLAY_TITLE_MAX_CHARS);
          expect(title).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);
          expect(title).not.toContain('\u001b');
          expect(title).not.toContain(FAKE_SECRET);
          expect(title).toContain('[REDACTED]');
        }

        // Verify encoded stdout JSONL tool_use name is sanitized and bounded <= 128 chars.
        const stdoutLines = [...turn1.stdoutBuffer.decompressStream()]
          .join('')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const toolUseLine = stdoutLines.find(
          (row) =>
            row['type'] === 'assistant' &&
            Array.isArray((row['message'] as Record<string, unknown> | undefined)?.['content']) &&
            ((row['message'] as Record<string, unknown>)['content'] as Array<Record<string, unknown>>).some(
              (b) => b['type'] === 'tool_use'
            )
        );
        expect(toolUseLine).toBeDefined();
        const toolBlock = (
          (toolUseLine!['message'] as Record<string, unknown>)['content'] as Array<Record<string, unknown>>
        ).find((b) => b['type'] === 'tool_use')!;
        const encodedToolName = toolBlock['name'] as string;
        expect(encodedToolName.length).toBeGreaterThan(0);
        expect(encodedToolName.length).toBeLessThanOrEqual(AGENT_DISPLAY_TITLE_MAX_CHARS);
        expect(encodedToolName).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);
        expect(encodedToolName).not.toContain(FAKE_SECRET);
        expect(encodedToolName).toContain('[REDACTED]');

        // Also verify durable turn-canceled and transport-disconnected/turn-uncertain observations on agy-acp-native.
        if (kind === 'agy') {
          const abortController = new AbortController();
          const cancelObs: AcpRunnerObservationEvent[] = [];
          const cancelRunner = new AcpBackedRunner({
            kind: 'agy',
            inner: makeNeverInnerRunner(),
            authorityGate: makeTrustedGate(),
            primaryWorkspaceRoot: workspaceRoot,
            allocateConnectionGeneration: () => durable.allocateConnectionGeneration(),
            platform: QUALIFIED_PLATFORM,
            launchTransport: () =>
              spawnStdioTransport({
                command: process.execPath,
                args: [acpAgentPath],
                cwd: workspaceRoot,
                env: {}
              }),
            onAcpObservation: (ev) => {
              cancelObs.push(ev);
              durable.recordObservation({
                profileId: ev.projection.profileId,
                attemptId: ev.attemptId,
                observation: ev.observation
              });
              if (ev.observation.kind === 'display') {
                abortController.abort();
              }
            }
          });
          const cancelledRes = await cancelRunner.invoke({
            cliPath: acpAgentPath,
            cwd: workspaceRoot,
            prompt: 'WAIT_FOR_CANCEL',
            phase: 'implement',
            iteration: 1,
            timeoutMs: 10_000,
            runId: 'run-r71705-cancel',
            attemptId: 'att-r71705-cancel',
            cancellationSignal: abortController.signal
          });
          expect(cancelledRes.exitCode).toBe(130);
          expect(cancelObs.map((o) => o.observation.kind)).toContain('turn-canceled');

          const crashObs: AcpRunnerObservationEvent[] = [];
          const crashRunner = new AcpBackedRunner({
            kind: 'agy',
            inner: makeNeverInnerRunner(),
            authorityGate: makeTrustedGate(),
            primaryWorkspaceRoot: workspaceRoot,
            allocateConnectionGeneration: () => durable.allocateConnectionGeneration(),
            platform: QUALIFIED_PLATFORM,
            launchTransport: () =>
              spawnStdioTransport({
                command: process.execPath,
                args: [acpAgentPath],
                cwd: workspaceRoot,
                env: {}
              }),
            onAcpObservation: (ev) => {
              crashObs.push(ev);
              durable.recordObservation({
                profileId: ev.projection.profileId,
                attemptId: ev.attemptId,
                observation: ev.observation
              });
            }
          });
          const crashRes = await crashRunner.invoke({
            cliPath: acpAgentPath,
            cwd: workspaceRoot,
            prompt: 'CRASH_MID_TURN',
            phase: 'implement',
            iteration: 1,
            timeoutMs: 10_000,
            runId: 'run-r71705-crash',
            attemptId: 'att-r71705-crash'
          });
          expect(crashRes.exitCode).toBe(1);
          expect(crashObs.map((o) => o.observation.kind)).toContain('transport-disconnected');
          expect(crashObs.map((o) => o.observation.kind)).toContain('turn-uncertain');
        }
      }

      // Verify the agent actually observed `session/load` AND `reject_once` ('opt-deny') answers across all 3 advertised profiles!
      const agentLog = (await readFile(agentLogPath, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const loadEvents = agentLog.filter((e) => e['event'] === 'session/load');
      const deniedAnswers = agentLog.filter(
        (e) =>
          e['event'] === 'permission-answer' &&
          (e['result'] as Record<string, Record<string, unknown>> | undefined)?.['outcome']?.['optionId'] === 'opt-deny'
      );
      expect(loadEvents.length).toBeGreaterThanOrEqual(3);
      expect(deniedAnswers.length).toBeGreaterThanOrEqual(6);

      // Confirm all durable lifecycle kinds landed in `acp_observation_ledger`.
      const ledgerKinds = conn
        .all<{ kind: string }>('SELECT DISTINCT kind FROM acp_observation_ledger')
        .map((r) => r.kind);
      expect(ledgerKinds).toContain('permission-requested');
      expect(ledgerKinds).toContain('permission-resolved');
      expect(ledgerKinds).toContain('turn-canceled');
      expect(ledgerKinds).toContain('turn-uncertain');
      expect(ledgerKinds).toContain('transport-disconnected');
    } finally {
      conn.close();
    }
  }, WAIT_MS);
});
