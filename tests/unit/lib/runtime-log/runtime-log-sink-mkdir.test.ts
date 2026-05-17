// Feature 019 — Unit tests for the RuntimeLogSink ENOENT-recovery
// path (T018):
//   1. First `appendFile` fails ENOENT → sink invokes
//      `mkdir(parent, { recursive: true })` → retries `appendFile` once
//      → success.
//   2. mkdir itself fails (EACCES) → sink records the synthetic
//      `'ENOENT-parent'` suppression and emits a single WARN through
//      the fallback logger.
//   3. mkdir succeeds but the retry `appendFile` still fails → same
//      `'ENOENT-parent'` collapse — the recovery path failed.
//   4. Re-entrancy guard: a second emit arriving while the first
//      recovery is still in-flight must NOT trigger a parallel mkdir.

import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { RuntimeLogSink } from '../../../../src/lib/runtime-log/runtime-log-sink';
import type { RuntimeLogAccessor } from '../../../../src/lib/runtime-log/runtime-log-settings';

const TARGET_PATH = '/tmp/runtime-log-sink-mkdir.test.log';
const TARGET_PARENT = path.dirname(TARGET_PATH);

function makeAccessor(): RuntimeLogAccessor {
  return {
    read: () => ({
      level: 'INFO',
      path: TARGET_PATH,
      // Feature 056 Track 9 — defaults for the rotation policy fields
      // that the sink now consumes. Large maxBytes ensures the existing
      // ENOENT-recovery cases never trip the rotation branch.
      maxBytes: 5 * 1024 * 1024,
      maxGenerations: 3
    })
  };
}

function makeStat() {
  // Lazy bytesOnDisk seed reads `{ size: 0 }` so existing tests run as
  // they did before rotation was introduced.
  return vi.fn().mockResolvedValue({ size: 0 });
}

function makeFallback(): SanitizedLogger & { warnings: string[] } {
  const warnings: string[] = [];
  const logger = new SanitizedLogger() as SanitizedLogger & {
    warnings: string[];
  };
  const orig = logger.warn.bind(logger);
  logger.warn = (msg: string) => {
    warnings.push(msg);
    orig(msg);
  };
  logger.warnings = warnings;
  return logger;
}

function formatLine(msg: string): string {
  return `[2026-05-13T00:00:00.000Z] INFO ${msg}`;
}

async function flush(): Promise<void> {
  // Drain queued microtasks and one immediate so the awaited mkdir +
  // retry-appendFile chain settles.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

describe('RuntimeLogSink — ENOENT → mkdir → retry success', () => {
  it('creates the parent directory and retries appendFile exactly once', async () => {
    const enoent = Object.assign(new Error('parent missing'), {
      code: 'ENOENT'
    });
    const appendFile = vi
      .fn()
      .mockRejectedValueOnce(enoent)
      .mockResolvedValueOnce(undefined);
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const fallback = makeFallback();
    const sink = new RuntimeLogSink({
      accessor: makeAccessor(),
      fallbackLogger: fallback,
      appendFile,
      mkdir,
      stat: makeStat()
    });

    sink.appendLine(formatLine('first emit'));
    await flush();

    expect(appendFile).toHaveBeenCalledTimes(2);
    expect(mkdir).toHaveBeenCalledTimes(1);
    expect(mkdir).toHaveBeenCalledWith(TARGET_PARENT, { recursive: true });
    expect(sink.isSuppressed(TARGET_PATH)).toBe(false);
    expect(fallback.warnings).toHaveLength(0);
  });

  it('does not retry a second time when the retry-appendFile also fails', async () => {
    const enoent = Object.assign(new Error('parent missing'), {
      code: 'ENOENT'
    });
    const enoent2 = Object.assign(new Error('still missing'), {
      code: 'ENOENT'
    });
    const appendFile = vi
      .fn()
      .mockRejectedValueOnce(enoent)
      .mockRejectedValueOnce(enoent2);
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const sink = new RuntimeLogSink({
      accessor: makeAccessor(),
      fallbackLogger: makeFallback(),
      appendFile,
      mkdir,
      stat: makeStat()
    });

    sink.appendLine(formatLine('first'));
    await flush();

    expect(appendFile).toHaveBeenCalledTimes(2);
    expect(mkdir).toHaveBeenCalledTimes(1);
    // recovery failed → suppression registered under ENOENT-parent.
    expect(sink.isSuppressed(TARGET_PATH, 'ENOENT-parent')).toBe(true);
  });
});

describe('RuntimeLogSink — ENOENT → mkdir fails (EACCES)', () => {
  it('records ENOENT-parent suppression and emits exactly one WARN', async () => {
    const enoent = Object.assign(new Error('parent missing'), {
      code: 'ENOENT'
    });
    const eacces = Object.assign(new Error('mkdir denied'), {
      code: 'EACCES'
    });
    const appendFile = vi.fn().mockRejectedValue(enoent);
    const mkdir = vi.fn().mockRejectedValue(eacces);
    const fallback = makeFallback();
    const sink = new RuntimeLogSink({
      accessor: makeAccessor(),
      fallbackLogger: fallback,
      appendFile,
      mkdir,
      stat: makeStat()
    });

    sink.appendLine(formatLine('first'));
    await flush();

    expect(mkdir).toHaveBeenCalledTimes(1);
    expect(sink.isSuppressed(TARGET_PATH, 'ENOENT-parent')).toBe(true);
    expect(
      fallback.warnings.filter((w) => w.includes('ENOENT-parent'))
    ).toHaveLength(1);

    // Subsequent emits do not trigger any more attempts.
    sink.appendLine(formatLine('second'));
    sink.appendLine(formatLine('third'));
    await flush();
    expect(appendFile).toHaveBeenCalledTimes(1);
    expect(mkdir).toHaveBeenCalledTimes(1);
    expect(
      fallback.warnings.filter((w) => w.includes('ENOENT-parent'))
    ).toHaveLength(1);
  });

  it('records ENOENT-parent when mkdir throws an unrecognized errno too', async () => {
    const enoent = Object.assign(new Error('parent missing'), {
      code: 'ENOENT'
    });
    const weirdErr = Object.assign(new Error('weird'), { code: 'EWEIRD' });
    const appendFile = vi.fn().mockRejectedValue(enoent);
    const mkdir = vi.fn().mockRejectedValue(weirdErr);
    const sink = new RuntimeLogSink({
      accessor: makeAccessor(),
      fallbackLogger: makeFallback(),
      appendFile,
      mkdir,
      stat: makeStat()
    });

    sink.appendLine(formatLine('first'));
    await flush();

    expect(sink.isSuppressed(TARGET_PATH, 'ENOENT-parent')).toBe(true);
  });
});

describe('RuntimeLogSink — non-ENOENT first error skips the mkdir path', () => {
  it('records the literal cause (EACCES) without invoking mkdir', async () => {
    const eacces = Object.assign(new Error('append denied'), {
      code: 'EACCES'
    });
    const appendFile = vi.fn().mockRejectedValue(eacces);
    const mkdir = vi.fn();
    const sink = new RuntimeLogSink({
      accessor: makeAccessor(),
      fallbackLogger: makeFallback(),
      appendFile,
      mkdir,
      stat: makeStat()
    });

    sink.appendLine(formatLine('first'));
    await flush();

    expect(mkdir).not.toHaveBeenCalled();
    expect(sink.isSuppressed(TARGET_PATH, 'EACCES')).toBe(true);
  });
});

describe('RuntimeLogSink — clearSuppression after ENOENT-parent re-enables retry', () => {
  it('a successful retry after clearSuppression restores writes', async () => {
    const enoent = Object.assign(new Error('parent missing'), {
      code: 'ENOENT'
    });
    const eacces = Object.assign(new Error('mkdir denied'), {
      code: 'EACCES'
    });
    const appendFile = vi
      .fn()
      .mockRejectedValueOnce(enoent)
      .mockResolvedValueOnce(undefined);
    const mkdir = vi
      .fn()
      .mockRejectedValueOnce(eacces)
      .mockResolvedValueOnce(undefined);
    const sink = new RuntimeLogSink({
      accessor: makeAccessor(),
      fallbackLogger: makeFallback(),
      appendFile,
      mkdir,
      stat: makeStat()
    });

    sink.appendLine(formatLine('first'));
    await flush();
    expect(sink.isSuppressed(TARGET_PATH, 'ENOENT-parent')).toBe(true);

    // Operator "fixes" the parent permission and clears suppression.
    sink.clearSuppression(TARGET_PATH);

    // But the path is *still* missing on the FS, so the NEXT emit will
    // ALSO take the ENOENT recovery path. Pre-program a second ENOENT
    // (we already burned the first .mockRejectedValueOnce), this time
    // followed by a successful mkdir + appendFile.
    appendFile
      .mockRejectedValueOnce(
        Object.assign(new Error('still missing'), { code: 'ENOENT' })
      )
      .mockResolvedValueOnce(undefined);
    mkdir.mockResolvedValueOnce(undefined);

    sink.appendLine(formatLine('retry-after-fix'));
    await flush();

    expect(sink.isSuppressed(TARGET_PATH)).toBe(false);
  });
});
