// GENERATED FILE — do not edit.
//
// Emitted from scripts/contracts/ipc-descriptors/catalog.mjs by scripts/generate-contract-schemas.mjs.
// Edit the descriptor and run: npm run contracts:generate

import {
  CMD_DEACTIVATE_DEFINITION,
  CMD_DISCARD_DEFINITION_DRAFT,
  CMD_EXPORT_PROCESS_YAML,
  CMD_PREFLIGHT_PROCESS_YAML,
  CMD_PUBLISH_DEFINITION,
  CMD_PUBLISH_PACKAGE,
  CMD_READ_DEFINITION_VERSION,
  CMD_RESTORE_DEFINITION_VERSION,
  CMD_SAVE_DEFINITION_DRAFT,
  type DeactivateDefinitionCommand,
  type DiscardDefinitionDraftCommand,
  type ExportProcessYamlCommand,
  type PreflightProcessYamlCommand,
  type PublishDefinitionCommand,
  type PublishPackageCommand,
  type ReadDefinitionVersionCommand,
  type RestoreDefinitionVersionCommand,
  type SaveDefinitionDraftCommand
} from '../../sidebar-ipc';
import { fail, hasUnexpectedKeys, ok, type IpcValidationResult } from '../../validators/shared';

export function validateSaveDefinitionDraft(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_SAVE_DEFINITION_DRAFT, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['kind', 'id', 'expectedDraftVersion', 'body', 'note'])) {
    return fail('invalid-payload', { type: CMD_SAVE_DEFINITION_DRAFT, correlationId });
  }
  const validated_kindRaw: unknown = validatedObj['kind'];
  if (!(validated_kindRaw === 'phase' || validated_kindRaw === 'workflow' || validated_kindRaw === 'pipeline')) {
    return fail('invalid-payload', { type: CMD_SAVE_DEFINITION_DRAFT, correlationId });
  }
  const validated_kind: 'phase' | 'workflow' | 'pipeline' = validated_kindRaw;
  const validated_idRaw: unknown = validatedObj['id'];
  if (typeof validated_idRaw !== 'string') {
    return fail('invalid-payload', { type: CMD_SAVE_DEFINITION_DRAFT, correlationId });
  }
  if (validated_idRaw.length < 1 || validated_idRaw.length > 64) {
    return fail('invalid-payload', { type: CMD_SAVE_DEFINITION_DRAFT, correlationId });
  }
  const validated_id: string = validated_idRaw;
  const validated_expectedDraftVersionRaw: unknown = validatedObj['expectedDraftVersion'];
  if (typeof validated_expectedDraftVersionRaw !== 'string') {
    return fail('invalid-payload', { type: CMD_SAVE_DEFINITION_DRAFT, correlationId });
  }
  if (validated_expectedDraftVersionRaw.length < 1 || validated_expectedDraftVersionRaw.length > 128) {
    return fail('invalid-payload', { type: CMD_SAVE_DEFINITION_DRAFT, correlationId });
  }
  const validated_expectedDraftVersion: string = validated_expectedDraftVersionRaw;
  if (!Object.hasOwn(validatedObj, 'body')) {
    return fail('invalid-payload', { type: CMD_SAVE_DEFINITION_DRAFT, correlationId });
  }
  const validated_body: unknown = validatedObj['body'];
  const validated_noteRaw: unknown = validatedObj['note'];
  let validated_note: string | undefined;
  if (validated_noteRaw !== undefined) {
    if (typeof validated_noteRaw !== 'string') {
      return fail('invalid-payload', { type: CMD_SAVE_DEFINITION_DRAFT, correlationId });
    }
    if (validated_noteRaw.length > 512) {
      return fail('invalid-payload', { type: CMD_SAVE_DEFINITION_DRAFT, correlationId });
    }
    const validated_noteChecked: string = validated_noteRaw;
    validated_note = validated_noteChecked;
  }
  const validated = { kind: validated_kind, id: validated_id, expectedDraftVersion: validated_expectedDraftVersion, body: validated_body, ...(validated_note === undefined ? {} : { note: validated_note }) };
  const command: SaveDefinitionDraftCommand = { type: CMD_SAVE_DEFINITION_DRAFT, correlationId, payload: validated };
  return ok(command);
}

export function validatePublishDefinition(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('invalid-payload', { type: CMD_PUBLISH_DEFINITION, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['kind', 'id', 'expectedDraftVersion'])) {
    return fail('invalid-payload', { type: CMD_PUBLISH_DEFINITION, correlationId });
  }
  const validated_kindRaw: unknown = validatedObj['kind'];
  if (!(validated_kindRaw === 'phase' || validated_kindRaw === 'workflow' || validated_kindRaw === 'pipeline')) {
    return fail('invalid-payload', { type: CMD_PUBLISH_DEFINITION, correlationId });
  }
  const validated_kind: 'phase' | 'workflow' | 'pipeline' = validated_kindRaw;
  const validated_idRaw: unknown = validatedObj['id'];
  if (typeof validated_idRaw !== 'string') {
    return fail('invalid-payload', { type: CMD_PUBLISH_DEFINITION, correlationId });
  }
  if (validated_idRaw.length < 1 || validated_idRaw.length > 64) {
    return fail('invalid-payload', { type: CMD_PUBLISH_DEFINITION, correlationId });
  }
  const validated_id: string = validated_idRaw;
  const validated_expectedDraftVersionRaw: unknown = validatedObj['expectedDraftVersion'];
  if (typeof validated_expectedDraftVersionRaw !== 'string') {
    return fail('invalid-payload', { type: CMD_PUBLISH_DEFINITION, correlationId });
  }
  if (validated_expectedDraftVersionRaw.length < 1 || validated_expectedDraftVersionRaw.length > 128) {
    return fail('invalid-payload', { type: CMD_PUBLISH_DEFINITION, correlationId });
  }
  const validated_expectedDraftVersion: string = validated_expectedDraftVersionRaw;
  const validated = { kind: validated_kind, id: validated_id, expectedDraftVersion: validated_expectedDraftVersion };
  const command: PublishDefinitionCommand = { type: CMD_PUBLISH_DEFINITION, correlationId, payload: validated };
  return ok(command);
}

export function validateDeactivateDefinition(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('invalid-payload', { type: CMD_DEACTIVATE_DEFINITION, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['kind', 'id', 'expectedDraftVersion'])) {
    return fail('invalid-payload', { type: CMD_DEACTIVATE_DEFINITION, correlationId });
  }
  const validated_kindRaw: unknown = validatedObj['kind'];
  if (!(validated_kindRaw === 'phase' || validated_kindRaw === 'workflow' || validated_kindRaw === 'pipeline')) {
    return fail('invalid-payload', { type: CMD_DEACTIVATE_DEFINITION, correlationId });
  }
  const validated_kind: 'phase' | 'workflow' | 'pipeline' = validated_kindRaw;
  const validated_idRaw: unknown = validatedObj['id'];
  if (typeof validated_idRaw !== 'string') {
    return fail('invalid-payload', { type: CMD_DEACTIVATE_DEFINITION, correlationId });
  }
  if (validated_idRaw.length < 1 || validated_idRaw.length > 64) {
    return fail('invalid-payload', { type: CMD_DEACTIVATE_DEFINITION, correlationId });
  }
  const validated_id: string = validated_idRaw;
  const validated_expectedDraftVersionRaw: unknown = validatedObj['expectedDraftVersion'];
  if (typeof validated_expectedDraftVersionRaw !== 'string') {
    return fail('invalid-payload', { type: CMD_DEACTIVATE_DEFINITION, correlationId });
  }
  if (validated_expectedDraftVersionRaw.length < 1 || validated_expectedDraftVersionRaw.length > 128) {
    return fail('invalid-payload', { type: CMD_DEACTIVATE_DEFINITION, correlationId });
  }
  const validated_expectedDraftVersion: string = validated_expectedDraftVersionRaw;
  const validated = { kind: validated_kind, id: validated_id, expectedDraftVersion: validated_expectedDraftVersion };
  const command: DeactivateDefinitionCommand = { type: CMD_DEACTIVATE_DEFINITION, correlationId, payload: validated };
  return ok(command);
}

export function validateRestoreDefinitionVersion(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_RESTORE_DEFINITION_VERSION, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['kind', 'id', 'expectedDraftVersion', 'fromVersionId'])) {
    return fail('invalid-payload', { type: CMD_RESTORE_DEFINITION_VERSION, correlationId });
  }
  const validated_kindRaw: unknown = validatedObj['kind'];
  if (!(validated_kindRaw === 'phase' || validated_kindRaw === 'workflow' || validated_kindRaw === 'pipeline')) {
    return fail('invalid-payload', { type: CMD_RESTORE_DEFINITION_VERSION, correlationId });
  }
  const validated_kind: 'phase' | 'workflow' | 'pipeline' = validated_kindRaw;
  const validated_idRaw: unknown = validatedObj['id'];
  if (typeof validated_idRaw !== 'string') {
    return fail('invalid-payload', { type: CMD_RESTORE_DEFINITION_VERSION, correlationId });
  }
  if (validated_idRaw.length < 1 || validated_idRaw.length > 64) {
    return fail('invalid-payload', { type: CMD_RESTORE_DEFINITION_VERSION, correlationId });
  }
  const validated_id: string = validated_idRaw;
  const validated_expectedDraftVersionRaw: unknown = validatedObj['expectedDraftVersion'];
  if (typeof validated_expectedDraftVersionRaw !== 'string') {
    return fail('invalid-payload', { type: CMD_RESTORE_DEFINITION_VERSION, correlationId });
  }
  if (validated_expectedDraftVersionRaw.length < 1 || validated_expectedDraftVersionRaw.length > 128) {
    return fail('invalid-payload', { type: CMD_RESTORE_DEFINITION_VERSION, correlationId });
  }
  const validated_expectedDraftVersion: string = validated_expectedDraftVersionRaw;
  const validated_fromVersionIdRaw: unknown = validatedObj['fromVersionId'];
  if (typeof validated_fromVersionIdRaw !== 'string') {
    return fail('invalid-payload', { type: CMD_RESTORE_DEFINITION_VERSION, correlationId });
  }
  if (validated_fromVersionIdRaw.length < 1 || validated_fromVersionIdRaw.length > 128) {
    return fail('invalid-payload', { type: CMD_RESTORE_DEFINITION_VERSION, correlationId });
  }
  const validated_fromVersionId: string = validated_fromVersionIdRaw;
  const validated = { kind: validated_kind, id: validated_id, expectedDraftVersion: validated_expectedDraftVersion, fromVersionId: validated_fromVersionId };
  const command: RestoreDefinitionVersionCommand = { type: CMD_RESTORE_DEFINITION_VERSION, correlationId, payload: validated };
  return ok(command);
}

export function validateDiscardDefinitionDraft(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('invalid-payload', { type: CMD_DISCARD_DEFINITION_DRAFT, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['kind', 'id', 'expectedDraftVersion'])) {
    return fail('invalid-payload', { type: CMD_DISCARD_DEFINITION_DRAFT, correlationId });
  }
  const validated_kindRaw: unknown = validatedObj['kind'];
  if (!(validated_kindRaw === 'phase' || validated_kindRaw === 'workflow' || validated_kindRaw === 'pipeline')) {
    return fail('invalid-payload', { type: CMD_DISCARD_DEFINITION_DRAFT, correlationId });
  }
  const validated_kind: 'phase' | 'workflow' | 'pipeline' = validated_kindRaw;
  const validated_idRaw: unknown = validatedObj['id'];
  if (typeof validated_idRaw !== 'string') {
    return fail('invalid-payload', { type: CMD_DISCARD_DEFINITION_DRAFT, correlationId });
  }
  if (validated_idRaw.length < 1 || validated_idRaw.length > 64) {
    return fail('invalid-payload', { type: CMD_DISCARD_DEFINITION_DRAFT, correlationId });
  }
  const validated_id: string = validated_idRaw;
  const validated_expectedDraftVersionRaw: unknown = validatedObj['expectedDraftVersion'];
  if (typeof validated_expectedDraftVersionRaw !== 'string') {
    return fail('invalid-payload', { type: CMD_DISCARD_DEFINITION_DRAFT, correlationId });
  }
  if (validated_expectedDraftVersionRaw.length < 1 || validated_expectedDraftVersionRaw.length > 128) {
    return fail('invalid-payload', { type: CMD_DISCARD_DEFINITION_DRAFT, correlationId });
  }
  const validated_expectedDraftVersion: string = validated_expectedDraftVersionRaw;
  const validated = { kind: validated_kind, id: validated_id, expectedDraftVersion: validated_expectedDraftVersion };
  const command: DiscardDefinitionDraftCommand = { type: CMD_DISCARD_DEFINITION_DRAFT, correlationId, payload: validated };
  return ok(command);
}

export function validatePublishPackage(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_PUBLISH_PACKAGE, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['layers'])) {
    return fail('invalid-payload', { type: CMD_PUBLISH_PACKAGE, correlationId });
  }
  const validated_layersRaw: unknown = validatedObj['layers'];
  if (!Array.isArray(validated_layersRaw) || validated_layersRaw.length < 1) {
    return fail('invalid-payload', { type: CMD_PUBLISH_PACKAGE, correlationId });
  }
  const validated_layers: {
  readonly kind: 'phase' | 'workflow' | 'pipeline';
  readonly expectedRevision: string;
  readonly definitions: readonly {
    readonly id: string;
    readonly body: unknown;
  }[];
}[] = [];
  for (const validated_layersEl of validated_layersRaw) {
    if (validated_layersEl === null || typeof validated_layersEl !== 'object' || Array.isArray(validated_layersEl)) {
      return fail('invalid-payload', { type: CMD_PUBLISH_PACKAGE, correlationId });
    }
    const validated_layersItemObj = validated_layersEl as Record<string, unknown>;
    if (hasUnexpectedKeys(validated_layersItemObj, ['kind', 'expectedRevision', 'definitions'])) {
      return fail('invalid-payload', { type: CMD_PUBLISH_PACKAGE, correlationId });
    }
    const validated_layersItem_kindRaw: unknown = validated_layersItemObj['kind'];
    if (!(validated_layersItem_kindRaw === 'phase' || validated_layersItem_kindRaw === 'workflow' || validated_layersItem_kindRaw === 'pipeline')) {
      return fail('invalid-payload', { type: CMD_PUBLISH_PACKAGE, correlationId });
    }
    const validated_layersItem_kind: 'phase' | 'workflow' | 'pipeline' = validated_layersItem_kindRaw;
    const validated_layersItem_expectedRevisionRaw: unknown = validated_layersItemObj['expectedRevision'];
    if (typeof validated_layersItem_expectedRevisionRaw !== 'string') {
      return fail('invalid-payload', { type: CMD_PUBLISH_PACKAGE, correlationId });
    }
    if (validated_layersItem_expectedRevisionRaw.length < 1 || validated_layersItem_expectedRevisionRaw.length > 128) {
      return fail('invalid-payload', { type: CMD_PUBLISH_PACKAGE, correlationId });
    }
    const validated_layersItem_expectedRevision: string = validated_layersItem_expectedRevisionRaw;
    const validated_layersItem_definitionsRaw: unknown = validated_layersItemObj['definitions'];
    if (!Array.isArray(validated_layersItem_definitionsRaw) || validated_layersItem_definitionsRaw.length < 1 || validated_layersItem_definitionsRaw.length > 500) {
      return fail('invalid-payload', { type: CMD_PUBLISH_PACKAGE, correlationId });
    }
    const validated_layersItem_definitions: {
  readonly id: string;
  readonly body: unknown;
}[] = [];
    for (const validated_layersItem_definitionsEl of validated_layersItem_definitionsRaw) {
      if (validated_layersItem_definitionsEl === null || typeof validated_layersItem_definitionsEl !== 'object' || Array.isArray(validated_layersItem_definitionsEl)) {
        return fail('invalid-payload', { type: CMD_PUBLISH_PACKAGE, correlationId });
      }
      const validated_layersItem_definitionsItemObj = validated_layersItem_definitionsEl as Record<string, unknown>;
      if (hasUnexpectedKeys(validated_layersItem_definitionsItemObj, ['id', 'body'])) {
        return fail('invalid-payload', { type: CMD_PUBLISH_PACKAGE, correlationId });
      }
      const validated_layersItem_definitionsItem_idRaw: unknown = validated_layersItem_definitionsItemObj['id'];
      if (typeof validated_layersItem_definitionsItem_idRaw !== 'string') {
        return fail('invalid-payload', { type: CMD_PUBLISH_PACKAGE, correlationId });
      }
      if (validated_layersItem_definitionsItem_idRaw.length < 1 || validated_layersItem_definitionsItem_idRaw.length > 64) {
        return fail('invalid-payload', { type: CMD_PUBLISH_PACKAGE, correlationId });
      }
      const validated_layersItem_definitionsItem_id: string = validated_layersItem_definitionsItem_idRaw;
      if (!Object.hasOwn(validated_layersItem_definitionsItemObj, 'body')) {
        return fail('invalid-payload', { type: CMD_PUBLISH_PACKAGE, correlationId });
      }
      const validated_layersItem_definitionsItem_body: unknown = validated_layersItem_definitionsItemObj['body'];
      const validated_layersItem_definitionsItem = { id: validated_layersItem_definitionsItem_id, body: validated_layersItem_definitionsItem_body };
      validated_layersItem_definitions.push(validated_layersItem_definitionsItem);
    }
    const validated_layersItem = { kind: validated_layersItem_kind, expectedRevision: validated_layersItem_expectedRevision, definitions: validated_layersItem_definitions };
    validated_layers.push(validated_layersItem);
  }
  const validated = { layers: validated_layers };
  const command: PublishPackageCommand = { type: CMD_PUBLISH_PACKAGE, correlationId, payload: validated };
  return ok(command);
}

export function validateReadDefinitionVersion(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_READ_DEFINITION_VERSION, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, ['kind', 'id', 'versionId'])) {
    return fail('unexpected-payload-fields', { type: CMD_READ_DEFINITION_VERSION, correlationId });
  }
  const validated_kindRaw: unknown = validatedObj['kind'];
  if (!(validated_kindRaw === 'phase' || validated_kindRaw === 'workflow')) {
    return fail('invalid-payload-field', { type: CMD_READ_DEFINITION_VERSION, correlationId });
  }
  const validated_kind: 'phase' | 'workflow' = validated_kindRaw;
  const validated_idRaw: unknown = validatedObj['id'];
  if (typeof validated_idRaw !== 'string') {
    return fail('invalid-payload-field', { type: CMD_READ_DEFINITION_VERSION, correlationId });
  }
  if (validated_idRaw.length < 1 || validated_idRaw.length > 64) {
    return fail('invalid-payload-field', { type: CMD_READ_DEFINITION_VERSION, correlationId });
  }
  const validated_id: string = validated_idRaw;
  const validated_versionIdRaw: unknown = validatedObj['versionId'];
  if (typeof validated_versionIdRaw !== 'string') {
    return fail('invalid-payload-field', { type: CMD_READ_DEFINITION_VERSION, correlationId });
  }
  if (validated_versionIdRaw.length < 1 || validated_versionIdRaw.length > 64) {
    return fail('invalid-payload-field', { type: CMD_READ_DEFINITION_VERSION, correlationId });
  }
  const validated_versionId: string = validated_versionIdRaw;
  const validated = { kind: validated_kind, id: validated_id, versionId: validated_versionId };
  const command: ReadDefinitionVersionCommand = { type: CMD_READ_DEFINITION_VERSION, correlationId, payload: validated };
  return ok(command);
}

export function validateExportProcessYaml(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
  }
  const pObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(pObj, ['resourceKind', 'resourceId', 'inclusion'])) {
    return fail('unexpected-payload-fields', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
  }
  const disc: unknown = pObj['resourceKind'];
  switch (disc) {
    case 'modelCatalog': {
      if (pObj['resourceId'] !== undefined) {
        return fail('unexpected-payload-fields', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
      }
      if (pObj['inclusion'] !== undefined) {
        return fail('invalid-inclusion', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
      }
      if (hasUnexpectedKeys(pObj, ['resourceKind'])) {
        return fail('unexpected-payload-fields', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
      }
      const command: ExportProcessYamlCommand = { type: CMD_EXPORT_PROCESS_YAML, correlationId, payload: { resourceKind: 'modelCatalog' } };
      return ok(command);
    }
    case 'phase': {
      if (pObj['inclusion'] !== undefined) {
        return fail('unexpected-payload-fields', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
      }
      if (hasUnexpectedKeys(pObj, ['resourceKind', 'resourceId'])) {
        return fail('unexpected-payload-fields', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
      }
      const arm_resourceIdRaw: unknown = pObj['resourceId'];
      if (typeof arm_resourceIdRaw !== 'string') {
        return fail('invalid-resource-id', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
      }
      if (arm_resourceIdRaw.length < 1) {
        return fail('invalid-resource-id', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
      }
      if (arm_resourceIdRaw.length > 64) {
        return fail('resource-id-too-long', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
      }
      const arm_resourceId: string = arm_resourceIdRaw;
      const command: ExportProcessYamlCommand = { type: CMD_EXPORT_PROCESS_YAML, correlationId, payload: { resourceKind: 'phase', resourceId: arm_resourceId } };
      return ok(command);
    }
    case 'workflow': {
      if (hasUnexpectedKeys(pObj, ['resourceKind', 'resourceId', 'inclusion'])) {
        return fail('unexpected-payload-fields', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
      }
      const arm_resourceIdRaw: unknown = pObj['resourceId'];
      if (typeof arm_resourceIdRaw !== 'string') {
        return fail('invalid-resource-id', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
      }
      if (arm_resourceIdRaw.length < 1) {
        return fail('invalid-resource-id', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
      }
      if (arm_resourceIdRaw.length > 64) {
        return fail('resource-id-too-long', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
      }
      const arm_resourceId: string = arm_resourceIdRaw;
      const arm_inclusionRaw: unknown = pObj['inclusion'];
      if (!(arm_inclusionRaw === 'references-only' || arm_inclusionRaw === 'include-closure')) {
        return fail('invalid-inclusion', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
      }
      const arm_inclusion: 'references-only' | 'include-closure' = arm_inclusionRaw;
      const command: ExportProcessYamlCommand = { type: CMD_EXPORT_PROCESS_YAML, correlationId, payload: { resourceKind: 'workflow', resourceId: arm_resourceId, inclusion: arm_inclusion } };
      return ok(command);
    }
    default:
      return fail('invalid-resource-kind', { type: CMD_EXPORT_PROCESS_YAML, correlationId });
  }
}

export function validatePreflightProcessYaml(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const rawPayload: unknown = obj['payload'];
  if (rawPayload === null || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return fail('missing-payload', { type: CMD_PREFLIGHT_PROCESS_YAML, correlationId });
  }
  const validatedObj = rawPayload as Record<string, unknown>;
  if (hasUnexpectedKeys(validatedObj, [])) {
    return fail('unexpected-payload-fields', { type: CMD_PREFLIGHT_PROCESS_YAML, correlationId });
  }
  const validated = {  };
  const command: PreflightProcessYamlCommand = { type: CMD_PREFLIGHT_PROCESS_YAML, correlationId, payload: validated };
  return ok(command);
}
