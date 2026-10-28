// FR-R4-F02 (spec 240, US8; contract E2 G5, G7) — each limit the runner receives, beside the layer
// that supplied it. A fake `inspect` stands in for the editor's configuration service: it layers a
// key the way the editor does (folder, then workspace, then user, then the manifest default), so the
// value `get` returns and the origin `inspect` reports are two views of one layering, and the case
// is that they never disagree.
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => configurationFor() },
  Uri: { file: (path: string) => ({ fsPath: path }) }
}));
vi.mock('../../../src/config/settings-schema-validator', () => ({ validateWorkspaceSettings: vi.fn() }));

import { originOf, resolveWorkspaceSettings } from '../../../src/activation/workspace-settings';
import { SanitizedLogger } from '../../../src/lib/logger';

interface Layers {
  readonly default?: unknown;
  readonly global?: unknown;
  readonly workspace?: unknown;
  readonly folder?: unknown;
}

let table: Readonly<Record<string, Layers>> = {};
const configurationFor = (): unknown => ({
  get: (key: string, fallback?: unknown) => {
    const layers = table[key] ?? {};
    return layers.folder ?? layers.workspace ?? layers.global ?? layers.default ?? fallback;
  },
  inspect: (key: string) => {
    const layers = table[key] ?? {};
    return {
      key,
      defaultValue: layers.default,
      globalValue: layers.global,
      workspaceValue: layers.workspace,
      workspaceFolderValue: layers.folder
    };
  }
});

const resolve = (layers: Readonly<Record<string, Layers>>) => {
  table = layers;
  return resolveWorkspaceSettings({ workspaceRoot: '/workspace', logger: new SanitizedLogger() });
};

describe('originOf names the layer that won (E2 G5)', () => {
  it('folder beats workspace beats user beats default', () => {
    expect(originOf({ workspaceFolderValue: 1, workspaceValue: 2, globalValue: 3 })).toBe('workspace-folder');
    expect(originOf({ workspaceValue: 2, globalValue: 3 })).toBe('workspace');
    expect(originOf({ globalValue: 3 })).toBe('user');
    expect(originOf({})).toBe('default');
    expect(originOf(undefined)).toBe('default');
  });

  it('a layer that holds `false`, `0` or an empty value still wins: presence, not truth', () => {
    expect(originOf({ workspaceValue: 0 })).toBe('workspace');
    expect(originOf({ globalValue: false })).toBe('user');
    expect(originOf({ workspaceFolderValue: '' })).toBe('workspace-folder');
  });
});

describe('resolveWorkspaceSettings returns each limit with its origin (E2 G5)', () => {
  it('with nothing set, every limit is the default, from the default layer', () => {
    const settings = resolve({});

    expect(settings.limits).toEqual({
      iterationCap: { value: 10, origin: 'default' },
      idleTimeoutSeconds: { value: 5400, origin: 'default' },
      maxDurationSeconds: { value: 21600, origin: 'default' }
    });
  });

  it.each([
    ['user', { global: 4 }, 4],
    ['workspace', { global: 4, workspace: 6 }, 6],
    ['workspace-folder', { global: 4, workspace: 6, folder: 8 }, 8]
  ])('the iteration cap set at %s layers is that layer\'s value', (origin, layers, value) => {
    const settings = resolve({ 'loop.maxIterations': { default: 10, ...layers } });

    expect(settings.limits.iterationCap).toEqual({ value, origin });
  });

  it('the wall-clock bound is read the same way', () => {
    const settings = resolve({ 'invocation.maxDurationSeconds': { default: 21600, workspace: 900 } });

    expect(settings.limits.maxDurationSeconds).toEqual({ value: 900, origin: 'workspace' });
  });

  it('the returned values equal what the runner is built with: the scalar fields are the same readings', () => {
    const settings = resolve({
      'loop.maxIterations': { default: 10, folder: 3 },
      'invocation.idleTimeoutSeconds': { default: 5400, workspace: 120 },
      'invocation.maxDurationSeconds': { default: 21600, global: 7200 }
    });

    expect(settings.iterationCap).toBe(settings.limits.iterationCap.value);
    expect(settings.timeoutSeconds).toBe(settings.limits.idleTimeoutSeconds.value);
    expect(settings.maxDurationSeconds).toBe(settings.limits.maxDurationSeconds.value);
  });
});

describe('the idle bound resolves the legacy key in today\'s order, and the origin names the layer, not the key (E2 G5)', () => {
  it('the new key set at user level wins over a legacy key set at folder level, and is `user`', () => {
    const settings = resolve({
      'invocation.idleTimeoutSeconds': { default: 5400, global: 600 },
      'invocation.timeoutSeconds': { default: 5400, folder: 300 }
    });

    expect(settings.timeoutSeconds).toBe(600);
    expect(settings.limits.idleTimeoutSeconds).toEqual({ value: 600, origin: 'user' });
  });

  it('with the new key unset, the legacy key\'s explicit value is used and its layer is the origin', () => {
    const settings = resolve({
      'invocation.idleTimeoutSeconds': { default: 5400 },
      'invocation.timeoutSeconds': { default: 5400, workspace: 300 }
    });

    expect(settings.timeoutSeconds).toBe(300);
    expect(settings.limits.idleTimeoutSeconds).toEqual({ value: 300, origin: 'workspace' });
  });

  it('with neither set explicitly it is 5400, from the default layer, even though both keys have manifest defaults', () => {
    const settings = resolve({
      'invocation.idleTimeoutSeconds': { default: 5400 },
      'invocation.timeoutSeconds': { default: 5400 }
    });

    expect(settings.timeoutSeconds).toBe(5400);
    expect(settings.limits.idleTimeoutSeconds).toEqual({ value: 5400, origin: 'default' });
  });
});
