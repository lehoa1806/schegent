// Feature 014 T038 — wake-up context-isolation integration test.
//
// What this test asserts (US2 acceptance scenarios 1-3, SC-003, SC-009):
//   1. The host's `publishRunnerBundle` writes a `workspace-roots.json`
//      mirror to `<homeDir>/workspace-roots.json`.
//   2. When the runner fires, it reads that mirror — verified by the
//      cwd-defense check still passing with the workspace listed.
//   3. The runner's ephemeral cwd lives under `os.tmpdir()` and NOT
//      under the workspace path. The JSONL record's `ephemeralCwd`
//      field is the forensic evidence.
//   4. The runner records `cwdInsideWorkspace: false` (the InvocationLog
//      type guarantees this — the test re-asserts as defense in depth).
//   5. The marker file `MARKER_DO_NOT_INGEST.txt` in the workspace is
//      not touched (cwd is elsewhere; the workspace is never opened).
//
// Why this lives in tests/integration/ rather than tests/unit/:
//   It exercises the real `publishRunnerBundle` writing real mirror
//   files, the real `runWakeup` consuming them, the real `InvocationLog`
//   reader — only the `node:child_process.spawn` call to `claude` is
//   stubbed (so the test doesn't depend on the host having claude
//   installed and doesn't make a network call).

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir as realTmpdir } from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { runWakeup as RunWakeupType } from '../../../src/headless/wakeup-runner';
import type { InvocationLog as InvocationLogType } from '../../../src/wakeup/invocation-log';
import type { publishRunnerBundle as PublishRunnerBundleType } from '../../../src/wakeup/runner-bundle';

const spawnCalls: Array<{ cmd: string; args: readonly string[]; opts: { cwd?: string; env?: NodeJS.ProcessEnv } | undefined }> = [];

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    default: actual,
    spawn: ((cmd: string, args: readonly string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      spawnCalls.push({ cmd, args, opts });
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
let publishRunnerBundle: typeof PublishRunnerBundleType;

describe('Feature 014 T038 — wake-up context-isolation integration', () => {
  let tempRoot: string;
  let workspaceDir: string;
  let homeDir: string;
  let runnerSourcePath: string;
  let markerPath: string;
  let markerMtimeBefore: Date;
  let savedHomeEnv: string | undefined;

  beforeAll(async () => {
    ({ runWakeup } = await import('../../../src/headless/wakeup-runner.js'));
    ({ InvocationLog } = await import('../../../src/wakeup/invocation-log.js'));
    ({ publishRunnerBundle } = await import('../../../src/wakeup/runner-bundle.js'));
  });

  beforeEach(async () => {
    tempRoot = mkdtempSync(path.join(realTmpdir(), 'schegent-context-isolation-'));
    workspaceDir = path.join(tempRoot, 'fake-workspace');
    homeDir = path.join(tempRoot, 'wakeup-home');
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    // Plant the marker. If the runner ever picked up this directory as
    // its cwd, claude's auto-ingest would read it.
    markerPath = path.join(workspaceDir, 'MARKER_DO_NOT_INGEST.txt');
    writeFileSync(markerPath, 'this content must not be read by claude\n', 'utf8');
    markerMtimeBefore = statSync(markerPath).mtime;

    // Source runner: a tiny placeholder file. publishRunnerBundle just
    // copies it to <homeDir>/runner.js — the runner.js file itself is
    // never spawned by this test (we call runWakeup() in-process).
    runnerSourcePath = path.join(tempRoot, 'runner-source.js');
    writeFileSync(runnerSourcePath, '// placeholder for publishRunnerBundle\n', 'utf8');

    savedHomeEnv = process.env.SCHEGENT_WAKEUP_HOME;
    process.env.SCHEGENT_WAKEUP_HOME = homeDir;
    spawnCalls.length = 0;
  });

  afterEach(() => {
    if (savedHomeEnv === undefined) delete process.env.SCHEGENT_WAKEUP_HOME;
    else process.env.SCHEGENT_WAKEUP_HOME = savedHomeEnv;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('publishes mirror → fires runner → JSONL record proves the cwd never enters the workspace', async () => {
    // 1. Real publishRunnerBundle writes settings.json + workspace-roots.json + runner.js.
    const bundle = await publishRunnerBundle(runnerSourcePath, homeDir, {
      settings: {
        enabled: true,
        schedulerType: 'periodic',
        chronologicalTime: '04:00',
        periodicInterval: 'Every 1h',
        model: 'runner-default'
      },
      workspaceRoots: [workspaceDir]
    });

    // Sanity-check the host-side mirror layout.
    expect(bundle.homeDir).toBe(homeDir);
    expect(bundle.workspaceRootsPath).toBe(path.join(homeDir, 'workspace-roots.json'));
    const mirror = JSON.parse(readFileSync(bundle.workspaceRootsPath, 'utf8'));
    expect(mirror).toEqual({ roots: [workspaceDir] });

    // 2. Fire the runner. The mocked spawn pretends claude exited 0.
    const code = await runWakeup();
    expect(code).toBe(0);

    // 3. The spawn observer captured one claude invocation. Inspect
    //    the cwd that the runner asked it to run in.
    const claudeCalls = spawnCalls.filter((c) => c.cmd === 'claude');
    expect(claudeCalls.length).toBe(1);
    const spawnCwd = claudeCalls[0].opts?.cwd;
    expect(typeof spawnCwd).toBe('string');
    expect(spawnCwd!).toContain('schegent-primer-session');
    // CRITICAL: the spawn cwd is not the workspace and not a child of it.
    expect(spawnCwd!.startsWith(workspaceDir + path.sep)).toBe(false);
    expect(spawnCwd!).not.toBe(workspaceDir);

    // 4. JSONL record forensic check.
    const log = new InvocationLog(homeDir);
    const records = await log.read();
    expect(records.length).toBe(1);
    const rec = records[0];
    expect(rec.cwdInsideWorkspace).toBe(false);
    expect(rec.ephemeralCwd).toContain('schegent-primer-session');
    // The ephemeral cwd starts with the system tmpdir (resolved by
    // os.tmpdir() — we are NOT mocking that here, this is the real one).
    expect(rec.ephemeralCwd.startsWith(realTmpdir())).toBe(true);
    expect(rec.ephemeralCwd.startsWith(workspaceDir + path.sep)).toBe(false);
    expect(rec.envScrubbed).toBe(true);
    expect(rec.claudeExitCode).toBe(0);

    // 5. The marker file was not touched. We do not assert byte-equality
    //    on the file (mocked claude cannot read anyway) but assert the
    //    mtime is unchanged — a coarse-grained sentinel that no one
    //    opened the file for write/append since the test started.
    const markerMtimeAfter = statSync(markerPath).mtime;
    expect(markerMtimeAfter.getTime()).toBe(markerMtimeBefore.getTime());
  });

  it('rewriting the bundle (subsequent Save) updates workspace-roots.json atomically', async () => {
    // First Save with workspaceDir alone.
    await publishRunnerBundle(runnerSourcePath, homeDir, {
      settings: {
        enabled: true,
        schedulerType: 'periodic',
        chronologicalTime: '04:00',
        periodicInterval: 'Every 1h',
        model: 'runner-default'
      },
      workspaceRoots: [workspaceDir]
    });
    let mirror = JSON.parse(readFileSync(path.join(homeDir, 'workspace-roots.json'), 'utf8'));
    expect(mirror.roots).toEqual([workspaceDir]);

    // Second Save — operator opened a second folder. publishRunnerBundle
    // MUST overwrite the mirror.
    const secondRoot = path.join(tempRoot, 'fake-workspace-2');
    mkdirSync(secondRoot);
    await publishRunnerBundle(runnerSourcePath, homeDir, {
      settings: {
        enabled: true,
        schedulerType: 'periodic',
        chronologicalTime: '04:00',
        periodicInterval: 'Every 1h',
        model: 'runner-default'
      },
      workspaceRoots: [workspaceDir, secondRoot]
    });
    mirror = JSON.parse(readFileSync(path.join(homeDir, 'workspace-roots.json'), 'utf8'));
    expect(mirror.roots).toEqual([workspaceDir, secondRoot]);

    // Third Save — operator closed all workspaces. Mirror becomes empty.
    await publishRunnerBundle(runnerSourcePath, homeDir, {
      settings: {
        enabled: true,
        schedulerType: 'periodic',
        chronologicalTime: '04:00',
        periodicInterval: 'Every 1h',
        model: 'runner-default'
      },
      workspaceRoots: []
    });
    mirror = JSON.parse(readFileSync(path.join(homeDir, 'workspace-roots.json'), 'utf8'));
    expect(mirror.roots).toEqual([]);
  });
});
