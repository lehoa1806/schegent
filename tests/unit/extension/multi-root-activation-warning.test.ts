// Feature 058 (US1, T012) — activation guard unit tests covering U-1..U-8
// from `specs/058-multi-root-workspace/contracts/multi-root-warning-contract.md`.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
  maybeShowMultiRootWarning,
  resetMultiRootWarningGuardForTest
} from '../../../src/state/multi-root-warning';
import type { MultiRootWarningShownPayload } from '../../../src/contracts/audit-events';

// The vscode types are imported only for shape; we never construct a real Uri.
// Cast at the picker-style boundary: `as unknown as vscode.WorkspaceFolder`.
interface MockFolder {
  readonly uri: { readonly fsPath: string; readonly scheme: string };
  readonly name: string;
  readonly index: number;
}

function folder(fsPath: string, name: string, index: number): vscode.WorkspaceFolder {
  const mock: MockFolder = { uri: { fsPath, scheme: 'file' }, name, index };
  return mock as unknown as vscode.WorkspaceFolder;
}

beforeEach(() => {
  resetMultiRootWarningGuardForTest();
});

describe('multi-root activation warning (058, T012)', () => {
  it('U-1: single-folder workspace fires neither audit nor notifier', async () => {
    const append = vi.fn().mockResolvedValue({});
    const info = vi.fn();
    const only = folder('/tmp/ws-only', 'ws-only', 0);
    const result = await maybeShowMultiRootWarning({
      workspaceFolders: [only],
      canonicalFolder: only,
      suppressWarning: false,
      auditWriter: { append },
      notifier: { info }
    });
    expect(result).toBe(false);
    expect(append).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('U-1b: zero-folder workspace fires neither audit nor notifier', async () => {
    const append = vi.fn().mockResolvedValue({});
    const info = vi.fn();
    const result = await maybeShowMultiRootWarning({
      workspaceFolders: undefined,
      canonicalFolder: undefined,
      suppressWarning: false,
      auditWriter: { append },
      notifier: { info }
    });
    expect(result).toBe(false);
    expect(append).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('U-2: two-folder workspace with suppression=false fires both, payload shape exact', async () => {
    const append = vi.fn().mockResolvedValue({});
    const info = vi.fn();
    const first = folder('/tmp/ws-first', 'ws-first', 0);
    const second = folder('/tmp/ws-second', 'ws-second', 1);
    const result = await maybeShowMultiRootWarning({
      workspaceFolders: [first, second],
      canonicalFolder: first,
      suppressWarning: false,
      auditWriter: { append },
      notifier: { info }
    });
    expect(result).toBe(true);
    expect(append).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);

    const entry = append.mock.calls[0]![0] as {
      eventType: string;
      payload: MultiRootWarningShownPayload;
      outcome: string;
    };
    expect(entry.eventType).toBe('multi-root.warning-shown');
    expect(entry.outcome).toBe('info');
    expect(Object.keys(entry.payload).sort()).toEqual(['canonicalFolderName', 'folderCount']);
    expect(entry.payload.folderCount).toBe(2);
    expect(entry.payload.canonicalFolderName).toBe('ws-first');
  });

  it('U-3: three-folder workspace records folderCount=3 and folder[0].name', async () => {
    const append = vi.fn().mockResolvedValue({});
    const info = vi.fn();
    const first = folder('/tmp/a', 'alpha', 0);
    const second = folder('/tmp/b', 'beta', 1);
    const third = folder('/tmp/c', 'gamma', 2);
    await maybeShowMultiRootWarning({
      workspaceFolders: [first, second, third],
      canonicalFolder: first,
      suppressWarning: false,
      auditWriter: { append },
      notifier: { info }
    });
    const entry = append.mock.calls[0]![0] as { payload: MultiRootWarningShownPayload };
    expect(entry.payload.folderCount).toBe(3);
    expect(entry.payload.canonicalFolderName).toBe('alpha');
  });

  it('U-4: two-folder workspace with suppression=true fires neither audit nor notifier', async () => {
    const append = vi.fn().mockResolvedValue({});
    const info = vi.fn();
    const first = folder('/tmp/a', 'alpha', 0);
    const second = folder('/tmp/b', 'beta', 1);
    const result = await maybeShowMultiRootWarning({
      workspaceFolders: [first, second],
      canonicalFolder: first,
      suppressWarning: true,
      auditWriter: { append },
      notifier: { info }
    });
    expect(result).toBe(false);
    expect(append).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('U-5: payload key set is exactly {canonicalFolderName, folderCount}', async () => {
    const append = vi.fn().mockResolvedValue({});
    const info = vi.fn();
    const first = folder('/tmp/a', 'alpha', 0);
    const second = folder('/tmp/b', 'beta', 1);
    await maybeShowMultiRootWarning({
      workspaceFolders: [first, second],
      canonicalFolder: first,
      suppressWarning: false,
      auditWriter: { append },
      notifier: { info }
    });
    const entry = append.mock.calls[0]![0] as { payload: Record<string, unknown> };
    expect(Object.keys(entry.payload).sort()).toEqual(['canonicalFolderName', 'folderCount']);
  });

  it('U-6: payload uses folder.name (not folder.uri.fsPath)', async () => {
    const append = vi.fn().mockResolvedValue({});
    const info = vi.fn();
    const first = folder('/private/var/folders/some/very/long/host-path/Repos/repo-a', 'repo-a', 0);
    const second = folder('/tmp/b', 'beta', 1);
    await maybeShowMultiRootWarning({
      workspaceFolders: [first, second],
      canonicalFolder: first,
      suppressWarning: false,
      auditWriter: { append },
      notifier: { info }
    });
    const entry = append.mock.calls[0]![0] as { payload: MultiRootWarningShownPayload };
    expect(entry.payload.canonicalFolderName).toBe('repo-a');
    // Path bytes MUST NOT appear in the payload.
    expect(entry.payload.canonicalFolderName).not.toContain('/');
    expect(entry.payload.canonicalFolderName).not.toContain('private');
    // Sanity: the toast message can contain a hint (folder name only).
    const toastMessage = info.mock.calls[0]![0] as string;
    expect(toastMessage).toContain('repo-a');
    expect(toastMessage).not.toContain('/private/var/folders');
  });

  it('U-7: second call within the same activation does NOT re-emit', async () => {
    const append = vi.fn().mockResolvedValue({});
    const info = vi.fn();
    const first = folder('/tmp/a', 'alpha', 0);
    const second = folder('/tmp/b', 'beta', 1);
    const deps = {
      workspaceFolders: [first, second],
      canonicalFolder: first,
      suppressWarning: false,
      auditWriter: { append },
      notifier: { info }
    };
    const r1 = await maybeShowMultiRootWarning(deps);
    const r2 = await maybeShowMultiRootWarning(deps);
    expect(r1).toBe(true);
    expect(r2).toBe(false);
    expect(append).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('U-8: audit emission precedes notifier — a notifier throw does not lose the audit', async () => {
    let auditCalledAt = -1;
    let notifierCalledAt = -1;
    let counter = 0;
    const append = vi.fn().mockImplementation(async () => {
      auditCalledAt = ++counter;
      return {};
    });
    const info = vi.fn().mockImplementation(() => {
      notifierCalledAt = ++counter;
      throw new Error('notifier exploded');
    });
    const first = folder('/tmp/a', 'alpha', 0);
    const second = folder('/tmp/b', 'beta', 1);
    const result = await maybeShowMultiRootWarning({
      workspaceFolders: [first, second],
      canonicalFolder: first,
      suppressWarning: false,
      auditWriter: { append },
      notifier: { info }
    });
    expect(result).toBe(true);
    expect(append).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(auditCalledAt).toBeGreaterThan(0);
    expect(notifierCalledAt).toBeGreaterThan(auditCalledAt);
  });
});
