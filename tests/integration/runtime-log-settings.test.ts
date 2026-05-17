// Feature 019 T022 — Integration test: writeGeneralSettings + the
// `onRuntimeLogSettingChanged` hook + RuntimeLogSink end-to-end.
//
// Verifies:
//   1. Saving a new absolute path → next emit lands at the new path,
//      and the old default location is NOT touched.
//   2. Saving back to the empty-string default → emit lands at
//      <workspaceRoot>/.schegent/syslog.
//   3. Saving the SAME path after a permission failure cleared
//      suppression → the sink retries the next emit instead of
//      short-circuiting.
//
// The test mocks `vscode.WorkspaceConfiguration` in-memory so it can
// run under vitest (no VS Code host) but uses REAL fs/promises for the
// sink's appendFile + mkdir.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SanitizedLogger } from '../../src/lib/logger';
import { RuntimeLogSink } from '../../src/lib/runtime-log/runtime-log-sink';
import {
  createRuntimeLogAccessor,
  __resetRuntimeLogAccessorWarnCache
} from '../../src/lib/runtime-log/runtime-log-settings';
import {
  writeGeneralSettings,
  type GeneralSettingsConfig
} from '../../src/config/general-settings';

/**
 * In-memory mock of WorkspaceConfiguration that supports the subset of
 * the API we exercise: `get`, `inspect`, `update`. Mirrors the test
 * harness pattern in `tests/unit/config/general-settings.test.ts`.
 */
function makeMockConfig() {
  const workspace: Record<string, unknown> = {};
  return {
    get<T>(key: string, defaultValue?: T): T {
      return (workspace[key] !== undefined ? workspace[key] : defaultValue) as T;
    },
    inspect(key: string) {
      return {
        key,
        defaultValue: undefined,
        globalValue: undefined,
        workspaceValue: workspace[key],
        workspaceFolderValue: undefined
      };
    },
    async update(key: string, value: unknown, _target: number) {
      if (value === undefined) {
        delete workspace[key];
      } else {
        workspace[key] = value;
      }
    },
    _workspace: workspace
  };
}

interface Harness {
  config: ReturnType<typeof makeMockConfig>;
  logger: SanitizedLogger;
  sink: RuntimeLogSink;
  workspaceRoot: string;
  save(updates: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }>;
  hookFired: () => number;
}

function buildHarness(workspaceRoot: string): Harness {
  const mockConfig = makeMockConfig();
  const logger = new SanitizedLogger();
  const accessor = createRuntimeLogAccessor(
    () => mockConfig as unknown as GeneralSettingsConfig,
    () => workspaceRoot,
    logger
  );
  const sink = new RuntimeLogSink({ accessor, fallbackLogger: logger });
  logger.addSink(sink);

  let hookCount = 0;
  const save = async (updates: Record<string, unknown>) => {
    const previousPath = accessor.read()?.path ?? null;
    return writeGeneralSettings(
      mockConfig as unknown as GeneralSettingsConfig,
      updates,
      {
        onRuntimeLogSettingChanged: () => {
          hookCount++;
          sink.clearSuppression(previousPath);
          const nextPath = accessor.read()?.path ?? null;
          if (nextPath && nextPath !== previousPath) {
            sink.clearSuppression(nextPath);
          }
        }
      }
    );
  };

  return { config: mockConfig, logger, sink, workspaceRoot, save, hookFired: () => hookCount };
}

let tmpRoot: string;
let workspaceRoot: string;

beforeEach(async () => {
  __resetRuntimeLogAccessorWarnCache();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-rtlog-int-'));
  workspaceRoot = path.join(tmpRoot, 'workspace');
  await fs.mkdir(workspaceRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('Feature 019 T022 — save runtimeLogFilePath retargets the sink', () => {
  it('saving an absolute path routes the next emit to that path; default is untouched', async () => {
    const harness = buildHarness(workspaceRoot);
    const customPath = path.join(tmpRoot, 'custom', 'syslog');
    const result = await harness.save({
      'logging.runtimeLogFilePath': customPath
    });
    expect(result.ok).toBe(true);
    expect(harness.hookFired()).toBe(1);

    harness.logger.info('written to custom path');
    await harness.sink.flushPendingWrites();

    const customContents = await fs.readFile(customPath, 'utf8');
    expect(customContents).toMatch(/INFO written to custom path\n$/);

    const defaultPath = path.join(workspaceRoot, '.schegent', 'syslog');
    const defaultExists = await fs.access(defaultPath).then(() => true).catch(() => false);
    expect(defaultExists).toBe(false);
  });

  it('saving back to empty string restores the default workspace path', async () => {
    const harness = buildHarness(workspaceRoot);
    const customPath = path.join(tmpRoot, 'custom', 'syslog');
    await harness.save({ 'logging.runtimeLogFilePath': customPath });

    harness.logger.info('first under custom');
    await harness.sink.flushPendingWrites();

    // Reset to default.
    const reset = await harness.save({ 'logging.runtimeLogFilePath': '' });
    expect(reset.ok).toBe(true);
    expect(harness.hookFired()).toBe(2);

    harness.logger.info('second under default');
    await harness.sink.flushPendingWrites();

    const defaultPath = path.join(workspaceRoot, '.schegent', 'syslog');
    const contents = await fs.readFile(defaultPath, 'utf8');
    expect(contents).toMatch(/INFO second under default\n$/);
  });
});

describe('Feature 019 T022 — suppression cleared on save after a permission failure', () => {
  it('saving the same path after a write failure clears suppression and retries', async () => {
    const harness = buildHarness(workspaceRoot);

    // Use a target path whose parent directory cannot be created by
    // the sink — simulate by pre-creating the parent as a FILE (so
    // mkdir fails with EEXIST/ENOTDIR depending on platform, and the
    // ENOENT-recovery path collapses to 'ENOENT-parent').
    const parentAsFile = path.join(tmpRoot, 'blocked-parent');
    await fs.writeFile(parentAsFile, '', { mode: 0o644 });
    const blockedTarget = path.join(parentAsFile, 'syslog');

    await harness.save({ 'logging.runtimeLogFilePath': blockedTarget });

    harness.logger.info('first emit — should fail');
    await harness.sink.flushPendingWrites();
    expect(harness.sink.isSuppressed(blockedTarget)).toBe(true);

    // Operator "fixes" the parent: remove the blocking file so a real
    // directory can be created on retry.
    await fs.rm(parentAsFile);

    // Save the SAME path again (no-op for VS Code, but the hook fires).
    const second = await harness.save({
      'logging.runtimeLogFilePath': blockedTarget
    });
    expect(second.ok).toBe(true);

    // Suppression for that path should have been cleared.
    expect(harness.sink.isSuppressed(blockedTarget)).toBe(false);

    harness.logger.info('retry after fix');
    await harness.sink.flushPendingWrites();

    const contents = await fs.readFile(blockedTarget, 'utf8');
    expect(contents).toMatch(/INFO retry after fix\n$/);
  });
});

describe('Feature 019 T022 — saving runtimeLogLevel takes effect on next emit', () => {
  it('switching from INFO to WARN drops the next INFO emit', async () => {
    const harness = buildHarness(workspaceRoot);
    const target = path.join(tmpRoot, 'log', 'syslog');
    await harness.save({ 'logging.runtimeLogFilePath': target });

    // INFO is the default → INFO emit lands.
    harness.logger.info('admitted at INFO floor');
    await harness.sink.flushPendingWrites();
    let contents = await fs.readFile(target, 'utf8');
    expect(contents).toMatch(/INFO admitted at INFO floor\n$/);

    // Switch to WARN → next INFO is dropped, but WARN admits.
    const raise = await harness.save({ 'logging.runtimeLogLevel': 'WARN' });
    expect(raise.ok).toBe(true);

    harness.logger.info('should be dropped — WARN floor');
    harness.logger.warn('admitted at WARN');
    await harness.sink.flushPendingWrites();
    contents = await fs.readFile(target, 'utf8');
    expect(contents).not.toContain('should be dropped');
    expect(contents).toMatch(/WARN admitted at WARN\n$/);
  });
});
