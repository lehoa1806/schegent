// Feature 217 (FR-008, SC-002, SC-003) — every path the product creates for
// itself declares its mode, and exactly one routine narrows a path that exists.
//
// FR-008 has two halves. The first is the type split in `src/lib/safe-open.ts`: a
// writing open that omits `fileMode`, or a directory-creating one that omits
// `dirMode`, no longer compiles. That is the half the checker can provide, and it
// covers only code that calls the helper, and there only options whose keys the
// checker knows: a cast past the type compiles (`{ flags: 'a' } as SafeOpenOptions`),
// and so does a computed key whose type is wider than one literal
// (`{ flags: 'r', [key]: 'w' }`), and so does a setter with no getter
// (`set fileMode(_: number) {}`), which the checker types as what it takes and which
// reads as `undefined`, each able to leave a mode out. The helper refuses such a mode
// when it runs, before it creates anything, which turns the leak into an error in the
// field; this gate fails it before it ships. A sink that never calls the helper is
// invisible to the type system — `fsp.open(p, 'a')` typechecks with no mode at all —
// and that is how the CLI transport log and the runtime log came to be written 0o644
// under a 022 umask, readable by every local account
// (specs/217-evidence-posture-and-bounds/measurements.md). This gate is the second
// half: within the reach set out below, it finds each place `src/` creates a path
// through `node:fs` or VS Code's `workspace.fs` without the helper, and fails unless
// that place is the helper itself or carries a stated reason. It reads each open
// through the helper too, and fails one unless its options are a bare literal it can
// read whole, declaring each mode the open needs: a `fileMode` unless its flags only
// read, and a `dirMode` whenever its `createDirs` may be true, whatever its flags.
// Options built elsewhere fail, as do a literal under a cast and one with a spread, a
// key it cannot spell, a key spelled twice, a `__proto__` key, and a key given a
// setter or a method where a value belongs. It reads the helper's name wherever the
// source spells it, and fails each use but a call that spells it (bare or after a
// dot), an import or export under that name, and a type (`typeof openWithinRoot`).
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
// Any other name the scan reads but cannot follow fails rather than passing unread:
// an untyped hand-off, a port declared in another module or extending one, a
// namespace indexed in brackets, an import alias (`import later = fs.promises`), a
// `require` or a dynamic `import()` of `node:fs`, of `vscode` or of a module named
// at run time, `require` used any way but a direct call or `require.resolve`, and
// an `export … from` or an `export import … = require(…)` that hands the module to a
// file whose own imports never name it.
//
// Two further reaches are not `node:fs` at all. VS Code's `workspace.fs` creates
// files and takes no mode, and its members are read after the dotted chain that
// names it: `workspace.fs` on the workspace an import from `vscode` binds, under any
// name the import gives it (`ws.fs`) or through the module (`vscode.workspace.fs`),
// and on any other value spelled `workspace`, a local, a parameter or a property
// (`deps.workspace.fs`). The bound workspace, any workspace's `fs`, and the module
// that carries them fail as a namespace does when read any way but a dotted member:
// handed on whole, destructured, indexed in brackets, or wrapped (in parentheses,
// `as`, `satisfies`, `!` or `<T>`). A `chmod`, `lchmod` or `fchmod`, whether
// synchronous or not, on any receiver is a second narrowing mechanism, which FR-007
// and SC-003 forbid outside `src/lib/narrow-mode.ts` (contracts/narrow-mode.md,
// invariant 4). Each is read in every member syntax the source spells: after a dot,
// in brackets, and as a key a declaration or assignment destructures. A name in
// brackets or a computed key is read when it is a literal string, quoted or a
// template with no substitution, bare or wrapped.
//
// The scan reads syntax, not types, so a hand-off it follows is bounded by what the
// interface declares, and what lies past the forms above is outside it. The reviewer
// is the control for each: a cast past a port's interface; a `chmod` or a helper
// whose name the source does not spell, as a key any other expression computes or
// reflection over its receiver (`Reflect.get`, `Object.entries`); a `workspace` the
// import does not bind, reached other than by that chain (under another name,
// wrapped, in brackets or destructured), since only the spelled chain marks it as
// VS Code's; a module loaded any other way (`module.require`, a function
// `createRequire` returns, `process.getBuiltinModule`, code evaluated from a
// string); a file VS Code writes other than through `workspace.fs` (a
// `WorkspaceEdit` applied by `workspace.applyEdit`, `workspace.save` or `saveAs`, a
// document's own `save()`); and a path or mode that a process the host spawns
// creates or changes.
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

/** VS Code's API, whose `workspace.fs` creates files and takes no mode. */
const VSCODE_MODULES = new Set(['vscode']);

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

const isHelperName = (name: string): boolean => HELPER_OPENS.has(name) || HELPER_WALKS.has(name);

/** The fields a mode is declared through, by name (rule 67). */
const DECLARED_FIELDS = new Set(['fileMode', 'dirMode']);

/** A mode a helper call must declare. */
type Need = 'fileMode' | 'dirMode';

/**
 * - `writes`: creates a path, or opens one for writing.
 * - `changes-mode`: a `chmod`.
 * - `unresolved`: reaches `node:fs` or VS Code's `workspace`, or may, through a name the
 *   scan cannot follow.
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
  /**
   * The modes a helper call must declare. A walk needs `dirMode`. An open needs
   * `fileMode` unless its flags only read, and `dirMode` when it spells a `createDirs`
   * other than the bare `false`, whatever its flags, since the walk creates
   * directories for a read too. Options the scan cannot read need both. Empty for
   * every other reach.
   */
  readonly needs: readonly Need[];
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

interface ModuleBindings {
  /** Local names bound to a whole module, or to `node:fs`'s `promises` object. */
  readonly namespaces: ReadonlySet<string>;
  /** Local names bound to one entry, mapped to the entry's own name. */
  readonly entries: ReadonlyMap<string, string>;
}

/** Which names in this file reach one of `modules`, read from its imports. Types reach nothing. */
function importBindings(source: ts.SourceFile, modules: ReadonlySet<string>): ModuleBindings {
  const namespaces = new Set<string>();
  const entries = new Map<string, string>();
  for (const statement of source.statements) {
    if (ts.isImportEqualsDeclaration(statement)) {
      const reference = statement.moduleReference;
      if (
        !statement.isTypeOnly &&
        ts.isExternalModuleReference(reference) &&
        ts.isStringLiteral(reference.expression) &&
        modules.has(reference.expression.text)
      ) {
        namespaces.add(statement.name.text);
      }
      continue;
    }
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier) || !modules.has(specifier.text)) continue;
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

/** Whether this qualified name is, or begins, the module reference of an import alias. */
function aliasesAnImport(name: ts.QualifiedName): boolean {
  let outer: ts.Node = name;
  while (ts.isQualifiedName(outer.parent)) outer = outer.parent;
  const holder = outer.parent;
  return ts.isImportEqualsDeclaration(holder) && holder.moduleReference === outer;
}

/**
 * Whether this identifier evaluates its binding. A declaration, a property name, or
 * a type position names something without reaching it. An import alias evaluates the
 * name it begins with (`import later = fs.promises`), so that name is a reference.
 */
function isValueReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isImportEqualsDeclaration(parent)) return parent.moduleReference === id;
  if (ts.isQualifiedName(parent)) return parent.left === id && aliasesAnImport(parent);
  if (
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportSpecifier(parent) ||
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

/**
 * What an options literal gives a property under any key the source spells (`flags`,
 * `'flags'`, `['flags']`): its value, or for an accessor or a method the declaration
 * itself, whose value this scan does not read. Of a key spelled twice it gives the
 * first, and no verdict turns on that: a helper's options that spell one are
 * unreadable, and a raw call's `mode` counts only by being there.
 */
function propertyNamed(object: ts.ObjectLiteralExpression, name: string): ts.Node | null {
  const property = object.properties.find(
    (candidate) => candidate.name !== undefined && spelledKey(candidate.name) === name
  );
  if (property === undefined) return null;
  if (ts.isPropertyAssignment(property)) return property.initializer;
  return ts.isShorthandPropertyAssignment(property) ? property.name : property;
}

/** The key that, bare or quoted, sets an object literal's prototype. */
const PROTOTYPE_SETTER_KEY = '__proto__';

/**
 * Whether this scan can tell what each property of an options literal sets: every key
 * spelled, none twice, none `__proto__`, and each given a value or a getter. A spread,
 * a key it cannot spell (`[key]`) or a second spelling can each set an option out of
 * its sight. JavaScript keeps the last of two spellings, and the second compiles
 * behind a cast that widens it (`['fileMode' as string]: undefined`), past the checker
 * and past a scan that reads a mode's name and never its value. A `__proto__` key,
 * bare or quoted, sets the literal's prototype, and the helper reads each option the
 * literal leaves out through it. The checker rejects the key, and a `@ts-expect-error`
 * compiles past that. A computed one sets no prototype and fails all the same. A
 * setter with no getter spells its key and gives it no value: the checker types it as
 * what the setter takes, so `set fileMode(_: number) {}` satisfies a required mode,
 * and the helper reads `undefined`. A method's value is a function, never a mode. A
 * getter's value is what it returns, which this scan does not read, as it reads no
 * other value.
 */
function readableOptions(object: ts.ObjectLiteralExpression): boolean {
  const keys = object.properties.map((property) =>
    property.name === undefined ? null : spelledKey(property.name)
  );
  return (
    !object.properties.some(
      (property) => ts.isSetAccessorDeclaration(property) || ts.isMethodDeclaration(property)
    ) &&
    keys.every((key) => key !== null && key !== PROTOTYPE_SETTER_KEY) &&
    new Set(keys).size === keys.length
  );
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
function writesFlag(flag: ts.Node): boolean {
  return !ts.isStringLiteralLike(flag) || /[wa+]/.test(flag.text);
}

/**
 * Where a raw `node:fs` call declares its mode: `open`'s third argument, a `mode`
 * property of the options, or `mkdir`'s positional mode. `null` when there is none
 * the scan can read; an options object built elsewhere declares nothing visible.
 */
function modeExpression(entry: string, args: ts.NodeArray<ts.Expression>): ts.Node | null {
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
  const unjudged = { entry, form, declared: null, needs: [] } as const;
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
      needs: ['dirMode']
    };
  }
  const readable =
    argument !== undefined && ts.isObjectLiteralExpression(argument) && readableOptions(argument);
  if (!readable) return { entry, kind: 'writes', form: 'call', declared: null, needs: ['fileMode', 'dirMode'] };
  const flags = propertyNamed(argument, 'flags');
  const createDirs = propertyNamed(argument, 'createDirs');
  const needs: Need[] = [];
  if (flags === null || writesFlag(flags)) needs.push('fileMode');
  if (createDirs !== null && createDirs.kind !== ts.SyntaxKind.FalseKeyword) needs.push('dirMode');
  return {
    entry,
    // A read that creates no directory creates nothing.
    kind: needs.length === 0 ? 'other' : 'writes',
    form: 'call',
    declared: argument.properties.flatMap((property) => {
      const key = property.name === undefined ? null : spelledKey(property.name);
      return key === null ? [] : [key];
    }),
    needs
  };
}

function calleeName(callee: ts.Expression): string | null {
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
}

/**
 * Whether this expression is VS Code's `workspace`. Spelled, so a port typed as the
 * workspace (`deps.workspace.fs`) is read too, and resolved, so is the name an import
 * from `vscode` gives it (`{ workspace as ws }`).
 */
function isWorkspace(expression: ts.Expression, imported: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(expression)) return expression.text === 'workspace' || imported.has(expression.text);
  return ts.isPropertyAccessExpression(expression) && expression.name.text === 'workspace';
}

function isWorkspaceFs(expression: ts.Expression, imported: ReadonlySet<string>): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === 'fs' &&
    isWorkspace(expression.expression, imported)
  );
}

/**
 * The text of a string literal, bare or under what leaves its value as it is:
 * parentheses, `as`, `satisfies`, `!` and `<T>`. Null for a key any other expression
 * computes.
 */
function literalKey(key: ts.Expression): string | null {
  let inner = key;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isSatisfiesExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isTypeAssertionExpression(inner)
  ) {
    inner = inner.expression;
  }
  return ts.isStringLiteralLike(inner) ? inner.text : null;
}

/** The key a property name spells: `chmod`, `'chmod'`, `['chmod']`, `[('chmod')]`. */
function spelledKey(name: ts.PropertyName | ts.BindingName): string | null {
  if (ts.isComputedPropertyName(name)) return literalKey(name.expression);
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
}

/**
 * Whether this literal is a destructuring target: what `=`, `for … of` or `for … in`
 * assigns to, reached through any nesting of array and object patterns.
 */
function isAssigned(literal: ts.Node): boolean {
  let node = literal;
  for (;;) {
    const parent = node.parent;
    if (ts.isArrayLiteralExpression(parent)) {
      node = parent;
    } else if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
      node = parent.parent;
    } else if (ts.isBinaryExpression(parent)) {
      return parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    } else {
      return (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === node;
    }
  }
}

/**
 * The member a destructuring takes, declared or assigned, when the source spells its
 * key: `{ chmod }`, `{ 'chmod': c }`, `{ ['chmod']: c }`. A rest element takes the
 * whole receiver.
 */
function destructuredKey(node: ts.Node): string | null {
  if (ts.isBindingElement(node)) {
    if (!ts.isObjectBindingPattern(node.parent) || node.dotDotDotToken !== undefined) return null;
    return spelledKey(node.propertyName ?? node.name);
  }
  if (ts.isShorthandPropertyAssignment(node) || ts.isPropertyAssignment(node)) {
    return isAssigned(node.parent) ? spelledKey(node.name) : null;
  }
  return null;
}

/**
 * The helper this node reaches other than as the callee of a call that spells its
 * name, bare or after a dot, or as an import or export specifier under that name: the
 * helper held, wrapped, applied (`openWithinRoot.call`), named in brackets, taken by a
 * destructuring, or imported, re-exported or aliased under another name. A call
 * through any of these is passed what this scan never reads.
 */
function helperReference(node: ts.Node): string | null {
  if (ts.isIdentifier(node)) {
    if (!isHelperName(node.text)) return null;
    const parent = node.parent;
    // A step of an import alias's reference, `import open = safe.openWithinRoot`.
    if (ts.isQualifiedName(parent)) return aliasesAnImport(parent) ? node.text : null;
    // A specifier is read whole, below.
    if (ts.isExportSpecifier(parent)) return null;
    return isValueReference(node) && callOf(node) === null ? node.text : null;
  }
  if (ts.isPropertyAccessExpression(node)) {
    return isHelperName(node.name.text) && callOf(node) === null ? node.name.text : null;
  }
  if (ts.isElementAccessExpression(node)) {
    const named = literalKey(node.argumentExpression);
    return named !== null && isHelperName(named) ? named : null;
  }
  if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
    const imported = (node.propertyName ?? node.name).text;
    return isHelperName(imported) && node.name.text !== imported ? imported : null;
  }
  if (ts.isBindingElement(node) || ts.isPropertyAssignment(node)) {
    const key = destructuredKey(node);
    return key !== null && isHelperName(key) ? key : null;
  }
  return null;
}

/**
 * An `export … from` a module this scan follows, or an `export import x = require(…)`
 * of one. Either hands the module's entries to whoever imports this file, and that
 * file's own imports never name the module.
 */
function reExportsFollowedModule(statement: ts.ExportDeclaration | ts.ImportEqualsDeclaration): boolean {
  if (ts.isImportEqualsDeclaration(statement)) {
    const reference = statement.moduleReference;
    return (
      !statement.isTypeOnly &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true &&
      ts.isExternalModuleReference(reference) &&
      ts.isStringLiteral(reference.expression) &&
      (NODE_FS_MODULES.has(reference.expression.text) || VSCODE_MODULES.has(reference.expression.text))
    );
  }
  const specifier = statement.moduleSpecifier;
  if (statement.isTypeOnly || specifier === undefined || !ts.isStringLiteral(specifier)) return false;
  if (!NODE_FS_MODULES.has(specifier.text) && !VSCODE_MODULES.has(specifier.text)) return false;
  const clause = statement.exportClause;
  return clause === undefined || !ts.isNamedExports(clause) || clause.elements.some((element) => !element.isTypeOnly);
}

/**
 * A `require('fs')`, an `import('node:fs')`, either of `vscode`, or either of a module
 * named at run time: a binding this scan cannot follow, since only a static import says
 * which local names carry the module.
 */
function loadsFollowedModuleDynamically(call: ts.CallExpression): boolean {
  const loader =
    call.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(call.expression) && call.expression.text === 'require');
  const target = call.arguments.at(0);
  if (!loader || target === undefined) return false;
  if (!ts.isStringLiteralLike(target)) return true;
  return NODE_FS_MODULES.has(target.text) || VSCODE_MODULES.has(target.text);
}

/** Every filesystem reach in one file's text. Pure, so a synthetic source can be judged. */
function scanSource(file: string, text: string): Occurrence[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const bindings = importBindings(source, NODE_FS_MODULES);
  const editor = importBindings(source, VSCODE_MODULES);
  const workspaceNames = new Set(
    [...editor.entries].flatMap(([local, imported]) => (imported === 'workspace' ? [local] : []))
  );
  // VS Code's `workspace` by binding alone, so a local that only shares its name is not it.
  const isBoundWorkspace = (expression: ts.Expression): boolean =>
    ts.isIdentifier(expression)
      ? workspaceNames.has(expression.text)
      : ts.isPropertyAccessExpression(expression) &&
        expression.name.text === 'workspace' &&
        ts.isIdentifier(expression.expression) &&
        editor.namespaces.has(expression.expression.text);
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
    record(site, { entry, kind: 'unresolved', form: 'reference', declared: null, needs: [] });
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
          needs: []
        });
      }
      return;
    }
    const site = receiver.parent as ts.PropertyAccessExpression;
    record(site, rawShape(site, member));
  };

  const visit = (node: ts.Node): void => {
    if ((ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) && reExportsFollowedModule(node)) {
      unresolved(node, 'a re-export');
    }
    // A member named in brackets is the member it names: `handle['chmod']`.
    if (ts.isElementAccessExpression(node)) {
      const named = literalKey(node.argumentExpression);
      if (named !== null && MODE_ENTRIES.has(named)) record(node, rawShape(node, named));
    }
    // So is the key a destructuring takes, `const { chmod } = handle`, called later.
    const key = destructuredKey(node);
    if (key !== null && MODE_ENTRIES.has(key)) {
      record(node, { entry: key, kind: 'changes-mode', form: 'reference', declared: null, needs: [] });
    }
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression);
      if (callee !== null && (HELPER_OPENS.has(callee) || HELPER_WALKS.has(callee))) {
        record(node.expression, helperShape(callee, node));
      }
      if (loadsFollowedModuleDynamically(node)) unresolved(node, 'a dynamic load');
    }
    // A helper reached any other way hands on a call whose options this scan never reads.
    const helper = helperReference(node);
    if (helper !== null) {
      record(node, { entry: helper, kind: 'writes', form: 'reference', declared: null, needs: [] });
    }
    if (ts.isPropertyAccessExpression(node)) {
      const member = node.name.text;
      if (MODE_ENTRIES.has(member)) record(node, rawShape(node, member));
      if (isWorkspaceFs(node.expression, workspaceNames)) {
        const entry = `workspace.fs.${member}`;
        const call = callOf(node);
        record(node, {
          entry,
          kind: WORKSPACE_FS_WRITING.has(member) ? 'writes' : 'other',
          form: call === null ? 'reference' : 'call',
          declared: null,
          needs: []
        });
      } else if (member === 'fs' && isWorkspace(node.expression, workspaceNames) && memberOf(node) === null) {
        unresolved(node, 'the workspace.fs object');
      } else if (isBoundWorkspace(node) && memberOf(node) === null) {
        unresolved(node, 'the workspace object');
      }
    }
    if (ts.isIdentifier(node) && isValueReference(node)) {
      // `require` asserted, cast, aliased or applied loads a module through a call this
      // scan does not read. A direct call is read above; `require.resolve` loads nothing.
      if (node.text === 'require' && callOf(node) === null && memberOf(node) !== 'resolve') {
        unresolved(node, 'the require function');
      }
      if (isBoundWorkspace(node) && memberOf(node) === null) unresolved(node, 'the workspace object');
      // The module carries `workspace` with it, so it fails as a `node:fs` namespace does.
      if (editor.namespaces.has(node.text) && memberOf(node) === null) {
        unresolved(node, `the ${node.text} namespace`);
      }
      reachThrough(node);
    }
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

function judgeHelperCall({ file, entry, form, declared, needs }: Occurrence): Judgement {
  // The helper forwarding its own options, which its signature already types.
  if (file === HELPER_FILE) return PASSES;
  if (form === 'reference') {
    return fails(
      `${entry} is reached other than as the callee of a call that spells its name, so what ` +
        'it is passed is never read here; import it under its own name and call it by that ' +
        'name, bare or after a dot'
    );
  }
  if (HELPER_WALKS.has(entry)) {
    return declared === null ? fails(`${entry} creates directories and declares no dirMode`) : PASSES;
  }
  if (declared === null) {
    return fails(
      `${entry} is passed options this census cannot read; write them inline, every key ` +
        'spelled out once as a property or a getter, none spread in and none `__proto__`, ' +
        'so the modes they declare are visible here'
    );
  }
  const missing = needs.find((need) => !declared.includes(need));
  if (missing === 'fileMode') return fails(`${entry} opens for writing and declares no fileMode`);
  if (missing === 'dirMode') return fails(`${entry} creates directories and declares no dirMode`);
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
        `${entry} reaches the filesystem through a name this census cannot follow. Call ` +
        'each entry it uses by a name this file imports'
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

  it('fails a directory walk through the helper that is passed no dirMode', () => {
    // A walk takes its dirMode third, so one passed no third argument declares none.
    // The type requires it, and each failing line compiles behind the directive above
    // it. Line 8 passes one, so it does not fail.
    expect(
      judgedWith(syntheticPath('walk-modes'), [
        "import { ensureAnchorWithinRoot, ensureDirWithinRoot } from '../lib/safe-open';",
        '',
        'export function makeDirs(root: string) {',
        '  // @ts-expect-error -- no dirMode, which the type requires',
        "  void ensureDirWithinRoot(root, ['a']);",
        '  // @ts-expect-error -- no dirMode, which the type requires',
        "  void ensureAnchorWithinRoot(root, ['b']);",
        "  void ensureDirWithinRoot(root, ['c'], 0o700);",
        '}'
      ])
    ).toEqual([
      'src/synthetic/walk-modes.ts:5 — ensureDirWithinRoot creates directories and declares no dirMode',
      'src/synthetic/walk-modes.ts:7 — ensureAnchorWithinRoot creates directories and declares no dirMode'
    ]);
  });

  it('reads the options under any key they spell, and takes an accessor to create directories', () => {
    // Line 4's computed keys are the keys they spell, so its fileMode counts and its
    // createDirs needs a dirMode. A getter's value is not read, so line 5's is taken to
    // create directories.
    expect(
      judgedWith(syntheticPath('spelled-options'), [
        "import { openWithinRoot } from '../lib/safe-open';",
        '',
        'export function openLogs(root: string) {',
        "  void openWithinRoot(root, ['logs', 'a.log'], { ['flags']: 'a', ['fileMode']: 0o600, ['createDirs']: true });",
        "  void openWithinRoot(root, ['logs', 'b.log'], { flags: 'a', fileMode: 0o600, get createDirs() { return true; } });",
        '}'
      ])
    ).toEqual([
      'src/synthetic/spelled-options.ts:4 — openWithinRoot creates directories and declares no dirMode',
      'src/synthetic/spelled-options.ts:5 — openWithinRoot creates directories and declares no dirMode'
    ]);
  });

  it('fails a helper open whose options are built where the census cannot read them', () => {
    // Each line hides an option from the census. Line 4's options are built elsewhere
    // and line 5 spreads them in. Line 6's key has a type wider than one literal, so
    // the checker never learns which option it sets, and lines 7 and 8 spell a key a
    // second time behind a cast that widens it. JavaScript keeps the second, so line 7
    // opens for writing and line 8 declares no fileMode. Line 9 casts its options past
    // the type and declares no fileMode either. Every line compiles.
    expect(
      judgedWith(syntheticPath('opaque-options'), [
        "import { openWithinRoot, type SafeOpenOptions } from '../lib/safe-open';",
        '',
        'export function openLogs(root: string, options: SafeOpenOptions, key: string) {',
        "  void openWithinRoot(root, ['a.log'], options);",
        "  void openWithinRoot(root, ['b.log'], { ...options, fileMode: 0o600 });",
        "  void openWithinRoot(root, ['c.log'], { flags: 'r', [key]: 'w' });",
        "  void openWithinRoot(root, ['d.log'], { flags: 'r', [('flags' as string)]: 'w' });",
        "  void openWithinRoot(root, ['e.log'], { flags: 'a', fileMode: 0o600, ['fileMode' as string]: undefined });",
        "  void openWithinRoot(root, ['f.log'], { flags: 'a' } as SafeOpenOptions);",
        '}'
      ])
    ).toEqual(
      [4, 5, 6, 7, 8, 9].map((line) =>
        expect.stringContaining(
          `src/synthetic/opaque-options.ts:${line} — openWithinRoot is passed options this census cannot read`
        )
      )
    );
  });

  it('fails a read through the helper that may create directories and declares no dirMode', () => {
    // A read creates no file, but the walk creates directories whenever createDirs is
    // set, whatever the flags. The type forbids createDirs on a read, and line 4's cast
    // compiles past it. Line 5 declares the dirMode and no fileMode, which no read needs,
    // and line 6 creates nothing, so neither fails. Every line compiles.
    expect(
      judgedWith(syntheticPath('read-creates-dirs'), [
        "import { openWithinRoot } from '../lib/safe-open';",
        '',
        'export function readLogs(root: string) {',
        "  void openWithinRoot(root, ['logs', 'a.log'], { flags: 'r', createDirs: true as never });",
        "  void openWithinRoot(root, ['logs', 'b.log'], { flags: 'r', createDirs: true as never, dirMode: 0o700 as never });",
        "  void openWithinRoot(root, ['logs', 'c.log'], { flags: 'r', createDirs: false });",
        '}'
      ])
    ).toEqual(['src/synthetic/read-creates-dirs.ts:4 — openWithinRoot creates directories and declares no dirMode']);
  });

  it('fails helper options that give the literal a prototype', () => {
    // A `__proto__` key, bare or quoted, sets the literal's prototype, and the helper
    // reads each option the literal leaves out through it, so lines 5 and 7 create
    // directories and declare no dirMode. A computed one sets no prototype and fails
    // all the same (line 9). The checker rejects each key, and each line compiles
    // behind the directive above it.
    expect(
      judgedWith(syntheticPath('prototype-options'), [
        "import { openWithinRoot } from '../lib/safe-open';",
        '',
        'export function openLogs(root: string, base: { createDirs: true }) {',
        '  // @ts-expect-error -- a prototype key, which the type rejects',
        "  void openWithinRoot(root, ['logs', 'a.log'], { __proto__: base, flags: 'a', fileMode: 0o600 });",
        '  // @ts-expect-error -- a prototype key, which the type rejects',
        "  void openWithinRoot(root, ['logs', 'b.log'], { '__proto__': base, flags: 'a', fileMode: 0o600 });",
        '  // @ts-expect-error -- a prototype key, which the type rejects',
        "  void openWithinRoot(root, ['logs', 'c.log'], { ['__proto__']: base, flags: 'a', fileMode: 0o600 });",
        '}'
      ])
    ).toEqual(
      [5, 7, 9].map((line) =>
        expect.stringContaining(
          `src/synthetic/prototype-options.ts:${line} — openWithinRoot is passed options this census cannot read`
        )
      )
    );
  });

  it('fails helper options that spell a mode and give it no value', () => {
    // A setter with no getter is typed as what it takes, so it satisfies a mode the
    // type requires, and reading it gives `undefined`: line 4 opens for writing with no
    // fileMode and line 5 creates directories with no dirMode, and each compiles as it
    // stands. A method's value is a function, never a mode. The checker rejects line
    // 7, and it compiles behind the directive above it.
    expect(
      judgedWith(syntheticPath('valueless-options'), [
        "import { openWithinRoot } from '../lib/safe-open';",
        '',
        'export function openLogs(root: string) {',
        "  void openWithinRoot(root, ['a.log'], { flags: 'a', set fileMode(_: number) {} });",
        "  void openWithinRoot(root, ['logs', 'b.log'], { flags: 'a', fileMode: 0o600, createDirs: true, set dirMode(_: number) {} });",
        '  // @ts-expect-error -- a method, which the type rejects',
        "  void openWithinRoot(root, ['c.log'], { flags: 'a', fileMode() { return 0o600; } });",
        '}'
      ])
    ).toEqual(
      [4, 5, 7].map((line) =>
        expect.stringContaining(
          `src/synthetic/valueless-options.ts:${line} — openWithinRoot is passed options this census cannot read`
        )
      )
    );
  });

  it('fails a helper reached other than as the callee of a call that spells its name', () => {
    // The census reads what a helper is passed at a call that spells the helper's name,
    // bare or after a dot. Any other way to reach the helper hands on a call it never
    // reads, so each fails where the source spells the name: an import or a re-export
    // under another name (lines 2 and 4), an import alias (line 5), a value held (lines
    // 10 and 17), a key a destructuring takes (line 11), a callee applied or wrapped
    // (lines 12 to 15), and brackets (line 16). Line 3's re-export keeps the name, line
    // 7 is a type, and lines 18 and 19 are calls the census reads, so none of them fails.
    const reached = (line: number, entry: string): string =>
      `src/synthetic/helper-references.ts:${line} — ${entry} is reached other than as the callee of a call that spells its name`;
    expect(
      judgedWith(syntheticPath('helper-references'), [
        "import * as safe from '../lib/safe-open';",
        "import { openWithinRoot, openWithinRoot as openSafely } from '../lib/safe-open';",
        "export { ensureDirWithinRoot } from '../lib/safe-open';",
        "export { ensureDirWithinRoot as ensureHere } from '../lib/safe-open';",
        'import openAliased = safe.openWithinRoot;',
        '',
        'type Open = typeof openWithinRoot;',
        '',
        'export function openLogs(root: string, options: Parameters<Open>[2]) {',
        '  const held = openWithinRoot;',
        '  const { openWithinRoot: taken } = safe;',
        "  void openWithinRoot.call(undefined, root, ['a.log'], options);",
        "  void (0, openWithinRoot)(root, ['b.log'], options);",
        "  void (openWithinRoot)(root, ['c.log'], options);",
        "  void openWithinRoot!(root, ['d.log'], options);",
        "  void safe['openWithinRoot'](root, ['e.log'], options);",
        '  const dotted = safe.ensureDirWithinRoot;',
        "  void openWithinRoot(root, ['f.log'], { flags: 'a', fileMode: 0o600 });",
        "  void safe.openWithinRoot(root, ['g.log'], { flags: 'a', fileMode: 0o600 });",
        '  return [held, taken, dotted, openSafely, openAliased];',
        '}'
      ])
    ).toEqual(
      [
        reached(2, 'openWithinRoot'),
        reached(4, 'ensureDirWithinRoot'),
        ...[5, 10, 11, 12, 13, 14, 15, 16].map((line) => reached(line, 'openWithinRoot')),
        reached(17, 'ensureDirWithinRoot')
      ]
        .sort()
        .map((prefix) => expect.stringContaining(prefix))
    );
  });

  it('fails a helper an assignment takes by destructuring, under any key it spells', () => {
    // Line 11 above takes one in a declaration, through a binding pattern. An assignment
    // destructures through an object literal instead, and each line here takes a helper
    // under a key spelled bare, quoted or computed.
    const reached = (line: number, entry: string): string =>
      `src/synthetic/assigned-helpers.ts:${line} — ${entry} is reached other than as the callee of a call that spells its name`;
    expect(
      judgedWith(syntheticPath('assigned-helpers'), [
        "import * as safe from '../lib/safe-open';",
        '',
        'export function takeHelpers(): unknown[] {',
        '  let bare: unknown;',
        '  let quoted: unknown;',
        '  let computed: unknown;',
        '  ({ openWithinRoot: bare } = safe);',
        "  ({ 'openWithinRootByPath': quoted } = safe);",
        "  ({ ['ensureAnchorWithinRoot']: computed } = safe);",
        '  return [bare, quoted, computed];',
        '}'
      ])
    ).toEqual(
      [reached(7, 'openWithinRoot'), reached(8, 'openWithinRootByPath'), reached(9, 'ensureAnchorWithinRoot')].map(
        (prefix) => expect.stringContaining(prefix)
      )
    );
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
      expect.stringContaining('src/synthetic/escape.ts:3 — the fsp namespace reaches the filesystem through a name this census cannot follow')
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

  it('sees a chmod named in brackets, and reads no other bracketed member as one', () => {
    // A literal in parentheses or a type assertion is still the literal. The last two
    // calls are the controls: a bracketed name is read as the member it names, so a
    // member outside the chmod family is no reach, wrapped or not.
    expect(
      reachesIn([
        'export async function pin(handle: Record<string, (mode?: number) => Promise<void>>) {',
        "  await handle['chmod'](0o600);",
        '  await handle[`fchmod`](0o600);',
        "  await handle[('lchmod')](0o600);",
        "  await handle['chmodSync' as const](0o600);",
        "  await handle['fchmodSync' satisfies string](0o600);",
        "  await handle['lchmodSync'!](0o600);",
        "  await handle[<const>('chmod')](0o600);",
        "  await handle['stat']();",
        "  await handle[('stat' as const)]();",
        '}'
      ])
    ).toEqual([
      { line: 2, entry: 'chmod', kind: 'changes-mode', form: 'call', declared: null },
      { line: 3, entry: 'fchmod', kind: 'changes-mode', form: 'call', declared: null },
      { line: 4, entry: 'lchmod', kind: 'changes-mode', form: 'call', declared: null },
      { line: 5, entry: 'chmodSync', kind: 'changes-mode', form: 'call', declared: null },
      { line: 6, entry: 'fchmodSync', kind: 'changes-mode', form: 'call', declared: null },
      { line: 7, entry: 'lchmodSync', kind: 'changes-mode', form: 'call', declared: null },
      { line: 8, entry: 'chmod', kind: 'changes-mode', form: 'call', declared: null }
    ]);
  });

  it('sees a chmod taken by destructuring, and reads no other destructured member as one', () => {
    // The key a binding takes is the member it names, however the key is spelled, in a
    // declaration or a parameter alike. Two controls on line 6: `stat` is no reach, and a
    // rest element named like an entry takes the whole receiver, not that member.
    expect(
      reachesIn([
        'export function pin(handle: Record<string, (mode?: number) => Promise<void>>) {',
        '  const { chmod } = handle;',
        '  const { fchmod: narrow } = handle;',
        "  const { 'lchmod': other, ['chmodSync']: settled } = handle;",
        "  const { [('fchmod')]: wrapped, ['lchmodSync' as const]: asserted } = handle;",
        '  const { stat, ...lchmodSync } = handle;',
        '}',
        'export function apply({ fchmodSync }: Record<string, (mode?: number) => void>) {}'
      ])
    ).toEqual([
      { line: 2, entry: 'chmod', kind: 'changes-mode', form: 'reference', declared: null },
      { line: 3, entry: 'fchmod', kind: 'changes-mode', form: 'reference', declared: null },
      { line: 4, entry: 'lchmod', kind: 'changes-mode', form: 'reference', declared: null },
      { line: 4, entry: 'chmodSync', kind: 'changes-mode', form: 'reference', declared: null },
      { line: 5, entry: 'fchmod', kind: 'changes-mode', form: 'reference', declared: null },
      { line: 5, entry: 'lchmodSync', kind: 'changes-mode', form: 'reference', declared: null },
      { line: 8, entry: 'fchmodSync', kind: 'changes-mode', form: 'reference', declared: null }
    ]);
  });

  it('sees a chmod taken by a destructuring assignment, and reads no literal that builds a port', () => {
    // A literal destructures only as what `=`, `for … of` or `for … in` assigns to,
    // however deeply nested. Lines 8 to 11 are the controls: a literal that builds a
    // value, on the right of `=`, beside another operator, iterated or returned, takes
    // no member, so a `chmod` key in it is no reach.
    expect(
      reachesIn([
        'export function later(handle: Record<string, (mode?: number) => Promise<void>>, list: (typeof handle)[]) {',
        '  let chmod: unknown;',
        '  let other: unknown;',
        '  ({ chmod, lchmodSync: other } = handle);',
        "  [{ 'fchmod': other }] = list;",
        '  ({ inner: { fchmodSync: other } } = { inner: handle });',
        '  for ({ chmodSync: other } of list);',
        '  other = { fchmod: handle.stat };',
        '  other = { lchmod: handle.stat } || handle;',
        '  for (const entry of [{ chmod: other }]);',
        '  return { chmod: other };',
        '}'
      ])
    ).toEqual([
      { line: 4, entry: 'chmod', kind: 'changes-mode', form: 'reference', declared: null },
      { line: 4, entry: 'lchmodSync', kind: 'changes-mode', form: 'reference', declared: null },
      { line: 5, entry: 'fchmod', kind: 'changes-mode', form: 'reference', declared: null },
      { line: 6, entry: 'fchmodSync', kind: 'changes-mode', form: 'reference', declared: null },
      { line: 7, entry: 'chmodSync', kind: 'changes-mode', form: 'reference', declared: null }
    ]);
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

  it("follows VS Code's workspace under the name its import gives it, and fails closed on it or the module handed on whole", () => {
    expect(
      reachesIn([
        "import * as vscode from 'vscode';",
        "import { workspace as ws } from 'vscode';",
        'export async function save(target: vscode.Uri, data: Uint8Array) {',
        '  await ws.fs.writeFile(target, data);',
        '  const { fs } = vscode.workspace;',
        '  return ws;',
        '}',
        'export const api = vscode;'
      ])
    ).toEqual([
      { line: 4, entry: 'workspace.fs.writeFile', kind: 'writes', form: 'call', declared: null },
      { line: 5, entry: 'the workspace object', kind: 'unresolved', form: 'reference', declared: null },
      { line: 6, entry: 'the workspace object', kind: 'unresolved', form: 'reference', declared: null },
      { line: 8, entry: 'the vscode namespace', kind: 'unresolved', form: 'reference', declared: null }
    ]);
  });

  it('fails closed on a re-export, which hands the API to a module whose own imports never name it', () => {
    // The type-only lines are the control: a type carries no entry to call.
    expect(
      reachesIn([
        "export { open } from 'node:fs/promises';",
        "export * from 'fs';",
        "export * as editor from 'vscode';",
        "export type { Stats } from 'node:fs';",
        "export { type Dirent } from 'node:fs';"
      ])
    ).toEqual([
      { line: 1, entry: 'a re-export', kind: 'unresolved', form: 'reference', declared: null },
      { line: 2, entry: 'a re-export', kind: 'unresolved', form: 'reference', declared: null },
      { line: 3, entry: 'a re-export', kind: 'unresolved', form: 'reference', declared: null }
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

  it('fails closed on a require and a dynamic import of vscode, whose workspace it cannot follow under a new name', () => {
    // Each load is the only line that can fail: the writes below it go through
    // names no import gives, so nothing else in this source is read as a reach.
    expect(
      reachesIn([
        'export async function save(target: unknown, data: Uint8Array) {',
        "  const editor = await import('vscode');",
        '  const files = editor.workspace;',
        '  await files.fs.writeFile(target, data);',
        '}',
        "const { workspace: later } = require('vscode');",
        'export const write = (target: unknown, data: Uint8Array) => later.fs.writeFile(target, data);'
      ])
    ).toEqual([
      { line: 2, entry: 'a dynamic load', kind: 'unresolved', form: 'reference', declared: null },
      { line: 6, entry: 'a dynamic load', kind: 'unresolved', form: 'reference', declared: null }
    ]);
  });

  it('fails closed on a load whose module is named at run time, and passes one that names another module', () => {
    // The last line is the control: a load of a module the scan does not follow is no
    // reach, or every dynamic import in the tree would need a reason.
    expect(
      reachesIn([
        "const name = ['node', 'fs'].join(':');",
        'const loaded = require(name);',
        'export const later = import(name);',
        "export const spawner = import('node:child_process');"
      ])
    ).toEqual([
      { line: 2, entry: 'a dynamic load', kind: 'unresolved', form: 'reference', declared: null },
      { line: 3, entry: 'a dynamic load', kind: 'unresolved', form: 'reference', declared: null }
    ]);
  });

  it('fails closed on require used any way but a direct call, and passes require.resolve', () => {
    // The last two lines are the control: `require.resolve` returns a path and loads
    // nothing, and a direct call of a module the scan does not follow is no reach.
    expect(
      reachesIn([
        "const asserted = require!('node:fs');",
        "const cast = (require as NodeRequire)('node:fs');",
        'const loader = require;',
        "const sequenced = (0, require)('node:fs');",
        "const called = require.call(null, 'node:fs');",
        "const applied = Reflect.apply(require, null, ['node:fs']);",
        "const main = require.main?.require('node:fs');",
        "export const where = require.resolve('node:fs');",
        "export const path = require('node:path');"
      ])
    ).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((line) => ({
        line,
        entry: 'the require function',
        kind: 'unresolved',
        form: 'reference',
        declared: null
      }))
    );
  });

  it('fails closed on an import alias, and reads an exported import-equals as a re-export', () => {
    // Two controls. The `workspace` on line 6 names a member, not the import on line 3
    // that shares its name, so the line fails once. And an import-equals kept in this
    // file is followed like any other import, so only its uses can reach; there are none.
    expect(
      reachesIn([
        "import * as fs from 'node:fs';",
        "import * as vscode from 'vscode';",
        "import { workspace } from 'vscode';",
        'import whole = fs;',
        'import later = fs.promises;',
        'import files = vscode.workspace;',
        "export import exported = require('node:fs');",
        "export import editor = require('vscode');",
        "import kept = require('node:fs');"
      ])
    ).toEqual([
      { line: 4, entry: 'the fs namespace', kind: 'unresolved', form: 'reference', declared: null },
      { line: 5, entry: 'the fs namespace', kind: 'unresolved', form: 'reference', declared: null },
      { line: 6, entry: 'the vscode namespace', kind: 'unresolved', form: 'reference', declared: null },
      { line: 7, entry: 'a re-export', kind: 'unresolved', form: 'reference', declared: null },
      { line: 8, entry: 'a re-export', kind: 'unresolved', form: 'reference', declared: null }
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
