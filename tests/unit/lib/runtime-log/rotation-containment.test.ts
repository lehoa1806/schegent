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
// mutating branches:
//
//   - append   → `openWithinRootByPath`, which walks the components and holds
//                the descriptor it proved (FR-R3-080, T1064)
//   - rename   → `resolveContainedLink`, both ends (the leaf is not followed)
//   - unlink   → `resolveContainedLink`, on the generation being dropped
//
// The last two are checked fresh on every rollover, which is deliberate and is
// what the mid-flight cases below pin: a rotation must not inherit an admission
// the append made earlier.
//
// FR-R3-080 (T1064) REPLACED THIS FILE'S FILESYSTEM. It used to run against an
// in-memory map with an injected `realpath`, and that arrangement could not
// prove the property it was named for: the fake `realpath` WAS the answer, so
// the test asserted that the sink believed a stub. Every case below now runs on
// a real temp directory with real symlinks, which is what the append path's
// component walk actually reads. The properties asserted are unchanged.

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import * as nodeFs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { SanitizedLogger } from '../../../../src/lib/logger';
import { RuntimeLogSink } from '../../../../src/lib/runtime-log/runtime-log-sink';
import type { RuntimeLogAccessor } from '../../../../src/lib/runtime-log/runtime-log-settings';
import type { RuntimeLogLevel } from '../../../../src/lib/runtime-log/runtime-log-level';

let allowedRoot: string;
let escapedRoot: string;
let targetPath: string;

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

/**
 * The real filesystem, behind spies.
 *
 * The spies exist so "was this syscall reached at all" stays assertable — the
 * refusal cases are about a syscall NOT happening against a location the host
 * was never allowed to look at. They delegate; they decide nothing.
 */
function spiedFs() {
  const rename: Mock<(from: string, to: string) => Promise<void>> = vi.fn(
    async (from, to) => nodeFs.rename(from, to)
  );
  const unlink: Mock<(target: string) => Promise<void>> = vi.fn(async (target) =>
    nodeFs.unlink(target)
  );
  const stat: Mock<(target: string) => Promise<{ size: number }>> = vi.fn(async (target) => {
    const s = await nodeFs.stat(target);
    return { size: s.size };
  });
  const readdir: Mock<(target: string) => Promise<readonly string[]>> = vi.fn(async (target) =>
    nodeFs.readdir(target)
  );
  const appendFile: Mock<(target: string, data: string) => Promise<void>> = vi.fn(
    async (target, data) => nodeFs.appendFile(target, data)
  );
  const writeFile: Mock<(target: string, data: string) => Promise<void>> = vi.fn(
    async (target, data) => nodeFs.writeFile(target, data)
  );
  const mkdir = vi.fn<(target: string, opts: { recursive: true }) => Promise<unknown>>(
    async (target) => nodeFs.mkdir(target, { recursive: true })
  );
  return { rename, unlink, stat, readdir, appendFile, writeFile, mkdir };
}

async function read(target: string): Promise<string | undefined> {
  try {
    return await nodeFs.readFile(target, 'utf8');
  } catch {
    return undefined;
  }
}

beforeEach(async () => {
  const base = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'runtime-log-contain-'));
  allowedRoot = path.join(base, 'allowed');
  escapedRoot = path.join(base, 'elsewhere');
  await nodeFs.mkdir(path.join(allowedRoot, 'logs'), { recursive: true });
  await nodeFs.mkdir(escapedRoot, { recursive: true });
  targetPath = path.join(allowedRoot, 'logs', 'runtime.log');
});

describe('FR-R3-005 — runtime-log mutations are contained at the point of effect', () => {
  it('refuses the append when the configured path resolves outside every allowed root', async () => {
    // The setting is lexically inside the allowed root, so `runtime-log-path.ts`
    // admits it. The symlink is what the walk sees and the lexical check could
    // not: `logs` is a link to a directory outside the root.
    await nodeFs.rm(path.join(allowedRoot, 'logs'), { recursive: true, force: true });
    await nodeFs.symlink(escapedRoot, path.join(allowedRoot, 'logs'), 'dir');
    const fs = spiedFs();
    const sink = new RuntimeLogSink({
      accessor: accessorFor({ level: 'INFO', path: targetPath, maxBytes: 65_536, maxGenerations: 3 }),
      fallbackLogger: fallbackLogger(),
      containmentRoots: () => [allowedRoot],
      ...fs
    });

    sink.appendLine(line('one'));
    await sink.flushPendingWrites();

    expect(fs.appendFile).not.toHaveBeenCalled();
    // Nothing was written through the link.
    expect(await nodeFs.readdir(escapedRoot)).toEqual([]);
    expect(sink.isSuppressed(targetPath, 'not-contained')).toBe(true);
  });

  it('treats a resolution failure as a refusal, never a fall-through to the lexical check', async () => {
    // A component that is a FILE, not a directory. The walk cannot resolve past
    // it, and the answer is a refusal rather than an admission by default.
    await nodeFs.rm(path.join(allowedRoot, 'logs'), { recursive: true, force: true });
    await nodeFs.writeFile(path.join(allowedRoot, 'logs'), 'not a directory');
    const fs = spiedFs();
    const sink = new RuntimeLogSink({
      accessor: accessorFor({ level: 'INFO', path: targetPath, maxBytes: 65_536, maxGenerations: 3 }),
      fallbackLogger: fallbackLogger(),
      containmentRoots: () => [allowedRoot],
      ...fs
    });

    sink.appendLine(line('one'));
    await sink.flushPendingWrites();

    expect(fs.appendFile).not.toHaveBeenCalled();
    expect(sink.isSuppressed(targetPath)).toBe(true);
  });

  it('records the refusal without naming the path it refused', async () => {
    await nodeFs.rm(path.join(allowedRoot, 'logs'), { recursive: true, force: true });
    await nodeFs.symlink(escapedRoot, path.join(allowedRoot, 'logs'), 'dir');
    const fallback = fallbackLogger();
    const sink = new RuntimeLogSink({
      accessor: accessorFor({ level: 'INFO', path: targetPath, maxBytes: 65_536, maxGenerations: 3 }),
      fallbackLogger: fallback,
      containmentRoots: () => [allowedRoot],
      ...spiedFs()
    });

    sink.appendLine(line('one'));
    await sink.flushPendingWrites();

    const warned = fallback.warnings.join('\n');
    expect(warned).toContain('runtime-log-sink');
    // The refusal is reported; the path it refused is not, because a warn line
    // is not a place to publish where an operator's logs live.
    expect(warned).not.toContain(targetPath);
    expect(warned).not.toContain(escapedRoot);
  });

  it('unlocks the refusal when the operator corrects the setting', async () => {
    // `clearSuppression` is the post-save callback, and it has to drop both the
    // suppression AND the held descriptor — otherwise a corrected setting stays
    // refused for the life of the window.
    await nodeFs.rm(path.join(allowedRoot, 'logs'), { recursive: true, force: true });
    await nodeFs.symlink(escapedRoot, path.join(allowedRoot, 'logs'), 'dir');
    const sink = new RuntimeLogSink({
      accessor: accessorFor({ level: 'INFO', path: targetPath, maxBytes: 65_536, maxGenerations: 3 }),
      fallbackLogger: fallbackLogger(),
      containmentRoots: () => [allowedRoot],
      ...spiedFs()
    });

    sink.appendLine(line('one'));
    await sink.flushPendingWrites();
    expect(await read(targetPath)).toBeUndefined();

    // The operator repoints the link at a real directory inside the root.
    await nodeFs.unlink(path.join(allowedRoot, 'logs'));
    await nodeFs.mkdir(path.join(allowedRoot, 'logs'), { recursive: true });
    sink.clearSuppression(targetPath);
    sink.appendLine(line('two'));
    await sink.flushPendingWrites();

    expect(await read(targetPath)).toContain('two');
  });

  it('refuses the rotation rename on a fresh check rather than inheriting the append admission', async () => {
    // The append proves the target. The roots then narrow — a workspace folder
    // changing under a host that outlives it — and the rollover must not ride
    // on the earlier admission. `containmentRoots` is read fresh on every
    // rotation check for exactly this.
    let roots: readonly string[] = [allowedRoot];
    const fs = spiedFs();
    const sink = new RuntimeLogSink({
      accessor: accessorFor({ level: 'INFO', path: targetPath, maxBytes: 64, maxGenerations: 2 }),
      fallbackLogger: fallbackLogger(),
      containmentRoots: () => roots,
      ...fs
    });

    sink.appendLine(line('first'));
    await sink.flushPendingWrites();
    expect(await read(targetPath)).toContain('first');

    // An existing directory, so the refusal is "not contained" rather than
    // "could not resolve" — the narrowing under test is a change of scope, not
    // a broken root.
    roots = [escapedRoot];
    sink.appendLine(line('second'));
    await sink.flushPendingWrites();

    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalled();
    // The triggering line is dropped rather than written to an unproven path.
    expect(await read(targetPath)).not.toContain('second');
    expect(sink.isSuppressed(targetPath, 'not-contained')).toBe(true);
  });

  it('refuses the stale-generation unlink on its own check, after the rename has landed', async () => {
    // The narrowing is triggered by the rename itself, so the ordering under
    // test is the real one: each destructive step proves its own path, and a
    // proof taken for the step before it does not carry.
    let roots: readonly string[] = [allowedRoot];
    const fs = spiedFs();
    fs.rename.mockImplementation(async (from: string, to: string) => {
      await nodeFs.rename(from, to);
      roots = [escapedRoot];
    });
    const sink = new RuntimeLogSink({
      accessor: accessorFor({ level: 'INFO', path: targetPath, maxBytes: 64, maxGenerations: 1 }),
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

  it('leaves the no-symlink path exactly as it was, with the walk the only addition', async () => {
    // The scenario's last clause. Nothing is a link, so append, rollover,
    // generation shift and the stale sweep all behave as they did before the
    // guard existed.
    const fs = spiedFs();
    const sink = new RuntimeLogSink({
      accessor: accessorFor({ level: 'INFO', path: targetPath, maxBytes: 64, maxGenerations: 1 }),
      fallbackLogger: fallbackLogger(),
      containmentRoots: () => [allowedRoot],
      ...fs
    });
    // A stale generation beyond the cap, for the sweep to find.
    await nodeFs.writeFile(`${targetPath}.7`, 'old');

    const first = line('first');
    const second = line('second');
    sink.appendLine(first);
    await sink.flushPendingWrites();
    sink.appendLine(second);
    await sink.flushPendingWrites();

    expect(await read(`${targetPath}.1`)).toBe(`${first}\n`);
    expect(await read(targetPath)).toBe(`${second}\n`);
    // The sweep drops `.7`, which is beyond the cap of one generation.
    expect(fs.unlink).toHaveBeenCalledWith(`${targetPath}.7`);
    expect(sink.isSuppressed(targetPath)).toBe(false);
  });

  it('mutates nothing at all when no roots are allowed', async () => {
    // An empty list is the fail-closed reading of "nothing is allowed", and it
    // is deliberately different from omitting `containmentRoots`, which means
    // "no containment layer" and is what the sink's older unit tests rely on.
    const fs = spiedFs();
    const sink = new RuntimeLogSink({
      accessor: accessorFor({ level: 'INFO', path: targetPath, maxBytes: 65_536, maxGenerations: 3 }),
      fallbackLogger: fallbackLogger(),
      containmentRoots: () => [],
      ...fs
    });

    sink.appendLine(line('one'));
    await sink.flushPendingWrites();

    expect(fs.appendFile).not.toHaveBeenCalled();
    expect(await read(targetPath)).toBeUndefined();
    expect(sink.isSuppressed(targetPath, 'not-contained')).toBe(true);
  });
});
