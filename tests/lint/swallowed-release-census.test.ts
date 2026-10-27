// FR-R4-F01 (spec 239, US6, T069, research R3a/C7, FR-033, contract K5) — a release that fails
// says so, except in the one place where saying nothing is the decision.
//
// `ExecutionLeaseManager.release` used to return `Promise<void>`, so a release the registry
// refused (`not-holder`) or could not write (`unavailable`) looked identical to one that worked,
// and four call sites wrapped the call in `.catch(() => undefined)` besides. A lease that was
// not given back is exactly the failure an operator meets as "this queue will not start for
// fifteen seconds" with nothing in the log to connect the two.
//
// What is now counted, keyed by file and enclosing function (never by line, which moves):
//
//   1. every `.release(...)` call wrapped in `.catch(...)` (directly, or through
//      `Promise.resolve(...)`) under `src/state`, `src/services` and `src/controller`. Exactly
//      one site may stay silent, and its reason is recorded below;
//   2. the sites that were silent and now go through `releaseLeaseLogged`, with how many calls
//      each has, so a fifth swallow cannot be added by copying a neighbour;
//   3. `release` and `releaseOne` on the lease manager and `release` on the port are typed
//      `ReleaseOutcome`, and `WorkspaceLockManager.release` logs the outcome it was given.
//
// KEPT SILENT — `state/execution-lease.ts#ExecutionLeaseManager.withLease`. A lease taken by
// `withLease` ends inside the call that took it, and this is its `finally`. The function's own
// result (or its own throw) is what the caller must see: a release failure surfacing from a
// `finally` would replace it. A lease that was not given back ends in the staleness reclaim
// (`STALENESS_THRESHOLD_MS`, 15 s), the same bound every other failed release already has. That is
// a decision, recorded here rather than left as an unexplained `catch`.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..', '..', 'src');
const SCANNED_DIRECTORIES = ['state', 'services', 'controller'] as const;

interface SilentRow {
  readonly site: string;
  readonly reason: string;
}

const KEPT_SILENT: readonly SilentRow[] = [
  {
    site: 'state/execution-lease.ts#ExecutionLeaseManager.withLease',
    reason:
      'the lease ends inside the call that took it; a throw from this finally would replace the ' +
      "function's own result, and a lease not given back ends in the 15 s staleness reclaim"
  }
];

interface LoggedRow {
  readonly site: string;
  readonly calls: number;
}

/** Sites that were swallowed and now call `releaseLeaseLogged`, with their call counts. */
const NOW_LOGGED: readonly LoggedRow[] = [
  { site: 'services/auto-drain-coordinator.ts#AutoDrainCoordinator.startPendingHead', calls: 3 },
  { site: 'controller/workflow-controller.ts#SchegentWorkflowController.resumeExistingOnQueue', calls: 1 }
];

function sourceFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** The nearest named function-like ancestor, as `Class.method`, `function` or `variable`. */
function enclosingFunction(node: ts.Node): string {
  for (let current = node.parent as ts.Node | undefined; current; current = current.parent as ts.Node | undefined) {
    if (ts.isMethodDeclaration(current) || ts.isConstructorDeclaration(current)) {
      const cls = current.parent;
      const owner = ts.isClassLike(cls) && cls.name ? `${cls.name.text}.` : '';
      const name = ts.isConstructorDeclaration(current) ? 'constructor' : current.name.getText();
      return `${owner}${name}`;
    }
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
      if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
        return parent.name.getText();
      }
    }
  }
  return '<module>';
}

const siteOf = (file: string, node: ts.Node): string =>
  `${relative(SRC, file).split('\\').join('/')}#${enclosingFunction(node)}`;

const isMethodCall = (node: ts.Node, name: string): node is ts.CallExpression =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  node.expression.name.text === name;

/** `X.release(...)`, or `Promise.resolve(X.release(...))`, with a `.catch(...)` chained on it. */
function isSwallowedRelease(node: ts.Node): boolean {
  if (!isMethodCall(node, 'catch')) return false;
  const receiver = (node.expression as ts.PropertyAccessExpression).expression;
  if (isMethodCall(receiver, 'release')) return true;
  return (
    ts.isCallExpression(receiver) &&
    receiver.expression.getText() === 'Promise.resolve' &&
    receiver.arguments.some((argument) => isMethodCall(argument, 'release'))
  );
}

function countBy(items: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

const scannedFiles = SCANNED_DIRECTORIES.flatMap((directory) => sourceFiles(join(SRC, directory)));

function sitesOf(matches: (node: ts.Node) => boolean): ReadonlyMap<string, number> {
  const sites: string[] = [];
  for (const file of scannedFiles) {
    const source = parse(file);
    const visit = (node: ts.Node): void => {
      if (matches(node)) sites.push(siteOf(file, node));
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return countBy(sites);
}

describe('the swallowed-release census (C7)', () => {
  it('scans a real tree: the control finds the lease manager and the coordinator', () => {
    const names = scannedFiles.map((file) => relative(SRC, file).split('\\').join('/'));
    expect(names).toContain('state/execution-lease.ts');
    expect(names).toContain('services/auto-drain-coordinator.ts');
    expect(names).toContain('controller/workflow-controller.ts');
  });

  it('leaves exactly the recorded call silent, and no other release swallowed', () => {
    const swallowed = sitesOf(isSwallowedRelease);

    expect([...swallowed.keys()].sort()).toEqual(KEPT_SILENT.map((row) => row.site).sort());
    for (const row of KEPT_SILENT) {
      expect(swallowed.get(row.site), row.site).toBe(1);
      expect(row.reason.length, `${row.site} has no recorded reason`).toBeGreaterThan(40);
    }
  });

  it('routes the four formerly-swallowed sites through releaseLeaseLogged, call for call', () => {
    const logged = sitesOf((node) => ts.isCallExpression(node) && node.expression.getText() === 'releaseLeaseLogged');

    expect(Object.fromEntries(logged)).toEqual(
      Object.fromEntries(NOW_LOGGED.map((row) => [row.site, row.calls]))
    );
  });

  it('keeps the helper itself from swallowing: it names the outcome it logs', () => {
    const source = readFileSync(join(SRC, 'state', 'execution-lease.ts'), 'utf8');
    const helper = /export async function releaseLeaseLogged[\s\S]*?\n}\n/.exec(source);

    expect(helper, 'releaseLeaseLogged is exported from state/execution-lease.ts').not.toBeNull();
    expect(helper![0]).toContain("'execution lease release failed'");
    expect(helper![0]).toContain('outcome');
    expect(helper![0]).not.toMatch(/\.catch\(\s*\(\)\s*=>\s*undefined\s*\)/);
  });
});

/** The text of a method's declared return type, or `null` when the method is absent. */
function declaredReturnType(file: string, owner: string, method: string): string | null {
  const source = parse(join(SRC, file));
  let found: string | null = null;
  const visit = (node: ts.Node): void => {
    const named =
      (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) && node.name.getText() === method;
    const parent = node.parent as ts.Node | undefined;
    const ownedBy =
      parent !== undefined &&
      (ts.isClassLike(parent) || ts.isInterfaceDeclaration(parent)) &&
      parent.name?.text === owner;
    if (named && ownedBy) found = (node as ts.MethodDeclaration).type?.getText() ?? '<inferred>';
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('release answers with a typed outcome (K5)', () => {
  it.each([
    ['state/execution-lease.ts', 'ExecutionLeaseManager', 'release'],
    ['state/execution-lease.ts', 'ExecutionLeaseManager', 'releaseOne'],
    ['services/auto-drain-coordinator.ts', 'ExecutionLeasePort', 'release']
  ])('%s %s.%s is declared in terms of ReleaseOutcome', (file, owner, method) => {
    const type = declaredReturnType(file, owner, method);

    expect(type, `${owner}.${method} was not found in ${file}`).not.toBeNull();
    expect(type).toContain('ReleaseOutcome');
  });

  it('WorkspaceLockManager.release logs the outcome it was given, and only the outcome', () => {
    const source = parse(join(SRC, 'state', 'lock.ts'));
    let body: string | null = null;
    const visit = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node) && node.name.getText() === 'release') body = node.body?.getText() ?? null;
      ts.forEachChild(node, visit);
    };
    visit(source);

    expect(body, 'WorkspaceLockManager.release was not found').not.toBeNull();
    expect(body).toMatch(/logger\?\.warn\(\s*'workspace lock release failed'/);
    expect(body).toContain('outcome');
  });
});
