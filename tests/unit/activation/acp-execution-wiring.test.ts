/**
 * Review gap GC-08 (2026-11-12) — the ACP authority gate's primacy probe must not be satisfied by
 * "a SQLite store is attached": a window opens its store while primary and keeps it after losing
 * primacy. And the gate's receipt writer must say when a receipt goes nowhere.
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({
  writer: undefined as { run(sql: string, ...params: unknown[]): void } | undefined,
  protectedPaths: [] as string[]
}));

vi.mock('../../../src/activation/sqlite-cutover-wiring', () => ({
  getSqliteCutoverCoordinator: () => ({
    getSqliteStore: () =>
      registry.writer === undefined ? null : { writerConnection: registry.writer },
    getDatabaseProtectedPaths: () => registry.protectedPaths,
    recordAcpObservation: () => undefined
  })
}));

import { buildHostAcpDispatchOptions } from '../../../src/activation/acp-execution-wiring';
import type { BackendRunner } from '../../../src/contracts/backend-runner';
import {
  doesSubtreeOverlapProtectedPathsSync,
  isTargetProtectedPathSync,
  isWorkspaceProtectedPattern
} from '../../../src/lib/protected-path-match';
import { AcpBackedRunner } from '../../../src/runner/acp-backed-runner';
import type { AcpStdioTransport } from '../../../src/services/acp-runtime/stdio-transport';
import type { WorkspaceStateStore } from '../../../src/state/workspace-state';
import { removeTempRoot } from '../../temp-root-cleanup';

type Dispatch = ReturnType<typeof buildHostAcpDispatchOptions>;
type Gate = NonNullable<Dispatch['authorityGate']>;

const SESSION = 'sess-1';
const WIRING_OWNERSHIP_GENERATION = 1;

function makeLogger(): { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), info: vi.fn() };
}

function build(options: {
  readonly primary: boolean;
  readonly logger?: ReturnType<typeof makeLogger>;
}): { readonly dispatch: Dispatch; readonly gate: Gate } {
  const dispatch = buildHostAcpDispatchOptions({
    workspaceRoot: '/workspace',
    store: {} as WorkspaceStateStore,
    logger: (options.logger ?? makeLogger()) as never,
    isWorkspaceTrusted: () => true,
    hasPrimacy: () => Promise.resolve(options.primary)
  });
  const gate = dispatch.authorityGate;
  if (gate === undefined) throw new Error('wiring built no authority gate');
  gate.registerScope({
    attemptId: 'att-1',
    acpSessionId: SESSION,
    connectionGeneration: 1,
    ownershipGeneration: WIRING_OWNERSHIP_GENERATION,
    executionRoot: '/workspace',
    primaryWorkspaceRoot: '/workspace'
  });
  return { dispatch, gate };
}

function readRequest(): Parameters<Gate['authorize']>[0] {
  return { requestKind: 'filesystem', acpSessionId: SESSION, connectionGeneration: 1, mutating: false };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

const tempDirs: string[] = [];

function createFakeAcpTransport(): AcpStdioTransport {
  const stdoutListeners: Array<(chunk: Uint8Array) => void> = [];
  const closeListeners: Array<() => void> = [];
  let closed = false;
  const emit = (obj: unknown): void => {
    const bytes = Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8');
    queueMicrotask(() => {
      for (const listener of stdoutListeners) listener(bytes);
    });
  };
  return {
    pid: undefined,
    write(line: string): void {
      const msg = JSON.parse(line.trim()) as { id?: number; method?: string };
      if (msg.method === 'initialize') {
        emit({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'agy-fake', version: '1.5.5' },
            agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } }
          }
        });
      } else if (msg.method === 'session/new') {
        emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-fake-001' } });
      } else if (msg.method === 'session/prompt') {
        emit({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }
    },
    onStdout(listener) {
      stdoutListeners.push(listener);
    },
    onStderr() {
      // noop
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
    async close() {
      if (!closed) {
        closed = true;
        for (const listener of closeListeners) listener();
      }
    },
    isProcessTreeGone: () => true
  };
}

function makeDummyInnerRunner(): BackendRunner {
  return {
    hasActiveProcess: false,
    async invoke() {
      throw new Error('CLI fallback must never run');
    },
    cancelActive: () => false,
    close() {
      // noop
    },
    settleTeardowns: async () => []
  };
}

describe('GC-08 — ACP authority gate primacy and receipt writer wiring', () => {
  beforeEach(() => {
    registry.writer = { run: vi.fn() };
  });

  afterEach(async () => {
    while (tempDirs.length > 0) {
      await removeTempRoot(tempDirs.pop()!);
    }
  });

  it('denies a window that lost primacy though its SQLite store is still attached', async () => {
    const { dispatch, gate } = build({ primary: false });

    dispatch.currentOwnershipGeneration?.();
    await settle();

    const decision = gate.authorize(readRequest());
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('ownership-lost');
  });

  it('denies from the callback after the first verify, when no session start ran one', async () => {
    const { gate } = build({ primary: false });

    gate.authorize(readRequest());
    await settle();

    expect(gate.authorize(readRequest()).reason).toBe('ownership-lost');
  });

  // GC-08 follow-up (2026-11-12) — the attached store no longer stands in before the first verdict.
  // A session awaits `primeAuthority()` before it registers its scope, so the verdict is in place
  // when its first callback arrives, and nothing is allowed on a store's word.
  it('denies before the first verdict even when a store is attached', () => {
    const { gate } = build({ primary: true });

    expect(gate.authorize(readRequest()).reason).toBe('ownership-lost');
  });

  it('primes an authoritative verdict a session can wait for', async () => {
    const { dispatch, gate } = build({ primary: true });

    await expect(dispatch.primeAuthority?.()).resolves.toBe(true);
    expect(gate.authorize(readRequest()).allowed).toBe(true);
  });

  it('primes a refusal when primacy is lost or cannot be read', async () => {
    const lost = build({ primary: false });
    await expect(lost.dispatch.primeAuthority?.()).resolves.toBe(false);
    expect(lost.gate.authorize(readRequest()).reason).toBe('ownership-lost');

    const unreadable = buildHostAcpDispatchOptions({
      workspaceRoot: '/workspace',
      store: {} as WorkspaceStateStore,
      logger: makeLogger() as never,
      isWorkspaceTrusted: () => true,
      hasPrimacy: () => Promise.reject(new Error('lock file unreadable'))
    });
    await expect(unreadable.primeAuthority?.()).resolves.toBe(false);
  });

  it('denies before the first verdict when no store is attached', () => {
    registry.writer = undefined;
    const { gate } = build({ primary: true });

    expect(gate.authorize(readRequest()).reason).toBe('ownership-lost');
  });

  it('reports a receipt with no store to write it to, once', async () => {
    registry.writer = undefined;
    const logger = makeLogger();
    const { dispatch, gate } = build({ primary: true, logger });
    dispatch.currentOwnershipGeneration?.();
    await settle();

    expect(gate.authorize(readRequest()).allowed).toBe(true);
    gate.authorize(readRequest());

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
      operation: 'acp-authorization-receipt',
      error: 'AcpReceiptStoreDetachedError'
    });
  });

  it('reports a receipt write the database refused', async () => {
    registry.writer = {
      run: () => {
        throw new RangeError('constraint');
      }
    };
    const logger = makeLogger();
    const { dispatch, gate } = build({ primary: true, logger });
    await dispatch.primeAuthority?.();

    expect(gate.authorize(readRequest()).allowed).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
      operation: 'acp-authorization-receipt',
      error: 'RangeError'
    });
  });

  it('FR-R7-11 Task 20: wires live coordinator getDatabaseProtectedPaths into ACP dispatch and blocks canonical, fallback, sidecar, preserved, symlink, and case-variant store paths', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'schegent-acp-prot-'));
    tempDirs.push(root);
    const workspaceRoot = path.join(root, 'workspace');
    const globalStoreDir = path.join(root, 'globalStorage', 'sqlite', 'scope1');
    const legacyStoreDir = path.join(root, 'workspaceStorage', 'win1', 'sqlite', 'scope1');
    const fallbackStoreDir = path.join(root, 'workspaceStorage', 'fallback', 'sqlite', 'scope1');
    await fsp.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    await fsp.mkdir(globalStoreDir, { recursive: true, mode: 0o700 });
    await fsp.mkdir(legacyStoreDir, { recursive: true, mode: 0o700 });
    await fsp.mkdir(fallbackStoreDir, { recursive: true, mode: 0o700 });

    const canonicalDb = path.join(globalStoreDir, 'schegent-state.db');
    const canonicalWal = `${canonicalDb}-wal`;
    const legacyDb = path.join(legacyStoreDir, 'schegent-state.db');
    const preservedDb = path.join(globalStoreDir, 'schegent-state.unselected-abc123.db');
    const fallbackDb = path.join(fallbackStoreDir, 'schegent-state.db');
    const benignFile = path.join(workspaceRoot, 'allowed.txt');
    const outsideFile = path.join(root, 'outside-secret.txt');
    await fsp.writeFile(canonicalDb, 'db', { mode: 0o600 });
    await fsp.writeFile(canonicalWal, 'wal', { mode: 0o600 });
    await fsp.writeFile(legacyDb, 'legacy', { mode: 0o600 });
    await fsp.writeFile(preservedDb, 'preserved', { mode: 0o600 });
    await fsp.writeFile(fallbackDb, 'fallback', { mode: 0o600 });
    await fsp.writeFile(benignFile, 'ok', { mode: 0o600 });
    await fsp.writeFile(outsideFile, 'outside', { mode: 0o600 });

    const symlinkToDb = path.join(workspaceRoot, 'db-symlink');
    await fsp.symlink(canonicalDb, symlinkToDb);
    const symlinkOutside = path.join(workspaceRoot, 'outside-symlink');
    await fsp.symlink(outsideFile, symlinkOutside);

    registry.protectedPaths = [canonicalDb, canonicalWal, legacyDb, preservedDb];
    const dispatch = buildHostAcpDispatchOptions({
      workspaceRoot,
      store: {} as WorkspaceStateStore,
      logger: makeLogger() as never,
      isWorkspaceTrusted: () => true,
      hasPrimacy: () => Promise.resolve(true)
    });
    const resolver = dispatch.protectedDatabasePaths;
    expect(typeof resolver).toBe('function');
    const resolved = typeof resolver === 'function' ? resolver() : resolver ?? [];
    expect(resolved).toEqual(registry.protectedPaths);

    const gate = dispatch.authorityGate!;
    await dispatch.primeAuthority?.();
    gate.registerScope({
      attemptId: 'att-protected',
      acpSessionId: 'sess-protected',
      connectionGeneration: 1,
      ownershipGeneration: WIRING_OWNERSHIP_GENERATION,
      executionRoot: workspaceRoot,
      primaryWorkspaceRoot: workspaceRoot,
      protectedDatabasePaths: resolver
    });

    for (const protectedTarget of [...registry.protectedPaths, symlinkToDb]) {
      const verdict = gate.authorize({
        requestKind: 'filesystem',
        acpSessionId: 'sess-protected',
        connectionGeneration: 1,
        mutating: false,
        targetPath: protectedTarget
      });
      expect(verdict.allowed, protectedTarget).toBe(false);
      expect(verdict.reason, protectedTarget).toBe('protected-target-refused');
    }

    if (process.platform === 'darwin' || process.platform === 'win32') {
      const upperVariant = path.join(globalStoreDir, 'SCHEGENT-STATE.DB');
      const caseVerdict = gate.authorize({
        requestKind: 'filesystem',
        acpSessionId: 'sess-protected',
        connectionGeneration: 1,
        mutating: false,
        targetPath: upperVariant
      });
      expect(caseVerdict.allowed).toBe(false);
      expect(caseVerdict.reason).toBe('protected-target-refused');
    }

    // Dynamic update when relocation switches to fallback root is immediately observed by registered live scope!
    registry.protectedPaths = [fallbackDb];
    const fallbackVerdict = gate.authorize({
      requestKind: 'filesystem',
      acpSessionId: 'sess-protected',
      connectionGeneration: 1,
      mutating: false,
      targetPath: fallbackDb
    });
    expect(fallbackVerdict.allowed).toBe(false);
    expect(fallbackVerdict.reason).toBe('protected-target-refused');

    // Direct AcpBackedRunner verifyResourceLink coverage for canonical, fallback, sidecar, preserved, symlinked DB, and symlink escape URIs.
    registry.protectedPaths = [canonicalDb, canonicalWal, legacyDb, preservedDb, fallbackDb];
    const runner = new AcpBackedRunner({
      kind: 'agy',
      inner: makeDummyInnerRunner(),
      readConfiguredProfile: () => 'agy-acp-native',
      authorityGate: gate,
      primaryWorkspaceRoot: workspaceRoot,
      ...(dispatch.protectedDatabasePaths !== undefined
        ? { protectedDatabasePaths: dispatch.protectedDatabasePaths }
        : {}),
      ...(dispatch.currentOwnershipGeneration !== undefined
        ? { currentOwnershipGeneration: dispatch.currentOwnershipGeneration }
        : {}),
      ...(dispatch.primeAuthority !== undefined ? { primeAuthority: dispatch.primeAuthority } : {}),
      platform: { os: 'darwin', arch: 'arm64' },
      launchTransport: () => createFakeAcpTransport()
    });

    const refusedTargets = [
      canonicalDb,
      fallbackDb,
      canonicalWal,
      preservedDb,
      symlinkToDb,
      symlinkOutside,
      ...(process.platform === 'darwin' || process.platform === 'win32'
        ? [path.join(globalStoreDir, 'SCHEGENT-STATE.DB')]
        : [])
    ];
    for (const target of refusedTargets) {
      const res = await runner.invoke({
        cliPath: '/usr/bin/fake-agy',
        cwd: workspaceRoot,
        prompt: 'Inspect resource',
        acpPromptBlocks: [{ type: 'resource-link', uri: pathToFileURL(target).href, name: path.basename(target) }],
        phase: 'implement',
        iteration: 1,
        timeoutMs: 5_000,
        runId: 'run-link-refuse'
      });
      expect(res.exitCode, target).toBe(1);
      expect(res.diagnosticWarnings, target).toContain('acp-prompt-refused:resource-inaccessible');
    }

    // Non-vacuity: benign file inside workspaceRoot passes verifyResourceLink cleanly!
    const okRes = await runner.invoke({
      cliPath: '/usr/bin/fake-agy',
      cwd: workspaceRoot,
      prompt: 'Inspect benign resource',
      acpPromptBlocks: [{ type: 'resource-link', uri: pathToFileURL(benignFile).href, name: 'allowed.txt' }],
      phase: 'implement',
      iteration: 1,
      timeoutMs: 5_000,
      runId: 'run-link-allow'
    });
    expect(okRes.exitCode).toBe(0);
    expect(okRes.sawTerminalResult).toBe(true);

    // Iteration 2 security regressions:
    // (1) Dangling file symlink pointing to an absent protected `-wal` sidecar must be refused.
    const absentShm = `${canonicalDb}-shm`;
    const danglingShmLink = path.join(workspaceRoot, 'dangling-shm-link');
    await fsp.symlink(absentShm, danglingShmLink);
    registry.protectedPaths = [canonicalDb, canonicalWal, absentShm];
    expect(isTargetProtectedPathSync(danglingShmLink, [absentShm])).toBe(true);
    const danglingProtectedVerdict = gate.authorize({
      requestKind: 'filesystem',
      acpSessionId: 'sess-protected',
      connectionGeneration: 1,
      mutating: true,
      targetPath: danglingShmLink
    });
    expect(danglingProtectedVerdict.allowed).toBe(false);
    expect(danglingProtectedVerdict.reason).toBe('protected-target-refused');

    const danglingLinkRes = await runner.invoke({
      cliPath: '/usr/bin/fake-agy',
      cwd: workspaceRoot,
      prompt: 'Inspect dangling symlink',
      acpPromptBlocks: [
        { type: 'resource-link', uri: pathToFileURL(danglingShmLink).href, name: 'dangling-shm-link' }
      ],
      phase: 'implement',
      iteration: 1,
      timeoutMs: 5_000,
      runId: 'run-link-dangling'
    });
    expect(danglingLinkRes.exitCode).toBe(1);
    expect(danglingLinkRes.diagnosticWarnings).toContain('acp-prompt-refused:resource-inaccessible');

    // (2) Dangling directory symlink pointing outside executionRoot must be refused.
    const danglingDirLink = path.join(workspaceRoot, 'dangling-out-dir');
    await fsp.symlink(path.join(root, 'nonexistent-outside-dir'), danglingDirLink);
    const danglingDirVerdict = gate.authorize({
      requestKind: 'filesystem',
      acpSessionId: 'sess-protected',
      connectionGeneration: 1,
      mutating: true,
      targetPath: path.join(danglingDirLink, 'payload.txt')
    });
    expect(danglingDirVerdict.allowed).toBe(false);
    expect(danglingDirVerdict.reason).toBe('outside-execution-root');

    // (3) Case-variant protected segments (.SCHEGENT, SECRETS) must be refused.
    for (const relTarget of ['.SCHEGENT/audit.log', 'SECRETS/token.json', '.SSH/config']) {
      const segVerdict = gate.authorize({
        requestKind: 'filesystem',
        acpSessionId: 'sess-protected',
        connectionGeneration: 1,
        mutating: false,
        targetPath: path.join(workspaceRoot, relTarget)
      });
      expect(segVerdict.allowed, relTarget).toBe(false);
      expect(segVerdict.reason, relTarget).toBe('protected-target-refused');
    }

    // (4) Child names starting with `..` inside a protected dir remain matched (not treated as parent traversal).
    const dotDotDir = path.join(root, 'protected-dir');
    expect(isTargetProtectedPathSync(path.join(dotDotDir, '..secret'), [dotDotDir])).toBe(true);
    expect(
      doesSubtreeOverlapProtectedPathsSync(root, [
        path.join(root, '..store', 'schegent-state.db')
      ])
    ).toBe(true);

    // Iteration 3 security regressions (POSIX left-to-right symlink walk & raw file:// URI dot-segment rejection):
    // (5) Relative dangling symlink beneath a symlinked parent (`/ws/up/up/escape` where `up -> .` and `escape -> ../...`)
    const upLink = path.join(workspaceRoot, 'up');
    await fsp.symlink('.', upLink);
    const relEscapeTarget = path.relative(workspaceRoot, absentShm);
    const relEscapeLink = path.join(workspaceRoot, 'rel-escape');
    await fsp.symlink(relEscapeTarget, relEscapeLink);
    const chainedEscapePath = path.join(workspaceRoot, 'up', 'up', 'rel-escape');
    expect(isTargetProtectedPathSync(chainedEscapePath, [absentShm])).toBe(true);
    const chainedVerdict = gate.authorize({
      requestKind: 'filesystem',
      acpSessionId: 'sess-protected',
      connectionGeneration: 1,
      mutating: true,
      targetPath: chainedEscapePath
    });
    expect(chainedVerdict.allowed).toBe(false);
    expect(chainedVerdict.reason).toBe('protected-target-refused');

    // (6) Symlink target containing `<symlink>/..` AND direct `<symlink>/..` targeting live canonicalDb
    const globalBackupsDir = path.join(globalStoreDir, 'backups');
    await fsp.mkdir(globalBackupsDir, { recursive: true, mode: 0o700 });
    const jumpLink = path.join(workspaceRoot, 'jump');
    await fsp.symlink(globalBackupsDir, jumpLink);
    const nestedDotDotLink = path.join(workspaceRoot, 'jump-dotdot-shm');
    await fsp.symlink('jump/../schegent-state.db-shm', nestedDotDotLink);
    expect(isTargetProtectedPathSync(nestedDotDotLink, [absentShm])).toBe(true);
    const nestedDotDotVerdict = gate.authorize({
      requestKind: 'filesystem',
      acpSessionId: 'sess-protected',
      connectionGeneration: 1,
      mutating: true,
      targetPath: nestedDotDotLink
    });
    expect(nestedDotDotVerdict.allowed).toBe(false);
    expect(nestedDotDotVerdict.reason).toBe('protected-target-refused');

    const directJumpDotDotVerdict = gate.authorize({
      requestKind: 'filesystem',
      acpSessionId: 'sess-protected',
      connectionGeneration: 1,
      mutating: false,
      targetPath: 'jump/../schegent-state.db'
    });
    expect(directJumpDotDotVerdict.allowed).toBe(false);
    expect(directJumpDotDotVerdict.reason).toBe('protected-target-refused');

    // (7) Raw unnormalized dot-segments, percent-encoded dot-segments, and query/fragment suffixes in file:// URIs
    const rawBaseUri = pathToFileURL(workspaceRoot).href.replace(/\/$/, '');
    const unsafeUris = [
      `${rawBaseUri}/jump/../schegent-state.db`,
      `${rawBaseUri}/jump/%2e%2e/schegent-state.db`,
      `${rawBaseUri}/jump/.\t./schegent-state.db`,
      `${rawBaseUri}/jump/.\n./schegent-state.db`,
      `${rawBaseUri}/jump/.\r./schegent-state.db`,
      `${rawBaseUri}/jump/.\t%2e/schegent-state.db`,
      `${rawBaseUri}/jump/.. /schegent-state.db`,
      `${rawBaseUri}/jump/..\x01/schegent-state.db`,
      'file://attacker.example/share/probe.txt',
      `file://localhost${workspaceRoot}/allowed.txt`,
      `${rawBaseUri}/allowed.txt?x=1`,
      `${rawBaseUri}/allowed.txt#frag`
    ];
    for (const unsafeUri of unsafeUris) {
      const uriRes = await runner.invoke({
        cliPath: '/usr/bin/fake-agy',
        cwd: workspaceRoot,
        prompt: 'Inspect unsafe URI',
        acpPromptBlocks: [{ type: 'resource-link', uri: unsafeUri, name: 'unsafe' }],
        phase: 'implement',
        iteration: 1,
        timeoutMs: 5_000,
        runId: 'run-link-unsafe-uri'
      });
      expect(uriRes.exitCode, unsafeUri).toBe(1);
      expect(uriRes.diagnosticWarnings, unsafeUri).toContain('acp-prompt-refused:resource-inaccessible');
    }

    // (8) Symlink planted at an authorizedOutputPath MUST NOT escalate to allow writing outside executionRoot or .env.
    const resultsDir = path.join(workspaceRoot, '.schegent', 'results', 'run-1', 'att-1');
    await fsp.mkdir(resultsDir, { recursive: true, mode: 0o700 });
    const envTarget = path.join(workspaceRoot, '.env');
    await fsp.writeFile(envTarget, 'SECRET=1\n');
    const outsideTarget = path.join(root, 'outside-secret.txt');
    await fsp.writeFile(outsideTarget, 'OUTSIDE\n');
    const plantedEnvLink = path.join(resultsDir, 'contribution-env.json');
    const plantedOutLink = path.join(resultsDir, 'contribution-out.json');
    const legitOutput = path.join(resultsDir, 'contribution-ok.json');
    await fsp.symlink(envTarget, plantedEnvLink);
    await fsp.symlink(outsideTarget, plantedOutLink);

    gate.registerScope({
      attemptId: 'att-auth-ref',
      acpSessionId: 'sess-auth-ref',
      connectionGeneration: 1,
      ownershipGeneration: WIRING_OWNERSHIP_GENERATION,
      executionRoot: workspaceRoot,
      primaryWorkspaceRoot: workspaceRoot,
      protectedDatabasePaths: dispatch.protectedDatabasePaths,
      authorizedOutputPaths: [plantedEnvLink, plantedOutLink, legitOutput]
    });
    expect(
      gate.authorize({
        requestKind: 'filesystem',
        acpSessionId: 'sess-auth-ref',
        connectionGeneration: 1,
        mutating: true,
        targetPath: plantedEnvLink
      }).allowed
    ).toBe(false);
    expect(
      gate.authorize({
        requestKind: 'filesystem',
        acpSessionId: 'sess-auth-ref',
        connectionGeneration: 1,
        mutating: true,
        targetPath: envTarget
      }).allowed
    ).toBe(false);
    expect(
      gate.authorize({
        requestKind: 'filesystem',
        acpSessionId: 'sess-auth-ref',
        connectionGeneration: 1,
        mutating: true,
        targetPath: plantedOutLink
      }).allowed
    ).toBe(false);
    expect(
      gate.authorize({
        requestKind: 'filesystem',
        acpSessionId: 'sess-auth-ref',
        connectionGeneration: 1,
        mutating: true,
        targetPath: outsideTarget
      }).allowed
    ).toBe(false);
    // Non-vacuity: legitimate symlink-free authorized output inside .schegent/results is allowed!
    expect(
      gate.authorize({
        requestKind: 'filesystem',
        acpSessionId: 'sess-auth-ref',
        connectionGeneration: 1,
        mutating: true,
        targetPath: legitOutput
      }).allowed
    ).toBe(true);

    // (9) No-gate AcpBackedRunner fallback also refuses protected workspace patterns (.env, .schegent).
    const noGateRunner = new AcpBackedRunner({
      kind: 'agy',
      inner: makeDummyInnerRunner(),
      readConfiguredProfile: () => 'agy-acp-native',
      primaryWorkspaceRoot: workspaceRoot,
      protectedDatabasePaths: () => [canonicalDb],
      platform: { os: 'darwin', arch: 'arm64' },
      launchTransport: () => createFakeAcpTransport()
    });
    const noGateEnvRes = await noGateRunner.invoke({
      cliPath: '/usr/bin/fake-agy',
      cwd: workspaceRoot,
      prompt: 'Inspect .env without gate',
      acpPromptBlocks: [{ type: 'resource-link', uri: pathToFileURL(envTarget).href, name: '.env' }],
      phase: 'implement',
      iteration: 1,
      timeoutMs: 5_000,
      runId: 'run-nogate-env'
    });
    expect(noGateEnvRes.exitCode).toBe(1);
    expect(noGateEnvRes.diagnosticWarnings).toContain('acp-prompt-refused:resource-inaccessible');

    // (10) Iter 6 S1: trailing dot segment (`/.`) must not mask protected basenames or protected directories.
    expect(isWorkspaceProtectedPattern(path.join(workspaceRoot, '.env', '.'))).toBe(true);
    expect(isWorkspaceProtectedPattern(`${path.join(workspaceRoot, '.env')}${path.sep}.`)).toBe(true);
    expect(isTargetProtectedPathSync(`${globalStoreDir}${path.sep}.`, [globalStoreDir])).toBe(true);
    expect(doesSubtreeOverlapProtectedPathsSync(`${globalStoreDir}${path.sep}.`, [globalStoreDir])).toBe(true);

    // (11) Iter 7 S3: createPermissionPolicy records a 'denied' / 'session-attempt-mismatch' receipt
    // (never 'allowed') when sessionId matches a registered scope but attemptId does not.
    const policy = gate.createPermissionPolicy(1);
    const receiptsBefore = gate.listReceipts().length;
    const permOutcome = policy({
      sessionId: 'sess-auth-ref',
      attemptId: 'att-wrong',
      toolCallId: 'tool-mismatch-1',
      toolTitle: 'write file',
      options: [{ optionId: 'allow-1', kind: 'allow_once' }]
    });
    expect(permOutcome).toBe('undecided');
    const latestReceipt = gate.listReceipts().at(-1);
    expect(gate.listReceipts().length).toBe(receiptsBefore + 1);
    expect(latestReceipt?.decision).toBe('denied');
    expect(latestReceipt?.reasonCode).toBe('session-attempt-mismatch');

    // (12) Iter 8 C1/S1: unattributed post-turn / post-cancellation permission request (`attemptId: null`)
    // against a still-registered session scope must be refused ('undecided') and record 'denied' / 'session-attempt-mismatch'.
    const receiptsBeforeNull = gate.listReceipts().length;
    const nullAttemptOutcome = policy({
      sessionId: 'sess-auth-ref',
      attemptId: null,
      toolCallId: 'tool-post-turn-1',
      toolTitle: 'write file after turn end',
      options: [{ optionId: 'allow-1', kind: 'allow_once' }]
    });
    expect(nullAttemptOutcome).toBe('undecided');
    const nullAttemptReceipt = gate.listReceipts().at(-1);
    expect(gate.listReceipts().length).toBe(receiptsBeforeNull + 1);
    expect(nullAttemptReceipt?.decision).toBe('denied');
    expect(nullAttemptReceipt?.reasonCode).toBe('session-attempt-mismatch');

    // (13) Iter 9 S1 & S2: Dual-order (`..`-before-symlink / Win32 RtlGetFullPathName_U) containment
    // and protected-path defenses refuse `<link>/../<alias>/schegent-state.db`, `<link>/../<outside-alias>/secret`,
    // and `<link>/../.env/<pad-link>/..`. Use explicit separator join (never `path.join`, which eagerly strips `..`).
    const decoyInner = path.join(workspaceRoot, 'dual-decoy', 'inner');
    const decoyEnvDir = path.join(workspaceRoot, 'dual-decoy', '.env');
    const benignDeep = path.join(workspaceRoot, 'dual-benign', 'deep');
    await fsp.mkdir(decoyInner, { recursive: true });
    await fsp.mkdir(decoyEnvDir, { recursive: true });
    await fsp.mkdir(benignDeep, { recursive: true });
    await fsp.symlink(decoyInner, path.join(workspaceRoot, 'dual-jump'));
    await fsp.symlink(globalStoreDir, path.join(workspaceRoot, 'db-alias'));
    await fsp.symlink(path.dirname(outsideTarget), path.join(workspaceRoot, 'out-alias'));
    await fsp.symlink(benignDeep, path.join(decoyEnvDir, 'pad'));

    const dualDbTarget = [workspaceRoot, 'dual-jump', '..', 'db-alias', 'schegent-state.db'].join(
      path.sep
    );
    expect(dualDbTarget).toContain(`${path.sep}..${path.sep}`);
    expect(isTargetProtectedPathSync(dualDbTarget, [canonicalDb])).toBe(true);
    expect(
      doesSubtreeOverlapProtectedPathsSync(
        [workspaceRoot, 'dual-jump', '..', 'db-alias'].join(path.sep),
        [canonicalDb]
      )
    ).toBe(true);
    const dualDbAuth = gate.authorize({
      requestKind: 'filesystem',
      acpSessionId: 'sess-auth-ref',
      connectionGeneration: 1,
      mutating: false,
      targetPath: ['dual-jump', '..', 'db-alias', 'schegent-state.db'].join(path.sep)
    });
    expect(dualDbAuth.allowed).toBe(false);
    expect(dualDbAuth.reason).toBe('protected-target-refused');

    const dualOutsideAuth = gate.authorize({
      requestKind: 'filesystem',
      acpSessionId: 'sess-auth-ref',
      connectionGeneration: 1,
      mutating: false,
      targetPath: ['dual-jump', '..', 'out-alias', path.basename(outsideTarget)].join(path.sep)
    });
    expect(dualOutsideAuth.allowed).toBe(false);
    expect(dualOutsideAuth.reason).toBe('outside-execution-root');

    const dualEnvPath = ['dual-jump', '..', '.env', 'pad', '..'].join(path.sep);
    expect(dualEnvPath).toContain(`${path.sep}..`);
    expect(isWorkspaceProtectedPattern([workspaceRoot, dualEnvPath].join(path.sep))).toBe(true);
    const dualEnvAuth = gate.authorize({
      requestKind: 'filesystem',
      acpSessionId: 'sess-auth-ref',
      connectionGeneration: 1,
      mutating: false,
      targetPath: dualEnvPath
    });
    expect(dualEnvAuth.allowed).toBe(false);
    expect(dualEnvAuth.reason).toBe('protected-target-refused');

    // Non-vacuity: a benign `..` path within `workspaceRoot` remains allowed.
    const benignDotDotAuth = gate.authorize({
      requestKind: 'filesystem',
      acpSessionId: 'sess-auth-ref',
      connectionGeneration: 1,
      mutating: false,
      targetPath: ['dual-benign', 'deep', '..', '..', path.basename(benignFile)].join(path.sep)
    });
    expect(benignDotDotAuth.allowed).toBe(true);
  });
});
