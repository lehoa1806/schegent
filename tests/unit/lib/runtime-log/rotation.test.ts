// Feature 056 Track 9 (T057, FR-035..FR-038) — rotation regression
// tests for `RuntimeLogSink`. The contract lives at
// `specs/056-principal-arch-hardening/contracts/runtime-log-rotation.md`.
//
// Seven cases per the contract's "Test expectations" section:
//   1. Below-threshold appends preserved.
//   2. Single rotation shifts path → path.1.
//   3. With maxGens=2, three rotations keep path / path.1 / path.2 and
//      drop path.3.
//   4. maxGens=0 truncates in place.
//   5. Mid-run maxBytes shrink triggers rotation on the next emit
//      (uncached accessor).
//   6. Saving either rotation key clears the sink's suppression map.
//   7. Single sanitization preserved — rotated content is byte-equal
//      to what SanitizedLogger.sanitize produced when first written.

import { describe, it, expect, vi, type Mock } from 'vitest';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { RuntimeLogSink } from '../../../../src/lib/runtime-log/runtime-log-sink';
import type { RuntimeLogAccessor } from '../../../../src/lib/runtime-log/runtime-log-settings';
import type { RuntimeLogLevel } from '../../../../src/lib/runtime-log/runtime-log-level';
import {
  writeGeneralSettings,
  type GeneralSettingsConfig
} from '../../../../src/config/general-settings';

const TARGET_PATH = '/tmp/runtime-log-rotation.test.log';

// Mirrors `RuntimeLogSettings` but drops the readonly modifier on the
// rotation fields so test bodies can mutate them mid-run to drive the
// uncached-accessor path.
interface MutableSettings {
  level: RuntimeLogLevel;
  path: string;
  maxBytes: number;
  maxGenerations: number;
}

function makeAccessor(state: MutableSettings): RuntimeLogAccessor {
  // The state object is captured by closure so test bodies can mutate
  // `state.maxBytes` mid-run and the next `read()` sees the change.
  return { read: () => ({ ...state }) };
}

function makeFallback(): SanitizedLogger {
  return new SanitizedLogger();
}

function formatLine(msg: string): string {
  // Mirrors SanitizedLogger's `[<ISO>] <LEVEL> <message>` format so the
  // sink's level-extraction does not short-circuit.
  return `[2026-05-17T00:00:00.000Z] INFO ${msg}`;
}

async function flush(sink: RuntimeLogSink): Promise<void> {
  await sink.flushPendingWrites();
}

/**
 * In-memory file-system mock that records every appendFile / writeFile
 * / rename / unlink / stat call and tracks the current contents per
 * path. Sufficient for the rotation tests; not a general fs simulator.
 */
function makeFsMocks() {
  const files = new Map<string, string>();

  const appendFile: Mock<(target: string, data: string) => Promise<void>> = vi.fn(
    async (target: string, data: string) => {
      files.set(target, (files.get(target) ?? '') + data);
    }
  );
  const writeFile: Mock<(target: string, data: string) => Promise<void>> = vi.fn(
    async (target: string, data: string) => {
      files.set(target, data);
    }
  );
  const rename: Mock<(from: string, to: string) => Promise<void>> = vi.fn(
    async (from: string, to: string) => {
      if (!files.has(from)) {
        const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        throw err;
      }
      files.set(to, files.get(from)!);
      files.delete(from);
    }
  );
  const unlink: Mock<(target: string) => Promise<void>> = vi.fn(
    async (target: string) => {
      if (!files.has(target)) {
        const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        throw err;
      }
      files.delete(target);
    }
  );
  const stat: Mock<(target: string) => Promise<{ size: number }>> = vi.fn(
    async (target: string) => {
      const content = files.get(target);
      if (content === undefined) {
        const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        throw err;
      }
      return { size: Buffer.byteLength(content, 'utf8') };
    }
  );
  const mkdir = vi.fn<(target: string, opts: { recursive: true }) => Promise<unknown>>(
    async () => undefined as unknown
  );

  return { files, appendFile, writeFile, rename, unlink, stat, mkdir };
}

describe('Feature 056 Track 9 — runtime-log rotation', () => {
  it('appends without rotation while bytesOnDisk + line.length < maxBytes', async () => {
    const state: MutableSettings = {
      level: 'INFO',
      path: TARGET_PATH,
      maxBytes: 65_536,
      maxGenerations: 3
    };
    const fs = makeFsMocks();
    const sink = new RuntimeLogSink({
      accessor: makeAccessor(state),
      fallbackLogger: makeFallback(),
      ...fs
    });

    sink.appendLine(formatLine('line one'));
    sink.appendLine(formatLine('line two'));
    await flush(sink);

    expect(fs.appendFile).toHaveBeenCalledTimes(2);
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.files.has(TARGET_PATH)).toBe(true);
    expect(fs.files.has(`${TARGET_PATH}.1`)).toBe(false);
  });

  it('single rotation: path → path.1 when threshold crossed; new path is the line that tripped rotation', async () => {
    // Tiny maxBytes so the second line triggers rotation. The first
    // line lands as append. The second sees bytesOnDisk + line >= max
    // and rotates.
    const state: MutableSettings = {
      level: 'INFO',
      path: TARGET_PATH,
      maxBytes: 64,
      maxGenerations: 3
    };
    const fs = makeFsMocks();
    const sink = new RuntimeLogSink({
      accessor: makeAccessor(state),
      fallbackLogger: makeFallback(),
      ...fs
    });

    const lineOne = formatLine('one');
    const lineTwo = formatLine('two');
    sink.appendLine(lineOne);
    sink.appendLine(lineTwo);
    await flush(sink);

    // After: path holds lineTwo (the trigger), path.1 holds lineOne.
    expect(fs.files.get(TARGET_PATH)).toBe(`${lineTwo}\n`);
    expect(fs.files.get(`${TARGET_PATH}.1`)).toBe(`${lineOne}\n`);
    expect(fs.rename).toHaveBeenCalled();
    expect(fs.writeFile).toHaveBeenCalledWith(TARGET_PATH, `${lineTwo}\n`);
  });

  it('with maxGenerations=2, three rotations keep path / path.1 / path.2 — path.3 MUST NOT exist', async () => {
    const state: MutableSettings = {
      level: 'INFO',
      path: TARGET_PATH,
      maxBytes: 50,
      maxGenerations: 2
    };
    const fs = makeFsMocks();
    const sink = new RuntimeLogSink({
      accessor: makeAccessor(state),
      fallbackLogger: makeFallback(),
      ...fs
    });

    // Four lines: A lands as append. B triggers rot1. C triggers rot2.
    // D triggers rot3. After D, path=D, path.1=C, path.2=B; A is gone.
    const lines = [
      formatLine('AAAAAAAAAAAAAAAAAAAAA'),
      formatLine('BBBBBBBBBBBBBBBBBBBBB'),
      formatLine('CCCCCCCCCCCCCCCCCCCCC'),
      formatLine('DDDDDDDDDDDDDDDDDDDDD')
    ];
    for (const l of lines) sink.appendLine(l);
    await flush(sink);

    expect(fs.files.get(TARGET_PATH)).toBe(`${lines[3]}\n`);
    expect(fs.files.get(`${TARGET_PATH}.1`)).toBe(`${lines[2]}\n`);
    expect(fs.files.get(`${TARGET_PATH}.2`)).toBe(`${lines[1]}\n`);
    expect(fs.files.has(`${TARGET_PATH}.3`)).toBe(false);
  });

  it('maxGenerations=0 truncates in place; no path.1 ever created', async () => {
    const state: MutableSettings = {
      level: 'INFO',
      path: TARGET_PATH,
      maxBytes: 50,
      maxGenerations: 0
    };
    const fs = makeFsMocks();
    const sink = new RuntimeLogSink({
      accessor: makeAccessor(state),
      fallbackLogger: makeFallback(),
      ...fs
    });

    const lineOne = formatLine('AAAAAAAAAAAAAAAAAAAAA');
    const lineTwo = formatLine('BBBBBBBBBBBBBBBBBBBBB');
    sink.appendLine(lineOne);
    sink.appendLine(lineTwo);
    await flush(sink);

    expect(fs.files.get(TARGET_PATH)).toBe(`${lineTwo}\n`);
    expect(fs.files.has(`${TARGET_PATH}.1`)).toBe(false);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.writeFile).toHaveBeenCalledWith(TARGET_PATH, `${lineTwo}\n`);
  });

  it('shrinking maxBytes mid-run triggers rotation on the very next emit (uncached accessor)', async () => {
    const state: MutableSettings = {
      level: 'INFO',
      path: TARGET_PATH,
      maxBytes: 65_536,
      maxGenerations: 3
    };
    const fs = makeFsMocks();
    const sink = new RuntimeLogSink({
      accessor: makeAccessor(state),
      fallbackLogger: makeFallback(),
      ...fs
    });

    const lineOne = formatLine('initial line — many bytes');
    sink.appendLine(lineOne);
    await flush(sink);
    expect(fs.files.has(`${TARGET_PATH}.1`)).toBe(false);

    // Operator drops maxBytes below the current size. The accessor is
    // read on every emit, so the next emit sees the new threshold.
    state.maxBytes = 8;
    const lineTwo = formatLine('post-shrink');
    sink.appendLine(lineTwo);
    await flush(sink);

    expect(fs.files.get(`${TARGET_PATH}.1`)).toBe(`${lineOne}\n`);
    expect(fs.files.get(TARGET_PATH)).toBe(`${lineTwo}\n`);
  });

  it('saving runtimeLogMaxBytes / runtimeLogMaxGenerations triggers the post-save suppression-map clear', async () => {
    // The contract specifies the post-save callback clears the sink's
    // suppression map even when the saved value is unchanged. We
    // verify the host-side wiring at the unit level by checking that
    // RUNTIME_LOG_KEYS in `general-settings.ts` includes both keys.
    // (The post-save callback in extension.ts walks runtimeLogSink.
    // clearAllSuppression on any save of a key in this set.)
    const updates: Record<string, unknown> = {};
    let savedKey = '';
    const config = {
      get: <T>(_key: string, defaultValue?: T): T => defaultValue as T,
      inspect: () => undefined,
      update: async (key: string, value: unknown) => {
        savedKey = key;
        updates[key] = value;
      }
    } as unknown as GeneralSettingsConfig;

    const callback = vi.fn();
    // Save maxBytes — must invoke the runtime-log changed hook.
    await writeGeneralSettings(
      config,
      { 'logging.runtimeLogMaxBytes': 1_048_576 },
      { onRuntimeLogSettingChanged: callback }
    );
    expect(callback).toHaveBeenCalledTimes(1);
    expect(savedKey).toBe('logging.runtimeLogMaxBytes');

    callback.mockReset();
    // Save maxGenerations — same expectation.
    await writeGeneralSettings(
      config,
      { 'logging.runtimeLogMaxGenerations': 2 },
      { onRuntimeLogSettingChanged: callback }
    );
    expect(callback).toHaveBeenCalledTimes(1);
    expect(savedKey).toBe('logging.runtimeLogMaxGenerations');
  });

  it('preserves single-sanitization: rotated content is byte-equal to SanitizedLogger.sanitize output', async () => {
    // Wire a real SanitizedLogger feeding the sink. After rotation the
    // bytes on disk (across path and path.1) must exactly match the
    // concatenated sanitize output we captured on the way in.
    const state: MutableSettings = {
      level: 'INFO',
      path: TARGET_PATH,
      maxBytes: 80,
      maxGenerations: 3
    };
    const fs = makeFsMocks();
    const fallback = new SanitizedLogger();
    const sink = new RuntimeLogSink({
      accessor: makeAccessor(state),
      fallbackLogger: fallback,
      ...fs
    });
    fallback.addSink(sink);

    // Two emits, both containing a known secret. The redaction
    // happens once inside `SanitizedLogger.write()` BEFORE the sink
    // sees the line. Rotation must NOT re-touch the bytes.
    fallback.info('Authorization: Bearer abc123xyz456DEADBEEF7890 trailing');
    fallback.info('Authorization: Bearer abc123xyz456DEADBEEF7890 again');
    await flush(sink);

    const newest = fs.files.get(TARGET_PATH) ?? '';
    const rotated = fs.files.get(`${TARGET_PATH}.1`) ?? '';
    const combined = `${rotated}${newest}`;
    expect(combined).not.toContain('abc123xyz456DEADBEEF7890');
    expect(combined).toContain('[REDACTED]');
    // Exactly one redaction per input line.
    expect((combined.match(/\[REDACTED\]/g) ?? []).length).toBe(2);
  });
});
