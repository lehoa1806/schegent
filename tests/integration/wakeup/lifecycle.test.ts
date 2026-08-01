// Feature 014 T037 — macOS lifecycle integration test for the wake-up
// daemon.
//
// What this test asserts (US1 acceptance, SC-001/002/005/006/007):
//   - DaemonManager.apply() with a `periodic, Every 1m` schedule
//     produces a registered launchd entry visible to `launchctl list`.
//   - Within ~75 seconds, launchd fires the bundled runner.js, the
//     runner acquires the lock and writes an invocation record to
//     `<homeDir>/invocations.log` with the literal `cwdInsideWorkspace:
//     false` and `lockAcquired: true`.
//   - DaemonManager.uninstall() removes the entry such that
//     `launchctl list com.schegent.wakeup.integration` returns non-zero within
//     30 s (the SC-005 budget).
//
// Why opt-in via SCHEGENT_INTEGRATION_TESTS=1:
//   This test installs an isolated launchd identity under a temporary
//   home directory. The opt-in gate remains because launchctl state is
//   a real external side effect even though production registration is
//   never touched.
//
// Why a stand-in runner instead of dist/wakeup-runner.js:
//   The real runner's behavior (lock acquisition, env scrubbing, cwd
//   workspace defense, claude spawn) is unit-tested at
//   `tests/unit/wakeup/runner-*.test.ts`. The lifecycle test only
//   needs to verify the launchd → node-script → invocation-log path,
//   so we publish a minimal stand-in that mimics the production
//   record shape (`cwdInsideWorkspace: false`, `lockAcquired: true`).
//   This keeps the test independent of `npm run build` ordering.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import {
  DaemonManager,
  defaultCommandRunner,
  type DaemonInstaller,
  type CommandRunner
} from '../../../src/wakeup/daemon-manager';
import { LaunchdInstaller } from '../../../src/wakeup/platforms/launchd';
import { InvocationLog, type InvocationRecord } from '../../../src/wakeup/invocation-log';
import type { WakeUpPlatform } from '../../../src/wakeup/platform-detect';

const OPTED_IN = process.env.SCHEGENT_INTEGRATION_TESTS === '1';
const IS_DARWIN = process.platform === 'darwin';
const SHOULD_RUN = IS_DARWIN && OPTED_IN;
const QUALIFICATION_LABEL = 'com.schegent.wakeup.integration';

// 60_000 ms is the minimum periodic interval the parser accepts; launchd
// honors StartInterval≥1s. Wait up to 75s for the first fire.
const FIRE_WAIT_MS = 75_000;
const UNINSTALL_WAIT_MS = 30_000;

interface LifecycleHarness {
  readonly tempRoot: string;
  readonly homeDir: string;
  readonly sourceRunnerPath: string;
  readonly manager: DaemonManager;
  readonly runner: CommandRunner;
}

function buildStandInRunner(): string {
  // A minimal Node script that mimics the production runner enough to
  // verify the lifecycle: claim a lockfile, write one InvocationRecord
  // line to `<homeDir>/invocations.log`, exit 0. Embedded as a string
  // because the test owns the file's location and contents.
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.SCHEGENT_WAKEUP_HOME;
if (!home) process.exit(2);
const lockPath = path.join(home, 'wakeup.lock');
let lockAcquired = false;
let fd = null;
try {
  fd = fs.openSync(lockPath, 'wx');
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, startMs: Date.now() }));
  lockAcquired = true;
} catch (err) {
  // already locked — exit silently
  process.exit(0);
}
const rec = {
  timestamp: new Date().toISOString(),
  platform: 'darwin',
  pid: process.pid,
  lockAcquired,
  ephemeralCwd: path.join(require('node:os').tmpdir(), 'schegent-primer-session', 'integration-test'),
  cwdInsideWorkspace: false,
  envScrubbed: true,
  claudeExitCode: 0,
  durationMs: 0
};
const logPath = path.join(home, 'invocations.log');
fs.appendFileSync(logPath, JSON.stringify(rec) + '\\n', 'utf8');
try { fs.closeSync(fd); } catch {}
try { fs.unlinkSync(lockPath); } catch {}
process.exit(0);
`;
}

function setupHarness(): LifecycleHarness {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'schegent-wakeup-lifecycle-'));
  const homeDir = path.join(tempRoot, 'wakeup-home');
  const sourceRunnerPath = path.join(tempRoot, 'runner.js');
  writeFileSync(sourceRunnerPath, buildStandInRunner(), 'utf8');

  const runner = defaultCommandRunner();
  const manager = new DaemonManager({
    installerFactory: (_p: WakeUpPlatform, c: CommandRunner): DaemonInstaller =>
      new LaunchdInstaller(c, undefined, QUALIFICATION_LABEL),
    commandRunner: runner,
    platform: () => 'darwin'
  });

  return { tempRoot, homeDir, sourceRunnerPath, manager, runner };
}

async function isLaunchdRegistered(runner: CommandRunner): Promise<boolean> {
  const r = await runner.run('launchctl', ['list', QUALIFICATION_LABEL]);
  return r.exitCode === 0;
}

async function waitForFirstFire(homeDir: string, deadlineMs: number): Promise<readonly InvocationRecord[]> {
  const log = new InvocationLog(homeDir);
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const recs = await log.read(10);
    if (recs.length > 0) return recs;
    await sleep(2_000);
  }
  return [];
}

async function waitForUnregistered(runner: CommandRunner, deadlineMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (!(await isLaunchdRegistered(runner))) return true;
    await sleep(2_000);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function forceCleanup(_tempRoot: string, runner: CommandRunner): Promise<void> {
  // Best-effort: unload the launchd entry by label (idempotent) and
  // unlink the plist on disk. If we never installed, both no-op.
  const plist = path.join(homedir(), 'Library', 'LaunchAgents', `${QUALIFICATION_LABEL}.plist`);
  await runner.run('launchctl', ['unload', plist]);
  try {
    await fs.unlink(plist);
  } catch {
    /* noop */
  }
}

describe.skipIf(!SHOULD_RUN)('Feature 014 — wake-up lifecycle (darwin)', () => {
  let harness: LifecycleHarness;

  beforeAll(() => {
    if (!SHOULD_RUN) return;
    harness = setupHarness();
  });

  afterAll(async () => {
    if (!harness) return;
    try {
      await forceCleanup(harness.tempRoot, harness.runner);
    } catch {
      /* swallow cleanup errors — test was already torn down */
    }
    try {
      rmSync(harness.tempRoot, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  it('enable → Save → launchctl lists the entry → fires within ~75s → disable → unregistered within 30s', async () => {
    // 1. Enable + Save with a 1-minute periodic interval.
    await harness.manager.apply({
      settings: {
        enabled: true,
        schedulerType: 'periodic',
        chronologicalTime: '04:00',
        periodicInterval: 'Every 1m',
        model: 'runner-default'
      },
      workspaceRoots: [],
      sourceRunnerPath: harness.sourceRunnerPath,
      homeDir: harness.homeDir
    });

    // 2. Assert launchctl now lists the label.
    expect(await isLaunchdRegistered(harness.runner)).toBe(true);

    // 3. Wait for the first fire — the bundled stand-in runner appends
    //    one InvocationRecord with lockAcquired=true and
    //    cwdInsideWorkspace=false (the InvocationLog reader rejects
    //    records that don't carry the literal `false`).
    const records = await waitForFirstFire(harness.homeDir, FIRE_WAIT_MS);
    expect(records.length).toBeGreaterThan(0);
    const rec = records[records.length - 1];
    expect(rec.lockAcquired).toBe(true);
    expect(rec.cwdInsideWorkspace).toBe(false);

    // 4. Disable + Save → DaemonManager.apply() routes to uninstall.
    await harness.manager.apply({
      settings: {
        enabled: false,
        schedulerType: 'periodic',
        chronologicalTime: '04:00',
        periodicInterval: 'Every 1m',
        model: 'runner-default'
      },
      workspaceRoots: [],
      sourceRunnerPath: harness.sourceRunnerPath,
      homeDir: harness.homeDir
    });

    // 5. Within 30 s, the launchd listing must be empty (SC-005).
    expect(await waitForUnregistered(harness.runner, UNINSTALL_WAIT_MS)).toBe(true);
  }, FIRE_WAIT_MS + UNINSTALL_WAIT_MS + 30_000);
});

// Make the file a discoverable suite even when skipped, so the runner
// emits a clear "skipped" status rather than "no tests found".
describe.skipIf(SHOULD_RUN)('Feature 014 — wake-up lifecycle (skipped)', () => {
  it.skip(`requires darwin + SCHEGENT_INTEGRATION_TESTS=1 (current: platform=${process.platform}, opted-in=${OPTED_IN})`, () => {
    expect(true).toBe(true);
  });
});

// Reference the imported helpers to keep tsc happy when the suite is
// fully skipped (otherwise unused-import drops these in strict mode).
void (existsSync as unknown);
void (spawn as unknown);
