// Feature 099 (FR-R3-015) T496c — the trust gate and the wiring above it
// (FR-051, FR-052, SC-008).
//
// Workspace Trust is the one gate the layer collapse keeps, and it is kept for a
// reason the layer tier never addressed: a cloned repository can contain a
// `.schegent/catalog/` directory, so activating one in an untrusted workspace
// would run definitions the operator has never read. The two `allow*Overrides`
// settings that went with the tier gated *which layer may redefine which*, a
// question that no longer exists.
//
// `null` rather than an empty store is the load-bearing part. An empty store and a
// store that is not allowed to exist look identical from a snapshot — zero
// definitions, zero faults — and the Builder has to tell the operator which one it
// is looking at. "No catalog, and nobody told you why" is the failure this
// distinction prevents, so the two facts are kept apart in the type rather than in
// a convention.

import { readdir } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import {
  createHostCatalogStore,
  isCatalogActivationTrusted,
  nodeDigest,
  systemClock
} from '../../src/activation/catalog-store-wiring';
import { emptyCatalogSnapshot } from '../../src/catalog';
import { disposeWorkspaceFolderPicker } from '../../src/state/workspace-folder-picker';
import { createWorkspace, openStore, removeWorkspace, treeOf } from '../fixtures/catalog-real-fs';

/** Point the host's workspace-root accessor at a real directory, or at nothing. */
function setWorkspaceFolder(fsPath: string | null): void {
  disposeWorkspaceFolderPicker();
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders =
    fsPath === null ? undefined : [{ uri: vscode.Uri.file(fsPath) }];
}

function setTrusted(trusted: boolean): void {
  (vscode.workspace as { isTrusted: boolean }).isTrusted = trusted;
}

describe('Feature 099 — an untrusted workspace activates no catalog (SC-008)', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await createWorkspace('trust-gate');
    setWorkspaceFolder(workspaceRoot);
  });

  afterEach(async () => {
    setTrusted(true);
    setWorkspaceFolder(null);
    disposeWorkspaceFolderPicker();
    await removeWorkspace(workspaceRoot);
  });

  it('builds no store at all, even with a catalog sitting on disk', async () => {
    // The case the gate exists for: the directory is already there, populated by
    // whoever the repository was cloned from.
    setTrusted(true);
    const planted = openStore(workspaceRoot);
    const before = await planted.read();
    expect(before.outcome).toBe('read');
    if (before.outcome !== 'read') return;
    expect(
      await planted.applyLifecycleWrite({
        op: 'save-draft',
        kind: 'phase',
        id: 'implement',
        body: { name: 'Implement' },
        expectedDraftVersion: 'no-draft'
      })
    ).toMatchObject({ outcome: 'written' });
    expect((await treeOf(workspaceRoot)).files.length).toBeGreaterThan(0);

    setTrusted(false);

    expect(isCatalogActivationTrusted()).toBe(false);
    // `null` is the fact "no store", and it is a different fact from "a store that
    // read as empty" (FR-052).
    expect(createHostCatalogStore()).toBeNull();
  });

  it('reads nothing and writes nothing while untrusted', async () => {
    setTrusted(false);
    const before = await treeOf(workspaceRoot);

    expect(createHostCatalogStore()).toBeNull();

    expect(await treeOf(workspaceRoot)).toEqual(before);
    expect(await readdir(workspaceRoot)).toEqual([]);
  });

  it('composes the empty catalog from the same revisions a real empty store reports', async () => {
    // The snapshot the Builder composes when there is no store must satisfy the
    // same revision gate a real empty store would, or the first save in a workspace
    // that has just been trusted is refused as stale against a revision nobody can
    // produce (FR-052).
    setTrusted(true);
    const real = openStore(workspaceRoot);
    const result = await real.read();
    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') return;

    const composed = emptyCatalogSnapshot(nodeDigest);
    expect(composed.revisions).toEqual(result.snapshot.revisions);
    expect(composed.definitions).toEqual([]);
    expect(composed.faults).toEqual([]);
    expect(composed.collectable).toEqual([]);
  });

  it('builds a working store once the workspace is trusted', async () => {
    setTrusted(true);

    const store = createHostCatalogStore();
    expect(store).not.toBeNull();
    if (store === null) return;

    const read = await store.read();
    expect(read.outcome).toBe('read');
    if (read.outcome !== 'read') return;

    expect(
      await store.applyLifecycleWrite({
        op: 'save-draft',
        kind: 'phase',
        id: 'implement',
        body: { name: 'Implement' },
        expectedDraftVersion: 'no-draft'
      })
    ).toMatchObject({ outcome: 'written', writtenVersionId: 'v1', draftVersionId: 'v1' });

    // The host's own root computation put it where the store's own tests look.
    expect((await treeOf(workspaceRoot)).files).toEqual([
      '.schegent/catalog/manifest.json',
      '.schegent/catalog/phases/implement/v1.json'
    ]);
  });

  it('refuses to write, by name, when a trusted workspace has no folder open', async () => {
    // FR-033a. The store is built — trust is granted — but there is nowhere to put
    // it, and that is a write refusal rather than a second kind of null.
    setTrusted(true);
    setWorkspaceFolder(null);

    const store = createHostCatalogStore();
    expect(store).not.toBeNull();
    if (store === null) return;

    const read = await store.read();
    expect(read.outcome).toBe('read');
    if (read.outcome !== 'read') return;
    expect(read.snapshot.definitions).toEqual([]);

    expect(
      await store.applyLifecycleWrite({
        op: 'save-draft',
        kind: 'phase',
        id: 'implement',
        body: { n: 1 },
        expectedDraftVersion: 'no-draft'
      })
    ).toEqual({ outcome: 'refused', reason: 'no-workspace' });
  });

  it('ships the clock and the digest the store is specified against', () => {
    // `sha256:<lowercase hex>` over the UTF-8 bytes of the canonical form (FR-012),
    // and epoch milliseconds (FR-021a). Both are pinned here because they are the
    // two ports whose contract is a format rather than a behaviour, and a format
    // that drifts silently invalidates every stored `contentHash`.
    expect(nodeDigest.sha256('')).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(nodeDigest.sha256('{"a":1}')).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Number.isInteger(systemClock.nowMs())).toBe(true);
  });
});
