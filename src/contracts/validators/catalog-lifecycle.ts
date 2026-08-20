// Feature 100 (FR-R3-016) T509 — ingress validators for the six lifecycle commands.
//
// The successors to `save-phases.ts`, `save-pipelines.ts`, and `save-workflows.ts`,
// which validated a whole-array envelope and a mutation-intent tag. Neither exists
// any more: an operation addresses one definition and declares its intent by being
// the command it is (FR-051).
//
// What this layer checks is the **control** fields — which definition, at which
// token, from which version. Those choose what gets written and gate the write, so
// a missing one must never arrive at the store as `undefined`. Bodies are checked
// for presence and nothing else: the store takes a body verbatim and never
// validates it (099 FR-010), and a shape check here would be a second, weaker
// validator sitting in front of the real one in `src/config/`.
//
// Unexpected keys are refused rather than stripped, following every validator in
// this directory: an envelope carrying a field this host does not know about was
// built against a different contract, and quietly dropping it would let the two
// drift until the difference showed up as data loss.

import {
  CMD_DEACTIVATE_DEFINITION,
  CMD_DISCARD_DEFINITION_DRAFT,
  CMD_PUBLISH_DEFINITION,
  CMD_PUBLISH_PACKAGE,
  CMD_RESTORE_DEFINITION_VERSION,
  CMD_SAVE_DEFINITION_DRAFT,
  type SidebarCommand
} from '../sidebar-ipc';
import { CATALOG_KINDS, type CatalogKind } from '../catalog-store';
import type { ExpectedDraftVersion } from '../catalog-lifecycle';
import { fail, hasUnexpectedKeys, ok, type IpcValidationResult } from './shared';

const ID_MAX = 64;
const TOKEN_MAX = 128;
const NOTE_MAX = 512;
/** A package publish is an imported document, not a hand-built one. */
const LAYER_DEFINITIONS_MAX = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isKind(value: unknown): boolean {
  return CATALOG_KINDS.some((kind) => kind === value);
}

/** `kind`, `id`, `expectedDraftVersion` — the three every operation carries. */
function hasValidTarget(value: Record<string, unknown>): boolean {
  return (
    isKind(value.kind) &&
    isBoundedString(value.id, ID_MAX) &&
    isBoundedString(value.expectedDraftVersion, TOKEN_MAX)
  );
}

interface LifecycleTargetPayload {
  readonly kind: CatalogKind;
  readonly id: string;
  readonly expectedDraftVersion: ExpectedDraftVersion;
}

/** Only ever called behind {@link hasValidTarget}, which is what makes the narrowing sound. */
function target(value: Record<string, unknown>): LifecycleTargetPayload {
  return {
    kind: value.kind as CatalogKind,
    id: value.id as string,
    expectedDraftVersion: value.expectedDraftVersion as ExpectedDraftVersion
  };
}

function payloadOf(obj: Record<string, unknown>): Record<string, unknown> | null {
  const payload = obj.payload;
  return isRecord(payload) ? payload : null;
}

export function validateSaveDefinitionDraft(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const value = payloadOf(obj);
  if (!value) {
    return fail('missing-payload', { type: CMD_SAVE_DEFINITION_DRAFT, correlationId });
  }
  const invalid =
    hasUnexpectedKeys(value, ['kind', 'id', 'expectedDraftVersion', 'body', 'note']) ||
    !hasValidTarget(value) ||
    // Presence, not shape. `body: null` is a body an operator can author and the
    // store can hold; `body` absent is an envelope that forgot what it was saving.
    !('body' in value) ||
    (value.note !== undefined && (typeof value.note !== 'string' || value.note.length > NOTE_MAX));
  if (invalid) return fail('invalid-payload', { type: CMD_SAVE_DEFINITION_DRAFT, correlationId });
  return ok({
    type: CMD_SAVE_DEFINITION_DRAFT,
    correlationId,
    payload: {
      ...target(value),
      body: value.body,
      ...(value.note === undefined ? {} : { note: value.note })
    }
  } as SidebarCommand);
}

/**
 * The three operations whose payload is the target and nothing else.
 *
 * The *checking* is shared — three identical bodies under three names would be
 * three places for the target contract to drift — while each command builds its
 * own envelope, so a refusal names the command the operator actually sent and the
 * accepted command keeps its own literal type rather than a union of three.
 *
 * These collapse the `missing-payload` / `invalid-payload` distinction the other
 * validators draw: for a payload of three required fields, an absent payload and
 * an empty one are the same mistake and the same fix.
 */
function targetOnlyPayload(obj: Record<string, unknown>): LifecycleTargetPayload | null {
  const value = payloadOf(obj);
  if (!value) return null;
  if (hasUnexpectedKeys(value, ['kind', 'id', 'expectedDraftVersion'])) return null;
  return hasValidTarget(value) ? target(value) : null;
}

export function validatePublishDefinition(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = targetOnlyPayload(obj);
  if (!payload) return fail('invalid-payload', { type: CMD_PUBLISH_DEFINITION, correlationId });
  return ok({ type: CMD_PUBLISH_DEFINITION, correlationId, payload } as SidebarCommand);
}

export function validateDeactivateDefinition(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = targetOnlyPayload(obj);
  if (!payload) return fail('invalid-payload', { type: CMD_DEACTIVATE_DEFINITION, correlationId });
  return ok({ type: CMD_DEACTIVATE_DEFINITION, correlationId, payload } as SidebarCommand);
}

export function validateDiscardDefinitionDraft(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = targetOnlyPayload(obj);
  if (!payload) {
    return fail('invalid-payload', { type: CMD_DISCARD_DEFINITION_DRAFT, correlationId });
  }
  return ok({ type: CMD_DISCARD_DEFINITION_DRAFT, correlationId, payload } as SidebarCommand);
}

export function validateRestoreDefinitionVersion(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const value = payloadOf(obj);
  if (!value) {
    return fail('missing-payload', { type: CMD_RESTORE_DEFINITION_VERSION, correlationId });
  }
  const invalid =
    hasUnexpectedKeys(value, ['kind', 'id', 'expectedDraftVersion', 'fromVersionId']) ||
    !hasValidTarget(value) ||
    !isBoundedString(value.fromVersionId, TOKEN_MAX);
  if (invalid) {
    return fail('invalid-payload', { type: CMD_RESTORE_DEFINITION_VERSION, correlationId });
  }
  return ok({
    type: CMD_RESTORE_DEFINITION_VERSION,
    correlationId,
    payload: { ...target(value), fromVersionId: value.fromVersionId }
  } as SidebarCommand);
}

function validDefinition(value: unknown): boolean {
  return (
    isRecord(value) &&
    !hasUnexpectedKeys(value, ['id', 'body']) &&
    isBoundedString(value.id, ID_MAX) &&
    'body' in value
  );
}

function validLayer(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (hasUnexpectedKeys(value, ['kind', 'definitions', 'expectedRevision'])) return false;
  if (!isKind(value.kind)) return false;
  if (!isBoundedString(value.expectedRevision, TOKEN_MAX)) return false;
  if (!Array.isArray(value.definitions)) return false;
  if (value.definitions.length === 0 || value.definitions.length > LAYER_DEFINITIONS_MAX) {
    return false;
  }
  return value.definitions.every(validDefinition);
}

/**
 * The layer order is the caller's to get right (FR-035) and is deliberately not
 * checked here: the publish sequence reorders by kind rank itself, so a validator
 * that refused an out-of-order document would reject an envelope the host handles
 * correctly.
 */
export function validatePublishPackage(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const value = payloadOf(obj);
  if (!value) return fail('missing-payload', { type: CMD_PUBLISH_PACKAGE, correlationId });
  const { layers } = value;
  const invalid =
    hasUnexpectedKeys(value, ['layers']) ||
    !Array.isArray(layers) ||
    layers.length === 0 ||
    !layers.every(validLayer);
  if (invalid) return fail('invalid-payload', { type: CMD_PUBLISH_PACKAGE, correlationId });
  return ok({
    type: CMD_PUBLISH_PACKAGE,
    correlationId,
    payload: { layers }
  } as SidebarCommand);
}
