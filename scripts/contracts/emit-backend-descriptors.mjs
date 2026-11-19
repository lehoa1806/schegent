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
    const out = {};
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
    const desc = descriptors[kind];
    if (!desc) continue;
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
    ...supportedBackends.map((kind) => descriptors[kind]?.acpProfile?.profileId).filter(Boolean).sort()
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

/**
 * Emits a self-contained webview projection (`webview-ui/src/lib/generated/backend-descriptors.ts`)
 * carrying zero host-code imports and only webview-safe static descriptor fields.
 */
export function emitWebviewBackendDescriptors({
  supportedBackends,
  defaultBackend,
  descriptors
}) {
  const unionExpr = supportedBackends.map((k) => `'${k}'`).join(' | ');
  const projected = {};
  for (const kind of supportedBackends) {
    const d = descriptors[kind];
    projected[kind] = {
      kind: d.kind,
      displayLabel: d.displayLabel,
      cliPathSettingKey: d.cliPathSettingKey,
      cliPathFieldKey: d.cliPathFieldKey,
      defaultCliBinary: d.defaultCliBinary,
      spendDenomination: d.spendDenomination,
      supportsAutoCompactPctOverride: d.autoCompactEnvVar !== null,
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
        `    ${kind}: Object.freeze({`,
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
