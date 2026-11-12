import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  getConfiguration: vi.fn()
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: mocks.getConfiguration
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath })
  }
}));

import type { BackendRunnerKind } from '../../../src/contracts/backend-kinds';
import { resolveCliPath } from '../../../src/config/cli-path-accessor';

beforeEach(() => {
  mocks.values.clear();
  mocks.getConfiguration.mockReset();
  mocks.getConfiguration.mockReturnValue({
    get: (key: string) => mocks.values.get(key)
  });
});

describe('resolveCliPath', () => {
  it.each([
    ['agy', 'agy.path', 'agy'],
    ['codex', 'codex.path', 'codex']
  ] as const)('uses the %s default for unset and malformed values', (kind, key, fallback) => {
    expect(resolveCliPath(kind, '/workspace', 'claude')).toBe(fallback);
    for (const malformed of ['', '   ', 42, false, null]) {
      mocks.values.set(key, malformed);
      expect(resolveCliPath(kind, '/workspace', 'claude')).toBe(fallback);
    }
  });

  it.each([
    ['agy', 'agy.path'],
    ['codex', 'codex.path']
  ] as const)('returns a trimmed custom %s path', (kind, key) => {
    mocks.values.set(key, '  /opt/tools/backend  ');
    expect(resolveCliPath(kind, '/workspace', 'claude')).toBe('/opt/tools/backend');
  });

  it('reads and trims the Claude path dynamically', () => {
    mocks.values.set('cli.path', ' /new/claude ');
    expect(resolveCliPath('claude', '/workspace', '/old/claude')).toBe('/new/claude');
  });

  it('uses the validated Claude fallback for an unset Claude path', () => {
    expect(resolveCliPath('claude', '/workspace', ' /opt/claude ')).toBe('/opt/claude');
    expect(resolveCliPath('claude', '/workspace', '   ')).toBe('claude');
  });

  // Review gap GC-06 (2026-11-12) — an unknown kind used to fall through to Claude's binary, so a
  // backend added without a path setting would have launched `claude` under another backend's name.
  it('refuses an unknown backend kind instead of resolving Claude for it', () => {
    mocks.values.set('cli.path', '/opt/claude');
    expect(() => resolveCliPath('future' as BackendRunnerKind, '/workspace', 'claude')).toThrow(
      'no CLI path setting for backend kind "future"'
    );
  });

  it('reads configuration at resource scope', () => {
    resolveCliPath('agy', '/workspace/project', 'claude');
    expect(mocks.getConfiguration).toHaveBeenCalledWith(
      'schegent',
      expect.objectContaining({ fsPath: '/workspace/project' })
    );
  });
});
