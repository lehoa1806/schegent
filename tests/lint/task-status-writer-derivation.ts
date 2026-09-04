// The Task status writer derivation, feature 200 (FR-R3-161) T013-T015.
// Governed by specs/200-cancel-removal-transition-table/contracts/
// task-status-writer-census.md.
//
// This module answers one question over a directory of TypeScript source:
// which sites take an already-existing Task and commit it carrying a different
// status? It returns *candidates*, not writers. The distinction is the point
// (contract C5.1): the rule is mechanical, the category is semantic, and
// contract C4.4 requires the mechanical rule to over-select rather than risk
// missing a writer. A false positive costs one line in the caller's exemption
// table; a false negative is the failure the gate exists to prevent.
//
// It lives outside any `.test.ts` so importing it does not re-register another
// file's suite — the same reason `architecture-layers.ts` sits here — and so it
// stays a pure function of a root directory with no dependency on the gate's
// assertions (contract C8 invariant 4). That purity is what lets the gate call
// it twice: once over `src/` for the real assertion, once over
// `tests/lint/fixtures/` for the negative control.
//
// THE THREE STAGES (contract C2):
//
//   1. population — every `.ts` file under the root whose source matches
//      `\bFeatureRequest\b`. Anchored on the NAME of the Task record, never on
//      a status VALUE: every Task status spelling is also written onto a
//      workflow run elsewhere in the tree (contract C4.1-C4.2, AGENTS.md rule
//      67). Never on `as FeatureRequestStatus` either — two enrolled writers
//      write their status uncast (C4.3).
//
//   2. candidate sites — within an in-scope file, every object literal whose
//      FIRST top-level element is a spread and which also assigns `status`, in
//      either the colon form or the shorthand.
//
//   3. sink — the file's source must additionally match `\brequests\b`.
//
// WHY STRUCTURAL WALKING AND NOT LINE REGEXES. Research D1 records a first
// prototype anchored on `^\s*status:`. It found six sites and they were the
// wrong six: it missed `finish` (which uses the shorthand), `cancel`, and the
// migrator's demotion (a single-line literal). Brace/paren/bracket depth is
// walked instead, so neither line breaks nor single-line formatting can hide a
// site.
//
// WHY STAGE 3 IS AT FILE LEVEL AND MUST STAY THERE. Narrowing it to the
// enclosing declaration was the second rejected prototype: it drops the surplus
// in-flight demotion in `src/state/queue-state-migrator.ts`, which is the one
// real unenrolled Task status writer in the tree and the whole evidence for
// this gate existing. That was a false negative of exactly the kind C4.4 names
// as fatal.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface CandidateSite {
  /** Path relative to the scan root, with POSIX separators. Stable across machines. */
  readonly file: string;
  /**
   * The name of the innermost named declaration enclosing the site, or
   * `'<file scope>'` when it sits outside every one. This is the key the gate
   * classifies on — never a line number (contract C8 invariant 5).
   */
  readonly declaration: string;
  /** 1-based line of the literal's opening brace. Evidence for humans; never asserted on. */
  readonly line: number;
  /** The literal's own source text, for a failure message that can be acted on. */
  readonly literal: string;
  /** The enclosing declaration's body source, which the gate tests for enrolment. */
  readonly enclosingBody: string;
}

const TASK_RECORD_NAME = /\bFeatureRequest\b/;
const REQUEST_COLLECTION_NAME = /\brequests\b/;
const SPREAD_ELEMENT = /^\.\.\./;
/** `status,` (shorthand) or `status: <anything>` (colon form). Not `statusBar:`. */
const STATUS_ELEMENT = /^status\s*(?::|$)/;

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'out', 'coverage', '.git']);

/**
 * Words that can appear where a declaration name would and are not one. The
 * member pattern below accepts an unmodified class member, which is
 * indistinguishable by shape from a control-flow keyword followed by its
 * condition.
 */
const NOT_A_DECLARATION_NAME = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'throw',
  'typeof',
  'await',
  'yield',
  'new',
  'delete',
  'void',
  'in',
  'of',
  'do',
  'else'
]);

interface Declaration {
  readonly name: string;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

/**
 * Replace every non-code region — comments, string bodies, template literals
 * including their interpolated expressions, and regex bodies — with spaces,
 * preserving length and newlines so every index still maps 1:1 onto the
 * original source.
 *
 * Everything downstream walks this masked text. Without it a brace inside a
 * string, or a quote inside a comment, silently shifts every depth count after
 * it, and a shifted depth count is how a structural scan produces the false
 * negative contract C4.4 calls fatal.
 */
export function maskNonCode(source: string): string {
  const out = source.split('');
  const blank = (i: number): void => {
    if (out[i] !== '\n') out[i] = ' ';
  };
  const n = source.length;
  let i = 0;
  let lastCode = '';

  while (i < n) {
    // `charAt` rather than `source[i]` throughout: the loop guard already proves
    // the index is in range, and `charAt` says so in the type instead of
    // handing every downstream comparison a `string | undefined` that
    // `noUncheckedIndexedAccess` would have to be silenced to accept. Out of
    // range it yields `''`, which matches nothing here.
    const ch = source.charAt(i);
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') blank(i++);
      continue;
    }
    if (ch === '/' && next === '*') {
      blank(i++);
      blank(i++);
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) blank(i++);
      if (i < n) {
        blank(i++);
        blank(i++);
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      blank(i++);
      while (i < n && source[i] !== ch) {
        if (source[i] === '\\') {
          blank(i++);
          if (i < n) blank(i++);
          continue;
        }
        blank(i++);
      }
      if (i < n) blank(i++);
      lastCode = ch;
      continue;
    }
    if (ch === '`') {
      blank(i++);
      // Interpolated expressions are masked along with the quasis. A Task
      // status literal inside `${...}` is not a shape this codebase writes, and
      // masking the whole template is what keeps a backtick inside an
      // expression from ending the scan early.
      let exprDepth = 0;
      while (i < n) {
        const c = source[i];
        if (c === '\\') {
          blank(i++);
          if (i < n) blank(i++);
          continue;
        }
        if (exprDepth === 0 && c === '`') {
          blank(i++);
          break;
        }
        if (exprDepth === 0 && c === '$' && source[i + 1] === '{') {
          blank(i++);
          blank(i++);
          exprDepth = 1;
          continue;
        }
        if (exprDepth > 0) {
          if (c === '{') exprDepth++;
          else if (c === '}') exprDepth--;
        }
        blank(i++);
      }
      lastCode = '`';
      continue;
    }
    if (ch === '/' && startsRegex(lastCode)) {
      // A regex body can hold unbalanced braces and stray quotes. Mask it the
      // same way, character class included so a `/` inside `[...]` does not end
      // it early.
      blank(i++);
      let inClass = false;
      while (i < n) {
        const c = source[i];
        if (c === '\\') {
          blank(i++);
          if (i < n) blank(i++);
          continue;
        }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          blank(i++);
          break;
        }
        blank(i++);
      }
      while (i < n && /[a-z]/.test(source.charAt(i))) blank(i++);
      lastCode = '/';
      continue;
    }

    if (!/\s/.test(ch)) lastCode = ch;
    i++;
  }

  return out.join('');
}

/**
 * Whether a `/` at this point opens a regex literal rather than a division.
 * The standard heuristic: a regex may only follow an operator, an opening
 * bracket, a separator, or the start of input.
 */
function startsRegex(lastCode: string): boolean {
  return lastCode === '' || '=(,:[!&|?{};+-*%~^<>'.includes(lastCode);
}

/** Map every `{` index to its matching `}` index, over already-masked code. */
function matchBraces(code: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '{') stack.push(i);
    else if (code[i] === '}') {
      const open = stack.pop();
      if (open !== undefined) pairs.set(open, i);
    }
  }
  return pairs;
}

/**
 * Split a literal's interior into its top-level elements by walking
 * brace/paren/bracket depth, so a nested literal, call or index expression
 * cannot contribute a comma.
 */
function topLevelElements(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

const DECLARATION_PATTERNS: readonly RegExp[] = [
  // `function foo(`, `export async function foo(`, generics included.
  /(?:^|[\n;}])[^\S\n]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]/g,
  // A class member carrying an explicit visibility modifier.
  /(?:^|[\n;}])[^\S\n]*(?:public|private|protected)\s+(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*[(<]/g,
  // A class member without one, and object-literal methods.
  /(?:^|[\n;}])[^\S\n]*(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g,
  // `const foo = (…) =>`, `const foo = async function (…)`, with or without a
  // type annotation.
  /(?:^|[\n;}])[^\S\n]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*(?:async\s+)?(?:function\b[^(]*)?[(<]/g
];

/**
 * Every named declaration in the file with a real `{ … }` body, located by
 * walking paren/angle/bracket depth from the signature so a return-type-position
 * inline object type or generic does not fool a naive "first `{`" search — the
 * walker shape `task-transition-decision-census.test.ts`'s `extractBody` and
 * `phase-control-decision-census.test.ts`'s `extractMethodBody` both use.
 */
function findDeclarations(code: string, braces: Map<number, number>): Declaration[] {
  const declarations: Declaration[] = [];
  for (const pattern of DECLARATION_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) {
      // Every pattern above has a mandatory capture group 1, so this cannot be
      // absent at runtime; the guard is what says that to the compiler without
      // an assertion, and a pattern edited later to make the group optional
      // fails closed by dropping the site rather than by naming `undefined`.
      //
      // `.at(1)` rather than `[1]` because the guard has to be necessary under
      // *both* programs this file is read by. `RegExpExecArray extends
      // Array<string>`, so `match[1]` is `string` under `tsconfig.json` (which
      // ESLint uses) and `string | undefined` under the strictness ratchet's
      // `noUncheckedIndexedAccess` pass — the guard is then either required or
      // an "unnecessary condition", depending on which tool is looking. `.at()`
      // is typed `T | undefined` regardless of that flag, so one spelling
      // satisfies both, and it is the honest one: a capture group's presence is
      // a runtime property the lib types overstate.
      const name = match.at(1);
      if (name === undefined || NOT_A_DECLARATION_NAME.has(name)) continue;
      const from = match.index;
      const bodyStart = findBodyStart(code, from, braces);
      if (bodyStart === -1) continue;
      // A signature with no body — an overload declaration, an expression-bodied
      // arrow, a property — would otherwise adopt the next unrelated block and
      // shadow every real declaration inside it. Only a `;` OUTSIDE every
      // bracket ends a statement: `runRestartCanceledTask(ctx: { store: …;
      // queue: …; })` carries semicolons inside its parameter list and is a
      // perfectly ordinary function.
      if (hasTopLevelSemicolon(code, from, bodyStart)) continue;
      const bodyEnd = braces.get(bodyStart);
      if (bodyEnd === undefined) continue;
      declarations.push({ name, bodyStart, bodyEnd });
      // Overlapping patterns are expected; the innermost-wins rule below makes
      // duplicates harmless.
      pattern.lastIndex = match.index + match[0].length;
    }
  }
  return declarations;
}

/**
 * The index of a declaration's real body-opening brace, walking paren/angle/
 * bracket depth from the signature so a parameter-position inline object type
 * does not fool a naive "first `{`" search — and additionally stepping over a
 * RETURN-type-position one, which the naive search does fall for:
 *
 *   function liftLegacyRequests(…): { requests: FeatureRequest[]; … } { … }
 *                                   ^ not the body                    ^ the body
 *
 * A `{` in type position is always preceded by `:`, `|`, `&` or `,`; a body's
 * is preceded by `)`, `>`, `}` or an identifier character. Getting this wrong
 * mislabels the enclosing declaration, and the gate classifies on declaration
 * name — so a mislabel is an enrolled writer reported as unenrolled.
 */
function findBodyStart(code: string, from: number, braces: Map<number, number>): number {
  const TYPE_POSITION_PREDECESSORS = new Set([':', '|', '&', ',']);
  let paren = 0;
  let angle = 0;
  let bracket = 0;
  let lastSignificant = '';
  for (let i = from; i < code.length; i++) {
    const ch = code.charAt(i);
    if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket--;
    else if (ch === '<') angle++;
    else if (ch === '>') {
      if (angle > 0) angle--;
    } else if (ch === '{' && paren === 0 && angle === 0 && bracket === 0) {
      if (!TYPE_POSITION_PREDECESSORS.has(lastSignificant)) return i;
      const close = braces.get(i);
      if (close === undefined) return -1;
      i = close;
      lastSignificant = '}';
      continue;
    }
    if (!/\s/.test(ch)) lastSignificant = ch;
  }
  return -1;
}

/** Whether the span holds a `;` outside every paren, bracket and brace. */
function hasTopLevelSemicolon(code: string, from: number, to: number): boolean {
  let depth = 0;
  for (let i = from; i < to; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ';' && depth === 0) return true;
  }
  return false;
}

/** The innermost declaration whose body contains `index`. */
function enclosingDeclaration(declarations: Declaration[], index: number): Declaration | null {
  let best: Declaration | null = null;
  for (const declaration of declarations) {
    if (declaration.bodyStart > index || declaration.bodyEnd < index) continue;
    if (best === null || declaration.bodyStart > best.bodyStart) best = declaration;
  }
  return best;
}

function collectTypeScriptFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        found.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * The derivation. Pure in the root directory; the only I/O is reading the files
 * under it.
 */
export function deriveTaskStatusWriterCandidates(root: string): CandidateSite[] {
  const sites: CandidateSite[] = [];

  for (const absolute of collectTypeScriptFiles(root)) {
    const source = readFileSync(absolute, 'utf8');

    // Stage 1 and stage 3 are both properties of the whole file, so both are
    // settled before any structural work.
    if (!TASK_RECORD_NAME.test(source)) continue;
    if (!REQUEST_COLLECTION_NAME.test(source)) continue;

    const code = maskNonCode(source);
    const braces = matchBraces(code);
    const declarations = findDeclarations(code, braces);

    for (const [open, close] of braces) {
      const elements = topLevelElements(code.slice(open + 1, close));
      // Stage 2: leading spread, and a `status` assignment anywhere at top level.
      // An empty literal has no first element and is not a candidate, so the
      // absence check and the emptiness check are the same check. `.at(0)` for
      // the reason recorded at `findDeclarations` above: it is typed
      // `T | undefined` under both the linting program and the strictness
      // ratchet's, so the guard is necessary to both rather than required by
      // one and reported as unnecessary by the other.
      const first = elements.at(0);
      if (first === undefined || !SPREAD_ELEMENT.test(first)) continue;
      if (!elements.some((element) => STATUS_ELEMENT.test(element))) continue;

      const declaration = enclosingDeclaration(declarations, open);
      sites.push({
        file: relative(root, absolute).split(sep).join('/'),
        declaration: declaration?.name ?? '<file scope>',
        line: source.slice(0, open).split('\n').length,
        literal: source.slice(open, close + 1).trim(),
        enclosingBody: declaration ? code.slice(declaration.bodyStart, declaration.bodyEnd + 1) : ''
      });
    }
  }

  return sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
