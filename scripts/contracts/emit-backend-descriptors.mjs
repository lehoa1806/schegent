// FR-R7-06 — extracts pure static data from `src/contracts/backend-descriptors.ts` and
// `src/contracts/backend-kinds.ts`, validates `package.json` manifest parity, and emits
// the self-contained webview mirror `webview-ui/src/lib/generated/backend-descriptors.ts`.

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

function unwrap(node) {
  let current = node;
  while (
    ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  if (
    ts.isCallExpression(current)
    && ts.isPropertyAccessExpression(current.expression)
    && current.expression.getText() === 'Object.freeze'
    && current.arguments.length > 0
  ) {
    return unwrap(current.arguments[0]);
  }
  return current;
}

function evalPureLiteral(node, sourceFile, context) {
  const expr = unwrap(node);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }
  if (ts.isNumericLiteral(expr)) {
    return Number(expr.text);
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.map((el, idx) => evalPureLiteral(el, sourceFile, `${context}[${idx}]`));
  }
  if (ts.isObjectLiteralExpression(expr)) {
    const out = Object.create(null);
    for (const prop of expr.properties) {
      if (!ts.isPropertyAssignment(prop)) {
        throw new Error(`${context}: unsupported non-data property in BackendDescriptor (${prop.getText(sourceFile)})`);
      }
      const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)
        ? prop.name.text
        : prop.name.getText(sourceFile);
      out[key] = evalPureLiteral(prop.initializer, sourceFile, `${context}.${key}`);
    }
    return out;
  }
  throw new Error(
    `${context}: BackendDescriptor must be pure static data, found ${ts.SyntaxKind[expr.kind]} (${expr.getText(sourceFile)})`
  );
}

export function extractBackendDescriptorTable(repoRoot) {
  const kindsPath = path.join(repoRoot, 'src/contracts/backend-kinds.ts');
  const descriptorsPath = path.join(repoRoot, 'src/contracts/backend-descriptors.ts');

  const kindsText = fs.readFileSync(kindsPath, 'utf8');
  const kindsSf = ts.createSourceFile('src/contracts/backend-kinds.ts', kindsText, ts.ScriptTarget.Latest, true);
  let supportedBackends = null;
  let defaultBackend = null;
  let unionMembers = null;

  const collectUnion = (node) => {
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return [node.literal.text];
    if (ts.isUnionTypeNode(node)) return node.types.flatMap(collectUnion);
    return [];
  };

  const visitKinds = (node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'BackendRunnerKind') {
      unionMembers = collectUnion(node.type);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (node.name.text === 'SUPPORTED_BACKENDS') {
        supportedBackends = evalPureLiteral(node.initializer, kindsSf, 'SUPPORTED_BACKENDS');
      }
      if (node.name.text === 'DEFAULT_BACKEND') {
        defaultBackend = evalPureLiteral(node.initializer, kindsSf, 'DEFAULT_BACKEND');
      }
    }
    ts.forEachChild(node, visitKinds);
  };
  visitKinds(kindsSf);

  if (!Array.isArray(supportedBackends) || supportedBackends.length === 0) {
    throw new Error('src/contracts/backend-kinds.ts: missing SUPPORTED_BACKENDS');
  }
  if (typeof defaultBackend !== 'string') {
    throw new Error('src/contracts/backend-kinds.ts: missing DEFAULT_BACKEND');
  }
  if (!Array.isArray(unionMembers) || unionMembers.length === 0) {
    throw new Error('src/contracts/backend-kinds.ts: missing BackendRunnerKind union');
  }

  const descText = fs.readFileSync(descriptorsPath, 'utf8');
  const descSf = ts.createSourceFile('src/contracts/backend-descriptors.ts', descText, ts.ScriptTarget.Latest, true);
  let descriptors = null;
  const visitDesc = (node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === 'BACKEND_DESCRIPTORS'
      && node.initializer
    ) {
      descriptors = evalPureLiteral(node.initializer, descSf, 'BACKEND_DESCRIPTORS');
      return;
    }
    ts.forEachChild(node, visitDesc);
  };
  visitDesc(descSf);

  if (!descriptors || typeof descriptors !== 'object') {
    throw new Error('src/contracts/backend-descriptors.ts: missing BACKEND_DESCRIPTORS');
  }

  return {
    unionMembers,
    supportedBackends,
    defaultBackend,
    descriptors
  };
}

function sameArray(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * FR-R7-06 (FR-006): validates that `package.json` manifest enums, defaults, CLI path keys,
 * ACP profile enums, and `BACKEND_DESCRIPTORS` all agree with `SUPPORTED_BACKENDS` in order.
 */
export function validateBackendManifestParity({
  unionMembers,
  supportedBackends,
  defaultBackend,
  descriptors,
  packageJson
}) {
  const errors = [];
  const descriptorKeys = Object.keys(descriptors);

  if (!sameArray(unionMembers, supportedBackends)) {
    errors.push(
      `BackendRunnerKind union [${unionMembers.join(', ')}] does not match SUPPORTED_BACKENDS [${supportedBackends.join(', ')}]`
    );
  }
  if (!sameArray(descriptorKeys, supportedBackends)) {
    errors.push(
      `BACKEND_DESCRIPTORS keys [${descriptorKeys.join(', ')}] do not match SUPPORTED_BACKENDS [${supportedBackends.join(', ')}] in order`
    );
  }

  const props = packageJson?.contributes?.configuration?.properties ?? {};

  const runnerProp = props['schegent.backend.runner'];
  if (!runnerProp || !sameArray(runnerProp.enum, supportedBackends)) {
    errors.push(
      `package.json schegent.backend.runner.enum [${(runnerProp?.enum ?? []).join(', ')}] does not match BACKEND_DESCRIPTORS order [${supportedBackends.join(', ')}]`
    );
  }
  if (runnerProp?.default !== defaultBackend) {
    errors.push(
      `package.json schegent.backend.runner.default (${String(runnerProp?.default)}) !== DEFAULT_BACKEND (${defaultBackend})`
    );
  }

  const uncontainedProp = props['schegent.backend.uncontainedBackends'];
  if (!sameArray(uncontainedProp?.items?.enum, supportedBackends)) {
    errors.push(
      `package.json schegent.backend.uncontainedBackends.items.enum [${(uncontainedProp?.items?.enum ?? []).join(', ')}] does not match BACKEND_DESCRIPTORS order [${supportedBackends.join(', ')}]`
    );
  }

  const modelsDefault = props['schegent.models']?.default;
  const modelsKeys = modelsDefault && typeof modelsDefault === 'object' ? Object.keys(modelsDefault) : [];
  if (!sameArray(modelsKeys, supportedBackends)) {
    errors.push(
      `package.json schegent.models.default keys [${modelsKeys.join(', ')}] do not match BACKEND_DESCRIPTORS order [${supportedBackends.join(', ')}]`
    );
  }

  for (const kind of supportedBackends) {
    if (!Object.prototype.hasOwnProperty.call(descriptors, kind)) continue;
    const desc = descriptors[kind];
    if (desc.kind !== kind) {
      errors.push(`BACKEND_DESCRIPTORS.${kind}.kind (${String(desc.kind)}) !== '${kind}'`);
    }
    const fullKey = `schegent.${desc.cliPathSettingKey}`;
    const pathProp = props[fullKey];
    if (!pathProp) {
      errors.push(`package.json missing CLI path setting ${fullKey} declared by BACKEND_DESCRIPTORS.${kind}`);
    } else if (pathProp.default !== desc.defaultCliBinary) {
      errors.push(
        `package.json ${fullKey}.default (${String(pathProp.default)}) !== BACKEND_DESCRIPTORS.${kind}.defaultCliBinary (${desc.defaultCliBinary})`
      );
    }
  }

  const expectedAcpProfiles = [
    'auto',
    ...supportedBackends
      .map((kind) => (Object.prototype.hasOwnProperty.call(descriptors, kind) ? descriptors[kind]?.acpProfile?.profileId : undefined))
      .filter(Boolean)
      .sort()
  ];
  const actualAcpProfiles = props['schegent.acp.profile']?.enum ?? [];
  if (!sameArray(actualAcpProfiles, expectedAcpProfiles)) {
    errors.push(
      `package.json schegent.acp.profile.enum [${actualAcpProfiles.join(', ')}] !== expected [${expectedAcpProfiles.join(', ')}]`
    );
  }

  if (errors.length > 0) {
    throw new Error(`Backend descriptor manifest parity failed:\n- ${errors.join('\n- ')}`);
  }
}

function propertyKeyName(nameNode, sourceFile) {
  if (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)) {
    return nameNode.text;
  }
  return nameNode.getText(sourceFile);
}

function getObjectFieldNodes(objLiteral, sourceFile) {
  const fields = new Map();
  for (const prop of objLiteral.properties) {
    if (ts.isPropertyAssignment(prop)) {
      fields.set(propertyKeyName(prop.name, sourceFile), prop.initializer);
    }
  }
  return fields;
}

function evalSettingsExpr(node, sourceFile, bindings, context) {
  const expr = unwrap(node);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }
  if (ts.isNumericLiteral(expr)) {
    return Number(expr.text);
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(expr)) {
    if (Object.prototype.hasOwnProperty.call(bindings, expr.text)) {
      return bindings[expr.text];
    }
    throw new Error(`${context}: unresolved identifier '${expr.text}'`);
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const target = evalSettingsExpr(expr.expression, sourceFile, bindings, context);
    if (target === null || target === undefined || typeof target !== 'object') {
      throw new Error(`${context}: cannot access .${expr.name.text} on ${String(target)}`);
    }
    if (!Object.prototype.hasOwnProperty.call(target, expr.name.text)) {
      throw new Error(`${context}: missing property '${expr.name.text}'`);
    }
    return target[expr.name.text];
  }
  if (ts.isArrayLiteralExpression(expr)) {
    const out = [];
    for (const el of expr.elements) {
      if (ts.isSpreadElement(el)) {
        const spreadVal = evalSettingsExpr(el.expression, sourceFile, bindings, context);
        if (!Array.isArray(spreadVal)) {
          throw new Error(`${context}: spread operand is not an array`);
        }
        out.push(...spreadVal);
      } else {
        out.push(evalSettingsExpr(el, sourceFile, bindings, context));
      }
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(expr)) {
    const out = Object.create(null);
    for (const prop of expr.properties) {
      if (!ts.isPropertyAssignment(prop)) {
        throw new Error(`${context}: unsupported property syntax (${prop.getText(sourceFile)})`);
      }
      const key = propertyKeyName(prop.name, sourceFile);
      out[key] = evalSettingsExpr(prop.initializer, sourceFile, bindings, `${context}.${key}`);
    }
    return out;
  }
  if (ts.isCallExpression(expr)) {
    if (ts.isIdentifier(expr.expression) && expr.expression.text === 'emptyBackendModels' && expr.arguments.length === 0) {
      return bindings.emptyBackendModels();
    }
    if (ts.isPropertyAccessExpression(expr.expression)) {
      const receiver = evalSettingsExpr(expr.expression.expression, sourceFile, bindings, context);
      const method = expr.expression.name.text;
      if (method === 'map' && Array.isArray(receiver) && expr.arguments.length === 1) {
        const cb = unwrap(expr.arguments[0]);
        if (ts.isArrowFunction(cb) && cb.parameters.length === 1 && ts.isIdentifier(cb.parameters[0].name) && !ts.isBlock(cb.body)) {
          const paramName = cb.parameters[0].name.text;
          return receiver.map((item) =>
            evalSettingsExpr(cb.body, sourceFile, { ...bindings, [paramName]: item }, `${context}.map`)
          );
        }
      }
      if (method === 'sort' && Array.isArray(receiver) && expr.arguments.length === 0) {
        return [...receiver].sort();
      }
    }
  }
  throw new Error(`${context}: unsupported expression (${expr.getText(sourceFile)})`);
}

function evalFieldOrError(fields, fieldName, sourceFile, bindings, errors, context) {
  const node = fields.get(fieldName);
  if (!node) {
    errors.push(`${context}: missing required field '${fieldName}'`);
    return { present: false, node: null, value: undefined };
  }
  try {
    return {
      present: true,
      node,
      value: evalSettingsExpr(node, sourceFile, bindings, `${context}.${fieldName}`)
    };
  } catch (err) {
    errors.push(`${context}.${fieldName}: ${err instanceof Error ? err.message : String(err)}`);
    return { present: true, node, value: undefined };
  }
}

function sameModelsMap(a, b, keys) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
  if (!sameArray(Object.keys(a), keys) || !sameArray(Object.keys(b), keys)) return false;
  return keys.every((k) => sameArray(a[k], b[k]));
}

/**
 * FR-R7-06 / FR-R7-11 (FR-006): validates that `src/config/settings-schema.ts` both derives
 * and evaluates effective backend-valued settings metadata (`schegent.backend.runner`,
 * `schegent.backend.uncontainedBackends`, `schegent.models`, `schegent.acp.profile`, and every
 * `schegent.<cliPathSettingKey>`) in lockstep with `BACKEND_DESCRIPTORS` and `package.json`.
 */
export function validateSettingsSchemaParity(
  repoRoot,
  { supportedBackends, defaultBackend, descriptors, packageJson, schemaText }
) {
  const effectiveDefaultBackend = defaultBackend ?? supportedBackends[0];
  const resolvedSchemaText =
    schemaText ?? fs.readFileSync(path.join(repoRoot, 'src/config/settings-schema.ts'), 'utf8');
  const sf = ts.createSourceFile(
    'src/config/settings-schema.ts',
    resolvedSchemaText,
    ts.ScriptTarget.Latest,
    true
  );

  let schemaObj = null;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === 'SETTINGS_SCHEMA'
      && node.initializer
    ) {
      const expr = unwrap(node.initializer);
      if (ts.isObjectLiteralExpression(expr)) schemaObj = expr;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (!schemaObj) {
    throw new Error('src/config/settings-schema.ts: missing SETTINGS_SCHEMA object literal');
  }

  const entryObjByKey = new Map();
  for (const prop of schemaObj.properties) {
    if (ts.isPropertyAssignment(prop) && (ts.isStringLiteral(prop.name) || ts.isIdentifier(prop.name))) {
      const init = unwrap(prop.initializer);
      if (ts.isObjectLiteralExpression(init)) {
        entryObjByKey.set(prop.name.text, init);
      }
    }
  }

  const descriptorList = supportedBackends
    .filter((kind) => Object.prototype.hasOwnProperty.call(descriptors, kind))
    .map((kind) => descriptors[kind]);
  const expectedModelsDefault = Object.fromEntries(supportedBackends.map((kind) => [kind, []]));
  const expectedAcpProfiles = [
    'auto',
    ...descriptorList
      .map((desc) => desc?.acpProfile?.profileId)
      .filter(Boolean)
      .sort()
  ];
  const bindings = {
    SUPPORTED_BACKENDS: [...supportedBackends],
    DEFAULT_BACKEND: effectiveDefaultBackend,
    BACKEND_DESCRIPTORS: descriptors,
    BACKEND_DESCRIPTOR_LIST: descriptorList,
    emptyBackendModels: () => Object.fromEntries(supportedBackends.map((kind) => [kind, []]))
  };
  const pkgProps = packageJson?.contributes?.configuration?.properties ?? null;
  const errors = [];

  // 1. schegent.backend.runner
  const runnerObj = entryObjByKey.get('schegent.backend.runner');
  if (!runnerObj) {
    errors.push('src/config/settings-schema.ts: missing schegent.backend.runner entry');
  } else {
    const fields = getObjectFieldNodes(runnerObj, sf);
    const runnerType = evalFieldOrError(fields, 'type', sf, bindings, errors, 'schegent.backend.runner');
    const runnerScope = evalFieldOrError(fields, 'scope', sf, bindings, errors, 'schegent.backend.runner');
    const runnerEnum = evalFieldOrError(fields, 'enum', sf, bindings, errors, 'schegent.backend.runner');
    const runnerDefault = evalFieldOrError(fields, 'default', sf, bindings, errors, 'schegent.backend.runner');
    if (runnerType.value !== 'enum') {
      errors.push(`schegent.backend.runner.type (${String(runnerType.value)}) !== 'enum'`);
    }
    if (runnerScope.value !== 'application') {
      errors.push(`schegent.backend.runner.scope (${String(runnerScope.value)}) !== 'application'`);
    }
    if (!runnerEnum.node || !/\bSUPPORTED_BACKENDS\b/.test(runnerEnum.node.getText(sf))) {
      errors.push('src/config/settings-schema.ts: schegent.backend.runner.enum must reference SUPPORTED_BACKENDS');
    }
    if (!sameArray(runnerEnum.value, supportedBackends)) {
      errors.push(
        `schegent.backend.runner.enum [${Array.isArray(runnerEnum.value) ? runnerEnum.value.join(', ') : String(runnerEnum.value)}] !== SUPPORTED_BACKENDS [${supportedBackends.join(', ')}]`
      );
    }
    if (!runnerDefault.node || !/\bDEFAULT_BACKEND\b/.test(runnerDefault.node.getText(sf))) {
      errors.push('src/config/settings-schema.ts: schegent.backend.runner.default must reference DEFAULT_BACKEND');
    }
    if (runnerDefault.value !== effectiveDefaultBackend) {
      errors.push(
        `schegent.backend.runner.default (${String(runnerDefault.value)}) !== DEFAULT_BACKEND (${effectiveDefaultBackend})`
      );
    }
    if (pkgProps) {
      const pkgRunner = pkgProps['schegent.backend.runner'];
      if (!sameArray(runnerEnum.value, pkgRunner?.enum)) {
        errors.push('schegent.backend.runner.enum disagrees with package.json');
      }
      if (runnerDefault.value !== pkgRunner?.default) {
        errors.push('schegent.backend.runner.default disagrees with package.json');
      }
    }
  }

  // 2. schegent.backend.uncontainedBackends
  const uncontainedObj = entryObjByKey.get('schegent.backend.uncontainedBackends');
  if (!uncontainedObj) {
    errors.push('src/config/settings-schema.ts: missing schegent.backend.uncontainedBackends entry');
  } else {
    const fields = getObjectFieldNodes(uncontainedObj, sf);
    const entryType = evalFieldOrError(fields, 'type', sf, bindings, errors, 'schegent.backend.uncontainedBackends');
    const itemType = evalFieldOrError(fields, 'itemType', sf, bindings, errors, 'schegent.backend.uncontainedBackends');
    const itemEnum = evalFieldOrError(fields, 'itemEnum', sf, bindings, errors, 'schegent.backend.uncontainedBackends');
    const entryDefault = evalFieldOrError(fields, 'default', sf, bindings, errors, 'schegent.backend.uncontainedBackends');
    const entryScope = evalFieldOrError(fields, 'scope', sf, bindings, errors, 'schegent.backend.uncontainedBackends');
    if (entryType.value !== 'array') {
      errors.push(`schegent.backend.uncontainedBackends.type (${String(entryType.value)}) !== 'array'`);
    }
    if (itemType.value !== 'string') {
      errors.push(`schegent.backend.uncontainedBackends.itemType (${String(itemType.value)}) !== 'string'`);
    }
    if (entryScope.value !== 'application') {
      errors.push(`schegent.backend.uncontainedBackends.scope (${String(entryScope.value)}) !== 'application'`);
    }
    if (!sameArray(entryDefault.value, [])) {
      errors.push('schegent.backend.uncontainedBackends.default must be []');
    }
    if (!itemEnum.node || !/\bSUPPORTED_BACKENDS\b/.test(itemEnum.node.getText(sf))) {
      errors.push('src/config/settings-schema.ts: schegent.backend.uncontainedBackends.itemEnum must reference SUPPORTED_BACKENDS');
    }
    if (!sameArray(itemEnum.value, supportedBackends)) {
      errors.push(
        `schegent.backend.uncontainedBackends.itemEnum [${Array.isArray(itemEnum.value) ? itemEnum.value.join(', ') : String(itemEnum.value)}] !== SUPPORTED_BACKENDS [${supportedBackends.join(', ')}]`
      );
    }
    if (pkgProps) {
      const pkgUncontained = pkgProps['schegent.backend.uncontainedBackends'];
      if (!sameArray(itemEnum.value, pkgUncontained?.items?.enum)) {
        errors.push('schegent.backend.uncontainedBackends.itemEnum disagrees with package.json items.enum');
      }
    }
  }

  // 3. schegent.models
  const modelsObj = entryObjByKey.get('schegent.models');
  if (!modelsObj) {
    errors.push('src/config/settings-schema.ts: missing schegent.models entry');
  } else {
    const fields = getObjectFieldNodes(modelsObj, sf);
    const modelsType = evalFieldOrError(fields, 'type', sf, bindings, errors, 'schegent.models');
    const modelsDefault = evalFieldOrError(fields, 'default', sf, bindings, errors, 'schegent.models');
    if (modelsType.value !== 'object') {
      errors.push(`schegent.models.type (${String(modelsType.value)}) !== 'object'`);
    }
    if (!modelsDefault.node || !/\bemptyBackendModels\s*\(\s*\)/.test(modelsDefault.node.getText(sf))) {
      errors.push('src/config/settings-schema.ts: schegent.models.default must call emptyBackendModels()');
    }
    if (!sameModelsMap(modelsDefault.value, expectedModelsDefault, supportedBackends)) {
      errors.push('schegent.models.default does not match emptyBackendModels() in SUPPORTED_BACKENDS order');
    }
    if (pkgProps) {
      const pkgModels = pkgProps['schegent.models']?.default;
      if (!sameModelsMap(modelsDefault.value, pkgModels, supportedBackends)) {
        errors.push('schegent.models.default disagrees with package.json');
      }
    }
  }

  // 4. schegent.acp.profile
  const acpObj = entryObjByKey.get('schegent.acp.profile');
  if (!acpObj) {
    errors.push('src/config/settings-schema.ts: missing schegent.acp.profile entry');
  } else {
    const fields = getObjectFieldNodes(acpObj, sf);
    const acpType = evalFieldOrError(fields, 'type', sf, bindings, errors, 'schegent.acp.profile');
    const acpDefault = evalFieldOrError(fields, 'default', sf, bindings, errors, 'schegent.acp.profile');
    const acpEnum = evalFieldOrError(fields, 'enum', sf, bindings, errors, 'schegent.acp.profile');
    if (acpType.value !== 'enum') {
      errors.push(`schegent.acp.profile.type (${String(acpType.value)}) !== 'enum'`);
    }
    if (acpDefault.value !== 'auto') {
      errors.push(`schegent.acp.profile.default (${String(acpDefault.value)}) !== 'auto'`);
    }
    if (!acpEnum.node || !/\bBACKEND_DESCRIPTOR_LIST\b/.test(acpEnum.node.getText(sf))) {
      errors.push('src/config/settings-schema.ts: schegent.acp.profile.enum must derive from BACKEND_DESCRIPTOR_LIST');
    }
    if (!sameArray(acpEnum.value, expectedAcpProfiles)) {
      errors.push(
        `schegent.acp.profile.enum [${Array.isArray(acpEnum.value) ? acpEnum.value.join(', ') : String(acpEnum.value)}] !== expected [${expectedAcpProfiles.join(', ')}]`
      );
    }
    if (pkgProps) {
      const pkgAcp = pkgProps['schegent.acp.profile'];
      if (!sameArray(acpEnum.value, pkgAcp?.enum)) {
        errors.push('schegent.acp.profile.enum disagrees with package.json');
      }
    }
  }

  // 5. Per-backend CLI path settings (schegent.<cliPathSettingKey>)
  for (const kind of supportedBackends) {
    if (!Object.prototype.hasOwnProperty.call(descriptors, kind)) continue;
    const desc = descriptors[kind];
    const fullKey = `schegent.${desc.cliPathSettingKey}`;
    const entryObj = entryObjByKey.get(fullKey);
    if (!entryObj) {
      errors.push(`src/config/settings-schema.ts: missing ${fullKey} declared by BACKEND_DESCRIPTORS.${kind}`);
      continue;
    }
    const fields = getObjectFieldNodes(entryObj, sf);
    const pathType = evalFieldOrError(fields, 'type', sf, bindings, errors, fullKey);
    const pathScope = evalFieldOrError(fields, 'scope', sf, bindings, errors, fullKey);
    const pathDefault = evalFieldOrError(fields, 'default', sf, bindings, errors, fullKey);
    const pathDocLabel = evalFieldOrError(fields, 'docLabel', sf, bindings, errors, fullKey);
    if (pathType.value !== 'string') {
      errors.push(`${fullKey}.type (${String(pathType.value)}) !== 'string'`);
    }
    if (pathScope.value !== 'application') {
      errors.push(`${fullKey}.scope (${String(pathScope.value)}) !== 'application'`);
    }
    if (!pathDefault.node || !pathDefault.node.getText(sf).includes(`BACKEND_DESCRIPTORS.${kind}.defaultCliBinary`)) {
      errors.push(`src/config/settings-schema.ts: ${fullKey}.default must reference BACKEND_DESCRIPTORS.${kind}.defaultCliBinary`);
    }
    if (pathDefault.value !== desc.defaultCliBinary) {
      errors.push(`${fullKey}.default (${String(pathDefault.value)}) !== BACKEND_DESCRIPTORS.${kind}.defaultCliBinary (${desc.defaultCliBinary})`);
    }
    if (!pathDocLabel.node || !pathDocLabel.node.getText(sf).includes(`BACKEND_DESCRIPTORS.${kind}.cliPathDocLabel`)) {
      errors.push(`src/config/settings-schema.ts: ${fullKey}.docLabel must reference BACKEND_DESCRIPTORS.${kind}.cliPathDocLabel`);
    }
    if (pathDocLabel.value !== desc.cliPathDocLabel) {
      errors.push(`${fullKey}.docLabel (${String(pathDocLabel.value)}) !== BACKEND_DESCRIPTORS.${kind}.cliPathDocLabel (${desc.cliPathDocLabel})`);
    }
    if (pkgProps) {
      const pkgPath = pkgProps[fullKey];
      if (!pkgPath || pkgPath.default !== pathDefault.value) {
        errors.push(`${fullKey}.default disagrees with package.json`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Settings schema descriptor parity failed:\n- ${errors.join('\n- ')}`);
  }
}

function formatObjectKey(key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

/**
 * Emits a self-contained webview projection (`webview-ui/src/lib/generated/backend-descriptors.ts`)
 * carrying zero host-code imports and only webview-safe static descriptor fields.
 */
export function emitWebviewBackendDescriptors({
  supportedBackends,
  defaultBackend,
  descriptors
}) {
  const unionExpr = supportedBackends.map((k) => JSON.stringify(k)).join(' | ');
  const projected = Object.create(null);
  for (const kind of supportedBackends) {
    if (!Object.prototype.hasOwnProperty.call(descriptors, kind)) {
      throw new Error(`emitWebviewBackendDescriptors: missing descriptor for '${kind}'`);
    }
    const d = descriptors[kind];
    projected[kind] = {
      kind: d.kind,
      displayLabel: d.displayLabel,
      cliPathSettingKey: d.cliPathSettingKey,
      cliPathFieldKey: d.cliPathFieldKey,
      defaultCliBinary: d.defaultCliBinary,
      spendDenomination: d.spendDenomination,
      supportsAutoCompactPctOverride: d.supportsAutoCompactOverride,
      supportsGitSideEffects: d.supportsGitSideEffects,
      supportsModelDiscovery: d.modelDiscoveryArgs !== null,
      unsupportedEffortLevels: d.unsupportedEffortLevels,
      exampleModelPlaceholder: d.exampleModelPlaceholder
    };
  }

  const descriptorEntries = supportedBackends
    .map((kind) => {
      const p = projected[kind];
      return [
        `    ${formatObjectKey(kind)}: Object.freeze({`,
        `      kind: ${JSON.stringify(p.kind)},`,
        `      displayLabel: ${JSON.stringify(p.displayLabel)},`,
        `      cliPathSettingKey: ${JSON.stringify(p.cliPathSettingKey)},`,
        `      cliPathFieldKey: ${JSON.stringify(p.cliPathFieldKey)},`,
        `      defaultCliBinary: ${JSON.stringify(p.defaultCliBinary)},`,
        `      spendDenomination: ${JSON.stringify(p.spendDenomination)},`,
        `      supportsAutoCompactPctOverride: ${JSON.stringify(p.supportsAutoCompactPctOverride)},`,
        `      supportsGitSideEffects: ${JSON.stringify(p.supportsGitSideEffects)},`,
        `      supportsModelDiscovery: ${JSON.stringify(p.supportsModelDiscovery)},`,
        `      unsupportedEffortLevels: Object.freeze(${JSON.stringify(p.unsupportedEffortLevels)} as const),`,
        `      exampleModelPlaceholder: ${JSON.stringify(p.exampleModelPlaceholder)}`,
        `    })`
      ].join('\n');
    })
    .join(',\n');

  return [
    '// GENERATED FILE — do not edit.',
    '//',
    '// Emitted from src/contracts/backend-kinds.ts and src/contracts/backend-descriptors.ts',
    '// by scripts/generate-contract-schemas.mjs (FR-R7-06).',
    '// Edit the host contract source and run: npm run contracts:generate',
    '//',
    '// Self-contained webview projection: carries zero imports from host `src/`.',
    '',
    `export type BackendRunnerKind = ${unionExpr};`,
    '',
    `export const SUPPORTED_BACKENDS: ReadonlyArray<BackendRunnerKind> = Object.freeze(${JSON.stringify(supportedBackends)});`,
    '',
    `export const DEFAULT_BACKEND: BackendRunnerKind = ${JSON.stringify(defaultBackend)};`,
    '',
    'export function isBackendRunnerKind(value: unknown): value is BackendRunnerKind {',
    '  return typeof value === \'string\' &&',
    '    (SUPPORTED_BACKENDS as ReadonlyArray<string>).includes(value);',
    '}',
    '',
    "export type SpendDenomination = 'usd' | 'tokens';",
    '',
    'export interface WebviewBackendDescriptor {',
    '  readonly kind: BackendRunnerKind;',
    '  readonly displayLabel: string;',
    '  readonly cliPathSettingKey: string;',
    '  readonly cliPathFieldKey: string;',
    '  readonly defaultCliBinary: string;',
    '  readonly spendDenomination: SpendDenomination;',
    '  readonly supportsAutoCompactPctOverride: boolean;',
    '  readonly supportsGitSideEffects: boolean;',
    '  readonly supportsModelDiscovery: boolean;',
    '  readonly unsupportedEffortLevels: readonly string[];',
    '  readonly exampleModelPlaceholder: string;',
    '}',
    '',
    'export type BackendMap<T> = { readonly [K in BackendRunnerKind]: T };',
    'export type MutableBackendMap<T> = { [K in BackendRunnerKind]: T };',
    '',
    'export const WEBVIEW_BACKEND_DESCRIPTORS: Readonly<Record<BackendRunnerKind, WebviewBackendDescriptor>> =',
    '  Object.freeze({',
    descriptorEntries,
    '  });',
    '',
    'export const WEBVIEW_BACKEND_LIST: readonly WebviewBackendDescriptor[] = Object.freeze(',
    '  SUPPORTED_BACKENDS.map((kind) => WEBVIEW_BACKEND_DESCRIPTORS[kind])',
    ');',
    '',
    'export function findWebviewBackendDescriptor(kind: unknown): WebviewBackendDescriptor | undefined {',
    '  if (typeof kind !== \'string\') return undefined;',
    '  if (!Object.prototype.hasOwnProperty.call(WEBVIEW_BACKEND_DESCRIPTORS, kind)) return undefined;',
    '  return WEBVIEW_BACKEND_DESCRIPTORS[kind as BackendRunnerKind];',
    '}',
    '',
    'export function getWebviewBackendDescriptor(kind: BackendRunnerKind): WebviewBackendDescriptor {',
    '  const descriptor = findWebviewBackendDescriptor(kind);',
    '  if (descriptor === undefined) {',
    '    throw new TypeError(`unknown backend kind "${String(kind)}"`);',
    '  }',
    '  return descriptor;',
    '}',
    '',
    'export function spendDenominationOf(kind: BackendRunnerKind): SpendDenomination {',
    '  return getWebviewBackendDescriptor(kind).spendDenomination;',
    '}',
    '',
    'export function isUnsupportedEffortForBackend(kind: unknown, effort: string): boolean {',
    '  const descriptor = findWebviewBackendDescriptor(kind);',
    '  if (descriptor === undefined) return false;',
    '  return descriptor.unsupportedEffortLevels.includes(effort);',
    '}',
    '',
    'export function mapMutableBackends<T>(',
    '  fn: (descriptor: WebviewBackendDescriptor) => T',
    '): MutableBackendMap<T> {',
    '  return Object.fromEntries(',
    '    SUPPORTED_BACKENDS.map((kind) => [kind, fn(WEBVIEW_BACKEND_DESCRIPTORS[kind])])',
    '  ) as MutableBackendMap<T>;',
    '}',
    '',
    'export function mapBackends<T>(',
    '  fn: (descriptor: WebviewBackendDescriptor) => T',
    '): BackendMap<T> {',
    '  return Object.freeze(mapMutableBackends(fn));',
    '}',
    ''
  ].join('\n');
}
