// Feature 019 — Unit tests for RuntimeLogSink. The sink owns:
//   - severity filter (short-circuit BEFORE any formatting work)
//   - per-path suppression set (one WARN per cause, no retries until
//     `clearSuppression` is called)
//   - ENOENT-on-parent retry-once-via-mkdir handled in T018.
//
// `fs.appendFile` and `fs.mkdir` are injected via the deps option so
// the tests run synchronously against in-memory spies.

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { RuntimeLogSink } from '../../../../src/lib/runtime-log/runtime-log-sink';
import type {
  RuntimeLogAccessor,
  RuntimeLogSettings
} from '../../../../src/lib/runtime-log/runtime-log-settings';

const TARGET_PATH = '/tmp/runtime-log-sink.test.log';

// Feature 056 Track 9 — fill rotation defaults on partial test settings.
// Existing tests construct only `{ level, path }`; the rotation policy
// is irrelevant to severity / suppression behavior so we plug in the
// real production defaults (5 MiB / 3 generations). The rotation test
// file builds its own settings explicitly.
type PartialRuntimeLogSettings = Pick<RuntimeLogSettings, 'level' | 'path'> &
  Partial<Pick<RuntimeLogSettings, 'maxBytes' | 'maxGenerations'>>;

function withRotationDefaults(
  partial: PartialRuntimeLogSettings
): RuntimeLogSettings {
  return {
    level: partial.level,
    path: partial.path,
    maxBytes: partial.maxBytes ?? 5 * 1024 * 1024,
    maxGenerations: partial.maxGenerations ?? 3
  };
}

function makeAccessor(
  settings: PartialRuntimeLogSettings | null
): RuntimeLogAccessor {
  return {
    read: () => (settings === null ? null : withRotationDefaults(settings))
  };
}

// Feature 056 Track 9 — every sink under test gets a deterministic stat
// mock so the lazy `bytesOnDisk` seed reads 0 instead of hitting the
// real /tmp/runtime-log-sink.test.log (which may exist from prior
// runs).
function makeStat() {
  return vi.fn().mockResolvedValue({ size: 0 });
}

function makeFallback(): SanitizedLogger & { warnings: string[] } {
  const warnings: string[] = [];
  const logger = new SanitizedLogger() as SanitizedLogger & { warnings: string[] };
  // Spy on warn so we can assert one-shot suppression warnings.
  const origWarn = logger.warn.bind(logger);
  logger.warn = (msg: string) => {
    warnings.push(msg);
    origWarn(msg);
  };
  logger.warnings = warnings;
  return logger;
}

/** Helper: synthesise a SanitizedLogger-formatted line for a given level. */
function formatLine(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', msg: string): string {
  return `[2026-05-13T00:00:00.000Z] ${level} ${msg}`;
}

/** Drain microtasks so the async write inside `appendLine` settles. */
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

describe('RuntimeLogSink — happy path', () => {
  it('appends a single line on success', async () => {
    const appendFile = vi.fn().mockResolvedValue(undefined);
    const sink = new RuntimeLogSink({
      accessor: makeAccessor({ level: 'INFO', path: TARGET_PATH }),
      fallbackLogger: makeFallback(),
      appendFile,
      stat: makeStat()
    });
    sink.appendLine(formatLine('INFO', 'hello'));
    await flush();
    expect(appendFile).toHaveBeenCalledTimes(1);
    expect(appendFile).toHaveBeenCalledWith(
      TARGET_PATH,
      expect.stringMatching(/INFO hello\n$/)
    );
  });
});

describe('RuntimeLogSink — severity filter (short-circuit)', () => {
  it('drops a DEBUG record when configured filter is INFO — no appendFile call', async () => {
    const appendFile = vi.fn().mockResolvedValue(undefined);
    const sink = new RuntimeLogSink({
      accessor: makeAccessor({ level: 'INFO', path: TARGET_PATH }),
      fallbackLogger: makeFallback(),
      appendFile,
      stat: makeStat()
    });
    sink.appendLine(formatLine('DEBUG', 'noisy'));
    await flush();
    expect(appendFile).not.toHaveBeenCalled();
  });

  it('admits an INFO record when configured filter is INFO', async () => {
    const appendFile = vi.fn().mockResolvedValue(undefined);
    const sink = new RuntimeLogSink({
      accessor: makeAccessor({ level: 'INFO', path: TARGET_PATH }),
      fallbackLogger: makeFallback(),
      appendFile,
      stat: makeStat()
    });
    sink.appendLine(formatLine('INFO', 'admitted'));
    await flush();
    expect(appendFile).toHaveBeenCalledTimes(1);
  });

  it('drops INFO when configured filter is WARN', async () => {
    const appendFile = vi.fn().mockResolvedValue(undefined);
    const sink = new RuntimeLogSink({
      accessor: makeAccessor({ level: 'WARN', path: TARGET_PATH }),
      fallbackLogger: makeFallback(),
      appendFile,
      stat: makeStat()
    });
    sink.appendLine(formatLine('INFO', 'below-floor'));
    await flush();
    expect(appendFile).not.toHaveBeenCalled();
  });

  it('drops every level except ERROR when configured filter is ERROR', async () => {
    const appendFile = vi.fn().mockResolvedValue(undefined);
    const sink = new RuntimeLogSink({
      accessor: makeAccessor({ level: 'ERROR', path: TARGET_PATH }),
      fallbackLogger: makeFallback(),
      appendFile,
      stat: makeStat()
    });
    sink.appendLine(formatLine('DEBUG', 'd'));
    sink.appendLine(formatLine('INFO', 'i'));
    sink.appendLine(formatLine('WARN', 'w'));
    sink.appendLine(formatLine('ERROR', 'e'));
    await flush();
    expect(appendFile).toHaveBeenCalledTimes(1);
    expect(appendFile).toHaveBeenCalledWith(
      TARGET_PATH,
      expect.stringContaining('ERROR e')
    );
  });
});

describe('RuntimeLogSink — accessor returns null (path unresolvable)', () => {
  it('drops emit without calling appendFile', async () => {
    const appendFile = vi.fn();
    const sink = new RuntimeLogSink({
      accessor: makeAccessor(null),
      fallbackLogger: makeFallback(),
      appendFile,
      stat: makeStat()
    });
    sink.appendLine(formatLine('ERROR', 'unresolvable'));
    await flush();
    expect(appendFile).not.toHaveBeenCalled();
  });
});

describe('RuntimeLogSink — suppression on failure', () => {
  let appendFile: Mock<[string, string], Promise<void>>;
  let mkdir: Mock<[string, { recursive: true }], Promise<unknown>>;
  let fallback: SanitizedLogger & { warnings: string[] };
  let sink: RuntimeLogSink;

  beforeEach(() => {
    appendFile = vi.fn().mockResolvedValue(undefined);
    mkdir = vi.fn().mockResolvedValue(undefined);
    fallback = makeFallback();
    sink = new RuntimeLogSink({
      accessor: makeAccessor({ level: 'INFO', path: TARGET_PATH }),
      fallbackLogger: fallback,
      appendFile,
      mkdir,
      stat: makeStat()
    });
  });

  it('records suppression on EACCES; subsequent emits do not call appendFile', async () => {
    const error = Object.assign(new Error('perm denied'), { code: 'EACCES' });
    appendFile.mockRejectedValue(error);
    sink.appendLine(formatLine('INFO', 'first'));
    await flush();
    expect(appendFile).toHaveBeenCalledTimes(1);
    expect(sink.isSuppressed(TARGET_PATH, 'EACCES')).toBe(true);

    // Subsequent emit must NOT call appendFile again — suppression in
    // force until clearSuppression is invoked.
    sink.appendLine(formatLine('INFO', 'second'));
    sink.appendLine(formatLine('WARN', 'third'));
    await flush();
    expect(appendFile).toHaveBeenCalledTimes(1);

    // Exactly one WARN per (path, cause) pair.
    expect(fallback.warnings.filter((w) => w.includes('EACCES'))).toHaveLength(1);
  });

  it('records suppression on EROFS', async () => {
    const error = Object.assign(new Error('read-only fs'), { code: 'EROFS' });
    appendFile.mockRejectedValue(error);
    sink.appendLine(formatLine('INFO', 'first'));
    await flush();
    expect(sink.isSuppressed(TARGET_PATH, 'EROFS')).toBe(true);
  });

  it('does not throw when appendFile fails', async () => {
    const error = Object.assign(new Error('boom'), { code: 'EIO' });
    appendFile.mockRejectedValue(error);
    expect(() => sink.appendLine(formatLine('INFO', 'first'))).not.toThrow();
    await flush();
    expect(sink.isSuppressed(TARGET_PATH)).toBe(true);
  });

  it('clearSuppression unlocks the next emit', async () => {
    const error = Object.assign(new Error('perm denied'), { code: 'EACCES' });
    appendFile.mockRejectedValueOnce(error);
    sink.appendLine(formatLine('INFO', 'first'));
    await flush();
    expect(sink.isSuppressed(TARGET_PATH)).toBe(true);

    appendFile.mockResolvedValueOnce(undefined);
    sink.clearSuppression(TARGET_PATH);
    sink.appendLine(formatLine('INFO', 'retry'));
    await flush();
    expect(appendFile).toHaveBeenCalledTimes(2);
    expect(sink.isSuppressed(TARGET_PATH)).toBe(false);
  });

  it('clearSuppression on a non-suppressed path is a no-op', () => {
    expect(() => sink.clearSuppression('/never/touched')).not.toThrow();
    expect(() => sink.clearSuppression(null)).not.toThrow();
    expect(() => sink.clearSuppression(undefined)).not.toThrow();
    expect(() => sink.clearSuppression('')).not.toThrow();
  });
});

describe('RuntimeLogSink — line without a level token', () => {
  it('passes through unfiltered (no level → no filter check)', async () => {
    const appendFile = vi.fn().mockResolvedValue(undefined);
    const sink = new RuntimeLogSink({
      accessor: makeAccessor({ level: 'ERROR', path: TARGET_PATH }),
      fallbackLogger: makeFallback(),
      appendFile,
      stat: makeStat()
    });
    // Synthesised line that is not in the SanitizedLogger shape.
    sink.appendLine('plain text from a different sink');
    await flush();
    expect(appendFile).toHaveBeenCalledTimes(1);
  });
});
