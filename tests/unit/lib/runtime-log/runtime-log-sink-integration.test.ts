// Feature 019 — Integration test (T019): exercises the
// sink + accessor + SanitizedLogger triad against an OS-level temp
// directory using REAL `fs/promises.appendFile` + `mkdir`.
//
// Verifies:
//   - On-disk wire format matches data-model.md:
//     `[<ISO-8601>] <LEVEL> <message>` (and `... <context-json>` when
//     a context object is supplied to `logger.debug(msg, ctx)`).
//   - Auto-creation of a missing parent directory on first emit.
//   - Severity filter short-circuits BELOW the configured level.
//   - Config changes between emits (via the accessor) take effect
//     on the next emit — no extension reload, no sink replacement.
//   - Secret patterns in the message body are redacted by
//     `SanitizedLogger` BEFORE the sink sees the line.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { RuntimeLogSink } from '../../../../src/lib/runtime-log/runtime-log-sink';
import {
  createRuntimeLogAccessor,
  __resetRuntimeLogAccessorWarnCache
} from '../../../../src/lib/runtime-log/runtime-log-settings';
import type { GeneralSettingsConfig } from '../../../../src/config/general-settings';
import type { RuntimeLogLevel } from '../../../../src/lib/runtime-log/runtime-log-level';

/** Minimal mock of WorkspaceConfiguration shaped for our reads. */
function makeConfig(state: {
  level?: unknown;
  pathValue?: unknown;
}): GeneralSettingsConfig {
  return {
    get: <T>(key: string, defaultValue?: T): T => {
      if (key === 'logging.runtimeLogLevel') {
        return (state.level !== undefined
          ? state.level
          : defaultValue) as T;
      }
      if (key === 'logging.runtimeLogFilePath') {
        return (state.pathValue !== undefined
          ? state.pathValue
          : defaultValue) as T;
      }
      return defaultValue as T;
    },
    update: async () => undefined
  } as unknown as GeneralSettingsConfig;
}

interface Harness {
  logger: SanitizedLogger;
  sink: RuntimeLogSink;
}

function wire(state: {
  level?: unknown;
  pathValue?: unknown;
}): Harness {
  const logger = new SanitizedLogger();
  const accessor = createRuntimeLogAccessor(
    () => makeConfig(state),
    () => null,
    logger
  );
  const sink = new RuntimeLogSink({ accessor, fallbackLogger: logger });
  logger.addSink(sink);
  return { logger, sink };
}

let tmpRoot: string;

async function readLines(filePath: string): Promise<string[]> {
  const buf = await fs.readFile(filePath, 'utf8');
  return buf.split('\n').filter((s) => s.length > 0);
}

beforeEach(async () => {
  __resetRuntimeLogAccessorWarnCache();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-rtlog-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('RuntimeLogSink integration — first emit creates parent dir', () => {
  it('writes <ISO> <LEVEL> <message> on first emit with auto-mkdir', async () => {
    const target = path.join(tmpRoot, '.schegent', 'syslog');
    const { logger, sink } = wire({ level: 'INFO', pathValue: target });

    logger.info('hello from integration test');
    await sink.flushPendingWrites();

    const lines = await readLines(target);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] INFO hello from integration test$/
    );
  });

  it('appends a serialized context JSON when logger.debug(msg, ctx) is used', async () => {
    const target = path.join(tmpRoot, '.schegent', 'syslog');
    const { logger, sink } = wire({ level: 'DEBUG', pathValue: target });

    logger.debug('phase-runner.lock-acquired', {
      pipelineId: 'default',
      phaseId: 'plan',
      waitMs: 0
    });
    await sink.flushPendingWrites();

    const lines = await readLines(target);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/DEBUG phase-runner\.lock-acquired /);
    expect(lines[0]).toContain('"pipelineId":"default"');
    expect(lines[0]).toContain('"phaseId":"plan"');
    expect(lines[0]).toContain('"waitMs":0');
  });
});

describe('RuntimeLogSink integration — severity filter applied per emit', () => {
  it('drops DEBUG when configured filter is INFO; admits INFO/WARN/ERROR', async () => {
    const target = path.join(tmpRoot, '.schegent', 'syslog');
    const { logger, sink } = wire({ level: 'INFO', pathValue: target });

    logger.debug('noisy debug line');
    logger.info('admitted info');
    logger.warn('admitted warn');
    logger.error('admitted error');
    await sink.flushPendingWrites();

    const lines = await readLines(target);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/INFO admitted info$/);
    expect(lines[1]).toMatch(/WARN admitted warn$/);
    expect(lines[2]).toMatch(/ERROR admitted error$/);
  });

  it('reflects a mid-session level change without recreating the sink', async () => {
    const target = path.join(tmpRoot, '.schegent', 'syslog');
    const state: { level: RuntimeLogLevel; pathValue: string } = {
      level: 'WARN',
      pathValue: target
    };
    const logger = new SanitizedLogger();
    const accessor = createRuntimeLogAccessor(
      () => makeConfig(state),
      () => null,
      logger
    );
    const sink = new RuntimeLogSink({ accessor, fallbackLogger: logger });
    logger.addSink(sink);

    logger.info('first - should be filtered (WARN floor)');
    await sink.flushPendingWrites();
    const fileExists = await fs
      .access(target)
      .then(() => true)
      .catch(() => false);
    expect(fileExists).toBe(false);

    state.level = 'INFO';
    logger.info('second - now admitted');
    await sink.flushPendingWrites();
    const lines = await readLines(target);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/INFO second - now admitted$/);
  });
});

describe('RuntimeLogSink integration — SanitizedLogger redaction on the way in', () => {
  it('redacted secrets do not reach the on-disk file', async () => {
    const target = path.join(tmpRoot, '.schegent', 'syslog');
    const { logger, sink } = wire({ level: 'INFO', pathValue: target });

    logger.info('Authorization: Bearer abc123xyz456DEADBEEF7890 trailing text');
    await sink.flushPendingWrites();

    const lines = await readLines(target);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('abc123xyz456DEADBEEF7890');
    expect(lines[0]).toContain('[REDACTED]');
  });
});

describe('RuntimeLogSink integration — accessor returns null', () => {
  it('drops the emit silently when no workspace + relative path', async () => {
    const { logger, sink } = wire({ level: 'INFO', pathValue: 'relative/path' });

    logger.info('should be dropped');
    await sink.flushPendingWrites();

    // No file should have been created under tmpRoot.
    const entries = await fs.readdir(tmpRoot);
    expect(entries).toHaveLength(0);
  });
});
