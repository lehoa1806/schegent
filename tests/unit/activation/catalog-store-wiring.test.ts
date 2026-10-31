// Feature 254 (FR-R4-F07, W-T2; contract W2, W3; FR-038, TA7) — one catalog store per directory per host.
//
// The catalog's manifest is last-writer-wins across processes (the rename has no compare), so the store
// cannot make two writers safe; what it can do is make sure THIS host never builds two stores on one
// directory. `createHostCatalogStore` is the only production construction path, reached once from
// `openWorkspaceSession`; it claims the canonical store root in a host-wide set and a second claim while
// the first is held returns `null` with one warning that carries no path. The claim is released by a
// `Disposable` pushed into the `disposables` `openWorkspaceSession` receives, which `closeStage2Resources`
// disposes, so a re-activated Stage 2 claims again.
//
// What is NOT claimed, and why that is asserted here: `createCatalogStore` itself. The test fixtures call
// it directly to model two windows (`tests/fixtures/catalog-real-fs.ts`), and the cross-process probe in
// `tests/integration/catalog-store-concurrency.test.ts` depends on being able to build two stores on one
// directory. A claim in the store would make that probe unwritable.
//
// The warning is path-free because a store root is a path under the operator's workspace, and a logged
// path is a disclosure the operator did not ask for (hard rule on sanitized logging). The check is on the
// serialised arguments, so a path smuggled into any argument is caught, not only the first.

import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { createHostCatalogStore } from '../../../src/activation/catalog-store-wiring';
import { disposeWorkspaceFolderPicker } from '../../../src/state/workspace-folder-picker';
import { openStore } from '../../fixtures/catalog-real-fs';

/** Point the host's workspace-root accessor at a directory, or at nothing. */
function setWorkspaceFolder(fsPath: string | null): void {
  disposeWorkspaceFolderPicker();
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders =
    fsPath === null ? undefined : [{ uri: vscode.Uri.file(fsPath) }];
}

function setTrusted(trusted: boolean): void {
  (vscode.workspace as { isTrusted: boolean }).isTrusted = trusted;
}

/** A disposables list shaped like the one `openWorkspaceSession` receives. */
function disposablesList(): vscode.Disposable[] {
  return [];
}

function disposeAll(list: vscode.Disposable[]): void {
  for (const entry of list.splice(0)) entry.dispose();
}

describe('FR-R4-F07 W-T2 — one host store per catalog directory (FR-038)', () => {
  const roots: string[] = [];
  let workspaceRoot: string;
  let warn: ReturnType<typeof vi.fn>;
  let logger: { warn: (message: string) => void };

  beforeEach(async () => {
    workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), 'schegent-254-claim-')));
    roots.push(workspaceRoot);
    setTrusted(true);
    setWorkspaceFolder(workspaceRoot);
    warn = vi.fn();
    logger = { warn: (message: string) => warn(message) };
  });

  afterEach(async () => {
    setTrusted(true);
    setWorkspaceFolder(null);
    disposeWorkspaceFolderPicker();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('refuses a second store on one root while the first is held, with one path-free warning', () => {
    const disposables = disposablesList();
    const first = createHostCatalogStore(undefined, undefined, logger, disposables);
    expect(first).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();

    const second = createHostCatalogStore(undefined, undefined, logger, disposables);

    expect(second).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(workspaceRoot);
    expect(logged).not.toContain(basename(workspaceRoot));
    expect(logged).not.toContain(tmpdir());
    disposeAll(disposables);
  });

  it('claims again once the first claim is released through its pushed Disposable (TA7)', () => {
    const disposables = disposablesList();
    expect(createHostCatalogStore(undefined, undefined, logger, disposables)).not.toBeNull();
    // The claim put exactly one Disposable on the list, and disposing it is what releases the root.
    expect(disposables).toHaveLength(1);
    expect(createHostCatalogStore(undefined, undefined, logger, disposablesList())).toBeNull();

    disposeAll(disposables);

    const third = disposablesList();
    expect(createHostCatalogStore(undefined, undefined, logger, third)).not.toBeNull();
    disposeAll(third);
  });

  it('releases a claim once: disposing the first Disposable again does not free a later claim', () => {
    const firstList = disposablesList();
    expect(createHostCatalogStore(undefined, undefined, logger, firstList)).not.toBeNull();
    const firstClaim = firstList.at(0);
    firstClaim?.dispose();

    const secondList = disposablesList();
    expect(createHostCatalogStore(undefined, undefined, logger, secondList)).not.toBeNull();

    // A stale handle from the earlier claim must not release the claim that replaced it.
    firstClaim?.dispose();

    expect(createHostCatalogStore(undefined, undefined, logger, disposablesList())).toBeNull();
    disposeAll(secondList);
  });

  it('does not conflict across two different roots', async () => {
    const other = await realpath(await mkdtemp(join(tmpdir(), 'schegent-254-claim-other-')));
    roots.push(other);
    const disposables = disposablesList();
    expect(createHostCatalogStore(undefined, undefined, logger, disposables)).not.toBeNull();

    setWorkspaceFolder(other);
    expect(createHostCatalogStore(undefined, undefined, logger, disposables)).not.toBeNull();

    expect(warn).not.toHaveBeenCalled();
    disposeAll(disposables);
  });

  it('claims nothing when the workspace is untrusted or has no folder (those are not stores)', () => {
    const disposables = disposablesList();

    setTrusted(false);
    expect(createHostCatalogStore(undefined, undefined, logger, disposables)).toBeNull();
    expect(disposables).toHaveLength(0);
    setTrusted(true);

    // A trusted window with no folder still gets a store, and two of them do not collide: there is
    // no directory to claim, so there is nothing to refuse.
    setWorkspaceFolder(null);
    expect(createHostCatalogStore(undefined, undefined, logger, disposables)).not.toBeNull();
    expect(createHostCatalogStore(undefined, undefined, logger, disposables)).not.toBeNull();
    expect(disposables).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();

    // And the untrusted refusal above did not leave a claim behind.
    setWorkspaceFolder(workspaceRoot);
    expect(createHostCatalogStore(undefined, undefined, logger, disposables)).not.toBeNull();
    disposeAll(disposables);
  });

  it('control: createCatalogStore itself is not claimed (the fixtures model two windows with it)', () => {
    const disposables = disposablesList();
    expect(createHostCatalogStore(undefined, undefined, logger, disposables)).not.toBeNull();

    // The fixture builds a store straight on the same directory, twice, with the host's claim held.
    expect(openStore(workspaceRoot)).toBeDefined();
    expect(openStore(workspaceRoot)).toBeDefined();
    expect(warn).not.toHaveBeenCalled();
    disposeAll(disposables);
  });
});
