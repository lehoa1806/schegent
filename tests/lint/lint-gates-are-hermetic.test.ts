// FR-R3-033 — a lint gate may not depend on a binary this project does not
// declare, and the preflight's description may not drift from what it runs.
//
// Both rules exist because of the same incident. Two of 88 gates in this
// directory resolved their file sets by spawning `rg`, which appears in no
// `devDependencies`, no workflow install step, and no `CONTRIBUTING`
// prerequisite. `npm run test:host` therefore failed on any machine without it
// — including the one a review ran on — while `CONTRIBUTING` named
// `npm run ci:fast` as the expectation for review. Nobody noticed for as long
// as everyone who ran it happened to have ripgrep installed.
//
// The second rule is the same drift one level up: `ci:fast` was described as
// "typecheck + lint + unit" while the script ran seven targets including a
// browser-backed visual suite and a VSIX build.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = resolve(__dirname, '..', '..');
const LINT_DIR = 'tests/lint';
const read = (path: string): string => readFileSync(resolve(REPO_ROOT, path), 'utf8');

/**
 * Tools a gate may invoke, and why each is considered available.
 *
 * The rule is not "do not spawn" — 22 gates in this directory already resolve
 * file sets with `grep` and `find`, and rewriting them is not what this finding
 * is about. The rule is "do not depend on a binary this project has not
 * declared". Ripgrep was undeclared: absent from `devDependencies`, from every
 * workflow install step, and from `CONTRIBUTING` Prerequisites, so `test:host`
 * failed on any machine without it while `CONTRIBUTING` named `ci:fast` as the
 * expectation for review.
 */
const AVAILABLE_TOOLS: ReadonlyArray<{ tool: string; why: string }> = [
  { tool: 'grep', why: 'POSIX; 22 existing gates depend on it' },
  { tool: 'find', why: 'POSIX; 4 existing gates depend on it' },
  { tool: 'git', why: 'this is a git repository; a checkout implies it' },
  { tool: 'node', why: 'the runtime the suite already runs in' },
  { tool: 'npm', why: 'declared by the project and required to run the suite at all' }
];

/**
 * Recorded, not fixed here: `grep` and `find` are POSIX and present on the
 * darwin and linux legs, but `ci.yml` declares a three-OS matrix. On the Windows
 * leg these 22 gates depend on tools that are not guaranteed. That is a real
 * portability question and a much larger change than this item scoped, so it is
 * written down rather than silently widened into this rule. Grandfathering them
 * here is a deliberate, visible decision.
 */

/**
 * Every tool a gate invokes, resolved from the TypeScript AST.
 *
 * A regex over `execSync(\`tool ...\`)` was the first design and it was
 * defeated by one line of indirection — `const bin = 'rg'; execSync(\`${bin}
 * --version\`)` passed cleanly, which is the exact incident this check exists
 * to prevent, undetected by the check meant to prevent it. Others that slipped
 * through: a command held in a variable, a tool name passed as an identifier to
 * `execFileSync`, and plain async `exec`, which the pattern did not even name.
 *
 * So the rule is inverted. Every call to a child_process entry point is found by
 * parsing, and its first argument must be a literal this file can read. An
 * argument it cannot read is not assumed benign — it is reported, because an
 * unreadable command is precisely how an undeclared binary gets in.
 */
const SPAWN_FUNCTIONS = new Set([
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'spawn',
  'spawnSync',
  'fork'
]);

interface Invocation {
  readonly tool: string | null;
  readonly text: string;
}

/**
 * Local names bound to child_process spawn functions in this file.
 *
 * Matching on the callee's name alone is wrong: `RegExp.prototype.exec` is also
 * called `exec`, and 18 gates in this directory use it. Resolving through the
 * import declaration is what separates `execSync` the subprocess from `.exec`
 * the regex method.
 */
function spawnBindings(file: ts.SourceFile): {
  direct: Map<string, string>;
  namespaces: Set<string>;
} {
  const direct = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const from = statement.moduleSpecifier.text;
    if (from !== 'node:child_process' && from !== 'child_process') continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (SPAWN_FUNCTIONS.has(imported)) direct.set(element.name.text, imported);
      }
    }
  }
  return { direct, namespaces };
}

function invocations(source: string, fileName: string): Invocation[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const { direct, namespaces } = spawnBindings(file);
  if (direct.size === 0 && namespaces.size === 0) return [];
  const found: Invocation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      let isSpawn = false;
      if (ts.isIdentifier(node.expression)) {
        isSpawn = direct.has(node.expression.text);
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression)
      ) {
        isSpawn =
          namespaces.has(node.expression.expression.text) &&
          SPAWN_FUNCTIONS.has(node.expression.name.text);
      }
      if (isSpawn) {
        // `arguments[0]` types as Expression rather than Expression | undefined
        // (noUncheckedIndexedAccess is off — see TOOLCHAIN-2), so the length
        // check is what actually guards an empty argument list.
        const first = node.arguments.length > 0 ? node.arguments[0] : undefined;
        let tool: string | null = null;
        if (first !== undefined && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
          tool = first.text.trim().split(/\s+/)[0] ?? null;
        } else if (first !== undefined && ts.isTemplateExpression(first)) {
          // `${bin} --version` has an empty head: the command itself is
          // interpolated and therefore unreadable here.
          const head = first.head.text.trim();
          tool = head.length > 0 ? (head.split(/\s+/)[0] ?? null) : null;
        }
        found.push({ tool, text: node.getText(file).slice(0, 80).replace(/\s+/g, ' ') });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('lint gates depend on no undeclared binary', () => {
  it('invokes only tools this project has declared', () => {
    const allowed = new Set(AVAILABLE_TOOLS.map((entry) => entry.tool));
    const offenders: string[] = [];
    for (const entry of readdirSync(resolve(REPO_ROOT, LINT_DIR))) {
      if (!entry.endsWith('.ts')) continue;
      const path = `${LINT_DIR}/${entry}`;
      // This file names tools in its own allowlist; scanning itself would
      // report them. It invokes nothing — asserted below rather than assumed.
      if (path === `${LINT_DIR}/lint-gates-are-hermetic.test.ts`) continue;
      for (const call of invocations(read(path), entry)) {
        if (call.tool === null) {
          offenders.push(
            `${path}: command is not a readable literal — \`${call.text}\``
          );
          continue;
        }
        if (!allowed.has(call.tool)) offenders.push(`${path}: ${call.tool}`);
      }
    }
    expect(
      offenders,
      `A lint gate invokes a binary this project does not declare. Gates run inside ` +
        `\`test:host\`, which \`ci:fast\` runs and which CONTRIBUTING names as the expectation for ` +
        `review — so an undeclared tool makes the documented preflight impossible to pass from a ` +
        `documented setup, which is exactly how ripgrep got in. Resolve file sets with \`node:fs\` ` +
        `(see tests/lint/webview-source-scan.ts) or the TypeScript compiler (see ` +
        `tests/lint/empty-catch-declares-intent.test.ts). If the tool genuinely belongs, declare it ` +
        `in CONTRIBUTING Prerequisites and add it to AVAILABLE_TOOLS with that reason.\n  ` +
        `${offenders.join('\n  ')}`
    ).toEqual([]);
  });
});

describe('the preflight description matches the preflight', () => {
  /** The npm targets `ci:fast` actually runs, in order, derived from the manifest. */
  function ciFastTargets(): string[] {
    const manifest = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
    const script = manifest.scripts?.['ci:fast'];
    expect(
      script,
      'package.json declares no `ci:fast` script. This check derives the target list from the ' +
        'manifest so it cannot go stale; if the preflight was renamed, rename it here too.'
    ).toBeTruthy();
    return [...(script as string).matchAll(/npm run ([\w:-]+)/g)].map((match) => match[1]);
  }

  it('names every target the script runs', () => {
    // Scoped to the description itself, not the whole document.
    //
    // A first version searched all of CONTRIBUTING.md and did not fire when
    // `test:perf` was added to `ci:fast` — because `test:perf` already has its
    // own row in the same command table. Every target of every script is named
    // somewhere in that table, so a document-wide search can never fail. The
    // unit that must name them is the `ci:fast` row.
    //
    // Collapsed before matching: the description is a table cell today and could
    // be reflowed into a list tomorrow, and a rule a rewrap defeats is a rule
    // that silently stops holding.
    const doc = read('CONTRIBUTING.md');
    const describing = doc
      .split('\n')
      .filter((line) => line.includes('ci:fast'))
      .join(' ')
      .replace(/\s+/g, ' ');
    expect(
      describing.length,
      'CONTRIBUTING.md no longer describes `ci:fast` anywhere. It is the command the same document ' +
        'names as the expectation for review; if it was renamed, rename it here too.'
    ).toBeGreaterThan(0);
    const prose = describing;
    const missing = ciFastTargets().filter((target) => !prose.includes(target));
    expect(
      missing,
      `CONTRIBUTING.md describes \`ci:fast\` without naming ${missing.join(', ')}. A contributor ` +
        `reading a three-target description will not expect a browser download or a VSIX build, ` +
        `and will read the resulting delay or failure as a broken checkout. Update the description ` +
        `when the script changes.`
    ).toEqual([]);
  });
});
