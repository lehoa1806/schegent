// A portable file scan for lint gates.
//
// Twenty-two gates in this directory resolved their file sets by shelling out to
// `grep` and `find`. That works on darwin and linux and does not work on Windows,
// which `.github/workflows/ci.yml` names in its matrix alongside them: Windows
// has no `grep`, and its `FIND.exe` is a string search over files rather than a
// file finder, so `find <root> \( -name '*.ts' \)` is not a slower version of the
// same thing — it is a different program that will either error or answer a
// question nobody asked.
//
// The failure was never observed because the Windows leg has never run against
// this tree. It is nonetheless predictable rather than speculative, which is why
// this exists: the alternative is discovering twenty-two red gates on the first
// push, in a job nobody has seen pass.
//
// FR-R3-033 made the same argument for `rg` and built `webview-source-scan.ts`
// for one directory. This is that pattern generalised, and its arrival lets
// `lint-gates-are-hermetic.test.ts` drop `grep` and `find` from the tools a gate
// may invoke — turning "declare what you shell out to" into "do not shell out".
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/** Directory names never descended into, matching what `.gitignore` ignores. */
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', '.git', '.svelte-kit']);

export interface ScanOptions {
  /** Restrict to these extensions, e.g. `['.ts', '.svelte']`. Default: all files. */
  readonly extensions?: readonly string[];
  /** Directory names to skip in addition to the defaults. */
  readonly skipDirectories?: readonly string[];
}

/** Every file under `root`, as absolute paths, depth-first and sorted. */
export function filesUnder(root: string, options: ScanOptions = {}): string[] {
  const skip = new Set([...SKIP_DIRECTORIES, ...(options.skipDirectories ?? [])]);
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // A root that does not exist is the caller's business to assert on; a
      // scan that invented an empty result here would let every "no matches"
      // assertion pass vacuously.
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const child = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(child);
        continue;
      }
      if (!entry.isFile()) continue;
      if (options.extensions && !options.extensions.some((ext) => entry.name.endsWith(ext))) {
        continue;
      }
      out.push(child);
    }
  };
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory()) walk(root);
  else if (statSync(root, { throwIfNoEntry: false })?.isFile()) out.push(resolve(root));
  return out.sort();
}

export interface MatchOptions extends ScanOptions {
  /** Treat `pattern` as a literal string rather than a regular expression. */
  readonly fixed?: boolean;
  /**
   * Treat `pattern` as a POSIX basic regular expression, which is what `grep`
   * without `-E` accepts.
   *
   * The difference matters and is easy to get wrong in both directions. In a
   * BRE, `( ) { } + ? |` are LITERAL characters and `\.` is an escaped dot — so
   * `queue\.enqueue(` means "queue.enqueue(" with a literal paren. Handing that
   * string to a JS regex throws on the unterminated group; handing it to a
   * fixed-string match looks for a backslash that is not there. Neither is the
   * pattern the author wrote.
   */
  readonly bre?: boolean;
  /** Case-insensitive matching. */
  readonly ignoreCase?: boolean;
}

/**
 * POSIX bracket expressions as their JavaScript equivalents.
 *
 * `grep` accepts `[[:space:]]`, `[[:alpha:]]` and friends; JavaScript regular
 * expressions do not, and silently treat the inner `[:space:]` as a character
 * set containing `:`, `a`, `c`, `e`, `p` and `s`. That is a match that succeeds
 * on the wrong input rather than an error, which is why this is translated
 * rather than left to fail loudly.
 */
const POSIX_CLASSES: ReadonlyArray<[RegExp, string]> = [
  [/\[\[:space:\]\]/g, '\\s'],
  [/\[\[:alpha:\]\]/g, '[a-zA-Z]'],
  [/\[\[:alnum:\]\]/g, '[a-zA-Z0-9]'],
  [/\[\[:digit:\]\]/g, '\\d'],
  [/\[\[:upper:\]\]/g, '[A-Z]'],
  [/\[\[:lower:\]\]/g, '[a-z]'],
  [/\[\[:punct:\]\]/g, '[!-\\/:-@\\[-`{-~]']
];

function translatePosixClasses(pattern: string): string {
  return POSIX_CLASSES.reduce((acc, [from, to]) => acc.replace(from, to), pattern);
}

/** A POSIX BRE as a JavaScript regular expression source. */
function breToJs(pattern: string): string {
  // Escape the metacharacters JS treats as special and BRE does not, leaving
  // backslash escapes the author wrote (`\.`, `\b`) alone.
  return pattern.replace(/(\\.)|([(){}+?|])/g, (_m, escaped, literal) =>
    escaped !== undefined ? escaped : `\\${literal}`
  );
}

const escapeLiteral = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Absolute paths of files under `root` whose contents match `pattern`.
 *
 * The replacement for `grep -rl`. Returns paths sorted, so a caller comparing
 * against a fixed list is comparing against a stable order — `grep`'s output
 * order is filesystem-dependent and two of the migrated gates were quietly
 * relying on it.
 */
export function filesMatching(root: string, pattern: string, options: MatchOptions = {}): string[] {
  const flags = options.ignoreCase === true ? 'i' : '';
  const source =
    options.fixed === true
      ? escapeLiteral(pattern)
      : options.bre === true
        ? breToJs(translatePosixClasses(pattern))
        : translatePosixClasses(pattern);
  const regex = new RegExp(source, flags);
  return filesUnder(root, options).filter((file) => {
    try {
      return regex.test(readFileSync(file, 'utf8'));
    } catch {
      // Unreadable or non-UTF8: not a match, and not a reason to fail the whole
      // scan. `grep` behaved the same way for binary files.
      return false;
    }
  });
}

export interface LineMatch {
  /** Absolute path of the file the line came from. */
  readonly file: string;
  /** 1-indexed, matching `grep -n`. */
  readonly line: number;
  readonly text: string;
}

/**
 * Matching lines under `root`, the replacement for `grep -rn`.
 *
 * Returned structured rather than as `file:line:text` strings: every caller that
 * used `-n` immediately split the string back apart on colons, which is wrong on
 * any path containing one. Callers that want the flat form can build it.
 */
export function linesMatching(
  root: string,
  pattern: string,
  options: MatchOptions = {}
): LineMatch[] {
  const flags = options.ignoreCase === true ? 'i' : '';
  const source =
    options.fixed === true
      ? escapeLiteral(pattern)
      : options.bre === true
        ? breToJs(translatePosixClasses(pattern))
        : translatePosixClasses(pattern);
  const regex = new RegExp(source, flags);
  const out: LineMatch[] = [];
  for (const file of filesUnder(root, options)) {
    let contents: string;
    try {
      contents = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    contents.split('\n').forEach((text, index) => {
      if (regex.test(text)) out.push({ file, line: index + 1, text });
    });
  }
  return out;
}
