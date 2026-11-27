// Pure-ESM contract descriptor DSL for FR-R7-05 (Schema-derived IPC & snapshot contracts).
//
// Zero runtime dependencies: runs directly under Node ^22 || ^24 from
// `scripts/generate-contract-schemas.mjs` and never ships into runtime bundles.

/**
 * Normalize a bare SchemaNode or a FieldSpec object into a canonical FieldSpec.
 *
 * @param {object} spec
 */
export function normalizeField(spec) {
  if (spec && typeof spec === 'object' && spec.kind === 'field') {
    return spec;
  }
  return Object.freeze({
    kind: 'field',
    schema: spec,
    optional: false,
    nullable: false,
    webviewOptional: false,
    undefinable: false,
    presenceOnly: false
  });
}

export const d = Object.freeze({
  /** @param {object} [opts] */
  str(opts = {}) {
    return Object.freeze({ kind: 'string', ...opts });
  },

  /** @param {object} [opts] */
  int(opts = {}) {
    return Object.freeze({ kind: 'integer', safe: false, ...opts });
  },

  /** @param {object} [opts] */
  num(opts = {}) {
    return Object.freeze({ kind: 'number', finite: true, ...opts });
  },

  /** @param {object} [opts] */
  bool(opts = {}) {
    return Object.freeze({ kind: 'boolean', ...opts });
  },

  /** @param {string|number|boolean} value @param {object} [opts] */
  lit(value, opts = {}) {
    return Object.freeze({ kind: 'literal', value, ...opts });
  },

  /** @param {readonly string[]} values @param {object} [opts] */
  enum(values, opts = {}) {
    return Object.freeze({ kind: 'enum', values: Object.freeze([...values]), ...opts });
  },

  /** @param {object} item @param {object} [opts] */
  arr(item, opts = {}) {
    return Object.freeze({ kind: 'array', item, ...opts });
  },

  /** @param {object} value @param {object} [opts] */
  rec(value, opts = {}) {
    return Object.freeze({ kind: 'record', value, ...opts });
  },

  /** @param {Record<string, object>} fields @param {object} [opts] */
  obj(fields, opts = {}) {
    const normalized = {};
    for (const [key, spec] of Object.entries(fields)) {
      normalized[key] = normalizeField(spec);
    }
    return Object.freeze({
      kind: 'object',
      closed: true,
      allowArray: false,
      fields: Object.freeze(normalized),
      ...opts
    });
  },

  /** @param {string} discriminator @param {Record<string, object>} arms @param {object} [opts] */
  discUnion(discriminator, arms, opts = {}) {
    return Object.freeze({
      kind: 'discUnion',
      discriminator,
      arms: Object.freeze({ ...arms }),
      ...opts
    });
  },

  /** @param {readonly object[]} members @param {object} [opts] */
  union(members, opts = {}) {
    return Object.freeze({
      kind: 'union',
      members: Object.freeze([...members]),
      ...opts
    });
  },

  /** @param {readonly object[]} members @param {object} [opts] */
  oneOf(members, opts = {}) {
    return Object.freeze({
      kind: 'oneOf',
      members: Object.freeze([...members]),
      ...opts
    });
  },

  /** @param {object} [opts] */
  unknown(opts = {}) {
    return Object.freeze({ kind: 'unknown', ...opts });
  },

  /** @param {string} name @param {object} [opts] */
  ref(name, opts = {}) {
    return Object.freeze({ kind: 'ref', name, ...opts });
  },

  /** @param {object} schema @param {object} [opts] */
  field(schema, opts = {}) {
    return Object.freeze({
      kind: 'field',
      schema,
      optional: false,
      nullable: false,
      webviewOptional: false,
      undefinable: false,
      presenceOnly: false,
      ...opts
    });
  },

  /** @param {object} spec */
  command(spec) {
    return Object.freeze({
      kind: 'command',
      payloadMode: spec.payload ? 'required' : 'none',
      ...spec
    });
  },

  /** @param {object} spec */
  hostMessage(spec) {
    return Object.freeze({ kind: 'hostMessage', ...spec });
  },

  /** @param {object} spec */
  snapshotType(spec) {
    return Object.freeze({ kind: 'snapshotType', ...spec });
  }
});

export const SAFE_PATH_SEGMENT_PATTERN = '^(?!\\.$)(?!\\.\\.$)[A-Za-z0-9._-]+$';
export const RECORD_IDENTIFIER_PATTERN = '^(?!\\.$)(?!\\.\\.$)[A-Za-z0-9._-]{1,128}$';
export const BOUNDED_IDENTIFIER_PATTERN = '^(?!\\.$)(?!\\.\\.$)[A-Za-z0-9._:-]+$';
export const PRINTABLE_ASCII_PATTERN = '^[\\x21-\\x7e]+$';
export const BASE64URL_CURSOR_PATTERN = '^[A-Za-z0-9_-]+$';
