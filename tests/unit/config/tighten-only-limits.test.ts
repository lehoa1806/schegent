/**
 * Review gap GC-10 (2026-11-12) — a repository's `.vscode/settings.json` may tighten an operator's
 * spend, retry or loop limit and never loosen or clear it. The operator's value is the user layer,
 * else the manifest default.
 */
import { describe, expect, it } from 'vitest';

import { RUN_LIMIT_KEYS, resolveRunLimit } from '../../../src/config/tighten-only-limits';

describe('GC-10 — run limits a workspace may only tighten', () => {
  it('covers exactly the spend, retry and loop limits', () => {
    expect([...RUN_LIMIT_KEYS].sort()).toEqual([
      'loop.maxIterations',
      'loop.maxUnchangedComparisons',
      'retry.forceContinueOnCap',
      'retry.maxAttempts',
      'spend.maxTokensPerRun',
      'spend.maxUsdPerRun'
    ]);
  });

  it('returns the manifest default from the default layer when nothing is set', () => {
    expect(resolveRunLimit('spend.maxUsdPerRun', undefined)).toEqual({
      value: null,
      origin: 'default',
      ignoredLayers: []
    });
    expect(resolveRunLimit('retry.maxAttempts', {})).toEqual({ value: 5, origin: 'default', ignoredLayers: [] });
  });

  describe('spend ceilings, where null is no bound', () => {
    it('ignores a workspace value above the user cap', () => {
      expect(resolveRunLimit('spend.maxUsdPerRun', { globalValue: 5, workspaceValue: 10 })).toEqual({
        value: 5,
        origin: 'user',
        ignoredLayers: ['workspace']
      });
    });

    it('ignores a workspace null that would clear the user cap', () => {
      expect(resolveRunLimit('spend.maxTokensPerRun', { globalValue: 1000, workspaceValue: null })).toEqual({
        value: 1000,
        origin: 'user',
        ignoredLayers: ['workspace']
      });
    });

    it('lets a workspace set a cap where the operator has none', () => {
      expect(resolveRunLimit('spend.maxUsdPerRun', { defaultValue: null, workspaceValue: 3 })).toEqual({
        value: 3,
        origin: 'workspace',
        ignoredLayers: []
      });
    });

    it('takes the tightest of user, workspace and folder', () => {
      expect(
        resolveRunLimit('spend.maxUsdPerRun', { globalValue: 5, workspaceValue: 2, workspaceFolderValue: 1 })
      ).toEqual({ value: 1, origin: 'workspace-folder', ignoredLayers: [] });
    });

    it('ignores a workspace value outside the setting schema', () => {
      expect(resolveRunLimit('spend.maxUsdPerRun', { globalValue: 5, workspaceFolderValue: 0 })).toEqual({
        value: 5,
        origin: 'user',
        ignoredLayers: ['workspace-folder']
      });
    });
  });

  describe('retry.forceContinueOnCap', () => {
    it('ignores a workspace true', () => {
      expect(resolveRunLimit('retry.forceContinueOnCap', { defaultValue: false, workspaceValue: true })).toEqual({
        value: false,
        origin: 'default',
        ignoredLayers: ['workspace']
      });
    });

    it('lets a workspace false override a user true', () => {
      expect(
        resolveRunLimit('retry.forceContinueOnCap', { globalValue: true, workspaceFolderValue: false })
      ).toEqual({ value: false, origin: 'workspace-folder', ignoredLayers: [] });
    });
  });

  describe('retry and loop ceilings', () => {
    it('ignores a workspace retry cap above the user cap and accepts one below', () => {
      expect(resolveRunLimit('retry.maxAttempts', { globalValue: 2, workspaceValue: 5 })).toEqual({
        value: 2,
        origin: 'user',
        ignoredLayers: ['workspace']
      });
      expect(resolveRunLimit('retry.maxAttempts', { defaultValue: 5, workspaceValue: 3 })).toEqual({
        value: 3,
        origin: 'workspace',
        ignoredLayers: []
      });
    });

    it('ignores a workspace iteration cap above the default', () => {
      expect(resolveRunLimit('loop.maxIterations', { defaultValue: 10, workspaceValue: 20 })).toEqual({
        value: 10,
        origin: 'default',
        ignoredLayers: ['workspace']
      });
    });

    it('does not report a workspace value equal to the operator value', () => {
      expect(resolveRunLimit('loop.maxIterations', { globalValue: 4, workspaceValue: 4 })).toEqual({
        value: 4,
        origin: 'user',
        ignoredLayers: []
      });
    });
  });

  describe('loop.maxUnchangedComparisons, where 0 is no bound', () => {
    it('lets a workspace turn the bound on', () => {
      expect(
        resolveRunLimit('loop.maxUnchangedComparisons', { defaultValue: 0, workspaceValue: 3 })
      ).toEqual({ value: 3, origin: 'workspace', ignoredLayers: [] });
    });

    it('ignores a workspace 0 that would turn the user bound off, and a larger bound', () => {
      expect(resolveRunLimit('loop.maxUnchangedComparisons', { globalValue: 3, workspaceValue: 0 })).toEqual({
        value: 3,
        origin: 'user',
        ignoredLayers: ['workspace']
      });
      expect(
        resolveRunLimit('loop.maxUnchangedComparisons', { globalValue: 3, workspaceFolderValue: 5 })
      ).toEqual({ value: 3, origin: 'user', ignoredLayers: ['workspace-folder'] });
    });
  });
});
