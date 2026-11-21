// Deterministic TypeScript type emitter for FR-R7-05.
//
// Emits host TypeScript interfaces/types with JSDoc comments from contract descriptors.

/**
 * Format a documentation string as a JSDoc comment block.
 *
 * @param {string | undefined} doc
 * @param {string} indent
 * @returns {string}
 */
export function formatDoc(doc, indent = '') {
  if (!doc) return '';
  const trimmed = doc.trim();
  if (!trimmed.includes('\n') && trimmed.length <= 92) {
    return `${indent}/** ${trimmed} */\n`;
  }
  const lines = trimmed.split('\n').map((line) => (line.length > 0 ? `${indent} * ${line}` : `${indent} *`));
  return `${indent}/**\n${lines.join('\n')}\n${indent} */\n`;
}

/**
 * Wrap union expressions in parentheses when used inside `readonly (...)[]`.
 *
 * @param {string} expr
 * @returns {string}
 */
function wrapForArray(expr) {
  return expr.includes(' | ') || expr.includes(' & ') ? `(${expr})` : expr;
}

/**
 * Emit a TypeScript type expression for a SchemaNode.
 *
 * @param {object} node
 * @param {{ mode: 'host' | 'webview', indent?: string }} opts
 * @returns {string}
 */
export function emitTypeExpr(node, opts) {
  const mode = opts.mode;
  const indent = opts.indent ?? '';

  switch (node.kind) {
    case 'string':
      if (mode === 'webview' && node.webviewType) return node.webviewType;
      return node.tsType ?? 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'literal':
      return typeof node.value === 'string' ? `'${node.value}'` : String(node.value);
    case 'enum':
      if (mode === 'webview') {
        return node.webviewType ?? node.values.map((v) => `'${v}'`).join(' | ');
      }
      return node.refName ?? node.values.map((v) => `'${v}'`).join(' | ');
    case 'unknown':
      return node.tsType ?? 'unknown';
    case 'ref':
      if (mode === 'webview') {
        return node.webviewType ?? node.name;
      }
      return node.tsType ?? node.name;
    case 'array': {
      const inner = emitTypeExpr(node.item, { mode, indent });
      return `readonly ${wrapForArray(inner)}[]`;
    }
    case 'record': {
      const keyType =
        mode === 'webview'
          ? (node.webviewKeyType ?? node.keyType ?? 'string')
          : (node.keyType ?? 'string');
      const valType = emitTypeExpr(node.value, { mode, indent });
      const rec = `Record<${keyType}, ${valType}>`;
      return node.readonly === false ? rec : `Readonly<${rec}>`;
    }
    case 'object': {
      const entries = Object.entries(node.fields);
      if (entries.length === 0) {
        return node.emptyRecordType ?? 'Record<string, never>';
      }
      const nextIndent = `${indent}  `;
      const lines = ['{'];
      for (const [key, field] of entries) {
        const docText = mode === 'webview' ? (field.webviewDoc ?? field.doc) : field.doc;
        if (docText) {
          lines.push(formatDoc(docText, nextIndent).replace(/\n$/, ''));
        }
        const optional = field.optional || (mode === 'webview' && field.webviewOptional);
        const schema = mode === 'webview' && field.webviewSchema ? field.webviewSchema : field.schema;
        let typeStr = emitTypeExpr(schema, { mode, indent: nextIndent });
        if (field.nullable) typeStr = `${typeStr} | null`;
        if (field.undefinable) typeStr = `${typeStr} | undefined`;
        lines.push(`${nextIndent}readonly ${key}${optional ? '?' : ''}: ${typeStr};`);
      }
      lines.push(`${indent}}`);
      return lines.join('\n');
    }
    case 'discUnion': {
      const arms = Object.values(node.arms);
      return arms
        .map((arm) => `\n${indent}  | ${emitTypeExpr(arm, { mode, indent: `${indent}    ` })}`)
        .join('');
    }
    case 'union': {
      const parts = node.members.map((m) => emitTypeExpr(m, { mode, indent }));
      if (parts.some((p) => p.includes('\n')) || parts.join(' | ').length > 88) {
        return parts.map((p) => `\n${indent}  | ${p}`).join('');
      }
      return parts.join(' | ');
    }
    default:
      throw new Error(`Unsupported descriptor kind in emitTypeExpr: ${String(node.kind)}`);
  }
}

/**
 * Emit a top-level interface or type alias declaration for a named descriptor.
 *
 * @param {object} decl
 * @param {'host' | 'webview'} mode
 * @returns {string}
 */
export function emitNamedDeclaration(decl, mode) {
  const docText = mode === 'webview' ? (decl.webviewDoc ?? decl.doc) : decl.doc;
  const header = formatDoc(docText, '');
  const exportName = mode === 'webview' ? (decl.webviewName ?? decl.name) : decl.name;
  const schema = mode === 'webview' && decl.webviewSchema ? decl.webviewSchema : decl.schema;

  if (decl.intersectionBase) {
    const base = mode === 'webview' ? (decl.webviewIntersectionBase ?? decl.intersectionBase) : decl.intersectionBase;
    const ext = emitTypeExpr(schema, { mode, indent: '' });
    return `${header}export type ${exportName} = ${base} & ${ext};`;
  }

  if (schema.kind === 'object' && decl.asType !== true) {
    const body = emitTypeExpr(schema, { mode, indent: '' });
    return `${header}export interface ${exportName} ${body}`;
  }

  const expr = emitTypeExpr(schema, { mode, indent: '' });
  const eq = expr.startsWith('\n') ? ' =' : ' = ';
  return `${header}export type ${exportName}${eq}${expr};`;
}

/**
 * Emit generated host TypeScript types for sidebar IPC commands & host messages.
 *
 * @param {{
 *   schemaVersion: number,
 *   commands: readonly object[],
 *   hostMessages: readonly object[],
 *   sourcePath: string
 * }} spec
 * @returns {string}
 */
export function emitHostIpcTypes(spec) {
  const imports = new Map();
  const addImport = (from, symbol) => {
    if (!imports.has(from)) imports.set(from, new Set());
    imports.get(from).add(symbol);
  };

  for (const cmd of spec.commands) {
    if (cmd.payloadTypeRef) {
      addImport(cmd.payloadTypeRef.from, cmd.payloadTypeRef.name);
    } else {
      collectTypeImports(cmd.payload, addImport);
    }
  }
  for (const msg of spec.hostMessages) {
    collectTypeImports(msg.schema, addImport);
  }

  const lines = [
    '// GENERATED FILE — do not edit.',
    '//',
    `// Emitted from ${spec.sourcePath} by scripts/generate-contract-schemas.mjs.`,
    '// Edit the descriptor and run: npm run contracts:generate',
    ''
  ];

  // Emit sorted type-only imports
  const sortedModules = [...imports.keys()].sort();
  for (const mod of sortedModules) {
    const syms = [...imports.get(mod)].sort();
    lines.push(`import type { ${syms.join(', ')} } from '${mod}';`);
  }
  if (sortedModules.length > 0) lines.push('');

  lines.push(`export const GENERATED_SIDEBAR_IPC_SCHEMA_VERSION = ${spec.schemaVersion} as const;`);
  lines.push('');

  lines.push('export interface GeneratedCommandBase<T extends string> {');
  lines.push('  readonly type: T;');
  lines.push('  readonly correlationId: string;');
  lines.push('}');
  lines.push('');

  for (const cmd of spec.commands) {
    const doc = formatDoc(cmd.doc, '');
    if (cmd.payloadMode === 'none') {
      lines.push(`${doc}export interface ${cmd.interfaceName} extends GeneratedCommandBase<'${cmd.type}'> {}`);
      lines.push('');
      continue;
    }
    const payloadExpr = cmd.payloadTypeRef
      ? cmd.payloadTypeRef.name
      : emitTypeExpr(cmd.payload, { mode: 'host', indent: '  ' });
    const opt = cmd.payloadMode === 'optional' || cmd.payloadMode === 'optional-empty-object' ? '?' : '';
    const extra =
      cmd.payloadMode === 'optional-empty-object'
        ? ' | Record<string, never>'
        : cmd.emptyPayloadValue === 'undefined'
          ? ' | undefined'
          : '';
    const colon = payloadExpr.startsWith('\n') ? ':' : ': ';
    lines.push(`${doc}export interface ${cmd.interfaceName} extends GeneratedCommandBase<'${cmd.type}'> {`);
    lines.push(`  readonly payload${opt}${colon}${payloadExpr}${extra};`);
    lines.push('}');
    lines.push('');
  }

  for (const msg of spec.hostMessages) {
    const doc = formatDoc(msg.doc, '');
    const typeParams = msg.typeParams ?? '';
    const body = emitTypeExpr(msg.schema, { mode: 'host', indent: '' });
    lines.push(`${doc}export interface ${msg.interfaceName}${typeParams} ${body}`);
    lines.push('');
  }

  if (spec.hostMessages.length > 0) {
    const members = spec.hostMessages.map((msg) => `  | ${msg.interfaceName}${msg.typeParams ?? ''}`);
    lines.push('export type HostMessage<S> =');
    lines.push(`${members.join('\n')};`);
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/**
 * Emit generated host TypeScript types for workflow snapshot slices.
 *
 * @param {{
 *   snapshotSchemaVersion: number,
 *   hostImports: Readonly<Record<string, readonly string[]>>,
 *   declarations: readonly object[],
 *   sourcePath: string
 * }} spec
 * @returns {string}
 */
export function emitHostSnapshotTypes(spec) {
  const lines = [
    '// GENERATED FILE — do not edit.',
    '//',
    `// Emitted from ${spec.sourcePath} by scripts/generate-contract-schemas.mjs.`,
    '// Edit the descriptor and run: npm run contracts:generate',
    ''
  ];

  const importEntries = Object.entries(spec.hostImports).sort(([a], [b]) => a.localeCompare(b));
  for (const [mod, symbols] of importEntries) {
    const sorted = [...symbols].sort();
    lines.push(`import type { ${sorted.join(', ')} } from '${mod}';`);
  }
  if (importEntries.length > 0) lines.push('');

  lines.push(`export const SCHEMA_VERSION = ${spec.snapshotSchemaVersion} as const;`);
  lines.push('');

  for (const decl of spec.declarations) {
    if (decl.hostSkip) continue;
    lines.push(emitNamedDeclaration(decl, 'host'));
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/**
 * Collect type imports referenced by a descriptor tree.
 *
 * @param {object | undefined} node
 * @param {(from: string, symbol: string) => void} addImport
 */
function collectTypeImports(node, addImport) {
  if (!node || typeof node !== 'object') return;
  if (node.tsImport && node.tsType) {
    addImport(node.tsImport, node.tsType);
  }
  if (node.refImport && node.refName) {
    addImport(node.refImport, node.refName);
  }
  if (node.kind === 'object') {
    for (const field of Object.values(node.fields)) {
      collectTypeImports(field.schema, addImport);
    }
  } else if (node.kind === 'array') {
    collectTypeImports(node.item, addImport);
  } else if (node.kind === 'record') {
    collectTypeImports(node.value, addImport);
  } else if (node.kind === 'discUnion') {
    for (const arm of Object.values(node.arms)) {
      collectTypeImports(arm, addImport);
    }
  } else if (node.kind === 'union') {
    for (const member of node.members) {
      collectTypeImports(member, addImport);
    }
  }
}
