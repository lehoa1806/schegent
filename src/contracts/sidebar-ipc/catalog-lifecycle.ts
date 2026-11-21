// Feature 100 (FR-R3-016) T507 — the lifecycle wire shapes.
//
// These replace the three whole-array layer saves (`catalog-save.ts`). A layer
// save carried every row of a kind and a diff-derived intent; a lifecycle command
// names **one definition** and **one operation**, so the intent is the command
// type itself and there is no diff to take (FR-051).
//
// Each payload IS the lifecycle-service request, reused rather than re-declared.
// A second declaration of the same five fields would be a second place for the
// wire and the service to drift, and the drift would be silent — both sides are
// structural. The one field that stays `unknown` is the definition body, which is
// the standing rule for catalog rows at this boundary: the store keeps bodies
// verbatim (099 FR-010) and the host validators narrow them.
//
// The predicates below therefore check the **control** fields only — which
// definition, which version, which staleness token. Those choose what gets
// written and gate the write, so a missing one must not reach the store as
// `undefined`. They deliberately do not inspect a body.
//
// Note the two neighbours: `../catalog-lifecycle` is the operation contract;
// `./catalog-lifecycle` (this file) is how those operations cross the webview
// boundary.

import type {
  DeactivateRequest,
  DiscardDraftRequest,
  PackagePublishRequest,
  PublishRequest,
  RestoreRequest,
  SaveDraftRequest
} from '../catalog-lifecycle';
import { CATALOG_KINDS, type CatalogKind } from '../catalog-store';

export type {
  SaveDefinitionDraftCommand,
  PublishDefinitionCommand,
  DeactivateDefinitionCommand,
  RestoreDefinitionVersionCommand,
  DiscardDefinitionDraftCommand,
  PublishPackageCommand
} from '../generated/sidebar-ipc-types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCatalogKind(value: unknown): value is CatalogKind {
  return CATALOG_KINDS.some((kind) => kind === value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The three fields every per-definition operation carries.
 *
 * `expectedDraftVersion` is a version id or the `NO_DRAFT` sentinel — both
 * strings, so a non-empty-string check is the whole of what is checkable here.
 * That is enough: the service compares the token against the manifest and refuses
 * a wrong one as stale (FR-014), which is exactly what a forged token gets.
 */
function isDefinitionTarget(payload: unknown): payload is Record<string, unknown> {
  return (
    isRecord(payload) &&
    isCatalogKind(payload.kind) &&
    isNonEmptyString(payload.id) &&
    isNonEmptyString(payload.expectedDraftVersion)
  );
}

export function isSaveDefinitionDraftPayload(payload: unknown): payload is SaveDraftRequest {
  if (!isDefinitionTarget(payload)) return false;
  // Presence, not shape. `body` is typed `unknown`, so an absent key and an
  // explicit `undefined` are the same to the type system but not to the store —
  // one is a caller that forgot the definition.
  if (!('body' in payload)) return false;
  return payload.note === undefined || typeof payload.note === 'string';
}

/** Publish, deactivate, and discard carry the target and nothing else. */
export function isDefinitionOperationPayload(
  payload: unknown
): payload is PublishRequest & DeactivateRequest & DiscardDraftRequest {
  return isDefinitionTarget(payload);
}

export function isRestoreDefinitionVersionPayload(payload: unknown): payload is RestoreRequest {
  return isDefinitionTarget(payload) && isNonEmptyString(payload.fromVersionId);
}

function isPackageLayer(layer: unknown): boolean {
  if (!isRecord(layer)) return false;
  if (!isCatalogKind(layer.kind)) return false;
  // Per-layer, retained from feature 099: one kind's revision gates one kind's
  // write, so two disjoint layers from one stale view do not collide (FR-036).
  if (!isNonEmptyString(layer.expectedRevision)) return false;
  if (!Array.isArray(layer.definitions)) return false;
  return layer.definitions.every(
    (definition) => isRecord(definition) && isNonEmptyString(definition.id) && 'body' in definition
  );
}

export function isPublishPackagePayload(payload: unknown): payload is PackagePublishRequest {
  if (!isRecord(payload)) return false;
  const { layers } = payload;
  return Array.isArray(layers) && layers.every(isPackageLayer);
}
