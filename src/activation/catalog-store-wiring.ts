// Feature 099 (FR-R3-015) T493 — the store's four ports, built once for the host.
//
// This is the only module that pairs the store with VS Code. It holds the
// workspace root, the Node clock, the Node digest, and the Workspace Trust
// decision, so `src/catalog/` holds none of them (FR-057). Everything below the
// port boundary is pure and testable with stubs; everything impure is here.

import * as crypto from 'node:crypto';

import * as vscode from 'vscode';

import {
  createCatalogStore,
  runProvenanceNone,
  type CatalogStore,
  type Clock,
  type Digest
} from '../catalog';
import { CATALOG_DIRECTORY_SEGMENTS, createCatalogFsAdapter } from '../lib/catalog-fs-adapter';
import { getCanonicalWorkspaceRoot } from '../state/workspace-folder-picker';

/** Epoch milliseconds, the store's one time representation (FR-021a). */
export const systemClock: Clock = Object.freeze({
  nowMs: () => Date.now()
});

/** `sha256:<lowercase hex>` over the UTF-8 bytes of the canonical form (FR-012). */
export const nodeDigest: Digest = Object.freeze({
  sha256: (canonical: string) =>
    `sha256:${crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')}`
});

/**
 * Is the catalog allowed to activate at all?
 *
 * Feature 099 (T493, FR-051, FR-052) — Workspace Trust is the single gate the
 * collapse keeps, and it is kept for a reason the layer tier never addressed: a
 * cloned repository can contain a `.schegent/catalog/` directory, so activating
 * one in an untrusted workspace would execute definitions the operator has never
 * read. The two `allow*Overrides` settings that went with the layer tier gated
 * *which layer may redefine which*, a question that no longer exists (FR-045).
 *
 * Exported so the Builder can report the gate rather than an empty catalog: the
 * two states look identical from a snapshot alone, and "no catalog, and nobody
 * told you why" is the failure this distinction exists to prevent (FR-052).
 */
export function isCatalogActivationTrusted(): boolean {
  return vscode.workspace.isTrusted;
}

/**
 * The store, or `null` in an untrusted workspace.
 *
 * `null` rather than an empty store, because the two are different facts and the
 * surfaces report them differently (FR-052). A trusted workspace with no folder
 * open still gets a store: its reads report the empty catalog (FR-001a) and its
 * writes refuse `no-workspace` by name (FR-033a), which is more useful than a
 * second null to disambiguate downstream.
 */
export function createHostCatalogStore(): CatalogStore | null {
  if (!isCatalogActivationTrusted()) return null;
  return createCatalogStore({
    fs: createCatalogFsAdapter(catalogStoreRoot()),
    clock: systemClock,
    digest: nodeDigest,
    // Feature 099 (FR-038) — the exemption exists and is testable before the data
    // behind it does. FR-R3-018 replaces this with the real run-provenance reader.
    provenance: runProvenanceNone
  });
}

/**
 * The store root as an absolute path, or `null` with no workspace folder open.
 *
 * The one place in the feature where a workspace root and the store's segments
 * meet, and it hands the result straight to the fs adapter — which is the one
 * place that keeps it (FR-061).
 */
function catalogStoreRoot(): string | null {
  const folder = getCanonicalWorkspaceRoot();
  if (folder === undefined) return null;
  return vscode.Uri.joinPath(folder.uri, ...CATALOG_DIRECTORY_SEGMENTS).fsPath;
}
