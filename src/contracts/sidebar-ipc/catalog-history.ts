// Feature 101 (US4, T049) — the one new IPC command: read a past version's body.
//
// Everything about a definition's history rides the snapshot already, as
// metadata (FR-012). What does not, and must not, is the version *bodies*: a
// definition with fifty retained versions would put fifty bodies on every
// snapshot to serve the one an operator eventually opens. So a body is pulled
// on demand, on the acknowledgement, exactly as the phase-log, metrics,
// audit-pointer, and preflight reads already do (FR-012a).
//
// **A coordinate, never a path** (FR-034). The request names `(kind, id,
// versionId)` and there is no path field to fill — not as a convenience, but
// because the store is segment-addressed and a path on the wire would be a
// second way to name a record, one the store would then have to trust.
//
// The whole command is declared here rather than inline in the barrel because
// the barrel is at its LOC budget and this is the shape that keeps its footprint
// to the registration itself: the literal, the type entry, the union member, and
// the guard-map entry. The guard body lives with the shapes it checks.

import { CATALOG_KINDS } from '../catalog-store';
import type { CatalogKind, CatalogVersionId } from '../catalog-store';
import type { CMD_READ_DEFINITION_VERSION, CommandBase } from '../sidebar-ipc';

/**
 * Which version to read.
 *
 * A coordinate. No path crosses this boundary in either direction (FR-034).
 */
export interface ReadDefinitionVersionRequest {
  readonly kind: CatalogKind;
  readonly id: string;
  readonly versionId: CatalogVersionId;
}

export interface ReadDefinitionVersionCommand
  extends CommandBase<typeof CMD_READ_DEFINITION_VERSION> {
  readonly payload: ReadDefinitionVersionRequest;
}

/**
 * The version's body, verbatim, and nothing else.
 *
 * A closed shape with one field, which is what lets the response validator
 * (`../validators/catalog-history`) reject a path smuggled in beside the body
 * rather than ignoring it. There is no `versionId` echo here: the webview
 * correlates on the acknowledgement id and already knows what it asked for, and
 * a second copy of the coordinate would be a second thing that can disagree.
 */
export interface ReadDefinitionVersionResponse {
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * The discriminator, tied to the barrel's literal by the compiler.
 *
 * The barrel owns the `CMD_` literal — every command's does, and the drift test
 * enumerates `COMMAND_TYPES` from there. Importing it here as a *value* would
 * make this module and the barrel a runtime cycle, which no sibling sub-module
 * has and which the contracts barrel is the worst file in the host to introduce
 * one into. Importing it as a *type* and annotating a local constant with it
 * gets the same protection for free: change the barrel's literal and this line
 * stops compiling.
 */
const READ_DEFINITION_VERSION: typeof CMD_READ_DEFINITION_VERSION = 'CMD_READ_DEFINITION_VERSION';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The full command guard, registered in the barrel's `COMMAND_GUARDS`.
 *
 * Checks the payload, not just the envelope: all three fields choose which
 * record is opened, so an absent one must not reach the store as `undefined` and
 * be resolved into some other definition's history.
 */
export function isCmdReadDefinitionVersion(
  value: unknown
): value is ReadDefinitionVersionCommand {
  if (!isRecord(value) || value.type !== READ_DEFINITION_VERSION) return false;
  const payload = value.payload;
  if (!isRecord(payload)) return false;
  return (
    CATALOG_KINDS.some((kind) => kind === payload.kind)
    && isNonEmptyString(payload.id)
    && isNonEmptyString(payload.versionId)
  );
}
