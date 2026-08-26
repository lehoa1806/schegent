// FR-R3-089 — backend identity lives in contracts; the factory keeps construction.
//
// THE FINDING, AND WHY IT IS A PLACEMENT QUESTION RATHER THAN A DEFECT
//
// Eight modules across `config/` and `services/` imported `SUPPORTED_BACKENDS`
// from `src/runner/backend-runner-factory.ts` to obtain a backend enum:
// validators that only need to know *which backend names exist* depending on the
// module that knows *how to build one*. The visible symptom was a runtime cycle
// between `services/backend-containment-policy.ts` and the factory, because
// `containmentByBackend()` iterates `SUPPORTED_BACKENDS` at runtime — a value
// import, not a type-only one. Both references sat inside function bodies, so it
// resolved lazily and had no runtime failure mode. Verified, not assumed.
//
// WHAT THIS GATE FORBIDS, in two directions
//
//   1. A **value** import of the factory from outside `src/runner/`. A type-only
//      import is allowed: it carries no module edge at runtime and cannot
//      reintroduce the cycle. The distinction is the whole point, so the gate
//      reads `import type` and inline `type` specifiers rather than matching the
//      module path alone.
//   2. A **re-export hub** for the identity surface anywhere but the contracts
//      module itself. FR-R3-089 says it plainly: "Do not add a barrel. A
//      re-export hub that everything imports from is the same coupling with a
//      different filename." Without this half, the gate is satisfiable by one
//      `export * from` and the finding comes straight back.
//
// NON-VACUITY. Both rules are exercised against a fixture derived from a real
// source file — `src/config/pipeline-config.ts`, one of the original offenders —
// rather than a string authored beside this gate. The tree has no offender, so a
// derived mutation is the honest substitute (see `tests/lint/gate-integrity/`).
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const IDENTITY_MODULE = 'src/contracts/backend-kinds.ts';
const FACTORY = 'backend-runner-factory';
const SELF = 'tests/lint/backend-kind-placement.test.ts';

/** The four symbols that constitute backend identity. */
const IDENTITY_SYMBOLS = [
  'BackendRunnerKind',
  'SUPPORTED_BACKENDS',
  'DEFAULT_BACKEND',
  'isBackendRunnerKind'
] as const;

const rel = (abs: string): string => relative(REPO_ROOT, abs).replaceAll('\\', '/');

/**
 * The one enumerated exemption, with its reason inline.
 *
 * `src/extension.ts` is the composition root. It takes `resolveBackendKind` — a
 * *construction* export, not an identity one — at activation to decide which
 * runner the registry should build. Reaching construction is what a composition
 * root is for, and routing it through another module would put a second
 * resolution site in the tree to keep in step.
 *
 * The exemption is bounded twice: it may take construction exports only (the
 * identity rule below admits no exemption at all), and
 * `allowlistEntriesStillApply` fails if the file stops importing a value, so the
 * permission cannot outlive its reason the way the eight entries FR-R3-088
 * found had.
 */
const CONSTRUCTION_ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: 'src/extension.ts',
    reason: 'composition root: resolves the backend kind at activation to seed the runner registry'
  }
];

/** Every `import ... from '<path>'` statement, with its clause and its path. */
const IMPORT_STATEMENT = /import\s+(?<clause>type\s+[\w$]+|\{[^}]*\}|type\s+\{[^}]*\}|[\w$*\s,]+?)\s+from\s+(['"])(?<path>[^'"]+)\2/g;

interface ValueImport {
  readonly file: string;
  readonly symbols: readonly string[];
}

/**
 * A value import of the factory: an import statement whose module path names the
 * factory and whose clause is not entirely type-only.
 *
 * `import type { X } from` and `import { type X } from` are both type-only and
 * both allowed. `import { X }` is a value import even when `X` happens to be a
 * type, because the emitted module edge is what this gate is about.
 */
function valueImportsOfFactory(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_STATEMENT)) {
    const path = match.groups?.path ?? '';
    if (!path.includes(FACTORY)) continue;
    const clause = (match.groups?.clause ?? '').trim();
    if (clause.startsWith('type ')) continue; // `import type ...`
    const named = clause.startsWith('{')
      ? clause
          .slice(1, -1)
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
      : [clause];
    const valueNames = named
      .filter((part) => !part.startsWith('type '))
      .map((part) => (part.split(/\s+as\s+/)[0] as string).trim())
      .filter((part) => part.length > 0);
    if (valueNames.length > 0) found.push(...valueNames);
  }
  return found;
}

/** A module that re-exports any identity symbol. */
function reExportsIdentity(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/export\s+(?:type\s+)?(\{[^}]*\}|\*)\s+from\s+(['"])([^'"]+)\2/g)) {
    const clause = match[1] as string;
    if (clause === '*') {
      if ((match[3] as string).includes('backend-kinds') || (match[3] as string).includes(FACTORY)) {
        found.push('* from ' + (match[3] as string));
      }
      continue;
    }
    for (const symbol of IDENTITY_SYMBOLS) {
      if (new RegExp(`\\b${symbol}\\b`).test(clause)) found.push(symbol);
    }
  }
  return found;
}

const sources = filesUnder(resolve(REPO_ROOT, 'src'), { extensions: ['.ts'] })
  .concat(filesUnder(resolve(REPO_ROOT, 'tests'), { extensions: ['.ts'] }))
  .filter((file) => !rel(file).includes('/generated/'));

describe('FR-R3-089 — backend identity is imported from contracts, not from the factory', () => {
  // Without this the scan could be emptied by a path typo and every assertion
  // below would pass trivially — the failure a placement gate can least afford.
  it('scanned a non-empty tree that includes the identity module and the factory', () => {
    expect(sources.length).toBeGreaterThan(300);
    expect(sources.map(rel)).toContain(IDENTITY_MODULE);
    expect(sources.map(rel)).toContain('src/runner/backend-runner-factory.ts');
  });

  it('no module ANYWHERE takes an IDENTITY symbol as a value from the factory', () => {
    // This rule admits no exemption. Identity has one home and the factory is
    // not it — that is the whole finding.
    const offenders: ValueImport[] = [];
    for (const file of sources) {
      const path = rel(file);
      if (path === SELF) continue;
      const symbols = valueImportsOfFactory(readFileSync(file, 'utf8')).filter((symbol) =>
        (IDENTITY_SYMBOLS as readonly string[]).includes(symbol)
      );
      if (symbols.length > 0) offenders.push({ file: path, symbols });
    }
    expect(offenders).toEqual([]);
  });

  it('no module outside src/runner/ takes a VALUE from backend-runner-factory, except the enumerated composition root', () => {
    const allowed = new Set(CONSTRUCTION_ALLOWLIST.map((entry) => entry.file));
    const offenders: ValueImport[] = [];
    for (const file of sources) {
      const path = rel(file);
      if (path.startsWith('src/runner/')) continue;
      if (path === SELF || allowed.has(path)) continue;
      // Test files construct runners deliberately — placement is a `src/`
      // question — so the tests tree is out of scope for this rule, and the
      // identity rule above still covers it without exemption.
      if (path.startsWith('tests/')) continue;
      const symbols = valueImportsOfFactory(readFileSync(file, 'utf8'));
      if (symbols.length > 0) offenders.push({ file: path, symbols });
    }
    expect(offenders).toEqual([]);
  });

  it('every allowlist entry still applies — an exemption outliving its reason is the FR-R3-088 defect', () => {
    const stale = CONSTRUCTION_ALLOWLIST.filter((entry) => {
      const source = readFileSync(resolve(REPO_ROOT, entry.file), 'utf8');
      return valueImportsOfFactory(source).length === 0;
    }).map((entry) => entry.file);
    expect(stale).toEqual([]);
  });

  it('every allowlist entry carries a reason a reader can act on', () => {
    for (const entry of CONSTRUCTION_ALLOWLIST) {
      expect(entry.reason.length).toBeGreaterThan(30);
    }
  });

  it('no module re-exports the identity surface — a barrel is the same coupling renamed', () => {
    const offenders: ValueImport[] = [];
    for (const file of sources) {
      const path = rel(file);
      if (path === IDENTITY_MODULE || path === SELF) continue;
      const symbols = reExportsIdentity(readFileSync(file, 'utf8'));
      if (symbols.length > 0) offenders.push({ file: path, symbols });
    }
    expect(offenders).toEqual([]);
  });

  it('NON-VACUITY: a value import added to a real config module is detected', () => {
    // Derived from the tree, not authored beside the gate: this is the exact
    // import `pipeline-config.ts` carried before FR-R3-089 moved it.
    const real = readFileSync(resolve(REPO_ROOT, 'src/config/pipeline-config.ts'), 'utf8');
    const mutated = real.replace(
      /^import \{[^}]*\} from '\.\.\/contracts\/backend-kinds';$/m,
      "import { SUPPORTED_BACKENDS, isBackendRunnerKind, type BackendRunnerKind } from '../runner/backend-runner-factory';"
    );
    expect(mutated).not.toBe(real);
    expect(valueImportsOfFactory(mutated)).toContain('SUPPORTED_BACKENDS');
    // and the unmutated file is clean, so the detector is not matching everything
    expect(valueImportsOfFactory(real)).toEqual([]);
  });

  it('NON-VACUITY: a type-only import of the factory is NOT reported', () => {
    const typeOnly = "import type { BackendRunnerKind } from '../runner/backend-runner-factory';";
    expect(valueImportsOfFactory(typeOnly)).toEqual([]);
    const inlineType = "import { type BackendRunnerKind } from '../runner/backend-runner-factory';";
    expect(valueImportsOfFactory(inlineType)).toEqual([]);
  });

  it('NON-VACUITY: a re-export hub is detected', () => {
    expect(reExportsIdentity("export { SUPPORTED_BACKENDS } from './contracts/backend-kinds';"))
      .toContain('SUPPORTED_BACKENDS');
    expect(reExportsIdentity("export * from './contracts/backend-kinds';"))
      .toHaveLength(1);
    expect(reExportsIdentity("export { somethingElse } from './other';")).toEqual([]);
  });
});
