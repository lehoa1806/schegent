// principal-review-2026-11-27-r2 (F-07) — every late-bound `bind[A-Z]\w*`
// setter exposed by a composition-root wiring module in `src/activation/` must
// have a live call site in `src/activation/` or `src/extension.ts`.
//
// WHY THIS EXISTS. Several activation modules construct collaborators before
// their downstream peers exist (e.g. `backend-execution-wiring.ts` constructs
// the monitor and telemetry sampler before the controller and projector exist)
// and return late-binding setters such as `bindLivenessRecorder`,
// `bindTelemetryProjector`, and `bindCapabilityProjector`. A missed setter call
// compiles cleanly and leaves the closure holding `null` — a silent runtime
// regression. This gate enumerates every exposed `bind[A-Z]\w*` setter on
// returned wiring objects under `src/activation/` via the TypeScript AST and
// fails if any setter lacks a live invocation wired from the composition root.
//
// HERMETIC: `node:fs`, `node:path`, `typescript`, `vitest` only.

import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ACTIVATION_DIR = resolve(REPO_ROOT, 'src', 'activation');
const EXTENSION_ENTRY = resolve(REPO_ROOT, 'src', 'extension.ts');

const LATE_BINDER_NAME_RE = /^bind[A-Z][A-Za-z0-9]*$/;

export interface ExposedLateBinder {
  readonly file: string;
  readonly line: number;
  readonly name: string;
}

export interface LateBinderAuditResult {
  readonly exposed: readonly ExposedLateBinder[];
  readonly unbound: readonly ExposedLateBinder[];
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  return null;
}

function unwrapObjectLiteral(expr: ts.Expression): ts.ObjectLiteralExpression | null {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return ts.isObjectLiteralExpression(current) ? current : null;
}

/**
 * Find every `bind[A-Z]\w*` setter exposed on an object literal returned from a
 * wiring module under `activation/`.
 */
export function findExposedLateBinders(
  sources: ReadonlyMap<string, string>
): readonly ExposedLateBinder[] {
  const found: ExposedLateBinder[] = [];
  const seen = new Set<string>();

  const record = (file: string, sf: ts.SourceFile, node: ts.Node, name: string): void => {
    const key = `${file}|${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    found.push({ file, line, name });
  };

  for (const [file, body] of sources) {
    if (!/(?:^|\/)activation\/.+\.ts$/.test(file)) continue;
    const sf = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, false);

    const inspectObjectLiteral = (obj: ts.ObjectLiteralExpression): void => {
      for (const prop of obj.properties) {
        if (
          ts.isPropertyAssignment(prop) ||
          ts.isMethodDeclaration(prop) ||
          ts.isGetAccessorDeclaration(prop)
        ) {
          const propName = propertyNameText(prop.name);
          if (propName !== null && LATE_BINDER_NAME_RE.test(propName)) {
            record(file, sf, prop, propName);
          }
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          const propName = prop.name.text;
          if (LATE_BINDER_NAME_RE.test(propName)) {
            record(file, sf, prop, propName);
          }
        }
      }
    };

    const visit = (node: ts.Node): void => {
      if (ts.isReturnStatement(node) && node.expression !== undefined) {
        const obj = unwrapObjectLiteral(node.expression);
        if (obj !== null) inspectObjectLiteral(obj);
      } else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
        const obj = unwrapObjectLiteral(node.body);
        if (obj !== null) inspectObjectLiteral(obj);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }

  return found.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

/**
 * Audit every exposed late-bound setter against live call sites across the
 * composition root (`extension.ts` + `activation/*.ts`).
 *
 * A setter `bindFoo` declared in file `D` is considered wired when either:
 *   1. Another file invokes `<expr>.bindFoo(...)` directly; OR
 *   2. Another file references `<expr>.bindFoo` (forwarding the setter) AND
 *      some file other than `D` invokes `bindFoo(...)` or `<expr>.bindFoo(...)`.
 */
export function auditLateBinderWiring(
  sources: ReadonlyMap<string, string>
): LateBinderAuditResult {
  const exposed = findExposedLateBinders(sources);
  const directMemberCalls = new Map<string, Set<string>>();
  const bareIdentifierCalls = new Map<string, Set<string>>();
  const memberReferences = new Map<string, Set<string>>();

  const addFile = (map: Map<string, Set<string>>, name: string, file: string): void => {
    let files = map.get(name);
    if (files === undefined) {
      files = new Set<string>();
      map.set(name, files);
    }
    files.add(file);
  };

  for (const [file, body] of sources) {
    const sf = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, false);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (ts.isPropertyAccessExpression(node.expression)) {
          const callee = node.expression.name.text;
          if (LATE_BINDER_NAME_RE.test(callee)) {
            addFile(directMemberCalls, callee, file);
          }
        } else if (ts.isIdentifier(node.expression)) {
          const callee = node.expression.text;
          if (LATE_BINDER_NAME_RE.test(callee)) {
            addFile(bareIdentifierCalls, callee, file);
          }
        }
      } else if (ts.isPropertyAccessExpression(node)) {
        const prop = node.name.text;
        if (LATE_BINDER_NAME_RE.test(prop)) {
          addFile(memberReferences, prop, file);
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }

  const unbound: ExposedLateBinder[] = [];
  for (const binder of exposed) {
    const hasDirectExternalCall = [...(directMemberCalls.get(binder.name) ?? [])].some(
      (f) => f !== binder.file
    );
    const hasExternalForward = [...(memberReferences.get(binder.name) ?? [])].some(
      (f) => f !== binder.file
    );
    const hasExternalBareCall = [...(bareIdentifierCalls.get(binder.name) ?? [])].some(
      (f) => f !== binder.file
    );

    if (!hasDirectExternalCall && !(hasExternalForward && hasExternalBareCall)) {
      unbound.push(binder);
    }
  }

  return { exposed, unbound };
}

function loadCompositionRootSources(): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  const extensionRel = relative(REPO_ROOT, EXTENSION_ENTRY).split('\\').join('/');
  map.set(extensionRel, readFileSync(EXTENSION_ENTRY, 'utf8'));
  for (const abs of filesUnder(ACTIVATION_DIR, { extensions: ['.ts'] })) {
    if (/\.d\.ts$/.test(abs)) continue;
    const rel = relative(REPO_ROOT, abs).split('\\').join('/');
    map.set(rel, readFileSync(abs, 'utf8'));
  }
  return map;
}

describe('composition-root late-binding wiring census (F-07)', () => {
  const sources = loadCompositionRootSources();
  const audit = auditLateBinderWiring(sources);

  it('discovers the live late-bound setters exposed in src/activation/ (anti-vacuity)', () => {
    const names = audit.exposed.map((entry) => entry.name);
    expect(names.length, 'expected at least 5 late-bound setters in src/activation/').toBeGreaterThanOrEqual(5);
    expect(names).toEqual(
      expect.arrayContaining([
        'bindLivenessRecorder',
        'bindTelemetryProjector',
        'bindCapabilityProjector',
        'bindGuardedRun',
        'bindDashboardBridge'
      ])
    );
  });

  it('every bind[A-Z]* setter exposed by src/activation/ wiring has a live call site in src/activation/ or src/extension.ts', () => {
    const offenders = audit.unbound.map((b) => `${b.file}:${b.line} (${b.name})`);
    expect(
      offenders,
      'An exposed late-binding setter in src/activation/ has no live call site in the ' +
        'composition root (src/extension.ts or a forwarded src/activation/ module). ' +
        'Wire it or remove the dead setter.'
    ).toEqual([]);
  });

  it('NON-VACUITY: catches an uncalled or merely-forwarded late-bound setter while accepting direct and forwarded calls', () => {
    const synthetic = new Map<string, string>([
      [
        'fixture/activation/producer-wiring.ts',
        [
          'export function wireProducer() {',
          '  let a: unknown = null;',
          '  let b: unknown = null;',
          '  let c: unknown = null;',
          '  let d: unknown = null;',
          '  return {',
          '    bindDirect: (v: unknown) => { a = v; },',
          '    bindForwarded: (v: unknown) => { b = v; },',
          '    bindForwardedUncalled: (v: unknown) => { c = v; },',
          '    bindOrphan: (v: unknown) => { d = v; },',
          '    read: () => [a, b, c, d]',
          '  };',
          '}'
        ].join('\n')
      ],
      [
        'fixture/activation/consumer-wiring.ts',
        [
          'export function wireConsumer(deps: { bindForwarded: (v: unknown) => void; bindForwardedUncalled: (v: unknown) => void }) {',
          '  deps.bindForwarded(1);',
          '  return { ignored: deps.bindForwardedUncalled };',
          '}'
        ].join('\n')
      ],
      [
        'fixture/extension.ts',
        [
          'import { wireProducer } from "./activation/producer-wiring";',
          'import { wireConsumer } from "./activation/consumer-wiring";',
          'export function activate() {',
          '  const p = wireProducer();',
          '  p.bindDirect(1);',
          '  wireConsumer({ bindForwarded: p.bindForwarded, bindForwardedUncalled: p.bindForwardedUncalled });',
          '}'
        ].join('\n')
      ]
    ]);

    const result = auditLateBinderWiring(synthetic);
    expect(result.exposed.map((e) => e.name)).toEqual([
      'bindDirect',
      'bindForwarded',
      'bindForwardedUncalled',
      'bindOrphan'
    ]);
    expect(result.unbound.map((e) => e.name)).toEqual([
      'bindForwardedUncalled',
      'bindOrphan'
    ]);
  });
});
