// Draft 2020-12 JSON Schema emitter for FR-R7-05.
//
// Produces full nested payload schemas for all 71 inbound commands,
// 3 host-to-webview push messages, and the WorkflowSnapshot + slices.

import {
  BASE64URL_CURSOR_PATTERN,
  BOUNDED_IDENTIFIER_PATTERN,
  PRINTABLE_ASCII_PATTERN,
  RECORD_IDENTIFIER_PATTERN,
  SAFE_PATH_SEGMENT_PATTERN
} from './descriptor-dsl.mjs';

/**
 * Convert a descriptor SchemaNode into a Draft 2020-12 JSON Schema object.
 *
 * @param {object} node
 * @returns {object}
 */
export function toJsonSchema(node) {
  if (!node || typeof node !== 'object') {
    return {};
  }

  const base = {};
  if (node.doc) base.description = node.doc.trim();

  switch (node.kind) {
    case 'string': {
      const schema = { ...base, type: 'string' };
      if (node.minLen !== undefined) schema.minLength = node.minLen;
      if (node.maxLen !== undefined) schema.maxLength = node.maxLen;
      if (node.format === 'safePathSegment') {
        schema.minLength = schema.minLength ?? 1;
        schema.maxLength = schema.maxLength ?? 256;
        schema.pattern = SAFE_PATH_SEGMENT_PATTERN;
      } else if (node.format === 'recordIdentifier') {
        schema.minLength = schema.minLength ?? 1;
        schema.maxLength = schema.maxLength ?? 128;
        schema.pattern = RECORD_IDENTIFIER_PATTERN;
      } else if (node.format === 'boundedIdentifier') {
        schema.minLength = schema.minLength ?? 1;
        schema.maxLength = schema.maxLength ?? 256;
        schema.pattern = BOUNDED_IDENTIFIER_PATTERN;
      } else if (node.format === 'printableAscii') {
        schema.pattern = PRINTABLE_ASCII_PATTERN;
      } else if (node.format === 'base64urlCursor') {
        schema.pattern = BASE64URL_CURSOR_PATTERN;
      } else if (node.pattern) {
        schema.pattern = node.pattern;
      }
      return schema;
    }

    case 'integer': {
      const schema = { ...base, type: 'integer' };
      if (node.min !== undefined) schema.minimum = node.min;
      if (node.max !== undefined) schema.maximum = node.max;
      return schema;
    }

    case 'number': {
      const schema = { ...base, type: 'number' };
      if (node.min !== undefined) schema.minimum = node.min;
      if (node.exclusiveMin !== undefined) schema.exclusiveMinimum = node.exclusiveMin;
      if (node.max !== undefined) schema.maximum = node.max;
      return schema;
    }

    case 'boolean':
      return { ...base, type: 'boolean' };

    case 'literal':
      return { ...base, const: node.value };

    case 'enum':
      return { ...base, type: 'string', enum: [...node.values] };

    case 'unknown':
      return { ...base };

    case 'ref':
      if (node.jsonSchema) return { ...base, ...node.jsonSchema };
      return { $ref: `#/$defs/${node.jsonRef ?? node.name}` };

    case 'array': {
      const schema = { ...base, type: 'array', items: toJsonSchema(node.item) };
      if (node.minItems !== undefined) schema.minItems = node.minItems;
      if (node.maxItems !== undefined) schema.maxItems = node.maxItems;
      if (node.unique) schema.uniqueItems = true;
      return schema;
    }

    case 'record': {
      if (node.keyEnum && node.keyEnum.length > 0) {
        const properties = {};
        for (const k of node.keyEnum) {
          properties[k] = toJsonSchema(node.value);
        }
        return {
          ...base,
          type: 'object',
          additionalProperties: false,
          required: [...node.keyEnum],
          properties
        };
      }
      return {
        ...base,
        type: 'object',
        additionalProperties: node.value.kind === 'unknown' ? true : toJsonSchema(node.value)
      };
    }

    case 'object': {
      const properties = {};
      const required = [];
      for (const [key, field] of Object.entries(node.fields)) {
        let propSchema = toJsonSchema(field.schema);
        if (field.nullable) {
          propSchema = { anyOf: [propSchema, { type: 'null' }] };
        }
        if (field.doc && !propSchema.description && !propSchema.$ref) {
          propSchema = { description: field.doc.trim(), ...propSchema };
        }
        properties[key] = propSchema;
        if (!field.optional && !field.undefinable) {
          required.push(key);
        }
      }
      const schema = {
        ...base,
        type: 'object',
        additionalProperties: node.closed === false,
        properties
      };
      if (required.length > 0) schema.required = required;
      return schema;
    }

    case 'discUnion':
      return {
        ...base,
        oneOf: Object.values(node.arms).map((arm) => toJsonSchema(arm))
      };

    case 'union':
      return {
        ...base,
        anyOf: node.members.map((m) => toJsonSchema(m))
      };

    default:
      throw new Error(`Unsupported descriptor kind in toJsonSchema: ${String(node.kind)}`);
  }
}

/**
 * Build the Draft 2020-12 envelope schema for one inbound command descriptor.
 *
 * @param {object} cmd
 * @returns {object}
 */
export function commandToJsonSchema(cmd) {
  const properties = {
    type: { const: cmd.type },
    correlationId: { type: 'string', minLength: 1, maxLength: 64 }
  };
  const required = ['type', 'correlationId'];

  if (cmd.payloadMode === 'required') {
    properties.payload = toJsonSchema(cmd.payload);
    required.push('payload');
  } else if (cmd.payloadMode === 'optional' || cmd.payloadMode === 'optional-empty-object') {
    properties.payload = toJsonSchema(cmd.payload);
  }

  return {
    ...(cmd.doc ? { description: cmd.doc.trim() } : {}),
    type: 'object',
    additionalProperties: false,
    required,
    properties
  };
}

/**
 * Build the complete payload-bearing `sidebar-ipc.schema.json` document.
 *
 * Preserves the four legacy top-level inventory properties (`schemaVersion`,
 * `commandTypes`, `hostMessageTypes`, `workflowSnapshotFields`) and adds
 * `snapshotSchemaVersion`, `commands`, `hostMessages`, `workflowSnapshot`,
 * and full nested `$defs`.
 *
 * @param {{
 *   generatedSchemaVersion: number,
 *   ipcSchemaVersion: number,
 *   snapshotSchemaVersion: number,
 *   commandTypes: readonly string[],
 *   hostMessageTypes: readonly string[],
 *   workflowSnapshotFields: readonly object[],
 *   commands: readonly object[],
 *   hostMessages: readonly object[],
 *   sharedDefs: Readonly<Record<string, object>>,
 *   snapshotDeclarations: readonly object[],
 *   sourceFiles: readonly string[]
 * }} spec
 */
export function buildSidebarIpcJsonSchema(spec) {
  const defs = {};

  for (const [name, node] of Object.entries(spec.sharedDefs).sort(([a], [b]) => a.localeCompare(b))) {
    defs[name] = toJsonSchema(node);
  }

  for (const decl of spec.snapshotDeclarations) {
    if (decl.hostSkip) continue;
    if (decl.intersectionBase && decl.jsonBaseFields) {
      const normalizedBase = {};
      for (const [k, v] of Object.entries(decl.jsonBaseFields)) {
        normalizedBase[k] = v && v.kind === 'field' ? v : { kind: 'field', schema: v };
      }
      const merged = {
        ...decl.schema,
        fields: { ...normalizedBase, ...decl.schema.fields }
      };
      defs[decl.name] = toJsonSchema(merged);
    } else {
      defs[decl.name] = toJsonSchema(decl.schema);
    }
  }

  const commandRefs = {};
  for (const cmd of spec.commands) {
    const defKey = `Command_${cmd.type}`;
    defs[defKey] = commandToJsonSchema(cmd);
    commandRefs[cmd.type] = { $ref: `#/$defs/${defKey}` };
  }

  const hostMessageRefs = {};
  for (const msg of spec.hostMessages) {
    const defKey = `HostMessage_${msg.type}`;
    defs[defKey] = toJsonSchema(msg.schema);
    hostMessageRefs[msg.type] = { $ref: `#/$defs/${defKey}` };
  }

  defs.InboundCommand = {
    oneOf: spec.commands.map((cmd) => ({ $ref: `#/$defs/Command_${cmd.type}` }))
  };
  defs.HostMessage = {
    oneOf: spec.hostMessages.map((msg) => ({ $ref: `#/$defs/HostMessage_${msg.type}` }))
  };

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://schegent.local/contracts/sidebar-ipc.schema.json',
    title: 'Schegent Sidebar IPC Contract',
    'x-generatedBy': 'scripts/generate-contract-schemas.mjs',
    'x-generatedSchemaVersion': spec.generatedSchemaVersion,
    'x-generatedFrom': [...spec.sourceFiles],
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'commandTypes', 'hostMessageTypes', 'workflowSnapshotFields'],
    properties: {
      schemaVersion: { type: 'integer', const: spec.ipcSchemaVersion },
      snapshotSchemaVersion: { type: 'integer', const: spec.snapshotSchemaVersion },
      commandTypes: {
        type: 'array',
        items: { type: 'string', enum: [...spec.commandTypes] },
        uniqueItems: true
      },
      hostMessageTypes: {
        type: 'array',
        items: { type: 'string', enum: [...spec.hostMessageTypes] },
        uniqueItems: true
      },
      workflowSnapshotFields: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'optional', 'type'],
          properties: {
            name: { type: 'string' },
            optional: { type: 'boolean' },
            type: { type: 'string' }
          }
        },
        default: spec.workflowSnapshotFields
      },
      commands: {
        type: 'object',
        additionalProperties: false,
        properties: commandRefs
      },
      hostMessages: {
        type: 'object',
        additionalProperties: false,
        properties: hostMessageRefs
      },
      workflowSnapshot: {
        $ref: '#/$defs/WorkflowSnapshot'
      }
    },
    $defs: defs
  };
}
