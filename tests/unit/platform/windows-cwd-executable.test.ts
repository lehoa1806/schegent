import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveExecutableCommand, spawnCommandFor } from '../../../src/lib/spawn-command';

/**
 * Review gap GC-24 & FR-R7-18 (N10, T024) — real Windows `cwd`-executable decoy vs
 * strictly-absolute `PATH` resolution via `spawnCommandFor`.
 *
 * The resolution rules are asserted across synthetic Windows paths on every platform in
 * `tests/unit/lib/spawn-command.test.ts` (`WIN32_PROBE`). What only a real Windows host can
 * establish is that:
 *   1. Real filesystem probing via `defaultAccessProbe` resolves bare names (`tool`, `taskkill`,
 *      `powershell.exe`, and the real Node binary) strictly from absolute `PATH` directories while
 *      ignoring decoy `.exe` files planted in `process.cwd()` / child `cwd`; and
 *   2. Passing the `spawnCommandFor` result to `child_process.spawn(..., { cwd, shell: false })`
 *      on Windows launches the real `PATH` executable rather than a planted `cwd` decoy.
 *
 * Lives under `tests/unit/platform/` alongside `windows-sentinel.test.ts` and
 * `windows-reparse.test.ts` so `npm run test:host` executes it unedited on a Windows checkout and
 * skips it everywhere else with the current platform named in the skip title only when skipped.
 *
 * STATUS: unrun on this cycle's platform.
 * See `docs/operations/platform-observation-record.md`.
 */
const IS_WINDOWS = process.platform === 'win32';
// The skip reason is in the title only where the suite is skipped, matching `windows-reparse.test.ts`,
// `windows-sentinel.test.ts`, and `linux-case-sensitivity.test.ts` (GC-18 second pass).
const SUITE_TITLE = IS_WINDOWS
  ? 'Windows cwd-executable refusal and PATH resolution'
  : `Windows cwd-executable refusal and PATH resolution (skipped: this run is on ${process.platform}, not win32)`;

describe.skipIf(!IS_WINDOWS)(SUITE_TITLE, () => {
  it('resolves bare names strictly from absolute PATH entries and ignores decoy executables in cwd', async () => {
    const originalCwd = process.cwd();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'win-cwd-exec-'));
    const cwdDir = path.join(root, 'workspace');
    const pathBinDir = path.join(root, 'path-bin');
    try {
      await fs.mkdir(cwdDir);
      await fs.mkdir(pathBinDir);

      // Plant cwd decoys alongside legitimate PATH-side files.
      await fs.writeFile(path.join(cwdDir, 'tool.exe'), 'cwd-decoy', 'utf8');
      await fs.writeFile(path.join(cwdDir, 'onlyincwd.exe'), 'cwd-only-decoy', 'utf8');
      await fs.writeFile(path.join(cwdDir, 'taskkill.exe'), 'cwd-taskkill-decoy', 'utf8');
      await fs.writeFile(path.join(cwdDir, 'powershell.exe'), 'cwd-powershell-decoy', 'utf8');
      await fs.writeFile(path.join(pathBinDir, 'tool.exe'), 'path-target', 'utf8');
      await fs.writeFile(path.join(pathBinDir, 'shim.cmd'), '@echo off\r\n', 'utf8');

      process.chdir(cwdDir);

      const expectedTool = path.join(pathBinDir, 'tool.exe');
      expect(spawnCommandFor('tool', { Path: pathBinDir })).toBe(expectedTool);
      expect(spawnCommandFor('tool', { Path: `.;.\\;${pathBinDir}` })).toBe(expectedTool);

      // An executable present ONLY in cwd (or when PATH is empty / relative-only) must fail
      // closed with ENOENT instead of falling back to cwd.
      expect(resolveExecutableCommand('onlyincwd', { Path: pathBinDir })).toEqual({
        ok: false,
        cause: 'not-found'
      });
      expect(() => spawnCommandFor('onlyincwd', { Path: pathBinDir })).toThrow(
        expect.objectContaining({ code: 'ENOENT' })
      );
      expect(() => spawnCommandFor('tool', {})).toThrow(
        expect.objectContaining({ code: 'ENOENT' })
      );
      expect(() => spawnCommandFor('.\\tool.exe', { Path: pathBinDir })).toThrow(
        expect.objectContaining({ code: 'ENOENT' })
      );
      expect(() => spawnCommandFor(path.join(pathBinDir, 'shim.cmd'), { Path: pathBinDir })).toThrow(
        expect.objectContaining({ code: 'EACCES' })
      );

      // Host system utilities resolved through `spawnCommandFor` must land outside the decoy cwd.
      const resolvedTaskkill = spawnCommandFor('taskkill', process.env);
      expect(path.isAbsolute(resolvedTaskkill)).toBe(true);
      expect(resolvedTaskkill.toLowerCase()).not.toBe(
        path.join(cwdDir, 'taskkill.exe').toLowerCase()
      );
      const resolvedPowershell = spawnCommandFor('powershell.exe', process.env);
      expect(path.isAbsolute(resolvedPowershell)).toBe(true);
      expect(resolvedPowershell.toLowerCase()).not.toBe(
        path.join(cwdDir, 'powershell.exe').toLowerCase()
      );
    } finally {
      // Restore cwd BEFORE deleting the temp tree: Windows refuses to remove a live cwd.
      process.chdir(originalCwd);
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('spawns the PATH-resolved executable rather than a planted cwd decoy with the same basename', async () => {
    const originalCwd = process.cwd();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'win-cwd-spawn-'));
    const cwdDir = path.join(root, 'workspace');
    try {
      await fs.mkdir(cwdDir);

      // Plant an unexecutable decoy matching the running Node binary's basename in cwdDir.
      const nodeBase = path.basename(process.execPath);
      const nodeStem = nodeBase.replace(/\.exe$/i, '');
      const decoyPath = path.join(cwdDir, nodeBase);
      await fs.writeFile(decoyPath, 'not a valid PE executable', 'utf8');

      process.chdir(cwdDir);

      const resolvedNode = spawnCommandFor(nodeStem, {
        Path: `.;${path.dirname(process.execPath)}`
      });
      expect(resolvedNode.toLowerCase()).toBe(process.execPath.toLowerCase());
      expect(resolvedNode.toLowerCase()).not.toBe(decoyPath.toLowerCase());

      const outcome = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
        const child = spawn(resolvedNode, ['-e', 'process.stdout.write("from-path-node")'], {
          cwd: cwdDir,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, stdout }));
      });

      expect(outcome.code).toBe(0);
      expect(outcome.stdout).toBe('from-path-node');
    } finally {
      process.chdir(originalCwd);
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
