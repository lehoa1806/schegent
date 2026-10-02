// Feature 217 (FR-008, SC-002, SC-003) — every path the product creates for
// itself declares its mode, and exactly one routine narrows a path that exists.
//
// FR-008 has two halves. The first is the type split in `src/lib/safe-open.ts`:
// a writing open that omits `fileMode`, or a directory-creating one that omits
// `dirMode`, no longer compiles. That is the half the checker can provide, and it
// covers only code that calls the helper. A sink that never calls it is invisible
// to the type system — `fsp.open(p, 'a')` typechecks with no mode at all — and
// that is how the CLI transport log and the runtime log came to be written 0o644
// under a 022 umask, readable by every local account
// (specs/217-evidence-posture-and-bounds/measurements.md). This gate is the second
// half: it finds every place `src/` creates a path without the helper, and fails
// unless that place is the helper itself or carries a stated reason.
//
// The subject set is the scan. Nothing here lists which modules are sinks: every
// `.ts` file under `src/` is parsed by TypeScript, and each file's own imports say
// which of its names reach `node:fs` — a namespace (`* as fs`), a default import,
// `{ promises as fsp }`, or a named entry (`{ open }`). A list of sinks is a list
// somebody forgets to extend, and the module that was never on it is the one the
// defect lives in. `tests/lint/safe-open-migration.test.ts` is the nearest gate,
// and it shows the cost: its pattern needs an `fs`-prefixed receiver, so it cannot
// see a bare `createWriteStream(...)` or an `fs.promises.open(...)`. This one
// resolves bindings instead of spelling them.
//
// A reach is wider than a call. A port default (`deps.mkdir ?? fs.mkdir`) hands a
// raw creating function to whoever calls the port later, so a value reference
// counts. A namespace handed on whole is followed when the hand-off types it as an
// interface declared in the same file (`filesystem: ContainmentFs = nodeFs`): such a
// port reaches only the members it declares, and each member counts as a reference.
// Any other name the scan cannot follow — an untyped hand-off, a port declared in
// another module or extending one, a `require`, a dynamic `import()` — fails rather
// than passing unread. The scan reads syntax, not types, so a hand-off it follows is
// bounded by what the interface declares; a cast past the interface is outside what
// any syntactic gate can see, and the reviewer is the control for that. Two further
// reaches are not `node:fs` at all: VS Code's `workspace.fs` creates files and
// takes no mode, and a `chmod` on any receiver is a second narrowing mechanism,
// which FR-007 and SC-003 forbid outside `src/lib/narrow-mode.ts`
// (contracts/narrow-mode.md, invariant 4).
//
// Hard rule 67: the gate searches call expressions and field NAMES — `fileMode`,
// `dirMode`, a `mode` property — and never a mode value or a path string. A gate
// written against `0o600` would pass a sink declaring `0o644`, and one written
// against `'.schegent'` would pass every sink that composes its path.
//
// The verdict is one function of the occurrences (T1804a). The real scan must give
// no failures, and a deliberately non-conforming synthetic source must give one
// that names its own file and line. Without that second half the suite proves only
// that the tree is clean today, which a gate that enforces nothing also proves.
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** The helper every evidence open is funnelled through (FR-008). */
const HELPER_FILE = 'src/lib/safe-open.ts';

/** The one routine that narrows a path which already exists (FR-007, SC-003). */
const NARROWING_FILE = 'src/lib/narrow-mode.ts';

const NODE_FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);

/**
 * `node:fs` entries that create a path or open one for writing: the subjects.
 * `rename` is not one. It moves an inode that already has its mode, and the file it
 * publishes was created somewhere this scan sees. That is the stated reason for the
 * `rename` ports the CLI transport and runtime-log sinks keep (T1803): each serves
 * rotation alone, moving a generation the sink itself wrote, mode and all, to the
 * next generation's name.
 */
const WRITING_ENTRIES = new Set([
  'open',
  'openSync',
  'appendFile',
  'appendFileSync',
  'writeFile',
  'writeFileSync',
  'mkdir',
  'mkdirSync',
  'mkdtemp',
  'mkdtempSync',
  'createWriteStream',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync'
]);

/** VS Code's file API entries that create a path. */
const WORKSPACE_FS_WRITING = new Set(['writeFile', 'createDirectory', 'copy']);

/**
 * Writing entries whose signature has no mode parameter: `mkdtemp` creates 0o700
 * by construction, a copy takes its source's mode, and VS Code's file API takes
 * none. A disposition can give the reason; nothing at the call can declare a mode.
 */
const MODELESS_ENTRIES = new Set([
  'mkdtemp',
  'mkdtempSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  ...[...WORKSPACE_FS_WRITING].map((entry) => `workspace.fs.${entry}`)
]);

/** Entries that change a mode, on any receiver. Narrowing is `narrow-mode.ts`'s alone. */
const MODE_ENTRIES = new Set(['chmod', 'chmodSync', 'lchmod', 'lchmodSync', 'fchmod', 'fchmodSync']);

/** The helper's opens. Each takes its options third. */
const HELPER_OPENS = new Set(['openWithinRoot', 'openWithinRootByPath']);

/** The helper's directory creators. Each takes a required `dirMode` third. */
const HELPER_WALKS = new Set(['ensureDirWithinRoot', 'ensureAnchorWithinRoot']);

/** The fields a mode is declared through, by name (rule 67). */
const DECLARED_FIELDS = new Set(['fileMode', 'dirMode']);

/**
 * - `writes`: creates a path, or opens one for writing.
 * - `changes-mode`: a `chmod`.
 * - `unresolved`: reaches `node:fs` through a name the scan cannot follow.
 * - `other`: reaches the filesystem and does neither; counted, never judged.
 */
type Kind = 'writes' | 'changes-mode' | 'unresolved' | 'other';

interface Occurrence {
  /** Repository-relative, forward slashes. */
  readonly file: string;
  readonly line: number;
  /** A `node:fs` entry (`open`), `workspace.fs.writeFile`, or a helper (`openWithinRoot`). */
  readonly entry: string;
  readonly kind: Kind;
  /** A call, or a value reference: a port default hands the function on. */
  readonly form: 'call' | 'reference';
  /**
   * The names written where the call declares its modes: the identifiers in a raw
   * call's mode argument, or the property names of a helper's options. `null` when
   * the call has nowhere the scan can read one.
   */
  readonly declared: readonly string[] | null;
  /** A helper open that creates directories, and so must declare `dirMode` as well. */
  readonly createsDirs: boolean;
}

type Shape = Omit<Occurrence, 'file' | 'line'>;

/**
 * A reach that bypasses the helper on purpose, and why. Keyed by file and entry;
 * `sites` pins how many places the reason covers, so a new call in a reasoned-about
 * file is a new decision rather than one inherited by proximity.
 */
interface Disposition {
  readonly file: string;
  readonly entry: string;
  readonly sites: number;
  readonly reason: string;
}

const ROOTLESS_RUNTIME_LOG =
  'Port default for a runtime-log sink built without `containmentRoots`, which only ' +
  'tests do. Production passes the roots (`src/activation/backend-wiring.ts`, pinned by ' +
  '`destructive-fs-requires-containment.test.ts`), and a rooted sink opens through the ' +
  'helper, so this function is reached only by a sink no user runs. ' +
  '`safe-open-migration.test.ts` records the same ports as TEST_ONLY_FS_PORT.';

/**
 * Every reach that creates a path without the helper, with its reason. The ledger
 * may only shrink, by routing a site through the helper; an entry whose site has
 * gone fails as stale, and a site with no entry fails by name.
 */
const DISPOSITIONS: readonly Disposition[] = [
  {
    file: 'src/services/run-checkpoint-service.ts',
    entry: 'mkdir',
    sites: 1,
    reason:
      "Creates the checkpoint root in VS Code's global storage, outside every workspace. " +
      'There is no root above it for the helper to walk from: it IS the root the helper ' +
      'walks from for every checkpoint under it (`safe-open-migration.test.ts` records it ' +
      'as TRUST_ANCHOR). It declares its mode.'
  },
  {
    file: 'src/services/evidence-export.ts',
    entry: 'mkdir',
    sites: 1,
    reason:
      'Creates the export directory the operator named, which is outside the workspace ' +
      "by design, so the helper — whose contract is 'within the workspace root' — cannot " +
      'express it. It declares its mode.'
  },
  {
    file: 'src/services/evidence-export.ts',
    entry: 'writeFile',
    sites: 2,
    reason:
      'Writes each exported file and the manifest into that operator-named destination, ' +
      'each after `resolveContainedForWrite` has checked its path against it. Both declare ' +
      'their mode.'
  },
  {
    file: 'src/commands/export-audit.ts',
    entry: 'workspace.fs.writeFile',
    sites: 1,
    reason:
      'Saves the counts-only audit export where the operator chose in a save dialog. The ' +
      'export carries counts, not evidence content; the destination is the operator\'s; ' +
      "and VS Code's file API has no mode parameter."
  },
  {
    file: 'src/activation/sidebar-router-wiring.ts',
    entry: 'workspace.fs.writeFile',
    sites: 1,
    reason:
      'Saves a process YAML document through a save dialog: a definition the operator ' +
      "exported, not evidence, to a place the operator chose. VS Code's file API has no " +
      'mode parameter.'
  },
  {
    file: 'src/audit/raw-transcript-writer.ts',
    entry: 'createWriteStream',
    sites: 2,
    reason:
      "The spool's stdout and stderr files, inside the per-run spool directory in OS temp " +
      "rather than the workspace. Each is created `wx` with a declared mode, so the file " +
      'is always new and the mode always applies.'
  },
  {
    file: 'src/audit/raw-transcript-writer.ts',
    entry: 'mkdtemp',
    sites: 1,
    reason:
      'Creates the per-run spool directory under the spool root, which ' +
      '`ensureAnchorWithinRoot` anchors at its OS-temp parent. `mkdtemp` creates owner-only ' +
      'by construction and takes no mode.'
  },
  {
    file: 'src/audit/raw-transcript-writer.ts',
    entry: 'chmod',
    sites: 1,
    reason:
      'Pins the directory `mkdtemp` has just created to 0o700. That can differ only under a ' +
      'umask that removed owner bits; `mkdtemp` grants no other bit, so there is none to ' +
      'clear. It reads no mode and narrows nothing, which is why it is reasoned about here ' +
      'rather than replaced: `narrowMode` only ever clears bits, and could not give back ' +
      'the owner write the spool needs.'
  },
  { file: 'src/lib/runtime-log/runtime-log-sink.ts', entry: 'appendFile', sites: 1, reason: ROOTLESS_RUNTIME_LOG },
  { file: 'src/lib/runtime-log/runtime-log-sink.ts', entry: 'mkdir', sites: 1, reason: ROOTLESS_RUNTIME_LOG },
  { file: 'src/lib/runtime-log/runtime-log-sink.ts', entry: 'writeFile', sites: 1, reason: ROOTLESS_RUNTIME_LOG },
  {
    file: 'src/monitor/cli-transport-sink.ts',
    entry: 'mkdir',
    sites: 1,
    reason:
      'Port default for the parent recovery, which runs only after an injected write port ' +
      'fails ENOENT. The production factory injects no write port — pinned by ' +
      "`safe-open-migration.test.ts`, 'keeps the injected fs ports out of production " +
      "wiring' — so every production open goes through the helper."
  }
];

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

interface FsBindings {
  /** Local names bound to a whole `node:fs` module, or to its `promises` object. */
  readonly namespaces: ReadonlySet<string>;
  /** Local names bound to one entry, mapped to the entry's own name. */
  readonly entries: ReadonlyMap<string, string>;
}

/** Which names in this file reach `node:fs`, read from its imports. Types reach nothing. */
function fsBindings(source: ts.SourceFile): FsBindings {
  const namespaces = new Set<string>();
  const entries = new Map<string, string>();
  for (const statement of source.statements) {
    if (ts.isImportEqualsDeclaration(statement)) {
      const reference = statement.moduleReference;
      if (
        !statement.isTypeOnly &&
        ts.isExternalModuleReference(reference) &&
        ts.isStringLiteral(reference.expression) &&
        NODE_FS_MODULES.has(reference.expression.text)
      ) {
        namespaces.add(statement.name.text);
      }
      continue;
    }
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier) || !NODE_FS_MODULES.has(specifier.text)) continue;
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    if (clause.name !== undefined) namespaces.add(clause.name.text);
    const named = clause.namedBindings;
    if (named === undefined) continue;
    if (ts.isNamespaceImport(named)) {
      namespaces.add(named.name.text);
      continue;
    }
    for (const element of named.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName ?? element.name).text;
      if (imported === 'promises') namespaces.add(element.name.text);
      else entries.set(element.name.text, imported);
    }
  }
  return { namespaces, entries };
}

/**
 * Whether this identifier evaluates its binding. A declaration, a property name, or
 * a type position names something without reaching it.
 */
function isValueReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isImportEqualsDeclaration(parent) ||
    ts.isQualifiedName(parent) ||
    ts.isTypeQueryNode(parent) ||
    ts.isTypeReferenceNode(parent)
  ) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === id;
  if (ts.isBindingElement(parent)) return parent.name !== id && parent.propertyName !== id;
  const declares =
    ts.isVariableDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isPropertyAssignment(parent);
  return !(declares && parent.name === id);
}

/** The member this expression is the receiver of: `open` for the `fs` in `fs.open`. */
function memberOf(expression: ts.Expression): string | null {
  const parent = expression.parent;
  return ts.isPropertyAccessExpression(parent) && parent.expression === expression
    ? parent.name.text
    : null;
}

function callOf(site: ts.Expression): ts.CallExpression | null {
  const parent = site.parent;
  return ts.isCallExpression(parent) && parent.expression === site ? parent : null;
}

function propertyNamed(object: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const property of object.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
      return property.name;
    }
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name
    ) {
      return property.initializer;
    }
  }
  return null;
}

/** Every identifier written in an expression: `options.fileMode` gives both names. */
function namesIn(node: ts.Node): string[] {
  const names: string[] = [];
  const walk = (child: ts.Node): void => {
    if (ts.isIdentifier(child)) names.push(child.text);
    ts.forEachChild(child, walk);
  };
  walk(node);
  return names;
}

/** A flag that opens for writing. One the scan cannot read is assumed to. */
function writesFlag(flag: ts.Expression): boolean {
  return !ts.isStringLiteralLike(flag) || /[wa+]/.test(flag.text);
}

/**
 * Where a raw `node:fs` call declares its mode: `open`'s third argument, a `mode`
 * property of the options, or `mkdir`'s positional mode. `null` when there is none
 * the scan can read; an options object built elsewhere declares nothing visible.
 */
function modeExpression(entry: string, args: ts.NodeArray<ts.Expression>): ts.Expression | null {
  const bare = entry.replace(/Sync$/, '');
  // `.at()`, not brackets, wherever the read is guarded: it is the one form the
  // linter and the strictness ratchet both accept
  // (docs/development/lint-and-type-aware-rules.md).
  if (bare === 'open') return args.at(2) ?? null;
  const options = args.at(bare === 'mkdir' || bare === 'createWriteStream' ? 1 : 2);
  if (options === undefined) return null;
  if (ts.isObjectLiteralExpression(options)) return propertyNamed(options, 'mode');
  // `mkdir` alone takes its mode positionally; elsewhere this slot holds an encoding.
  return bare === 'mkdir' && !ts.isStringLiteralLike(options) ? options : null;
}

function entryKind(entry: string): Kind {
  if (MODE_ENTRIES.has(entry)) return 'changes-mode';
  return WRITING_ENTRIES.has(entry) ? 'writes' : 'other';
}

/** The type a value is declared as where it lands: a parameter, a variable, or `this.x`. */
function declaredTypeOf(value: ts.Expression): ts.TypeNode | undefined {
  const parent = value.parent;
  if ((ts.isParameter(parent) || ts.isVariableDeclaration(parent)) && parent.initializer === value) {
    return parent.type;
  }
  if (
    !ts.isBinaryExpression(parent) ||
    parent.right !== value ||
    parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken
  ) {
    return undefined;
  }
  const target = parent.left;
  if (!ts.isPropertyAccessExpression(target) || target.expression.kind !== ts.SyntaxKind.ThisKeyword) {
    return undefined;
  }
  const owner = ts.findAncestor(parent, ts.isClassLike);
  const property = owner?.members.find(
    (member): member is ts.PropertyDeclaration =>
      ts.isPropertyDeclaration(member) &&
      ts.isIdentifier(member.name) &&
      member.name.text === target.name.text
  );
  return property?.type;
}

/**
 * The members a namespace handed on whole can be reached through, when the hand-off
 * narrows it to an interface declared in this file: `filesystem: ContainmentFs =
 * nodeFs`, or `this.fs = deps.filesystem ?? fs` where `fs` is declared `FsLike`. A
 * port typed so reaches only what it declares, and those names the scan can judge.
 * `null` when the hand-off names no such interface, or one this scan cannot read
 * whole, because it extends another or declares a computed member.
 */
function portMembers(escape: ts.Expression, source: ts.SourceFile): readonly string[] | null {
  const parent = escape.parent;
  const fallback =
    ts.isBinaryExpression(parent) &&
    parent.right === escape &&
    (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      parent.operatorToken.kind === ts.SyntaxKind.BarBarToken);
  const typeNode = declaredTypeOf(fallback ? parent : escape);
  if (typeNode === undefined || !ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) {
    return null;
  }
  const name = typeNode.typeName.text;
  const port = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name
  );
  if (port === undefined || port.heritageClauses !== undefined) return null;
  const members = port.members.flatMap((member) =>
    member.name !== undefined && ts.isIdentifier(member.name) ? [member.name.text] : []
  );
  return members.length === port.members.length ? members : null;
}

function rawShape(site: ts.Expression, entry: string): Shape {
  const call = callOf(site);
  const form = call === null ? 'reference' : 'call';
  const unjudged = { entry, form, declared: null, createsDirs: false } as const;
  if (entryKind(entry) !== 'writes') return { ...unjudged, kind: entryKind(entry) };
  if (call === null) return { ...unjudged, kind: 'writes' };
  const flag = call.arguments.at(1);
  // An `open` with no flag, or a read-only one, creates nothing.
  const reads = entry.startsWith('open') && (flag === undefined || !writesFlag(flag));
  const mode = modeExpression(entry, call.arguments);
  return {
    ...unjudged,
    kind: reads ? 'other' : 'writes',
    declared: mode === null ? null : namesIn(mode)
  };
}

function helperShape(entry: string, call: ts.CallExpression): Shape {
  const argument = call.arguments.at(2);
  if (HELPER_WALKS.has(entry)) {
    return {
      entry,
      kind: 'writes',
      form: 'call',
      declared: argument === undefined ? null : namesIn(argument),
      createsDirs: true
    };
  }
  const readable =
    argument !== undefined &&
    ts.isObjectLiteralExpression(argument) &&
    !argument.properties.some(ts.isSpreadAssignment);
  if (!readable) return { entry, kind: 'writes', form: 'call', declared: null, createsDirs: false };
  const flags = propertyNamed(argument, 'flags');
  const createDirs = propertyNamed(argument, 'createDirs');
  return {
    entry,
    kind: flags !== null && !writesFlag(flags) ? 'other' : 'writes',
    form: 'call',
    declared: argument.properties.flatMap((property) =>
      property.name !== undefined && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        ? [property.name.text]
        : []
    ),
    createsDirs: createDirs !== null && createDirs.kind !== ts.SyntaxKind.FalseKeyword
  };
}

function calleeName(callee: ts.Expression): string | null {
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
}

function isWorkspace(expression: ts.Expression): boolean {
  return ts.isIdentifier(expression)
    ? expression.text === 'workspace'
    : ts.isPropertyAccessExpression(expression) && expression.name.text === 'workspace';
}

function isWorkspaceFs(expression: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === 'fs' &&
    isWorkspace(expression.expression)
  );
}

/** A `require('fs')` or `import('node:fs')`: a binding this scan cannot follow. */
function loadsFsDynamically(call: ts.CallExpression): boolean {
  const loader =
    call.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(call.expression) && call.expression.text === 'require');
  const target = call.arguments.at(0);
  return loader && target !== undefined && ts.isStringLiteralLike(target) && NODE_FS_MODULES.has(target.text);
}

/** Every filesystem reach in one file's text. Pure, so a synthetic source can be judged. */
function scanSource(file: string, text: string): Occurrence[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const bindings = fsBindings(source);
  const found: Occurrence[] = [];
  const seen = new Set<ts.Node>();
  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const record = (site: ts.Node, shape: Shape): void => {
    if (seen.has(site)) return;
    seen.add(site);
    found.push({ file, line: lineOf(site), ...shape });
  };
  const unresolved = (site: ts.Node, entry: string): void => {
    record(site, { entry, kind: 'unresolved', form: 'reference', declared: null, createsDirs: false });
  };

  const reachThrough = (id: ts.Identifier): void => {
    const entry = bindings.entries.get(id.text);
    if (entry !== undefined) {
      record(id, rawShape(id, entry));
      return;
    }
    if (!bindings.namespaces.has(id.text)) return;
    let receiver: ts.Expression = id;
    let member = memberOf(receiver);
    if (member === 'promises') {
      receiver = receiver.parent as ts.PropertyAccessExpression;
      member = memberOf(receiver);
    }
    if (member === null) {
      const port = portMembers(receiver, source);
      if (port === null) {
        unresolved(receiver, `the ${receiver.getText(source)} namespace`);
        return;
      }
      // One reach per member the port declares, each a reference: whoever holds the
      // port calls them later.
      seen.add(receiver);
      for (const portEntry of port) {
        found.push({
          file,
          line: lineOf(receiver),
          entry: portEntry,
          kind: entryKind(portEntry),
          form: 'reference',
          declared: null,
          createsDirs: false
        });
      }
      return;
    }
    const site = receiver.parent as ts.PropertyAccessExpression;
    record(site, rawShape(site, member));
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression);
      if (callee !== null && (HELPER_OPENS.has(callee) || HELPER_WALKS.has(callee))) {
        record(node.expression, helperShape(callee, node));
      }
      if (loadsFsDynamically(node)) unresolved(node, 'a dynamic load');
    }
    if (ts.isPropertyAccessExpression(node)) {
      const member = node.name.text;
      if (MODE_ENTRIES.has(member)) record(node, rawShape(node, member));
      if (isWorkspaceFs(node.expression)) {
        const entry = `workspace.fs.${member}`;
        const call = callOf(node);
        record(node, {
          entry,
          kind: WORKSPACE_FS_WRITING.has(member) ? 'writes' : 'other',
          form: call === null ? 'reference' : 'call',
          declared: null,
          createsDirs: false
        });
      } else if (member === 'fs' && isWorkspace(node.expression) && memberOf(node) === null) {
        unresolved(node, 'the workspace.fs object');
      }
    }
    if (ts.isIdentifier(node) && isValueReference(node)) reachThrough(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/** What one occurrence requires: nothing, a disposition, a failure, or both. */
interface Judgement {
  readonly needsDisposition: boolean;
  readonly failure: string | null;
}

const PASSES: Judgement = { needsDisposition: false, failure: null };

function fails(failure: string): Judgement {
  return { needsDisposition: false, failure };
}

function judgeHelperCall({ file, entry, declared, createsDirs }: Occurrence): Judgement {
  // The helper forwarding its own options, which its signature already types.
  if (file === HELPER_FILE) return PASSES;
  if (HELPER_WALKS.has(entry)) {
    return declared === null ? fails(`${entry} creates directories and declares no dirMode`) : PASSES;
  }
  if (declared === null) {
    return fails(
      `${entry} is passed options this census cannot read; write them inline, so the ` +
        'modes they declare are visible here'
    );
  }
  if (!declared.includes('fileMode')) return fails(`${entry} opens for writing and declares no fileMode`);
  if (createsDirs && !declared.includes('dirMode')) {
    return fails(`${entry} creates directories and declares no dirMode`);
  }
  return PASSES;
}

function judge(occurrence: Occurrence): Judgement {
  const { file, entry, kind, form, declared } = occurrence;
  switch (kind) {
    case 'other':
      return PASSES;
    case 'unresolved':
      return { needsDisposition: true, failure: null };
    case 'changes-mode':
      return { needsDisposition: file !== NARROWING_FILE, failure: null };
    case 'writes':
      break;
  }
  if (HELPER_OPENS.has(entry) || HELPER_WALKS.has(entry)) return judgeHelperCall(occurrence);
  if (file === HELPER_FILE) {
    return form === 'call' && declared?.some((name) => DECLARED_FIELDS.has(name)) === true
      ? PASSES
      : fails(`${entry} in the helper does not forward the fileMode or dirMode its caller declared`);
  }
  // A reason can explain why a site bypasses the helper. It cannot excuse a mode the
  // site could have declared and did not.
  const undeclared = form === 'call' && declared === null && !MODELESS_ENTRIES.has(entry);
  return {
    needsDisposition: true,
    failure: undeclared ? `${entry} creates a path and declares no mode` : null
  };
}

function bypass({ entry, kind }: Occurrence): string {
  switch (kind) {
    case 'changes-mode':
      return (
        `${entry} changes a mode outside ${NARROWING_FILE}: a second narrowing mechanism ` +
        '(FR-007, SC-003). Call narrowMode, or add a disposition with its reason'
      );
    case 'unresolved':
      return (
        `${entry} reaches node:fs through a name this census cannot follow. Import the ` +
        'entries it uses by name'
      );
    default:
      return (
        `${entry} creates a path without ${HELPER_FILE}, so no declared mode is checked and ` +
        'nothing narrows an existing path. Route it through the helper, or add a ' +
        'disposition with its reason'
      );
  }
}

const keyOf = (item: { readonly file: string; readonly entry: string }): string =>
  `${item.file}#${item.entry}`;

/** Every failure the occurrences give under the dispositions, each naming its site. */
function verdict(occurrences: readonly Occurrence[], dispositions: readonly Disposition[]): string[] {
  const failures: string[] = [];
  const awaiting = new Map<string, Occurrence[]>();
  for (const occurrence of occurrences) {
    const { needsDisposition, failure } = judge(occurrence);
    if (failure !== null) failures.push(`${occurrence.file}:${occurrence.line} — ${failure}`);
    if (!needsDisposition) continue;
    awaiting.set(keyOf(occurrence), [...(awaiting.get(keyOf(occurrence)) ?? []), occurrence]);
  }
  for (const disposition of dispositions) {
    const covered = awaiting.get(keyOf(disposition)) ?? [];
    awaiting.delete(keyOf(disposition));
    if (covered.length === disposition.sites) continue;
    const lines = covered.map((occurrence) => occurrence.line).join(', ');
    failures.push(
      covered.length === 0
        ? `${disposition.file} — the disposition for ${disposition.entry} covers no site; strike it`
        : `${disposition.file} — ${disposition.entry} has ${covered.length} site(s), at line(s) ` +
            `${lines}, and its disposition reasons about ${disposition.sites}; a new site needs its own reason`
    );
  }
  for (const pending of awaiting.values()) {
    for (const occurrence of pending) {
      failures.push(`${occurrence.file}:${occurrence.line} — ${bypass(occurrence)}`);
    }
  }
  return failures.sort();
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

const SOURCES = filesUnder(resolve(REPO_ROOT, 'src'), { extensions: ['.ts'] });

const REAL = SOURCES.flatMap((absolute) =>
  scanSource(relative(REPO_ROOT, absolute).replace(/\\/g, '/'), readFileSync(absolute, 'utf8'))
);

const isHelperEntry = ({ entry }: Occurrence): boolean => HELPER_OPENS.has(entry) || HELPER_WALKS.has(entry);

/**
 * Where the synthetic sources claim to sit. Composed at runtime, never written as one
 * `src/…` literal: `lint-anchor-grounding.test.ts` requires every such literal in a
 * lint to exist, and these deliberately do not. Their absence is asserted instead,
 * because a real file at one of them would join the real scan under the same name.
 */
const SYNTHETIC_DIR = ['src', 'synthetic'].join('/');
const syntheticPath = (name: string): string => `${SYNTHETIC_DIR}/${name}.ts`;

/** One synthetic source's occurrences, as though it sat in `src/` under that name. */
function synthetic(file: string, lines: readonly string[]): Occurrence[] {
  return scanSource(file, lines.join('\n'));
}

/** The real scan with one synthetic file added, judged by the same verdict as the gate. */
function judgedWith(file: string, lines: readonly string[]): string[] {
  return verdict([...REAL, ...synthetic(file, lines)], DISPOSITIONS);
}

describe('Feature 217 evidence-sink mode census', () => {
  it('scanned a tree worth scanning', () => {
    // Vacuity control. "No site fails" is exactly what a scan that reached nothing
    // reports, so a moved root, a binding resolution that stopped resolving, or a
    // helper call the matcher no longer recognises would each give the cleanest
    // possible result. Each floor sits well under its measurement: a floor tight
    // against it fails on ordinary churn, and a gate that fails for uninteresting
    // reasons is a gate someone loosens. They exist to catch a scan that broke.
    const helperWrites = REAL.filter(
      (occurrence) => isHelperEntry(occurrence) && occurrence.file !== HELPER_FILE && occurrence.kind === 'writes'
    );
    const forwarded = REAL.filter(
      (occurrence) => occurrence.file === HELPER_FILE && !isHelperEntry(occurrence) && occurrence.kind === 'writes'
    ).map((occurrence) => occurrence.entry);
    expect(
      SOURCES.length,
      'the scan found almost no source under src/ — the root or the extension is wrong'
      // 532 files measured 2026-10-01.
    ).toBeGreaterThan(400);
    expect(
      REAL.length,
      'the scan found almost no filesystem reach — the binding resolution has stopped resolving'
      // 155 reaches measured 2026-10-01: 41 writing, 2 changing a mode, 112 neither.
    ).toBeGreaterThan(120);
    expect(
      helperWrites.length,
      'the scan found almost no writing helper call — it no longer recognises one, so it judges none'
      // 24 measured 2026-10-01: 17 writing opens and 7 directory walks, outside the helper.
    ).toBeGreaterThan(18);
    // Not floors but presences: the two raw calls through which the helper forwards
    // its callers' modes, and the one chmod narrowing is allowed. A scan blind to
    // these is blind to the same call anywhere else.
    expect(forwarded, 'the scan no longer sees the raw open and mkdir inside the helper').toEqual(
      expect.arrayContaining(['open', 'mkdir'])
    );
    expect(
      REAL.some((occurrence) => occurrence.file === NARROWING_FILE && occurrence.kind === 'changes-mode'),
      `the scan no longer sees the chmod in ${NARROWING_FILE}, so it would see none outside it`
    ).toBe(true);
    console.log(
      `[FR-008] evidence-sink census: ${SOURCES.length} file(s), ${REAL.length} reach(es), ` +
        `${helperWrites.length} writing helper call(s), ${DISPOSITIONS.length} disposition(s)`
    );
  });

  it('fails no site in src/', () => {
    expect(verdict(REAL, DISPOSITIONS)).toEqual([]);
  });

  it('gives every disposition its own key and a stated reason', () => {
    const keys = DISPOSITIONS.map(keyOf);
    expect(new Set(keys).size, 'two dispositions share a file and entry').toBe(keys.length);
    for (const disposition of DISPOSITIONS) {
      expect(disposition.reason.length, `${keyOf(disposition)} states no reason`).toBeGreaterThan(80);
      expect(disposition.sites, `${keyOf(disposition)} covers no site`).toBeGreaterThan(0);
    }
  });
});

// T1804a. Each case judges the real scan with one synthetic file added, through the
// one `verdict` the gate calls. The real scan alone gives no failures, so every
// failure below is the synthetic file's, and each must name its file and line.
describe('the census fires on a site that does not conform (T1804a)', () => {
  it('judges synthetic sources at a path with nothing on disk', () => {
    expect(
      existsSync(resolve(REPO_ROOT, SYNTHETIC_DIR)),
      `${SYNTHETIC_DIR} exists, so the real scan reads files under the names the cases below invent`
    ).toBe(false);
  });

  it('fails a creating helper open that declares no fileMode, naming its file and line', () => {
    expect(
      judgedWith(syntheticPath('no-file-mode'), [
        "import { openWithinRoot } from '../lib/safe-open';",
        '',
        'export function openLog(root: string) {',
        "  return openWithinRoot(root, ['x.log'], { flags: 'a', createDirs: false });",
        '}'
      ])
    ).toEqual(['src/synthetic/no-file-mode.ts:4 — openWithinRoot opens for writing and declares no fileMode']);
  });

  it('fails a helper open that creates directories and declares no dirMode', () => {
    expect(
      judgedWith(syntheticPath('no-dir-mode'), [
        "import { openWithinRoot } from '../lib/safe-open';",
        '',
        'export function openLog(root: string) {',
        "  return openWithinRoot(root, ['logs', 'x.log'], { flags: 'a', createDirs: true, fileMode: 0o600 });",
        '}'
      ])
    ).toEqual(['src/synthetic/no-dir-mode.ts:4 — openWithinRoot creates directories and declares no dirMode']);
  });

  it('fails a helper open whose options are built where the census cannot read them', () => {
    expect(
      judgedWith(syntheticPath('opaque-options'), [
        "import { openWithinRoot, type SafeOpenOptions } from '../lib/safe-open';",
        '',
        'export function openLog(root: string, options: SafeOpenOptions) {',
        "  return openWithinRoot(root, ['x.log'], options);",
        '}'
      ])
    ).toEqual([
      expect.stringContaining('src/synthetic/opaque-options.ts:4 — openWithinRoot is passed options this census cannot read')
    ]);
  });

  it('fails a raw open that bypasses the helper and declares no mode, on both counts', () => {
    expect(
      judgedWith(syntheticPath('raw-open'), [
        "import * as fsp from 'node:fs/promises';",
        '',
        'export async function openLog(target: string) {',
        "  return fsp.open(target, 'a');",
        '}'
      ])
    ).toEqual([
      'src/synthetic/raw-open.ts:4 — open creates a path and declares no mode',
      expect.stringContaining(`src/synthetic/raw-open.ts:4 — open creates a path without ${HELPER_FILE}`)
    ]);
  });

  it('fails a raw open that declares its mode but gives no reason to bypass the helper', () => {
    expect(
      judgedWith(syntheticPath('reasonless'), [
        "import * as fsp from 'node:fs/promises';",
        '',
        'export async function openLog(target: string) {',
        "  return fsp.open(target, 'a', 0o600);",
        '}'
      ])
    ).toEqual([expect.stringContaining(`src/synthetic/reasonless.ts:4 — open creates a path without ${HELPER_FILE}`)]);
  });

  it('fails a second narrowing mechanism outside narrow-mode.ts', () => {
    expect(
      judgedWith(syntheticPath('second-narrower'), [
        "import { chmod } from 'node:fs/promises';",
        '',
        'export async function pin(target: string) {',
        '  await chmod(target, 0o600);',
        '}'
      ])
    ).toEqual([
      expect.stringContaining(`src/synthetic/second-narrower.ts:4 — chmod changes a mode outside ${NARROWING_FILE}`)
    ]);
  });

  it('fails a namespace handed on where the census cannot follow it', () => {
    expect(
      judgedWith(syntheticPath('escape'), ["import * as fsp from 'node:fs/promises';", '', 'export const port = fsp;'])
    ).toEqual([
      expect.stringContaining('src/synthetic/escape.ts:3 — the fsp namespace reaches node:fs through a name this census cannot follow')
    ]);
  });

  it('fails a port that hands a creating member on, though it is never called here', () => {
    expect(
      judgedWith(syntheticPath('port'), [
        "import * as fsp from 'node:fs/promises';",
        '',
        'interface Port {',
        '  mkdir(target: string, options: { recursive: true }): Promise<unknown>;',
        '}',
        '',
        'export const port: Port = fsp;'
      ])
    ).toEqual([expect.stringContaining(`src/synthetic/port.ts:7 — mkdir creates a path without ${HELPER_FILE}`)]);
  });

  it('fails a new site in a reasoned-about file, naming every line its reason now spans', () => {
    expect(
      judgedWith('src/services/evidence-export.ts', [
        "import * as fsp from 'node:fs/promises';",
        '',
        'export async function another(target: string) {',
        '  await fsp.mkdir(target, { recursive: true, mode: 0o700 });',
        '}'
      ])
    ).toEqual([
      expect.stringMatching(
        /^src\/services\/evidence-export\.ts — mkdir has 2 site\(s\), at line\(s\) \d+, 4, and its disposition reasons about 1;/
      )
    ]);
  });

  it('fails a disposition whose site has gone', () => {
    const stale: Disposition = {
      file: syntheticPath('gone'),
      entry: 'mkdir',
      sites: 1,
      reason: 'A reason for a site that no longer exists, which the ledger must not keep carrying.'
    };
    expect(verdict(REAL, [...DISPOSITIONS, stale])).toEqual([
      'src/synthetic/gone.ts — the disposition for mkdir covers no site; strike it'
    ]);
  });
});

type Reach = Pick<Occurrence, 'line' | 'entry' | 'kind' | 'form' | 'declared'>;

/** What the scan finds in one synthetic source, without the file every row shares. */
function reachesIn(lines: readonly string[]): Reach[] {
  return synthetic(syntheticPath('reach'), lines).map(({ line, entry, kind, form, declared }) => ({
    line,
    entry,
    kind,
    form,
    declared
  }));
}

describe('the scan resolves each way a file reaches the filesystem', () => {
  it('follows a named import under its local name, and reports the entry it binds', () => {
    expect(
      reachesIn(["import { createWriteStream as spool } from 'node:fs';", "spool('/tmp/x');"])
    ).toEqual([{ line: 2, entry: 'createWriteStream', kind: 'writes', form: 'call', declared: null }]);
  });

  it('follows `fs.promises` from a whole-module namespace, and `{ promises as X }`', () => {
    expect(
      reachesIn([
        "import * as fs from 'node:fs';",
        "import { promises as fsp } from 'fs';",
        "export const opened = fs.promises.open('/tmp/x', 'w', 0o600);",
        "export const written = fsp.writeFile('/tmp/x', 'data', { mode: 0o600 });"
      ])
    ).toEqual([
      { line: 3, entry: 'open', kind: 'writes', form: 'call', declared: [] },
      { line: 4, entry: 'writeFile', kind: 'writes', form: 'call', declared: [] }
    ]);
  });

  it('follows a default import and an import-equals', () => {
    expect(
      reachesIn([
        "import fs from 'node:fs';",
        "import legacy = require('fs');",
        "fs.mkdirSync('/tmp/x', { recursive: true });",
        "legacy.appendFileSync('/tmp/x', 'line');"
      ])
    ).toEqual([
      { line: 3, entry: 'mkdirSync', kind: 'writes', form: 'call', declared: null },
      { line: 4, entry: 'appendFileSync', kind: 'writes', form: 'call', declared: null }
    ]);
  });

  it('counts a port default as a reach, though nothing calls it here', () => {
    expect(
      reachesIn([
        "import * as fs from 'node:fs/promises';",
        'export class Sink {',
        '  private readonly mkdir: typeof fs.mkdir;',
        '  constructor(deps: { mkdir?: typeof fs.mkdir }) {',
        '    this.mkdir = deps.mkdir ?? fs.mkdir;',
        '  }',
        '}'
      ])
    ).toEqual([{ line: 5, entry: 'mkdir', kind: 'writes', form: 'reference', declared: null }]);
  });

  it('reads an open as reading only when its flag says so', () => {
    expect(
      reachesIn([
        "import * as fsp from 'node:fs/promises';",
        'export async function both(target: string, flag: string) {',
        "  await fsp.open(target, 'r');",
        '  await fsp.open(target);',
        '  await fsp.open(target, flag);',
        '}'
      ])
    ).toEqual([
      { line: 3, entry: 'open', kind: 'other', form: 'call', declared: null },
      { line: 4, entry: 'open', kind: 'other', form: 'call', declared: null },
      { line: 5, entry: 'open', kind: 'writes', form: 'call', declared: null }
    ]);
  });

  it('sees a chmod on any receiver', () => {
    expect(
      reachesIn([
        'export async function pin(handle: { chmod(mode: number): Promise<void> }) {',
        '  await handle.chmod(0o600);',
        '}'
      ])
    ).toEqual([{ line: 2, entry: 'chmod', kind: 'changes-mode', form: 'call', declared: null }]);
  });

  it("reads VS Code's file API, and fails closed on the API handed on whole", () => {
    expect(
      reachesIn([
        "import * as vscode from 'vscode';",
        'export async function save(target: vscode.Uri, data: Uint8Array) {',
        '  await vscode.workspace.fs.writeFile(target, data);',
        '  await vscode.workspace.fs.readFile(target);',
        '  return vscode.workspace.fs;',
        '}'
      ])
    ).toEqual([
      { line: 3, entry: 'workspace.fs.writeFile', kind: 'writes', form: 'call', declared: null },
      { line: 4, entry: 'workspace.fs.readFile', kind: 'other', form: 'call', declared: null },
      { line: 5, entry: 'the workspace.fs object', kind: 'unresolved', form: 'reference', declared: null }
    ]);
  });

  it('fails closed on a require and a dynamic import of node:fs', () => {
    expect(
      reachesIn(["const fs = require('node:fs');", "export const later = import('node:fs/promises');"])
    ).toEqual([
      { line: 1, entry: 'a dynamic load', kind: 'unresolved', form: 'reference', declared: null },
      { line: 2, entry: 'a dynamic load', kind: 'unresolved', form: 'reference', declared: null }
    ]);
  });

  it('follows a namespace into a port interface declared beside it, and no further', () => {
    expect(
      reachesIn([
        "import * as nodeFs from 'node:fs/promises';",
        'interface ReadPort {',
        '  realpath(target: string): Promise<string>;',
        '}',
        'interface WidePort extends ReadPort {',
        '  readdir(target: string): Promise<string[]>;',
        '}',
        'export function resolveWith(filesystem: ReadPort = nodeFs): ReadPort {',
        '  return filesystem;',
        '}',
        'export const wide: WidePort = nodeFs;'
      ])
    ).toEqual([
      { line: 8, entry: 'realpath', kind: 'other', form: 'reference', declared: null },
      { line: 11, entry: 'the nodeFs namespace', kind: 'unresolved', form: 'reference', declared: null }
    ]);
  });

  it('reaches nothing through a type, a property name or a declaration', () => {
    // The last line is the control: without it, an empty result is also what a scan
    // that resolves nothing returns.
    expect(
      reachesIn([
        "import type { Stats } from 'node:fs';",
        "import { type Dirent, open } from 'node:fs/promises';",
        "export function sizeOf(entry: Dirent, stats: Stats, other: import('node:fs').Dirent): number {",
        '  return stats.size;',
        '}',
        'const options = { open: 1 };',
        'export const flag = options.open;',
        "export const opened = open('/tmp/x', 'wx', 0o600);"
      ])
    ).toEqual([{ line: 8, entry: 'open', kind: 'writes', form: 'call', declared: [] }]);
  });
});
