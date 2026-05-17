// Feature 014 T018 — unit tests for the runner's pure helpers.
//
// The runner's `main()` is gated behind `require.main === module`, so
// importing this module from a test is side-effect-free. We exercise
// the two security-critical exports:
//   - `scrubEnv`                  — strict allowlist + denylist defense.
//   - `cwdInsideAnyWorkspace`     — workspace-defense fail-closed check.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubEnv, cwdInsideAnyWorkspace } from '../../../src/headless/wakeup-runner';

describe('scrubEnv', () => {
  it('allows the canonical POSIX variables', () => {
    const out = scrubEnv({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      LANG: 'en_US.UTF-8',
      USER: 'me',
      LOGNAME: 'me',
      SHELL: '/bin/zsh',
      TMPDIR: '/tmp',
      TEMP: 'C:\\Temp',
      TMP: '/tmp'
    });
    expect(out).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      LANG: 'en_US.UTF-8',
      USER: 'me',
      LOGNAME: 'me',
      SHELL: '/bin/zsh',
      TMPDIR: '/tmp',
      TEMP: 'C:\\Temp',
      TMP: '/tmp'
    });
  });

  it('allows LC_* locale variables', () => {
    const out = scrubEnv({ LC_ALL: 'C', LC_TIME: 'en_US.UTF-8', LC_NUMERIC: 'en_US' });
    expect(out).toEqual({ LC_ALL: 'C', LC_TIME: 'en_US.UTF-8', LC_NUMERIC: 'en_US' });
  });

  it('drops VSCODE_* (host-injected)', () => {
    const out = scrubEnv({ VSCODE_PID: '123', VSCODE_IPC_HOOK: '/tmp/x', PATH: '/x' });
    expect(out).toEqual({ PATH: '/x' });
  });

  it('drops WORKSPACE* (workspace-derived)', () => {
    const out = scrubEnv({ WORKSPACE: '/work', WORKSPACE_ROOT: '/root', PATH: '/x' });
    expect(out).toEqual({ PATH: '/x' });
  });

  it('drops SCHEGENT_* (host-internal)', () => {
    const out = scrubEnv({ SCHEGENT_WAKEUP_HOME: '/x', SCHEGENT_DEBUG: '1', PATH: '/x' });
    expect(out).toEqual({ PATH: '/x' });
  });

  it('drops CLAUDE_AUTOCOMPACT_PCT_OVERRIDE specifically', () => {
    const out = scrubEnv({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50', PATH: '/x' });
    expect(out).toEqual({ PATH: '/x' });
  });

  it('drops *_TOKEN / *_SECRET / *_KEY / *_PASSWORD even on the allowlist', () => {
    const out = scrubEnv({
      MY_TOKEN: 'aaa',
      MY_SECRET: 'bbb',
      MY_KEY: 'ccc',
      MY_PASSWORD: 'ddd',
      PATH: '/x'
    });
    expect(out).toEqual({ PATH: '/x' });
  });

  it('drops anything not on the allowlist', () => {
    const out = scrubEnv({ NODE_ENV: 'production', HTTP_PROXY: 'http://x', PATH: '/x' });
    expect(out).toEqual({ PATH: '/x' });
  });

  it('drops undefined values silently', () => {
    const out = scrubEnv({ PATH: '/x', HOME: undefined });
    expect(out).toEqual({ PATH: '/x' });
  });
});

describe('cwdInsideAnyWorkspace', () => {
  let workspaceRoot: string;
  let outsideDir: string;
  let insideDir: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'schegent-ws-'));
    insideDir = join(workspaceRoot, 'nested');
    mkdirSync(insideDir);
    outsideDir = mkdtempSync(join(tmpdir(), 'schegent-out-'));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('is true when cwd equals the workspace root', () => {
    expect(cwdInsideAnyWorkspace(workspaceRoot, [workspaceRoot])).toBe(true);
  });

  it('is true when cwd is nested inside the workspace', () => {
    expect(cwdInsideAnyWorkspace(insideDir, [workspaceRoot])).toBe(true);
  });

  it('is false when cwd is a sibling of the workspace', () => {
    expect(cwdInsideAnyWorkspace(outsideDir, [workspaceRoot])).toBe(false);
  });

  it('is false when the workspace list is empty', () => {
    expect(cwdInsideAnyWorkspace(insideDir, [])).toBe(false);
  });

  it('resolves symlinks before comparing', () => {
    const linkPath = join(outsideDir, 'link-to-inside');
    symlinkSync(insideDir, linkPath, 'dir');
    expect(cwdInsideAnyWorkspace(linkPath, [workspaceRoot])).toBe(true);
  });
});
