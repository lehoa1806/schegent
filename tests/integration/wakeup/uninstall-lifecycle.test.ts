// Feature 014 T048 — wake-up uninstall-lifecycle integration test.
//
// What this test asserts (US4 acceptance scenarios 1-2, SC-005):
//   1. After a Save with enabled=true, the OS scheduler lists the entry.
//   2. After a Save with enabled=false, the listing is empty within
//      30 s — the SC-005 budget for "Disable + Save removes the
//      OS-native scheduled entry".
//
// Why this is a separate file from tests/integration/wakeup/lifecycle.test.ts:
//   The fire-and-cleanup test (T037) is the comprehensive end-to-end
//   exercise — install → wait 75 s for a fire → log inspection →
//   uninstall. This uninstall-focused sibling skips the fire-wait,
//   which means CI can keep the US4 contract under 60 s wall-clock
//   even when contributor patches change US4 behavior in isolation.
//   When both tests run, the redundancy of the disable-within-30s
//   assertion is a feature, not duplication — it pins the contract
//   in two independent harnesses.
//
// Opt-in gating matches the sibling lifecycle test
// (SCHEGENT_INTEGRATION_TESTS=1 + darwin). Casual `npm run test` skips
// this file with a clear notice. CI pipelines must opt in.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  DaemonManager,
  defaultCommandRunner,
  type DaemonInstaller,
  type CommandRunner
} from '../../../src/wakeup/daemon-manager';
import { LaunchdInstaller, LAUNCHD_LABEL } from '../../../src/wakeup/platforms/launchd';
import type { WakeUpPlatform } from '../../../src/wakeup/platform-detect';

const OPTED_IN = process.env.SCHEGENT_INTEGRATION_TESTS === '1';
const IS_DARWIN = process.platform === 'darwin';
const SHOULD_RUN = IS_DARWIN && OPTED_IN;

const UNINSTALL_WAIT_MS = 30_000;

interface UninstallHarness {
  readonly tempRoot: string;
  readonly homeDir: string;
  readonly sourceRunnerPath: string;
  readonly manager: DaemonManager;
  readonly runner: CommandRunner;
}

function setupHarness(): UninstallHarness {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'schegent-wakeup-uninstall-'));
  const homeDir = path.join(tempRoot, 'wakeup-home');
  const sourceRunnerPath = path.join(tempRoot, 'runner.js');
  // Minimal placeholder — the runner is never spawned in this test
  // because we never wait for the schedule to fire.
  writeFileSync(sourceRunnerPath, '#!/usr/bin/env node\nprocess.exit(0);\n', 'utf8');

  const runner = defaultCommandRunner();
  const manager = new DaemonManager({
    installerFactory: (_p: WakeUpPlatform, c: CommandRunner): DaemonInstaller =>
      new LaunchdInstaller(c),
    commandRunner: runner,
    platform: () => 'darwin'
  });
  return { tempRoot, homeDir, sourceRunnerPath, manager, runner };
}

async function isLaunchdRegistered(runner: CommandRunner): Promise<boolean> {
  const r = await runner.run('launchctl', ['list', LAUNCHD_LABEL]);
  return r.exitCode === 0;
}

async function waitForUnregistered(runner: CommandRunner, deadlineMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (!(await isLaunchdRegistered(runner))) return true;
    await new Promise((res) => setTimeout(res, 1_000));
  }
  return false;
}

async function forceCleanup(runner: CommandRunner): Promise<void> {
  const plist = path.join(
    process.env.HOME ?? '',
    'Library',
    'LaunchAgents',
    `${LAUNCHD_LABEL}.plist`
  );
  await runner.run('launchctl', ['unload', plist]);
  try {
    await fs.unlink(plist);
  } catch {
    /* noop */
  }
}

describe.skipIf(!SHOULD_RUN)('Feature 014 T048 — uninstall lifecycle (darwin)', () => {
  let harness: UninstallHarness;

  beforeAll(() => {
    if (!SHOULD_RUN) return;
    harness = setupHarness();
  });

  afterAll(async () => {
    if (!harness) return;
    try {
      await forceCleanup(harness.runner);
    } catch {
      /* swallow — test is tearing down anyway */
    }
    try {
      rmSync(harness.tempRoot, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  it('enable + Save → listed → disable + Save → unlisted within 30 s (SC-005)', async () => {
    // 1. Install — chronological 04:00 (a time we will never reach in
    //    the 30s test window, so the schedule cannot fire and skew the
    //    cleanup measurement).
    await harness.manager.apply({
      settings: {
        enabled: true,
        schedulerType: 'chronological',
        chronologicalTime: '04:00',
        periodicInterval: 'Every 1h',
        model: 'runner-default'
      },
      workspaceRoots: [],
      sourceRunnerPath: harness.sourceRunnerPath,
      homeDir: harness.homeDir
    });

    // 2. Confirm the listing.
    expect(await isLaunchdRegistered(harness.runner)).toBe(true);

    // 3. Disable + Save → DaemonManager routes to uninstall().
    const start = Date.now();
    await harness.manager.apply({
      settings: {
        enabled: false,
        schedulerType: 'chronological',
        chronologicalTime: '04:00',
        periodicInterval: 'Every 1h',
        model: 'runner-default'
      },
      workspaceRoots: [],
      sourceRunnerPath: harness.sourceRunnerPath,
      homeDir: harness.homeDir
    });

    // 4. Within 30 s the listing must be empty.
    expect(await waitForUnregistered(harness.runner, UNINSTALL_WAIT_MS)).toBe(true);
    expect(Date.now() - start).toBeLessThan(UNINSTALL_WAIT_MS);
  }, UNINSTALL_WAIT_MS + 15_000);

  it('uninstall is idempotent — re-uninstall after gone is a no-op success', async () => {
    // First uninstall on a fresh state (nothing was installed in this
    // test — confirmed by the cleanup at the end of the previous it).
    await expect(harness.manager.uninstall()).resolves.toBeUndefined();
    // Second uninstall on the already-gone state — also no-op success.
    await expect(harness.manager.uninstall()).resolves.toBeUndefined();
  });
});

// Make the file a discoverable suite even when skipped, so the runner
// emits a clear "skipped" status rather than "no tests found".
describe.skipIf(SHOULD_RUN)('Feature 014 T048 — uninstall lifecycle (skipped)', () => {
  it.skip(`requires darwin + SCHEGENT_INTEGRATION_TESTS=1 (current: platform=${process.platform}, opted-in=${OPTED_IN})`, () => {
    expect(true).toBe(true);
  });
});

// Reference imports to keep tsc happy when skipped.
void (existsSync as unknown);
