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

  it('uses the validated Claude fallback for unset Claude and unknown kinds', () => {
    expect(resolveCliPath('claude', '/workspace', ' /opt/claude ')).toBe('/opt/claude');
    expect(resolveCliPath('future', '/workspace', '   ')).toBe('claude');
  });

  it('reads configuration at resource scope', () => {
    resolveCliPath('agy', '/workspace/project', 'claude');
    expect(mocks.getConfiguration).toHaveBeenCalledWith(
      'schegent',
      expect.objectContaining({ fsPath: '/workspace/project' })
    );
  });
});
