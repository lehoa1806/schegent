// Zero-dependency Draft 2020-12 JSON Schema subset validator for FR-R7-05 (SC-003).
//
// Supports every keyword emitted by `scripts/contracts/emit-json-schema.mjs`:
// `$defs`, `$ref`, `type`, `const`, `enum`, `properties`, `required`,
// `additionalProperties`, `propertyNames`, `items`, `minItems`, `maxItems`,
// `uniqueItems`, `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`,
// `exclusiveMinimum`, `allOf`, `anyOf`, `oneOf`, `not`.

export interface JsonSchemaNode {
  readonly $defs?: Readonly<Record<string, JsonSchemaNode>>;
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchemaNode;
  readonly propertyNames?: JsonSchemaNode;
  readonly items?: JsonSchemaNode;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly allOf?: readonly JsonSchemaNode[];
  readonly anyOf?: readonly JsonSchemaNode[];
  readonly oneOf?: readonly JsonSchemaNode[];
  readonly not?: JsonSchemaNode;
}

export interface SchemaValidationFailure {
  readonly path: string;
  readonly message: string;
}

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly errors: readonly SchemaValidationFailure[];
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, idx) => deepEqual(item, b[idx]));
  }
  if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const aRec = a as Record<string, unknown>;
    const bRec = b as Record<string, unknown>;
    const aKeys = Object.keys(aRec);
    const bKeys = Object.keys(bRec);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => Object.hasOwn(bRec, key) && deepEqual(aRec[key], bRec[key]));
  }
  return false;
}

function matchesJsonType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    default:
      return false;
  }
}

const MAX_VALIDATION_DEPTH = 64;

function resolveRef(root: JsonSchemaNode, ref: string): JsonSchemaNode | null {
  if (!ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = root;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return null;
    if (!Object.hasOwn(current, part)) return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current !== null && typeof current === 'object' ? (current as JsonSchemaNode) : null;
}

function validateNode(
  root: JsonSchemaNode,
  schema: JsonSchemaNode,
  value: unknown,
  pointer: string,
  errors: SchemaValidationFailure[],
  depth = 0
): void {
  if (depth > MAX_VALIDATION_DEPTH) {
    errors.push({ path: pointer, message: `maximum schema recursion depth (${MAX_VALIDATION_DEPTH}) exceeded` });
    return;
  }
  if (schema.$ref !== undefined) {
    const target = resolveRef(root, schema.$ref);
    if (target === null) {
      errors.push({ path: pointer, message: `unresolved $ref: ${schema.$ref}` });
      return;
    }
    validateNode(root, target, value, pointer, errors, depth + 1);
    return;
  }

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push({ path: pointer, message: `expected const ${JSON.stringify(schema.const)}` });
    return;
  }

  if (schema.enum !== undefined && !schema.enum.some((entry) => deepEqual(value, entry))) {
    errors.push({ path: pointer, message: `value not in enum [${schema.enum.join(', ')}]` });
    return;
  }

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((kind) => matchesJsonType(value, kind))) {
      errors.push({ path: pointer, message: `expected type ${allowed.join('|')}` });
      return;
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path: pointer, message: `string length ${value.length} < minLength ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path: pointer, message: `string length ${value.length} > maxLength ${schema.maxLength}` });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path: pointer, message: `string does not match pattern ${schema.pattern}` });
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path: pointer, message: `number ${value} < minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path: pointer, message: `number ${value} > maximum ${schema.maximum}` });
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errors.push({ path: pointer, message: `number ${value} <= exclusiveMinimum ${schema.exclusiveMinimum}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path: pointer, message: `array length ${value.length} < minItems ${schema.minItems}` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path: pointer, message: `array length ${value.length} > maxItems ${schema.maxItems}` });
    }
    if (schema.uniqueItems === true) {
      for (let i = 0; i < value.length; i += 1) {
        for (let j = i + 1; j < value.length; j += 1) {
          if (deepEqual(value[i], value[j])) {
            errors.push({ path: `${pointer}/${j}`, message: 'duplicate array item violates uniqueItems' });
          }
        }
      }
    }
    if (schema.items !== undefined) {
      for (let i = 0; i < value.length; i += 1) {
        validateNode(root, schema.items, value[i], `${pointer}/${i}`, errors, depth + 1);
      }
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    if (schema.required !== undefined) {
      for (const reqKey of schema.required) {
        if (!Object.hasOwn(rec, reqKey) || rec[reqKey] === undefined) {
          errors.push({ path: `${pointer}/${reqKey}`, message: `missing required property '${reqKey}'` });
        }
      }
    }
    for (const [key, propVal] of Object.entries(rec)) {
      if (propVal === undefined) continue;
      if (schema.propertyNames !== undefined) {
        validateNode(root, schema.propertyNames, key, `${pointer}/${key}`, errors, depth + 1);
      }
      const propSchema =
        schema.properties !== undefined && Object.hasOwn(schema.properties, key)
          ? schema.properties[key]
          : undefined;
      if (propSchema !== undefined) {
        validateNode(root, propSchema, propVal, `${pointer}/${key}`, errors, depth + 1);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: `${pointer}/${key}`, message: `unexpected additional property '${key}'` });
      } else if (typeof schema.additionalProperties === 'object') {
        validateNode(root, schema.additionalProperties, propVal, `${pointer}/${key}`, errors, depth + 1);
      }
    }
  }

  if (schema.allOf !== undefined) {
    for (const sub of schema.allOf) {
      validateNode(root, sub, value, pointer, errors, depth + 1);
    }
  }

  if (schema.not !== undefined) {
    const local: SchemaValidationFailure[] = [];
    validateNode(root, schema.not, value, pointer, local, depth + 1);
    if (local.length === 0) {
      errors.push({ path: pointer, message: 'value matches a prohibited schema' });
    }
  }

  if (schema.anyOf !== undefined) {
    const branchErrors: SchemaValidationFailure[][] = [];
    let matched = false;
    for (const branch of schema.anyOf) {
      const local: SchemaValidationFailure[] = [];
      validateNode(root, branch, value, pointer, local, depth + 1);
      if (local.length === 0) {
        matched = true;
        break;
      }
      branchErrors.push(local);
    }
    if (!matched) {
      const sample = branchErrors[0]?.[0]?.message ?? 'no branch matched';
      errors.push({ path: pointer, message: `failed anyOf (${sample})` });
    }
  }

  if (schema.oneOf !== undefined) {
    let matches = 0;
    let firstBranchErr = 'no branch matched';
    for (const branch of schema.oneOf) {
      const local: SchemaValidationFailure[] = [];
      validateNode(root, branch, value, pointer, local, depth + 1);
      if (local.length === 0) {
        matches += 1;
      } else if (firstBranchErr === 'no branch matched') {
        const first = local.at(0);
        if (first !== undefined) {
          firstBranchErr = `${first.path}: ${first.message}`;
        }
      }
    }
    if (matches !== 1) {
      errors.push({
        path: pointer,
        message: matches === 0 ? `failed oneOf (${firstBranchErr})` : `matched ${matches} oneOf branches (expected 1)`
      });
    }
  }
}

export function validateAgainstSchema(
  rootSchema: JsonSchemaNode,
  value: unknown,
  targetRef?: string
): SchemaValidationResult {
  const errors: SchemaValidationFailure[] = [];
  const target = targetRef !== undefined ? { $ref: targetRef } : rootSchema;
  validateNode(rootSchema, target, value, '#', errors);
  return { valid: errors.length === 0, errors };
}
