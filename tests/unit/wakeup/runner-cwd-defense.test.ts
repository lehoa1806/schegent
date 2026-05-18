// Feature 014 T039 — runner workspace-cwd defense.
//
// The runner's hard invariant: even if os.tmpdir() is somehow returning
// a path inside a known VS Code workspace root (a maliciously modified
// TMPDIR env var, a misconfigured host, a future regression), the
// runner MUST refuse to spawn `claude` from that cwd. The forensic
// trail is an InvocationRecord with `errorReason:
// 'cwd-inside-workspace-aborted'` and `claudeExitCode: null` — the
// canonical evidence that the abort path took effect.
//
// What this test does:
//   1. Builds a temp home directory + a temp "workspace" directory.
//   2. Mocks `node:os.tmpdir()` (via vi.mock) to return a child of the
//      workspace directory so any `os.tmpdir() + 'schegent-primer-
//      session/<id>'` lands inside the workspace root.
//   3. Mocks `node:child_process.spawn` (via vi.mock) so the test can
//      observe whether claude was ever invoked.
//   4. Calls `runWakeup()` (the exported main) and asserts:
//      - return code 1 (the abort sentinel)
//      - one invocation record with errorReason='cwd-inside-workspace-aborted'
//      - spawn was NEVER invoked for `claude`
//   5. As a control, runs the happy path (workspace-roots.json empty)
//      and asserts spawn WAS invoked — proves the harness is real.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir as realTmpdir } from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { runWakeup as RunWakeupType } from '../../../src/headless/wakeup-runner';
import type { InvocationLog as InvocationLogType } from '../../../src/wakeup/invocation-log';

// ── Module mocks ───────────────────────────────────────────────────────────
//
// We need to control both `node:os.tmpdir()` (to force a workspace-
// resident ephemeral cwd) and `node:child_process.spawn` (to observe
// claude invocation). `vi.mock` is the only way that survives Node's
// read-only module export descriptors.

const tmpdirOverride = { value: '' as string };
const spawnCalls: Array<{ cmd: string; args: readonly string[] }> = [];

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: actual,
    tmpdir: () => (tmpdirOverride.value || actual.tmpdir())
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    default: actual,
    spawn: ((cmd: string, args: readonly string[]) => {
      spawnCalls.push({ cmd, args });
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { write: (s: string) => void; end: () => void };
        kill: (sig?: string) => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => undefined, end: () => undefined };
      child.kill = () => undefined;
      setImmediate(() => child.emit('close', 0));
      return child as unknown as ReturnType<typeof actual.spawn>;
    }) as unknown as typeof actual.spawn
  };
});

// IMPORTANT: import the SUT AFTER vi.mock so it picks up the mocks.
// CJS-compatible: load lazily in beforeAll instead of top-level await.
let runWakeup: typeof RunWakeupType;
let InvocationLog: typeof InvocationLogType;

describe('Feature 014 T039 — runner cwd-defense', () => {
  let tempRoot: string;
  let workspaceDir: string;
  let homeDir: string;
  let savedHomeEnv: string | undefined;

  beforeAll(async () => {
    ({ runWakeup } = await import('../../../src/headless/wakeup-runner.js'));
    ({ InvocationLog } = await import('../../../src/wakeup/invocation-log.js'));
  });

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(realTmpdir(), 'schegent-cwd-defense-'));
    workspaceDir = path.join(tempRoot, 'workspace');
    homeDir = path.join(tempRoot, 'wakeup-home');
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    savedHomeEnv = process.env.SCHEGENT_WAKEUP_HOME;
    process.env.SCHEGENT_WAKEUP_HOME = homeDir;
    spawnCalls.length = 0;
    tmpdirOverride.value = '';
  });

  afterEach(() => {
    if (savedHomeEnv === undefined) delete process.env.SCHEGENT_WAKEUP_HOME;
    else process.env.SCHEGENT_WAKEUP_HOME = savedHomeEnv;
    tmpdirOverride.value = '';
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeEnabledSettings(): void {
    writeFileSync(
      path.join(homeDir, 'settings.json'),
      JSON.stringify({
        enabled: true,
        schedulerType: 'periodic',
        chronologicalTime: '04:00',
        periodicInterval: 'Every 1h'
      }),
      'utf8'
    );
  }

  function writeWorkspaceRoots(roots: readonly string[]): void {
    writeFileSync(
      path.join(homeDir, 'workspace-roots.json'),
      JSON.stringify({ roots: [...roots] }),
      'utf8'
    );
  }

  it('aborts (return 1) and records `cwd-inside-workspace-aborted` when os.tmpdir() resolves inside a workspace root', async () => {
    writeEnabledSettings();
    writeWorkspaceRoots([workspaceDir]);

    const fakeTmp = path.join(workspaceDir, 'fake-tmp');
    mkdirSync(fakeTmp, { recursive: true });
    tmpdirOverride.value = fakeTmp;

    const code = await runWakeup();
    expect(code).toBe(1);

    // CRITICAL: claude was never spawned.
    expect(spawnCalls.filter((c) => c.cmd === 'claude').length).toBe(0);

    const log = new InvocationLog(homeDir);
    const records = await log.read();
    expect(records.length).toBe(1);
    expect(records[0].errorReason).toBe('cwd-inside-workspace-aborted');
    expect(records[0].claudeExitCode).toBeNull();
    expect(records[0].cwdInsideWorkspace).toBe(false);
    expect(records[0].envScrubbed).toBe(false);
  });

  it('proceeds to spawn claude when workspace-roots.json is empty (control case)', async () => {
    writeEnabledSettings();
    writeWorkspaceRoots([]);

    const code = await runWakeup();
    expect(code).toBe(0);

    expect(spawnCalls.filter((c) => c.cmd === 'claude').length).toBe(1);

    const log = new InvocationLog(homeDir);
    const records = await log.read();
    expect(records.length).toBe(1);
    expect(records[0].errorReason).toBeUndefined();
    expect(records[0].envScrubbed).toBe(true);
    expect(records[0].cwdInsideWorkspace).toBe(false);
  });

  it('aborts when the ephemeral cwd realpath equals a workspace root exactly (not just a prefix)', async () => {
    writeEnabledSettings();
    writeWorkspaceRoots([workspaceDir]);

    tmpdirOverride.value = workspaceDir;

    const code = await runWakeup();
    expect(code).toBe(1);
    expect(spawnCalls.filter((c) => c.cmd === 'claude').length).toBe(0);

    const log = new InvocationLog(homeDir);
    const records = await log.read();
    expect(records[0].errorReason).toBe('cwd-inside-workspace-aborted');
  });

  it('aborts when the ephemeral cwd is a deep descendant of any workspace root', async () => {
    writeEnabledSettings();
    writeWorkspaceRoots([workspaceDir]);

    const deep = path.join(workspaceDir, 'a', 'b', 'c', 'd', 'tmp');
    mkdirSync(deep, { recursive: true });
    tmpdirOverride.value = deep;

    const code = await runWakeup();
    expect(code).toBe(1);
    expect(spawnCalls.filter((c) => c.cmd === 'claude').length).toBe(0);

    const log = new InvocationLog(homeDir);
    const records = await log.read();
    expect(records[0].errorReason).toBe('cwd-inside-workspace-aborted');
  });

  it('proceeds when workspace-roots.json is missing (treated as zero roots)', async () => {
    writeEnabledSettings();
    // Intentionally do not write workspace-roots.json.

    const code = await runWakeup();
    expect(code).toBe(0);
    expect(spawnCalls.filter((c) => c.cmd === 'claude').length).toBe(1);
  });
});
