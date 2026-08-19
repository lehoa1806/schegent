// Feature FR-R3-005 (T334) — the runtime-log sink is contained at the point of
// effect, not at admission.
//
// `runtime-log-path.ts` already refuses a configured path that is lexically
// outside the three allowed roots (feature 098, SEC-03). That check is
// necessary and it is not sufficient: `path.relative` counts `..` hops, and a
// symlink is a hop it cannot count. A repository can ship a
// `.vscode/settings.json` naming `schegent.logging.runtimeLogFilePath` inside
// the workspace, and a symlink can put the file it names anywhere the operator's
// UID can write — which is where the sink then appends, renames and unlinks.
//
// So the guard belongs where the syscalls are. These tests drive the three
// mutating branches through the sink's injected seams:
//
//   - append   → `resolveContainedForWrite`, target form (the leaf is followed)
//   - rename   → `resolveContainedLink`, both ends (the leaf is not followed)
//   - unlink   → `resolveContainedLink`, on the generation being dropped
//
// The last two are checked fresh on every rollover while the append verdict is
// cached, which is deliberate and is what the mid-flight cases below pin: a
// rotation must not inherit an admission the append made earlier.

import { describe, it, expect, vi, type Mock } from 'vitest';

import { SanitizedLogger } from '../../../../src/lib/logger';
import { RuntimeLogSink } from '../../../../src/lib/runtime-log/runtime-log-sink';
import type { RuntimeLogAccessor } from '../../../../src/lib/runtime-log/runtime-log-settings';
import type { RuntimeLogLevel } from '../../../../src/lib/runtime-log/runtime-log-level';

/** The one allowed root for these tests. Nothing else may be mutated. */
const ALLOWED_ROOT = '/allowed';
/** Lexically inside `ALLOWED_ROOT` — admission passes on every one of these. */
const TARGET_PATH = '/allowed/logs/runtime.log';
/** Where a planted symlink sends it. */
const ESCAPED_PATH = '/elsewhere/runtime.log';

interface Settings {
  level: RuntimeLogLevel;
  path: string;
  maxBytes: number;
  maxGenerations: number;
}

function accessorFor(settings: Settings): RuntimeLogAccessor {
  return { read: () => ({ ...settings }) };
}

function fallbackLogger(): SanitizedLogger & { warnings: string[] } {
  const warnings: string[] = [];
  const logger = new SanitizedLogger() as SanitizedLogger & { warnings: string[] };
  const original = logger.warn.bind(logger);
  logger.warn = (message: string) => {
    warnings.push(message);
    original(message);
  };
  logger.warnings = warnings;
  return logger;
}

function line(message: string): string {
  return `[2026-08-18T00:00:00.000Z] INFO ${message}`;
}

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code }) as NodeJS.ErrnoException;
}

/**
 * An in-memory filesystem plus the `realpath` seam the oracle consults.
 *
 * `resolve` maps a path to what it resolves to; anything unmapped resolves to
 * itself, which is the no-symlinks case the "normal path is unchanged"
 * scenario asks for. A mapped value of an errno string throws instead, so the
 * resolution-failure branch is reachable without a real EACCES.
 */
function makeFs(resolve: Record<string, string> = {}) {
  const files = new Map<string, string>();
  const appendFile: Mock<(target: string, data: string) => Promise<void>> = vi.fn(
    async (target, data) => {
      files.set(target, (files.get(target) ?? '') + data);
    }
  );
  const writeFile: Mock<(target: string, data: string) => Promise<void>> = vi.fn(
    async (target, data) => {
      files.set(target, data);
    }
  );
  const rename: Mock<(from: string, to: string) => Promise<void>> = vi.fn(async (from, to) => {
    if (!files.has(from)) throw errnoError('ENOENT');
    files.set(to, files.get(from)!);
    files.delete(from);
  });
  const unlink: Mock<(target: string) => Promise<void>> = vi.fn(async (target) => {
    if (!files.has(target)) throw errnoError('ENOENT');
    files.delete(target);
  });
  const stat: Mock<(target: string) => Promise<{ size: number }>> = vi.fn(async (target) => {
    const content = files.get(target);
    if (content === undefined) throw errnoError('ENOENT');
    return { size: Buffer.byteLength(content, 'utf8') };
  });
  const mkdir = vi.fn<(target: string, opts: { recursive: true }) => Promise<unknown>>(
    async () => undefined as unknown
  );
  const readdir = vi.fn<(target: string) => Promise<readonly string[]>>(async () => []);
  const realpath: Mock<(target: string) => Promise<string>> = vi.fn(async (target) => {
    const mapped = resolve[target];
    if (mapped === undefined) return target;
    if (/^E[A-Z]+$/.test(mapped)) throw errnoError(mapped);
    return mapped;
  });
  return { files, appendFile, writeFile, rename, unlink, stat, mkdir, readdir, realpath };
}

describe('FR-R3-005 — runtime-log mutations are contained at the point of effect', () => {
  it('refuses the append when the configured path resolves outside every allowed root', async () => {
    // The setting is lexically inside the workspace, so `runtime-log-path.ts`
    // admits it. The symlink is what the oracle sees and the lexical check
    // could not.
    const fs = makeFs({ [TARGET_PATH]: ESCAPED_PATH });
    const fallback = fallbackLogger();
    const sink = new RuntimeLogSink({
      accessor: accessorFor({
        level: 'INFO',
        path: TARGET_PATH,
        maxBytes: 65_536,
        maxGenerations: 3
      }),
      fallbackLogger: fallback,
      containmentRoots: () => [ALLOWED_ROOT],
      ...fs
    });

    sink.appendLine(line('one'));
    await sink.flushPendingWrites();

    expect(fs.appendFile).not.toHaveBeenCalled();
    // Before the stat, not after: a refused path costs one resolution and no
    // syscall against a location the host was never allowed to look at.
    expect(fs.stat).not.toHaveBeenCalled();
    expect(sink.isSuppressed(TARGET_PATH, 'not-contained')).toBe(true);
  });

  it('treats a resolution failure as a refusal, never a fall-through to the lexical check', async () => {
    const fs = makeFs({ [TARGET_PATH]: 'EACCES' });
    const fallback = fallbackLogger();
    const sink = new RuntimeLogSink({
      accessor: accessorFor({
        level: 'INFO',
        path: TARGET_PATH,
        maxBytes: 65_536,
        maxGenerations: 3
      }),
      fallbackLogger: fallback,
      containmentRoots: () => [ALLOWED_ROOT],
      ...fs
    });

    sink.appendLine(line('one'));
    await sink.flushPendingWrites();

    expect(fs.appendFile).not.toHaveBeenCalled();
    // `resolve-failed`, not `not-contained`: the host could not prove where the
    // path leads, which is a different finding from proving it leads outside.
    expect(sink.isSuppressed(TARGET_PATH, 'resolve-failed')).toBe(true);
    expect(sink.isSuppressed(TARGET_PATH, 'not-contained')).toBe(false);
  });

  it('records the refusal without naming the path it refused', async () => {
    const fs = makeFs({ [TARGET_PATH]: ESCAPED_PATH });
    const fallback = fallbackLogger();
    const sink = new RuntimeLogSink({
      accessor: accessorFor({
        level: 'INFO',
        path: TARGET_PATH,
        maxBytes: 65_536,
        maxGenerations: 3
      }),
      fallbackLogger: fallback,
      containmentRoots: () => [ALLOWED_ROOT],
      ...fs
    });

    sink.appendLine(line('one'));
    sink.appendLine(line('two'));
    await sink.flushPendingWrites();

    // One WARN, deduped by the suppression map, and it says the operation was
    // refused rather than that it failed — the operator is looking for a
    // misconfigured path, not a disk problem.
    const refusals = fallback.warnings.filter((warning) => warning.includes('not-contained'));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('refused to write outside the allowed roots');
    expect(refusals[0]).not.toContain(ESCAPED_PATH);
    expect(refusals[0]).not.toContain(TARGET_PATH);
  });

  it('unlocks the refusal when the operator corrects the setting', async () => {
    // The append verdict is cached for the hot path. `clearSuppression` is the
    // post-save callback, and it has to drop the cache too — otherwise a
    // corrected setting stays refused for the life of the window.
    const resolution: Record<string, string> = { [TARGET_PATH]: ESCAPED_PATH };
    const fs = makeFs(resolution);
    const sink = new RuntimeLogSink({
      accessor: accessorFor({
        level: 'INFO',
        path: TARGET_PATH,
        maxBytes: 65_536,
        maxGenerations: 3
      }),
      fallbackLogger: fallbackLogger(),
      containmentRoots: () => [ALLOWED_ROOT],
      ...fs
    });

    sink.appendLine(line('one'));
    await sink.flushPendingWrites();
    expect(fs.appendFile).not.toHaveBeenCalled();

    delete resolution[TARGET_PATH];
    sink.clearSuppression(TARGET_PATH);
    sink.appendLine(line('two'));
    await sink.flushPendingWrites();

    expect(fs.appendFile).toHaveBeenCalledTimes(1);
  });

  it('refuses the rotation rename on a fresh check rather than inheriting the append admission', async () => {
    // The append proves the target and caches the verdict. The roots then
    // narrow — a workspace folder changing under a host that outlives it — and
    // the rollover must not ride on the earlier admission. `containmentRoots`
    // is read fresh on every rotation check for exactly this.
    let roots: readonly string[] = [ALLOWED_ROOT];
    const fs = makeFs();
    const fallback = fallbackLogger();
    const sink = new RuntimeLogSink({
      accessor: accessorFor({
        level: 'INFO',
        path: TARGET_PATH,
        maxBytes: 64,
        maxGenerations: 2
      }),
      fallbackLogger: fallback,
      containmentRoots: () => roots,
      ...fs
    });

    sink.appendLine(line('first'));
    await sink.flushPendingWrites();
    expect(fs.appendFile).toHaveBeenCalledTimes(1);

    roots = ['/somewhere-else'];
    sink.appendLine(line('second'));
    await sink.flushPendingWrites();

    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalled();
    // The triggering line is dropped rather than written to an unproven path.
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(sink.isSuppressed(TARGET_PATH, 'not-contained')).toBe(true);
  });

  it('refuses the stale-generation unlink on its own check, after the rename has landed', async () => {
    // The narrowing is triggered by the rename itself, so the ordering under
    // test is the real one: each destructive step proves its own path, and a
    // proof taken for the step before it does not carry.
    let roots: readonly string[] = [ALLOWED_ROOT];
    const fs = makeFs();
    fs.rename.mockImplementation(async (from: string, to: string) => {
      if (!fs.files.has(from)) throw errnoError('ENOENT');
      fs.files.set(to, fs.files.get(from)!);
      fs.files.delete(from);
      roots = ['/somewhere-else'];
    });
    const sink = new RuntimeLogSink({
      accessor: accessorFor({
        level: 'INFO',
        path: TARGET_PATH,
        maxBytes: 64,
        maxGenerations: 1
      }),
      fallbackLogger: fallbackLogger(),
      containmentRoots: () => roots,
      ...fs
    });

    sink.appendLine(line('first'));
    await sink.flushPendingWrites();
    sink.appendLine(line('second'));
    await sink.flushPendingWrites();

    expect(fs.rename).toHaveBeenCalledTimes(1);
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('leaves the no-symlink path exactly as it was, with resolution the only addition', async () => {
    // The scenario's last clause. Every path resolves to itself, so append,
    // rollover, generation shift and the stale sweep all behave as they did
    // before the guard existed.
    const fs = makeFs();
    fs.readdir.mockImplementation(async () => ['runtime.log', 'runtime.log.1', 'runtime.log.7']);
    const sink = new RuntimeLogSink({
      accessor: accessorFor({
        level: 'INFO',
        path: TARGET_PATH,
        maxBytes: 64,
        maxGenerations: 1
      }),
      fallbackLogger: fallbackLogger(),
      containmentRoots: () => [ALLOWED_ROOT],
      ...fs
    });

    const first = line('first');
    const second = line('second');
    sink.appendLine(first);
    await sink.flushPendingWrites();
    sink.appendLine(second);
    await sink.flushPendingWrites();

    expect(fs.files.get(`${TARGET_PATH}.1`)).toBe(`${first}\n`);
    expect(fs.files.get(TARGET_PATH)).toBe(`${second}\n`);
    // The sweep drops `.7`, which is beyond the cap of one generation.
    expect(fs.unlink).toHaveBeenCalledWith(`${TARGET_PATH}.7`);
    expect(sink.isSuppressed(TARGET_PATH)).toBe(false);
    expect(fs.realpath).toHaveBeenCalled();
  });

  it('mutates nothing at all when no roots are allowed', async () => {
    // An empty list is the fail-closed reading of "nothing is allowed", and it
    // is deliberately different from omitting `containmentRoots`, which means
    // "no containment layer" and is what the sink's older unit tests rely on.
    const fs = makeFs();
    const sink = new RuntimeLogSink({
      accessor: accessorFor({
        level: 'INFO',
        path: TARGET_PATH,
        maxBytes: 65_536,
        maxGenerations: 3
      }),
      fallbackLogger: fallbackLogger(),
      containmentRoots: () => [],
      ...fs
    });

    sink.appendLine(line('one'));
    await sink.flushPendingWrites();

    expect(fs.appendFile).not.toHaveBeenCalled();
    expect(sink.isSuppressed(TARGET_PATH, 'not-contained')).toBe(true);
  });
});
