// Self-contained webview snapshot mirror emitter for FR-R7-05.
//
// Emits `webview-ui/src/lib/generated/snapshot-mirror.ts` with ZERO imports from
// `repo/src/`. Local leaf aliases inside the file keep the generated module
// completely isolated while remaining 100% structurally compatible with the host
// contract types and `webview-ui/src/lib/snapshot-types.ts`.

import { emitNamedDeclaration, emitTypeExpr, formatDoc } from './emit-types.mjs';

/**
 * Emit `webview-ui/src/lib/generated/snapshot-mirror.ts`.
 *
 * @param {{
 *   snapshotSchemaVersion: number,
 *   webviewLocalImports: Readonly<Record<string, readonly string[]>>,
 *   webviewLeafAliases: ReadonlyArray<{ readonly name: string, readonly schema: object, readonly doc?: string }>,
 *   declarations: readonly object[],
 *   sourcePath: string
 * }} spec
 * @returns {string}
 */
export function emitWebviewSnapshotMirror(spec) {
  const lines = [
    '// GENERATED FILE — do not edit.',
    '//',
    `// Emitted from ${spec.sourcePath} by scripts/generate-contract-schemas.mjs.`,
    '// Edit the descriptor and run: npm run contracts:generate',
    '//',
    '// This module imports NOTHING from repo/src/. It is self-contained inside',
    '// webview-ui/ and re-exported by webview-ui/src/lib/snapshot-types.ts.',
    ''
  ];

  // Local imports strictly inside webview-ui/src/lib/ (never repo/src/)
  const localImports = Object.entries(spec.webviewLocalImports).sort(([a], [b]) => a.localeCompare(b));
  for (const [mod, syms] of localImports) {
    if (mod.includes('../../../src')) {
      throw new Error(`Refusing to emit repo/src import in webview snapshot mirror: ${mod}`);
    }
    lines.push(`import type { ${[...syms].sort().join(', ')} } from '${mod}';`);
  }
  if (localImports.length > 0) lines.push('');

  lines.push(`export const SCHEMA_VERSION = ${spec.snapshotSchemaVersion} as const;`);
  lines.push('');

  // Private structural leaf aliases so exported declarations stay clean and self-contained
  for (const alias of spec.webviewLeafAliases) {
    const doc = formatDoc(alias.doc, '');
    const expr = emitTypeExpr(alias.schema, { mode: 'webview', indent: '' });
    const eq = expr.startsWith('\n') ? ' =' : ' = ';
    lines.push(`${doc}type ${alias.name}${eq}${expr};`);
    lines.push('');
  }

  for (const decl of spec.declarations) {
    if (decl.webviewSkip) continue;
    lines.push(emitNamedDeclaration(decl, 'webview'));
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
