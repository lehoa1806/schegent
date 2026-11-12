/**
 * Review gap GC-10 (2026-11-12) — the per-phase and per-evaluation readers of the spend, retry and
 * loop limits apply the tighten-only rule: a repository layer may lower a limit and never raise,
 * clear or disable it. A fake `inspect` layers keys the way the editor does.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => configurationFor() },
  Uri: { file: (path: string) => ({ fsPath: path }) }
}));

import {
  readForceContinueOnRetryCap,
  readForceContinueOnRetryCapLimit,
  readMaxUnchangedComparisons,
  readMaxUnchangedComparisonsLimit,
  readRetryCap,
  readSpendLimits
} from '../../../src/activation/uncached-settings-accessors';

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

const ROOT = '/workspace';

describe('GC-10 — uncached run-limit readers are tighten-only', () => {
  it('a workspace cannot clear or raise the user spend caps', () => {
    table = {
      'spend.maxUsdPerRun': { default: null, global: 5, workspace: null },
      'spend.maxTokensPerRun': { default: null, global: 1000, workspace: 50_000 }
    };

    expect(readSpendLimits()).toEqual({
      limitUsd: { value: 5, origin: 'user' },
      limitTokens: { value: 1000, origin: 'user' }
    });
  });

  it('a workspace can set a spend cap the operator left open', () => {
    table = { 'spend.maxUsdPerRun': { default: null, workspace: 2 } };

    expect(readSpendLimits().limitUsd).toEqual({ value: 2, origin: 'workspace' });
  });

  it('a workspace cannot turn on continuing past the retry cap', () => {
    table = { 'retry.forceContinueOnCap': { default: false, workspace: true } };

    expect(readForceContinueOnRetryCap(ROOT)).toBe(false);
    expect(readForceContinueOnRetryCapLimit(ROOT)).toEqual({ value: false, origin: 'default' });
  });

  it('a folder can turn it off when the user turned it on', () => {
    table = { 'retry.forceContinueOnCap': { default: false, global: true, folder: false } };

    expect(readForceContinueOnRetryCapLimit(ROOT)).toEqual({ value: false, origin: 'workspace-folder' });
  });

  it('a workspace cannot raise the user retry cap, and can lower it', () => {
    table = { 'retry.maxAttempts': { default: 5, global: 2, workspace: 5 } };
    expect(readRetryCap(ROOT)).toBe(2);

    table = { 'retry.maxAttempts': { default: 5, global: 4, folder: 1 } };
    expect(readRetryCap(ROOT)).toBe(1);
  });

  it('an out-of-range user retry cap still reads as the manifest maximum', () => {
    table = { 'retry.maxAttempts': { default: 5, global: 20 } };

    expect(readRetryCap(ROOT)).toBe(5);
  });

  it('a workspace cannot turn off or widen the user unchanged-comparison bound', () => {
    table = { 'loop.maxUnchangedComparisons': { default: 0, global: 3, workspace: 0 } };
    expect(readMaxUnchangedComparisons(ROOT)).toBe(3);

    table = { 'loop.maxUnchangedComparisons': { default: 0, global: 3, folder: 7 } };
    expect(readMaxUnchangedComparisonsLimit(ROOT)).toEqual({ value: 3, origin: 'user' });
  });

  it('a workspace can turn the bound on', () => {
    table = { 'loop.maxUnchangedComparisons': { default: 0, workspace: 2 } };

    expect(readMaxUnchangedComparisonsLimit(ROOT)).toEqual({ value: 2, origin: 'workspace' });
  });
});
