// Review gap GC-24 (2026-11-12) & FR-R7-16 (16-16, FR-016) — unified platform-aware executable
// resolution shared by qualification, version probing, and child-process launch.
//
// WHAT THIS PINS:
//   - Bare names on BOTH POSIX and Win32 resolve along strictly absolute `PATH` entries only,
//     returning the resolved absolute path (never falling back to host or child `cwd`, and never
//     accepting empty or relative `PATH` entries);
//   - Explicit relative, drive-relative (`C:foo.exe`), and rooted-without-drive (`\foo.exe`,
//     `/foo.exe` on Win32) paths are refused consistently;
//   - On Win32, bare names match only spawnable `.com` then `.exe` regular files (skipping `.cmd`
//     and `.bat` shims); on POSIX, hits must be regular files with `X_OK`;
//   - Qualification (`resolveExecutable`), version probe (`createCliVersionProbe`), and launch
//     (`spawnCommandFor`) agree on every relative-path, PATH, extension, minimal-env, and
//     host-vs-child cwd scenario;
//   - Every agent CLI and git spawn site resolves through `spawnCommandFor(`.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  resolveExecutableCommand,
  spawnCommandFor,
  type ExecutableAccessProbe
} from '../../../src/lib/spawn-command';
import { resolveExecutable } from '../../../src/runner/executable-identity';
import { createCliVersionProbe } from '../../../src/runner/cli-version-probe';
import {
  SHIPPED_DEFAULT_POLICY,
  resolveProcessEnvironmentPolicy
} from '../../../src/contracts/process-environment-policy';
import { buildSpawnEnv, policyRequestFields } from '../../../src/runner/spawn-env';

let root = '';
let cwdDir = '';
let binA = '';
let binB = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gc24-1616-'));
  cwdDir = join(root, 'workspace');
  binA = join(root, 'a');
  binB = join(root, 'b');
  for (const dir of [cwdDir, binA, binB]) mkdirSync(dir);

  // POSIX fixtures on real disk
  writeFileSync(join(cwdDir, 'claude'), '#!/bin/sh\necho "planted 0.0.1"\n', 'utf8');
  chmodSync(join(cwdDir, 'claude'), 0o755);
  writeFileSync(join(binA, 'claude'), 'not executable', 'utf8');
  chmodSync(join(binA, 'claude'), 0o644);
  writeFileSync(join(binB, 'claude'), '#!/bin/sh\necho "2.1.246 (Claude Code)"\n', 'utf8');
  chmodSync(join(binB, 'claude'), 0o755);
  writeFileSync(join(binA, 'noexec'), 'plain file', 'utf8');
  chmodSync(join(binA, 'noexec'), 0o644);
  mkdirSync(join(binA, 'codex'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Deterministic virtual filesystem probe for cross-platform Win32 paths on POSIX hosts. */
function makeWin32Probe(entries: Record<string, 'file' | 'dir'>): ExecutableAccessProbe {
  const normalized = new Map<string, 'file' | 'dir'>(
    Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v])
  );
  return (candidate) => {
    const entry = normalized.get(candidate.toLowerCase());
    if (entry === 'file') return 'resolved';
    if (entry === 'dir') return 'not-executable';
    return 'not-found';
  };
}

const WIN32_PROBE = makeWin32Probe({
  'C:\\workspace\\claude.exe': 'file',
  'C:\\binA\\claude.cmd': 'file',
  'C:\\binA\\claude.bat': 'file',
  'C:\\binB\\claude.exe': 'file',
  'C:\\binA\\git.com': 'file',
  'C:\\binA\\git.exe': 'file',
  'C:\\binB\\tool.v2.exe': 'file',
  'C:\\binA\\codex.exe': 'dir',
  'C:\\binB\\codex.exe': 'file',
  'C:\\binA\\onlydir.exe': 'dir',
  '\\\\server\\share\\bin\\agy.exe': 'file'
});

function winEnv(...dirs: string[]): NodeJS.ProcessEnv {
  return { Path: dirs.join(';') };
}

describe('GC-24 & 16-16 — win32 bare names resolve along strictly absolute PATH entries only', () => {
  it('returns the PATH hit, skipping .cmd/.bat shims and never searching cwd', () => {
    expect(
      spawnCommandFor('claude', winEnv('C:\\binA', 'C:\\binB'), 'win32', WIN32_PROBE)
    ).toBe('C:\\binB\\claude.exe');
  });

  it('tries .com before .exe in one directory, as libuv does', () => {
    expect(spawnCommandFor('git', winEnv('C:\\binA'), 'win32', WIN32_PROBE)).toBe('C:\\binA\\git.com');
  });

  it('tries the name as given first when it has a spawnable extension', () => {
    expect(spawnCommandFor('tool.v2.exe', winEnv('C:\\binB'), 'win32', WIN32_PROBE)).toBe(
      'C:\\binB\\tool.v2.exe'
    );
  });

  it('skips a directory hit and continues to a later valid PATH entry, or throws EACCES when only a directory matches', () => {
    expect(
      spawnCommandFor('codex', winEnv('C:\\binA', 'C:\\binB'), 'win32', WIN32_PROBE)
    ).toBe('C:\\binB\\codex.exe');
    expect(() =>
      spawnCommandFor('onlydir', winEnv('C:\\binA'), 'win32', WIN32_PROBE)
    ).toThrow(expect.objectContaining({ code: 'EACCES' }));
  });

  it('throws ENOENT on a miss and names no directory', () => {
    let caught: unknown;
    try {
      spawnCommandFor('claude', winEnv('C:\\binA'), 'win32', WIN32_PROBE);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: 'ENOENT' });
    expect(String((caught as Error).message)).not.toContain('C:\\binA');
  });

  it('throws ENOENT when PATH is empty, rather than falling back to cwd', () => {
    expect(() => spawnCommandFor('claude', {}, 'win32', WIN32_PROBE)).toThrow(
      expect.objectContaining({ code: 'ENOENT' })
    );
  });

  it('skips empty, relative, drive-relative, and rooted-without-drive PATH entries on win32', () => {
    expect(
      spawnCommandFor(
        'claude',
        winEnv('', '.', '.\\workspace', 'C:workspace', '\\workspace', 'C:\\binB'),
        'win32',
        WIN32_PROBE
      )
    ).toBe('C:\\binB\\claude.exe');
    expect(
      resolveExecutableCommand(
        'claude',
        winEnv('', '.', '.\\workspace', 'C:workspace', '\\workspace'),
        'win32',
        WIN32_PROBE
      )
    ).toEqual({ ok: false, cause: 'not-found' });
  });

  it('reads PATH case-insensitively and supports UNC absolute PATH entries on win32', () => {
    expect(spawnCommandFor('claude', { PATH: 'C:\\binB' }, 'win32', WIN32_PROBE)).toBe(
      'C:\\binB\\claude.exe'
    );
    expect(
      spawnCommandFor('agy', { Path: '\\\\server\\share\\bin' }, 'win32', WIN32_PROBE)
    ).toBe('\\\\server\\share\\bin\\agy.exe');
  });

  it('refuses explicit relative, drive-relative, and rooted-without-drive paths on win32, while allowing strictly absolute paths', () => {
    for (const bad of ['.\\claude.exe', './claude.exe', '..\\claude.exe', 'bin\\claude.exe', 'C:claude.exe', '\\claude.exe', '/claude.exe', '\\\\server', '', '.', '..']) {
      expect(resolveExecutableCommand(bad, winEnv('C:\\binB'), 'win32', WIN32_PROBE)).toEqual({
        ok: false,
        cause: 'invalid-path'
      });
      expect(() => spawnCommandFor(bad, winEnv('C:\\binB'), 'win32', WIN32_PROBE), bad).toThrow(
        expect.objectContaining({ code: 'ENOENT' })
      );
    }

    expect(spawnCommandFor('C:\\binB\\claude.exe', winEnv('C:\\binA'), 'win32', WIN32_PROBE)).toBe(
      'C:\\binB\\claude.exe'
    );
    expect(
      spawnCommandFor('\\\\server\\share\\bin\\agy.exe', winEnv('C:\\binA'), 'win32', WIN32_PROBE)
    ).toBe('\\\\server\\share\\bin\\agy.exe');
  });

  it('CR-B5: refuses explicit absolute .cmd and .bat paths on win32 before probing disk and leaks no path', () => {
    const spyProbe = vi.fn(WIN32_PROBE);
    const shellOnlyPaths = [
      'C:\\binA\\claude.cmd',
      'C:\\binA\\claude.bat',
      'C:\\binA\\CLAUDE.CMD',
      'C:/binA/claude.BAT',
      '\\\\server\\share\\bin\\agy.cmd'
    ];
    for (const candidate of shellOnlyPaths) {
      expect(
        resolveExecutableCommand(candidate, winEnv('C:\\binB'), 'win32', spyProbe),
        candidate
      ).toEqual({ ok: false, cause: 'not-executable' });

      let caught: unknown;
      try {
        spawnCommandFor(candidate, winEnv('C:\\binB'), 'win32', spyProbe);
      } catch (error) {
        caught = error;
      }
      expect(caught, candidate).toMatchObject({ code: 'EACCES' });
      expect(String((caught as Error).message)).not.toContain(candidate);
      expect(String((caught as Error).message)).not.toContain('binA');
      expect(String((caught as Error).message)).not.toContain('share');
    }
    expect(spyProbe).not.toHaveBeenCalled();
  });
});

describe('16-16 — POSIX bare names resolve along strictly absolute PATH entries only', () => {
  it('returns the resolved absolute path on darwin and linux, skipping non-executable hits', () => {
    const env = { PATH: `${binA}:${binB}` };
    expect(spawnCommandFor('claude', env, 'darwin')).toBe(join(binB, 'claude'));
    expect(spawnCommandFor('claude', env, 'linux')).toBe(join(binB, 'claude'));
  });

  it('throws EACCES when every PATH hit lacks execute permission or is a directory', () => {
    expect(() => spawnCommandFor('noexec', { PATH: binA }, 'darwin')).toThrow(
      expect.objectContaining({ code: 'EACCES' })
    );
    expect(() => spawnCommandFor('codex', { PATH: binA }, 'linux')).toThrow(
      expect.objectContaining({ code: 'EACCES' })
    );
  });

  it('skips empty and relative PATH entries so cwd-planted binaries are never selected', () => {
    const relToHost = relative(process.cwd(), cwdDir);
    const badPathOnly = `:${relToHost}:.:./workspace:`;
    expect(resolveExecutableCommand('claude', { PATH: badPathOnly }, 'darwin')).toEqual({
      ok: false,
      cause: 'not-found'
    });
    expect(() => spawnCommandFor('claude', { PATH: badPathOnly }, 'darwin')).toThrow(
      expect.objectContaining({ code: 'ENOENT' })
    );
    expect(spawnCommandFor('claude', { PATH: `${badPathOnly}:${binB}` }, 'darwin')).toBe(
      join(binB, 'claude')
    );
  });

  it('refuses explicit relative paths on POSIX while allowing explicit absolute paths', () => {
    for (const bad of ['./claude', '../claude', 'workspace/claude', '.', '..', '', 'bad\0name']) {
      expect(resolveExecutableCommand(bad, { PATH: binB }, 'darwin')).toEqual({
        ok: false,
        cause: 'invalid-path'
      });
      expect(() => spawnCommandFor(bad, { PATH: binB }, 'darwin'), bad).toThrow(
        expect.objectContaining({ code: 'ENOENT' })
      );
    }
    expect(spawnCommandFor(process.execPath, {}, 'darwin')).toBe(process.execPath);
    // Cross-platform control: .cmd/.bat shell-only refusal is win32-specific.
    const posixProbe: ExecutableAccessProbe = (candidate) =>
      candidate === '/opt/bin/script.cmd' ? 'resolved' : 'not-found';
    expect(resolveExecutableCommand('/opt/bin/script.cmd', {}, 'linux', posixProbe)).toEqual({
      ok: true,
      resolvedPath: '/opt/bin/script.cmd'
    });
    expect(spawnCommandFor('/opt/bin/script.cmd', {}, 'darwin', posixProbe)).toBe('/opt/bin/script.cmd');
  });

  it('keeps qualification, version probe, and spawn resolution identical across minimal env and differing host/child cwd', async () => {
    if (process.platform === 'win32') return;
    const savedPath = process.env.PATH;
    try {
      // Host PATH puts relative `.` first, then binB — only binB is strictly absolute.
      process.env.PATH = `.:${binB}`;
      const allowlistEnv = buildSpawnEnv(policyRequestFields(SHIPPED_DEFAULT_POLICY));
      const minimalPolicy = resolveProcessEnvironmentPolicy({
        inheritEnvironment: false,
        mode: 'minimal',
        allowlist: []
      });
      const minimalEnv = buildSpawnEnv(policyRequestFields(minimalPolicy));

      // 1. Allowlist env + bare name -> all three pick binB/claude (never cwdDir/claude).
      expect(await resolveExecutable('claude', allowlistEnv, process.platform)).toBe('resolved');
      expect(spawnCommandFor('claude', allowlistEnv, process.platform)).toBe(join(binB, 'claude'));
      const allowProbe = createCliVersionProbe({ environmentPolicy: () => SHIPPED_DEFAULT_POLICY });
      expect(await allowProbe.observe('claude')).toBe('2.1.246');

      // 2. Minimal env (no PATH) + bare name -> all three refuse consistently.
      expect(await resolveExecutable('claude', minimalEnv, process.platform)).toBe('not-found');
      expect(() => spawnCommandFor('claude', minimalEnv, process.platform)).toThrow(
        expect.objectContaining({ code: 'ENOENT' })
      );
      const minProbe = createCliVersionProbe({ environmentPolicy: () => minimalPolicy });
      expect(await minProbe.observe('claude')).toBeNull();

      // 3. Explicit relative path -> all three refuse consistently even if file exists in cwd.
      const relExecutable = `./${relative(process.cwd(), join(cwdDir, 'claude'))}`;
      expect(await resolveExecutable(relExecutable, allowlistEnv, process.platform)).toBe('not-found');
      expect(() => spawnCommandFor(relExecutable, allowlistEnv, process.platform)).toThrow(
        expect.objectContaining({ code: 'ENOENT' })
      );
      expect(await allowProbe.observe(relExecutable)).toBeNull();
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });
});

describe('GC-24 — every agent CLI and git spawn site resolves through it', () => {
  const SITES = [
    'src/runner/claude-cli.ts',
    'src/runner/process-lifecycle-runner.ts',
    'src/runner/cli-version-probe.ts',
    'src/services/acp-runtime/stdio-transport.ts',
    'src/services/backend-capability-service.ts',
    'src/services/execution-lanes/git-runner.ts',
    'src/lib/git-diff-base.ts',
    'src/services/run-checkpoint-service.ts',
    'src/services/workflow-execution/recovery-envelope-builder.ts',
    'src/activation/run-safety-wiring.ts',
    'src/services/execution-lanes/verification-runner.ts'
  ];

  it.each(SITES)('%s calls spawnCommandFor', (site) => {
    const source = readFileSync(resolve(__dirname, '..', '..', '..', site), 'utf8');

    expect(source).toMatch(/spawnCommandFor\(/);
  });
});
