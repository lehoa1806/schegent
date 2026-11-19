// Zero-cast inbound IPC runtime validator emitter for FR-R7-05.
//
// Emits one TypeScript module per command family under
// `src/contracts/generated/validators/<family>.ts`.
// Every emitted validator constructs a statically typed command member of
// `SidebarCommand` and returns `ok(command)` with ZERO `as SidebarCommand` casts
// and ZERO ESLint warnings (`no-unnecessary-condition`, `no-unused-vars`).

import { emitTypeExpr } from './emit-types.mjs';

/**
 * Collect helper imports needed by a family's commands.
 *
 * @param {readonly object[]} commands
 */
function analyzeFamilyRequirements(commands) {
  const req = {
    usesHasUnexpectedKeys: false,
    usesIsSafePathSegment: false,
    usesRecordIdentifier: false,
    usesBoundedIdentifier: false,
    usesPrintableAscii: false,
    usesBase64urlCursor: false,
    usesCustomPatterns: new Map(),
    externalImports: new Map(),
    typeImportsFromSidebarIpc: new Set(),
    constImportsFromSidebarIpc: new Set(),
    extraTypeImports: new Map()
  };

  const addExternal = (from, fn) => {
    if (!req.externalImports.has(from)) req.externalImports.set(from, new Set());
    req.externalImports.get(from).add(fn);
  };
  const addExtraType = (from, name) => {
    if (!req.extraTypeImports.has(from)) req.extraTypeImports.set(from, new Set());
    req.extraTypeImports.get(from).add(name);
  };

  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'object') {
      if (node.closed !== false) req.usesHasUnexpectedKeys = true;
      for (const field of Object.values(node.fields)) {
        visit(field.schema);
      }
    } else if (node.kind === 'discUnion') {
      for (const arm of Object.values(node.arms)) {
        visit(arm);
      }
    } else if (node.kind === 'union') {
      for (const m of node.members) visit(m);
    } else if (node.kind === 'array') {
      visit(node.item);
    } else if (node.kind === 'record') {
      visit(node.value);
    } else if (node.kind === 'string') {
      if (node.format === 'safePathSegment') req.usesIsSafePathSegment = true;
      if (node.format === 'recordIdentifier') req.usesRecordIdentifier = true;
      if (node.format === 'boundedIdentifier') {
        req.usesIsSafePathSegment = true;
        req.usesBoundedIdentifier = true;
        addExternal('../../phase-context/context-policy', 'IDENTIFIER_PATTERN');
      }
      if (node.format === 'printableAscii') req.usesPrintableAscii = true;
      if (node.format === 'base64urlCursor') req.usesBase64urlCursor = true;
      if (node.pattern && !node.format) {
        const key = `RE_${req.usesCustomPatterns.size}`;
        if (![...req.usesCustomPatterns.values()].includes(node.pattern)) {
          req.usesCustomPatterns.set(key, node.pattern);
        }
      }
    } else if (node.kind === 'ref' && node.predicate) {
      addExternal(node.predicate.importFrom, node.predicate.fn);
      if (node.predicate.typeImport && node.tsType) {
        addExtraType(node.predicate.typeImport, node.tsType);
      } else if (
        node.tsType &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(node.tsType) &&
        node.predicate.importFrom !== '../../validators/run-request-shape'
      ) {
        addExtraType(node.predicate.importFrom, node.tsType);
      }
    } else if (node.kind === 'enum' && node.guardFn && node.guardImport) {
      addExternal(node.guardImport, node.guardFn);
    }
  };

  for (const cmd of commands) {
    req.constImportsFromSidebarIpc.add(cmd.type);
    req.typeImportsFromSidebarIpc.add(cmd.interfaceName);
    if (cmd.extraTypeImports) {
      for (const [mod, names] of Object.entries(cmd.extraTypeImports)) {
        for (const n of names) addExtraType(mod, n);
      }
    }
    visit(cmd.payload);
  }

  return req;
}

/**
 * Emit inline validation and typed extraction for a single value into `outVar`.
 *
 * @param {object} ctx
 * @param {object} field
 * @param {string} rawExpr
 * @param {string} outVar
 * @param {string} failReason
 * @param {string} indent
 * @returns {string[]}
 */
function emitValueCheck(ctx, field, rawExpr, outVar, failReason, indent) {
  const node = field.schema;
  const failStmt = (reason) =>
    `${indent}return fail('${reason}', { type: ${ctx.typeConst}, correlationId });`;

  if (field.nullable) {
    const innerField = { ...field, nullable: false };
    const innerLines = emitValueCheck(ctx, innerField, rawExpr, `${outVar}Val`, failReason, `${indent}  `);
    const tsType = emitTypeExpr(node, { mode: 'host', indent: '' });
    return [
      `${indent}let ${outVar}: ${tsType} | null;`,
      `${indent}if (${rawExpr} === null) {`,
      `${indent}  ${outVar} = null;`,
      `${indent}} else {`,
      ...innerLines,
      `${indent}  ${outVar} = ${outVar}Val;`,
      `${indent}}`
    ];
  }

  const err = field.err ?? node.err ?? failReason;

  switch (node.kind) {
    case 'unknown':
      return [`${indent}const ${outVar}: unknown = ${rawExpr};`];

    case 'boolean':
      return [
        `${indent}if (typeof ${rawExpr} !== 'boolean') {`,
        `  ${failStmt(err)}`,
        `${indent}}`,
        `${indent}const ${outVar}: boolean = ${rawExpr};`
      ];

    case 'literal': {
      const litExpr = typeof node.value === 'string' ? `'${node.value}'` : String(node.value);
      return [
        `${indent}if (${rawExpr} !== ${litExpr}) {`,
        `  ${failStmt(err)}`,
        `${indent}}`,
        `${indent}const ${outVar} = ${litExpr} as const;`
      ];
    }

    case 'integer': {
      const checkFn = node.safe ? 'Number.isSafeInteger' : 'Number.isInteger';
      const conds = [`typeof ${rawExpr} !== 'number'`, `!${checkFn}(${rawExpr})`];
      if (node.min !== undefined) conds.push(`${rawExpr} < ${node.min}`);
      if (node.max !== undefined) conds.push(`${rawExpr} > ${node.max}`);
      return [
        `${indent}if (${conds.join(' || ')}) {`,
        `  ${failStmt(err)}`,
        `${indent}}`,
        `${indent}const ${outVar}: number = ${rawExpr};`
      ];
    }

    case 'number': {
      const conds = [`typeof ${rawExpr} !== 'number'`];
      if (node.finite !== false) conds.push(`!Number.isFinite(${rawExpr})`);
      if (node.min !== undefined) conds.push(`${rawExpr} < ${node.min}`);
      if (node.exclusiveMin !== undefined) conds.push(`${rawExpr} <= ${node.exclusiveMin}`);
      if (node.max !== undefined) conds.push(`${rawExpr} > ${node.max}`);
      return [
        `${indent}if (${conds.join(' || ')}) {`,
        `  ${failStmt(err)}`,
        `${indent}}`,
        `${indent}const ${outVar}: number = ${rawExpr};`
      ];
    }

    case 'string': {
      const lines = [];
      if (node.format === 'safePathSegment') {
        lines.push(`${indent}if (!isSafePathSegment(${rawExpr})) {`);
        lines.push(`  ${failStmt(err)}`);
        lines.push(`${indent}}`);
        lines.push(`${indent}const ${outVar}: string = ${rawExpr};`);
        return lines;
      }
      if (node.format === 'recordIdentifier') {
        lines.push(`${indent}if (!isRecordIdentifier(${rawExpr})) {`);
        lines.push(`  ${failStmt(err)}`);
        lines.push(`${indent}}`);
        lines.push(`${indent}const ${outVar}: string = ${rawExpr};`);
        return lines;
      }
      if (node.format === 'boundedIdentifier') {
        lines.push(`${indent}if (!isBoundedIdentifier(${rawExpr})) {`);
        lines.push(`  ${failStmt(err)}`);
        lines.push(`${indent}}`);
        lines.push(`${indent}const ${outVar}: string = ${rawExpr};`);
        return lines;
      }

      const typeErr = node.typeErr ?? err;
      const rangeErr = node.rangeErr ?? err;
      const maxErr = node.maxErr ?? rangeErr;
      lines.push(`${indent}if (typeof ${rawExpr} !== 'string') {`);
      lines.push(`  ${failStmt(typeErr)}`);
      lines.push(`${indent}}`);
      const targetExpr = node.trim ? `${outVar}Trimmed` : rawExpr;
      if (node.trim) {
        lines.push(`${indent}const ${targetExpr} = ${rawExpr}.trim();`);
      }
      if (node.maxErr && node.minLen !== undefined && node.maxLen !== undefined) {
        lines.push(`${indent}if (${targetExpr}.length < ${node.minLen}) {`);
        lines.push(`  ${failStmt(rangeErr)}`);
        lines.push(`${indent}}`);
        lines.push(`${indent}if (${targetExpr}.length > ${node.maxLen}) {`);
        lines.push(`  ${failStmt(maxErr)}`);
        lines.push(`${indent}}`);
      } else {
        const checks = [];
        if (node.minLen !== undefined) checks.push(`${targetExpr}.length < ${node.minLen}`);
        if (node.maxLen !== undefined) checks.push(`${targetExpr}.length > ${node.maxLen}`);
        if (node.format === 'printableAscii') checks.push(`!PRINTABLE_ASCII.test(${targetExpr})`);
        if (node.format === 'base64urlCursor') checks.push(`!BASE64URL_CURSOR.test(${targetExpr})`);
        if (node.pattern && !node.format) {
          const reName = ctx.patternName(node.pattern);
          checks.push(`!${reName}.test(${targetExpr})`);
        }
        if (checks.length > 0) {
          lines.push(`${indent}if (${checks.join(' || ')}) {`);
          lines.push(`  ${failStmt(rangeErr)}`);
          lines.push(`${indent}}`);
        }
      }
      lines.push(`${indent}const ${outVar}: string = ${targetExpr};`);
      return lines;
    }

    case 'enum': {
      if (node.guardFn) {
        return [
          `${indent}if (!${node.guardFn}(${rawExpr})) {`,
          `  ${failStmt(err)}`,
          `${indent}}`,
          `${indent}const ${outVar} = ${rawExpr};`
        ];
      }
      const posConds = node.values.map((v) => `${rawExpr} === '${v}'`).join(' || ');
      const unionLit = node.values.map((v) => `'${v}'`).join(' | ');
      return [
        `${indent}if (!(${posConds})) {`,
        `  ${failStmt(err)}`,
        `${indent}}`,
        `${indent}const ${outVar}: ${unionLit} = ${rawExpr};`
      ];
    }

    case 'ref': {
      if (!node.predicate) {
        throw new Error(`ref '${node.name}' in inbound validator requires a predicate`);
      }
      return [
        `${indent}if (!${node.predicate.fn}(${rawExpr})) {`,
        `  ${failStmt(node.predicate.err ?? err)}`,
        `${indent}}`,
        `${indent}const ${outVar} = ${rawExpr};`
      ];
    }

    case 'array': {
      if (node.item.kind === 'unknown') {
        const conds = [`!Array.isArray(${rawExpr})`];
        if (node.minItems !== undefined) conds.push(`${rawExpr}.length < ${node.minItems}`);
        if (node.maxItems !== undefined) conds.push(`${rawExpr}.length > ${node.maxItems}`);
        return [
          `${indent}if (${conds.join(' || ')}) {`,
          `  ${failStmt(err)}`,
          `${indent}}`,
          `${indent}const ${outVar}: readonly unknown[] = ${rawExpr};`
        ];
      }
      const itemType = emitTypeExpr(node.item, { mode: 'host', indent: '' });
      const arrConds = [`!Array.isArray(${rawExpr})`];
      if (node.minItems !== undefined) arrConds.push(`${rawExpr}.length < ${node.minItems}`);
      if (node.maxItems !== undefined) arrConds.push(`${rawExpr}.length > ${node.maxItems}`);
      const itemVar = `${outVar}Item`;
      const itemRaw = `${outVar}El`;
      const itemCheck = emitValueCheck(
        ctx,
        { kind: 'field', schema: node.item, optional: false, nullable: false },
        itemRaw,
        itemVar,
        node.itemErr ?? err,
        `${indent}  `
      );
      return [
        `${indent}if (${arrConds.join(' || ')}) {`,
        `  ${failStmt(err)}`,
        `${indent}}`,
        `${indent}const ${outVar}: ${itemType}[] = [];`,
        `${indent}for (const ${itemRaw} of ${rawExpr}) {`,
        ...itemCheck,
        `${indent}  ${outVar}.push(${itemVar});`,
        `${indent}}`
      ];
    }

    case 'record': {
      if (node.value.kind === 'unknown') {
        return [
          `${indent}if (${rawExpr} === null || typeof ${rawExpr} !== 'object' || Array.isArray(${rawExpr})) {`,
          `  ${failStmt(err)}`,
          `${indent}}`,
          `${indent}const ${outVar}: Readonly<Record<string, unknown>> = ${rawExpr} as Record<string, unknown>;`
        ];
      }
      const valType = emitTypeExpr(node.value, { mode: 'host', indent: '' });
      const valRaw = `${outVar}EntryVal`;
      const valOut = `${outVar}Val`;
      const valCheck = emitValueCheck(
        ctx,
        { kind: 'field', schema: node.value, optional: false, nullable: false },
        valRaw,
        valOut,
        node.valueErr ?? err,
        `${indent}  `
      );
      return [
        `${indent}if (${rawExpr} === null || typeof ${rawExpr} !== 'object' || Array.isArray(${rawExpr})) {`,
        `  ${failStmt(err)}`,
        `${indent}}`,
        `${indent}const ${outVar}: Record<string, ${valType}> = {};`,
        `${indent}for (const [${outVar}Key, ${valRaw}] of Object.entries(${rawExpr})) {`,
        ...valCheck,
        `${indent}  ${outVar}[${outVar}Key] = ${valOut};`,
        `${indent}}`
      ];
    }

    case 'object': {
      return emitObjectBody(ctx, node, rawExpr, outVar, err, indent);
    }

    default:
      throw new Error(`Unsupported schema kind in emitValueCheck: ${String(node.kind)}`);
  }
}

/**
 * Emit object validation + typed object construction for an ObjectNode.
 *
 * @param {object} ctx
 * @param {object} objNode
 * @param {string} rawExpr
 * @param {string} outVar
 * @param {string} defaultErr
 * @param {string} indent
 * @returns {string[]}
 */
function emitObjectBody(ctx, objNode, rawExpr, outVar, defaultErr, indent) {
  const failReason = objNode.collapseInvalidErr ?? defaultErr;
  const missingErr = objNode.missingErr ?? failReason;
  const unexpectedErr = objNode.collapseInvalidErr ?? objNode.unexpectedErr ?? 'unexpected-payload-fields';
  const arrayClause = objNode.allowArray ? '' : ` || Array.isArray(${rawExpr})`;
  const objVar = `${outVar}Obj`;
  const lines = [
    `${indent}if (${rawExpr} === null || typeof ${rawExpr} !== 'object'${arrayClause}) {`,
    `${indent}  return fail('${missingErr}', { type: ${ctx.typeConst}, correlationId });`,
    `${indent}}`,
    `${indent}const ${objVar} = ${rawExpr} as Record<string, unknown>;`
  ];

  const fieldEntries = Object.entries(objNode.fields);
  if (objNode.closed !== false) {
    const keysLit = fieldEntries.map(([k]) => `'${k}'`).join(', ');
    lines.push(`${indent}if (hasUnexpectedKeys(${objVar}, [${keysLit}])) {`);
    lines.push(`${indent}  return fail('${unexpectedErr}', { type: ${ctx.typeConst}, correlationId });`);
    lines.push(`${indent}}`);
  }

  const assignedParts = [];

  for (const [key, field] of fieldEntries) {
    const rawVar = `${outVar}_${key}Raw`;
    const valVar = `${outVar}_${key}`;
    const effectiveErr = objNode.collapseInvalidErr ?? field.err ?? field.schema.err ?? failReason;

    if (field.presenceOnly) {
      const presErr = objNode.collapseInvalidErr ?? field.err ?? field.schema.presenceErr ?? failReason;
      lines.push(`${indent}if (!Object.hasOwn(${objVar}, '${key}')) {`);
      lines.push(`${indent}  return fail('${presErr}', { type: ${ctx.typeConst}, correlationId });`);
      lines.push(`${indent}}`);
      lines.push(`${indent}const ${valVar}: unknown = ${objVar}['${key}'];`);
      assignedParts.push(`${key}: ${valVar}`);
      continue;
    }

    lines.push(`${indent}const ${rawVar}: unknown = ${objVar}['${key}'];`);

    if (field.nullWhenAbsent) {
      // Used by CMD_READ_PHASE_LOG selection.iterationN: undefined or null -> null
      const nonNullField = { ...field, nullable: false, optional: false, nullWhenAbsent: false };
      const innerType = emitTypeExpr(field.schema, { mode: 'host', indent: '' });
      const innerLines = emitValueCheck(ctx, nonNullField, rawVar, `${valVar}Num`, effectiveErr, `${indent}  `);
      lines.push(`${indent}let ${valVar}: ${innerType} | null;`);
      lines.push(`${indent}if (${rawVar} === null || ${rawVar} === undefined) {`);
      lines.push(`${indent}  ${valVar} = null;`);
      lines.push(`${indent}} else {`);
      lines.push(...innerLines);
      lines.push(`${indent}  ${valVar} = ${valVar}Num;`);
      lines.push(`${indent}}`);
      assignedParts.push(`${key}: ${valVar}`);
      continue;
    }

    if (field.optional) {
      if (field.ignoreInvalid) {
        // Legacy CMD_SAVE_MODELS behavior: ignores non-matching optional expectedRevision / mutation
        const innerType = emitTypeExpr(field.schema, { mode: 'host', indent: '' });
        lines.push(`${indent}let ${valVar}: ${innerType} | undefined;`);
        if (field.schema.kind === 'string') {
          lines.push(`${indent}if (typeof ${rawVar} === 'string') {`);
          lines.push(`${indent}  ${valVar} = ${rawVar};`);
          lines.push(`${indent}}`);
        } else if (field.schema.kind === 'object' && field.schema.fields.kind?.schema.kind === 'enum') {
          const vals = field.schema.fields.kind.schema.values;
          lines.push(`${indent}if (${rawVar} !== undefined && ${rawVar} !== null && typeof ${rawVar} === 'object') {`);
          lines.push(`${indent}  const ${valVar}Kind = (${rawVar} as { kind?: unknown }).kind;`);
          lines.push(`${indent}  if (${vals.map((v) => `${valVar}Kind === '${v}'`).join(' || ')}) {`);
          lines.push(`${indent}    ${valVar} = { kind: ${valVar}Kind };`);
          lines.push(`${indent}  }`);
          lines.push(`${indent}}`);
        }
        assignedParts.push(`...(${valVar} === undefined ? {} : { ${key}: ${valVar} })`);
        continue;
      }

      const innerType = emitTypeExpr(field.schema, { mode: 'host', indent: '' });
      const fullType = field.nullable ? `${innerType} | null` : innerType;
      const innerField = { ...field, optional: false };
      const innerLines = emitValueCheck(ctx, innerField, rawVar, `${valVar}Checked`, effectiveErr, `${indent}  `);
      lines.push(`${indent}let ${valVar}: ${fullType} | undefined;`);
      lines.push(`${indent}if (${rawVar} !== undefined) {`);
      lines.push(...innerLines);
      lines.push(`${indent}  ${valVar} = ${valVar}Checked;`);
      lines.push(`${indent}}`);
      if (field.omitIfEmpty) {
        assignedParts.push(`...(${valVar} ? { ${key}: ${valVar} } : {})`);
      } else if (field.omitIfFalse) {
        assignedParts.push(`...(${valVar} === true ? { ${key}: true as const } : {})`);
      } else {
        assignedParts.push(`...(${valVar} === undefined ? {} : { ${key}: ${valVar} })`);
      }
      continue;
    }

    const checkLines = emitValueCheck(ctx, field, rawVar, valVar, effectiveErr, indent);
    lines.push(...checkLines);
    assignedParts.push(`${key}: ${valVar}`);
  }

  lines.push(`${indent}const ${outVar} = { ${assignedParts.join(', ')} };`);
  return lines;
}

/**
 * Emit a single command validator function.
 *
 * @param {object} cmd
 * @param {Map<string, string>} patternMap
 * @returns {string}
 */
function emitCommandValidator(cmd, patternMap) {
  const ctx = {
    typeConst: cmd.type,
    patternName(pattern) {
      for (const [k, v] of patternMap.entries()) {
        if (v === pattern) return k;
      }
      throw new Error(`Pattern not registered: ${pattern}`);
    }
  };

  const lines = [
    `export function ${cmd.validatorName}(`,
    '  obj: Record<string, unknown>,',
    '  correlationId: string',
    '): IpcValidationResult {'
  ];

  if (cmd.payloadMode === 'none') {
    lines.push(`  if ('payload' in obj && obj['payload'] !== undefined) {`);
    lines.push(`    return fail('unexpected-payload', { type: ${cmd.type}, correlationId });`);
    lines.push('  }');
    lines.push(`  const command: ${cmd.interfaceName} = { type: ${cmd.type}, correlationId };`);
    lines.push('  return ok(command);');
    lines.push('}');
    return lines.join('\n');
  }

  if (cmd.payloadMode === 'optional') {
    lines.push(`  const rawPayload: unknown = obj['payload'];`);
    lines.push('  if (rawPayload === undefined) {');
    lines.push(`    const command: ${cmd.interfaceName} = { type: ${cmd.type}, correlationId };`);
    lines.push('    return ok(command);');
    lines.push('  }');
    const objNode = { ...cmd.payload, missingErr: cmd.payloadInvalidErr ?? 'invalid-payload' };
    lines.push(...emitObjectBody(ctx, objNode, 'rawPayload', 'validated', 'invalid-payload', '  '));
    if (cmd.emptyPayloadValue === 'undefined') {
      lines.push('  const hasAny = Object.keys(validated).length > 0;');
      lines.push(
        `  const command: ${cmd.interfaceName} = { type: ${cmd.type}, correlationId, payload: hasAny ? validated : undefined };`
      );
    } else {
      lines.push(`  const command: ${cmd.interfaceName} = { type: ${cmd.type}, correlationId, payload: validated };`);
    }
    lines.push('  return ok(command);');
    lines.push('}');
    return lines.join('\n');
  }

  if (cmd.payloadMode === 'optional-empty-object') {
    lines.push(`  const rawPayload: unknown = obj['payload'];`);
    lines.push('  if (rawPayload === undefined) {');
    lines.push(`    const command: ${cmd.interfaceName} = { type: ${cmd.type}, correlationId, payload: {} };`);
    lines.push('    return ok(command);');
    lines.push('  }');
    const objNode = { ...cmd.payload, missingErr: cmd.payloadInvalidErr ?? 'invalid-payload' };
    lines.push(...emitObjectBody(ctx, objNode, 'rawPayload', 'validated', 'invalid-payload', '  '));
    lines.push(`  const command: ${cmd.interfaceName} = { type: ${cmd.type}, correlationId, payload: validated };`);
    lines.push('  return ok(command);');
    lines.push('}');
    return lines.join('\n');
  }

  // payloadMode === 'required'
  lines.push(`  const rawPayload: unknown = obj['payload'];`);

  if (cmd.payload.kind === 'discUnion') {
    const du = cmd.payload;
    const arrayClause = du.allowArray ? '' : ' || Array.isArray(rawPayload)';
    lines.push(`  if (rawPayload === null || typeof rawPayload !== 'object'${arrayClause}) {`);
    lines.push(`    return fail('${cmd.payloadMissingErr ?? 'missing-payload'}', { type: ${cmd.type}, correlationId });`);
    lines.push('  }');
    lines.push('  const pObj = rawPayload as Record<string, unknown>;');
    if (du.outerAllowedKeys) {
      const keysLit = du.outerAllowedKeys.map((k) => `'${k}'`).join(', ');
      lines.push(`  if (hasUnexpectedKeys(pObj, [${keysLit}])) {`);
      lines.push(`    return fail('unexpected-payload-fields', { type: ${cmd.type}, correlationId });`);
      lines.push('  }');
    }
    lines.push(`  const disc: unknown = pObj['${du.discriminator}'];`);
    if (du.missingDiscErr) {
      lines.push(`  if (typeof disc !== 'string') {`);
      lines.push(`    return fail('${du.missingDiscErr}', { type: ${cmd.type}, correlationId });`);
      lines.push('  }');
    }
    lines.push('  switch (disc) {');
    for (const [armKey, armNode] of Object.entries(du.arms)) {
      lines.push(`    case '${armKey}': {`);
      const armObj = { ...armNode, missingErr: cmd.payloadMissingErr ?? 'missing-payload' };
      // Skip outer null/object check since pObj is already validated
      const armEntries = Object.entries(armObj.fields);
      if (armObj.forbiddenFields) {
        for (const [fKey, fReason] of Object.entries(armObj.forbiddenFields)) {
          lines.push(`      if (pObj['${fKey}'] !== undefined) {`);
          lines.push(`        return fail('${fReason}', { type: ${cmd.type}, correlationId });`);
          lines.push('      }');
        }
      }
      if (armObj.closed !== false) {
        const keysLit = armEntries.map(([k]) => `'${k}'`).join(', ');
        lines.push(`      if (hasUnexpectedKeys(pObj, [${keysLit}])) {`);
        lines.push(
          `        return fail('${armObj.unexpectedErr ?? 'unexpected-payload-fields'}', { type: ${cmd.type}, correlationId });`
        );
        lines.push('      }');
      }
      const assigned = [];
      for (const [fKey, field] of armEntries) {
        if (fKey === du.discriminator) {
          assigned.push(`${fKey}: '${armKey}'`);
          continue;
        }
        const fRaw = `arm_${fKey}Raw`;
        const fVal = `arm_${fKey}`;
        const fErr = field.err ?? field.schema.err ?? 'invalid-payload';
        if (field.presenceOnly) {
          const presErr = field.err ?? field.schema.presenceErr ?? 'invalid-payload';
          lines.push(`      if (!Object.hasOwn(pObj, '${fKey}')) {`);
          lines.push(`        return fail('${presErr}', { type: ${cmd.type}, correlationId });`);
          lines.push('      }');
          lines.push(`      const ${fVal}: unknown = pObj['${fKey}'];`);
          assigned.push(`${fKey}: ${fVal}`);
          continue;
        }
        lines.push(`      const ${fRaw}: unknown = pObj['${fKey}'];`);
        if (field.optional) {
          const innerType = emitTypeExpr(field.schema, { mode: 'host', indent: '' });
          const fullType = field.nullable ? `${innerType} | null` : innerType;
          const innerField = { ...field, optional: false };
          lines.push(`      let ${fVal}: ${fullType} | undefined;`);
          lines.push(`      if (${fRaw} !== undefined) {`);
          lines.push(...emitValueCheck(ctx, innerField, fRaw, `${fVal}Checked`, fErr, '        '));
          lines.push(`        ${fVal} = ${fVal}Checked;`);
          lines.push('      }');
          assigned.push(`...(${fVal} === undefined ? {} : { ${fKey}: ${fVal} })`);
        } else {
          lines.push(...emitValueCheck(ctx, field, fRaw, fVal, fErr, '      '));
          assigned.push(`${fKey}: ${fVal}`);
        }
      }
      lines.push(
        `      const command: ${cmd.interfaceName} = { type: ${cmd.type}, correlationId, payload: { ${assigned.join(', ')} } };`
      );
      lines.push('      return ok(command);');
      lines.push('    }');
    }
    lines.push('    default:');
    lines.push(`      return fail('${du.invalidDiscErr ?? 'invalid-op'}', { type: ${cmd.type}, correlationId });`);
    lines.push('  }');
    lines.push('}');
    return lines.join('\n');
  }

  const objNode = {
    ...cmd.payload,
    missingErr: cmd.payloadMissingErr ?? cmd.payload.missingErr ?? 'missing-payload'
  };
  lines.push(...emitObjectBody(ctx, objNode, 'rawPayload', 'validated', 'invalid-payload', '  '));
  lines.push(`  const command: ${cmd.interfaceName} = { type: ${cmd.type}, correlationId, payload: validated };`);
  lines.push('  return ok(command);');
  lines.push('}');
  return lines.join('\n');
}

/**
 * Emit a complete per-family generated validator module.
 *
 * @param {{ family: string, sourcePath: string, commands: readonly object[] }} spec
 * @returns {string}
 */
export function emitFamilyValidatorModule(spec) {
  const req = analyzeFamilyRequirements(spec.commands);
  const lines = [
    '// GENERATED FILE — do not edit.',
    '//',
    `// Emitted from ${spec.sourcePath} by scripts/generate-contract-schemas.mjs.`,
    '// Edit the descriptor and run: npm run contracts:generate',
    ...(Array.isArray(spec.headerNotes) && spec.headerNotes.length > 0
      ? ['//', ...spec.headerNotes.map((note) => `// ${note}`)]
      : []),
    ''
  ];

  // Sidebar IPC imports (runtime CMD_* constants + command interfaces)
  const sidebarItems = [
    ...[...req.constImportsFromSidebarIpc].sort(),
    ...[...req.typeImportsFromSidebarIpc].sort().map((t) => `type ${t}`)
  ];
  lines.push(`import {\n  ${sidebarItems.join(',\n  ')}\n} from '../../sidebar-ipc';`);

  // Shared validator helpers
  const sharedItems = ['fail', 'ok', 'type IpcValidationResult'];
  if (req.usesHasUnexpectedKeys) sharedItems.splice(1, 0, 'hasUnexpectedKeys');
  if (req.usesIsSafePathSegment) sharedItems.splice(1, 0, 'isSafePathSegment');
  lines.push(`import { ${sharedItems.join(', ')} } from '../../validators/shared';`);

  // External helper imports (predicates / constants)
  for (const [mod, syms] of [...req.externalImports.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`import { ${[...syms].sort().join(', ')} } from '${mod}';`);
  }
  for (const [mod, syms] of [...req.extraTypeImports.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`import type { ${[...syms].sort().join(', ')} } from '${mod}';`);
  }
  lines.push('');

  if (req.usesRecordIdentifier) {
    lines.push('const RECORD_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;');
    lines.push('function isRecordIdentifier(value: unknown): value is string {');
    lines.push(
      `  return typeof value === 'string' && value !== '.' && value !== '..' && RECORD_ID_PATTERN.test(value);`
    );
    lines.push('}');
    lines.push('');
  }

  if (req.usesBoundedIdentifier) {
    lines.push('function isBoundedIdentifier(value: unknown): value is string {');
    lines.push(
      '  return typeof value === \'string\' && value.length >= 1 && value.length <= 256 && (isSafePathSegment(value) || IDENTIFIER_PATTERN.test(value));'
    );
    lines.push('}');
    lines.push('');
  }

  if (req.usesPrintableAscii) {
    lines.push('const PRINTABLE_ASCII = /^[\\x21-\\x7e]+$/;');
    lines.push('');
  }

  if (req.usesBase64urlCursor) {
    lines.push('const BASE64URL_CURSOR = /^[A-Za-z0-9_-]+$/;');
    lines.push('');
  }

  for (const [reName, pattern] of req.usesCustomPatterns.entries()) {
    lines.push(`const ${reName} = new RegExp(${JSON.stringify(pattern)});`);
  }
  if (req.usesCustomPatterns.size > 0) lines.push('');

  for (const cmd of spec.commands) {
    lines.push(emitCommandValidator(cmd, req.usesCustomPatterns));
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
