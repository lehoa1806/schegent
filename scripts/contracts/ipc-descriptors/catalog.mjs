// Family 6: catalog (9 commands)

import { d } from '../descriptor-dsl.mjs';
import { CATALOG_KINDS, CATALOG_LIFECYCLE_KINDS } from '../canonical-enums.mjs';

const ID_MAX = 64;
const TOKEN_MAX = 128;
const NOTE_MAX = 512;
const VERSION_ID_MAX = 64;
const LAYER_DEFINITIONS_MAX = 500;

const lifecycleTargetFields = () => ({
  kind: d.enum(CATALOG_LIFECYCLE_KINDS, { err: 'invalid-payload' }),
  id: d.str({ minLen: 1, maxLen: ID_MAX, err: 'invalid-payload' }),
  expectedDraftVersion: d.str({ minLen: 1, maxLen: TOKEN_MAX, err: 'invalid-payload' })
});

const publishPackageDefinition = d.obj(
  {
    id: d.str({ minLen: 1, maxLen: ID_MAX, err: 'invalid-payload' }),
    body: d.field(d.unknown({ presenceErr: 'invalid-payload' }), { presenceOnly: true })
  },
  { collapseInvalidErr: 'invalid-payload' }
);

const publishPackageLayer = d.obj(
  {
    kind: d.enum(CATALOG_LIFECYCLE_KINDS, { err: 'invalid-payload' }),
    expectedRevision: d.str({ minLen: 1, maxLen: TOKEN_MAX, err: 'invalid-payload' }),
    definitions: d.arr(publishPackageDefinition, {
      minItems: 1,
      maxItems: LAYER_DEFINITIONS_MAX,
      err: 'invalid-payload',
      itemErr: 'invalid-payload'
    })
  },
  { collapseInvalidErr: 'invalid-payload' }
);

export const CATALOG_COMMANDS = Object.freeze([
  d.command({
    type: 'CMD_SAVE_DEFINITION_DRAFT',
    interfaceName: 'SaveDefinitionDraftCommand',
    validatorName: 'validateSaveDefinitionDraft',
    family: 'catalog',
    emitInterface: false,
    doc: 'Save an authored draft body for one catalog definition.',
    payloadMode: 'required',
    payload: d.obj(
      {
        ...lifecycleTargetFields(),
        body: d.field(d.unknown({ presenceErr: 'invalid-payload' }), { presenceOnly: true }),
        note: d.field(d.str({ maxLen: NOTE_MAX, err: 'invalid-payload' }), { optional: true })
      },
      { collapseInvalidErr: 'invalid-payload', missingErr: 'missing-payload' }
    )
  }),

  d.command({
    type: 'CMD_PUBLISH_DEFINITION',
    interfaceName: 'PublishDefinitionCommand',
    validatorName: 'validatePublishDefinition',
    family: 'catalog',
    emitInterface: false,
    doc: 'Publish the current draft of one catalog definition.',
    payloadMode: 'required',
    payloadMissingErr: 'invalid-payload',
    payload: d.obj(lifecycleTargetFields(), {
      collapseInvalidErr: 'invalid-payload',
      missingErr: 'invalid-payload'
    })
  }),

  d.command({
    type: 'CMD_DEACTIVATE_DEFINITION',
    interfaceName: 'DeactivateDefinitionCommand',
    validatorName: 'validateDeactivateDefinition',
    family: 'catalog',
    emitInterface: false,
    doc: 'Deactivate one published catalog definition.',
    payloadMode: 'required',
    payloadMissingErr: 'invalid-payload',
    payload: d.obj(lifecycleTargetFields(), {
      collapseInvalidErr: 'invalid-payload',
      missingErr: 'invalid-payload'
    })
  }),

  d.command({
    type: 'CMD_RESTORE_DEFINITION_VERSION',
    interfaceName: 'RestoreDefinitionVersionCommand',
    validatorName: 'validateRestoreDefinitionVersion',
    family: 'catalog',
    emitInterface: false,
    doc: 'Copy a historical published version back into a draft.',
    payloadMode: 'required',
    payload: d.obj(
      {
        ...lifecycleTargetFields(),
        fromVersionId: d.str({ minLen: 1, maxLen: TOKEN_MAX, err: 'invalid-payload' })
      },
      { collapseInvalidErr: 'invalid-payload', missingErr: 'missing-payload' }
    )
  }),

  d.command({
    type: 'CMD_DISCARD_DEFINITION_DRAFT',
    interfaceName: 'DiscardDefinitionDraftCommand',
    validatorName: 'validateDiscardDefinitionDraft',
    family: 'catalog',
    emitInterface: false,
    doc: 'Discard an unpublished draft for one catalog definition.',
    payloadMode: 'required',
    payloadMissingErr: 'invalid-payload',
    payload: d.obj(lifecycleTargetFields(), {
      collapseInvalidErr: 'invalid-payload',
      missingErr: 'invalid-payload'
    })
  }),

  d.command({
    type: 'CMD_PUBLISH_PACKAGE',
    interfaceName: 'PublishPackageCommand',
    validatorName: 'validatePublishPackage',
    family: 'catalog',
    emitInterface: false,
    doc: 'Commit a multi-layer imported catalog package.',
    payloadMode: 'required',
    payload: d.obj(
      {
        layers: d.arr(publishPackageLayer, {
          minItems: 1,
          err: 'invalid-payload',
          itemErr: 'invalid-payload'
        })
      },
      { collapseInvalidErr: 'invalid-payload', missingErr: 'missing-payload' }
    )
  }),

  d.command({
    type: 'CMD_READ_DEFINITION_VERSION',
    interfaceName: 'ReadDefinitionVersionCommand',
    validatorName: 'validateReadDefinitionVersion',
    family: 'catalog',
    emitInterface: false,
    doc: 'Read a historical definition version body by (kind, id, versionId).',
    payloadMode: 'required',
    payload: d.obj({
      kind: d.enum(CATALOG_KINDS, { err: 'invalid-payload-field' }),
      id: d.str({ minLen: 1, maxLen: ID_MAX, err: 'invalid-payload-field' }),
      versionId: d.str({ minLen: 1, maxLen: VERSION_ID_MAX, err: 'invalid-payload-field' })
    })
  }),

  d.command({
    type: 'CMD_EXPORT_PROCESS_YAML',
    interfaceName: 'ExportProcessYamlCommand',
    validatorName: 'validateExportProcessYaml',
    family: 'catalog',
    emitInterface: false,
    doc: 'Export a Phase, Workflow, or Model Catalog to a host-dialog YAML file (never carries a path).',
    payloadMode: 'required',
    payload: d.discUnion(
      'resourceKind',
      {
        modelCatalog: d.obj(
          {
            resourceKind: d.lit('modelCatalog')
          },
          {
            forbiddenFields: {
              resourceId: 'unexpected-payload-fields',
              inclusion: 'invalid-inclusion'
            }
          }
        ),
        phase: d.obj(
          {
            resourceKind: d.lit('phase'),
            resourceId: d.str({
              minLen: 1,
              maxLen: ID_MAX,
              typeErr: 'invalid-resource-id',
              rangeErr: 'invalid-resource-id',
              maxErr: 'resource-id-too-long'
            })
          },
          {
            forbiddenFields: {
              inclusion: 'unexpected-payload-fields'
            }
          }
        ),
        workflow: d.obj({
          resourceKind: d.lit('workflow'),
          resourceId: d.str({
            minLen: 1,
            maxLen: ID_MAX,
            typeErr: 'invalid-resource-id',
            rangeErr: 'invalid-resource-id',
            maxErr: 'resource-id-too-long'
          }),
          inclusion: d.enum(['references-only', 'include-closure'], { err: 'invalid-inclusion' })
        })
      },
      {
        outerAllowedKeys: ['resourceKind', 'resourceId', 'inclusion'],
        invalidDiscErr: 'invalid-resource-kind'
      }
    )
  }),

  d.command({
    type: 'CMD_PREFLIGHT_PROCESS_YAML',
    interfaceName: 'PreflightProcessYamlCommand',
    validatorName: 'validatePreflightProcessYaml',
    family: 'catalog',
    emitInterface: false,
    doc: 'Open host dialog to preflight an imported process YAML document (empty payload only).',
    payloadMode: 'required',
    payload: d.obj({})
  })
]);
