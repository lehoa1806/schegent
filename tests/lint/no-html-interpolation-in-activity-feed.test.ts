// Feature 029 T044 — Activity Feed FR-017 regression: no raw HTML
// interpolation of operator-influenced strings.
//
// Hard rule: every `.svelte` file under the scanned directories MUST
// render text bodies as text only. The literal `{@html …}` token is
// forbidden because the log strings flow from the autonomous Claude
// CLI through host sanitization but are NOT guaranteed to be safe
// HTML — they are sanitized for secret patterns, not for HTML
// tokenisation.
//
// Detection: a recursive grep for the Svelte template token form
// `{@html <expression>}` (at least one whitespace between `@html` and
// the expression) across each scanned directory. The comment form
// `` `{@html}` `` used in defensive documentation does NOT match.
// Allowlist is empty by default; if a future component has a
// legitimate need to interpolate trusted host-rendered HTML, add the
// file to ALLOWED_FILES with an inline comment explaining the
// provenance of the trusted bytes.

import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filesMatching } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');

// Each scanned root is a directory whose `.svelte` files must NEVER
// contain `{@html EXPR}`. Adding a new root extends the prohibition;
// scan roots are NEVER mutually exclusive — every file under every
// root is checked.
const SCAN_ROOTS: readonly string[] = [
  // Activity feed (feature 029): assistant text, tool args, tool
  // results, system text. All host-sanitized for secrets but not for
  // HTML.
  resolve(REPO_ROOT, 'webview-ui', 'src', 'components', 'PhaseLogFeed'),
  // Builder surface (feature 101, FR-039): definition names, descriptions, and
  // version notes. Every one of those is operator-authored or imported from a
  // file on disk, so all three are untrusted text arriving from outside the
  // host. The Builder renders lifecycle chrome around them — rows, a history
  // panel, a changed-field summary — and each of those is a new render site
  // that must stay on Svelte's auto-escaping path.
  resolve(REPO_ROOT, 'webview-ui', 'src', 'components', 'Builder'),
  // Runs launch surface (feature 102, FR-040): definition names and
  // descriptions, rendered first as list rows and then again in a detail
  // panel before a launch. Both strings are operator-authored or imported
  // from a file on disk, so both are untrusted text arriving from outside
  // the host — the same provenance as the Builder's, now rendered at new
  // sites. Listed here BEFORE those components exist, because until a root
  // is scanned this lint passes while proving nothing about the render
  // sites it is meant to guard; feature 101 had to add `Builder` for the
  // same reason.
  resolve(REPO_ROOT, 'webview-ui', 'src', 'components', 'Runs')
];

// Feature 103 (T079, FR-046) — the History surface's components are flat
// `History*.svelte` files in `components/` rather than a directory of their
// own, so a scan root cannot reach them without dragging in every unrelated
// component beside them. They are enumerated by prefix instead.
//
// Enumerated rather than listed one by one on purpose: a rule that names only
// the files that existed when it was written stops covering the surface the
// moment an eighth component lands, and it would stop silently. The text at
// stake is the same class as the Builder's — run descriptions typed into the
// queue form, operator-named queues, definition and Workflow names read out of
// a process document, and event fields the CLI wrote into the audit log.
const SCAN_FILE_GROUPS: readonly { readonly dir: string; readonly prefix: string }[] = [
  { dir: resolve(REPO_ROOT, 'webview-ui', 'src', 'components'), prefix: 'History' }
];

// Empty allowlist — every existing scanned component renders text via
// Svelte's auto-escaping path. Add an entry here ONLY if you have a
// typed, host-rendered, trusted-HTML body to interpolate.
const ALLOWED_FILES: ReadonlySet<string> = new Set<string>();

/** Files under `dir` whose name starts with `prefix`, absolute, non-recursive. */
function svelteFilesWithPrefix(dir: string, prefix: string): readonly string[] {
  let names: readonly string[];
  try {
    names = readdirSync(dir);
  } catch {
    // Same tolerance the `status === 2` arm below extends to a missing scan
    // root: a partial worktree may not have the directory yet.
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith('.svelte'))
    .map((name) => resolve(dir, name));
}

/** Absolute scan results reported the way the assertions expect them. */
function toRelative(file: string): string {
  return file.startsWith(`${REPO_ROOT}/`) ? file.slice(REPO_ROOT.length + 1) : file;
}

function listMatchingFilesIn(scanRoot: string, pattern: string): readonly string[] {
  // `-E` in the original: these patterns are extended regexes, not literals.
  return filesMatching(scanRoot, pattern, { extensions: ['.svelte'] }).map(toRelative);
}

/** The same prohibition applied to an explicit file list rather than a tree. */
function listMatchingFilesAmong(files: readonly string[], pattern: string): readonly string[] {
  const regex = new RegExp(pattern);
  return files
    .filter((file) => {
      try {
        return regex.test(readFileSync(file, 'utf8'));
      } catch {
        // A named file that is absent is not a match. The `grep` this replaced
        // treated a missing scan root the same way, deliberately: a root may
        // legitimately not exist yet in a partial worktree.
        return false;
      }
    })
    .map(toRelative);
}

/** Every `.svelte` file under the scanned roots, matched or not. */
function allScannedFiles(): readonly string[] {
  const collected: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of filesMatching(root, '', { extensions: ['.svelte'] })) {
      collected.push(toRelative(file));
    }
  }
  for (const group of SCAN_FILE_GROUPS) {
    for (const file of svelteFilesWithPrefix(group.dir, group.prefix)) {
      collected.push(toRelative(file));
    }
  }
  return collected;
}

function listMatchingFiles(pattern: string): readonly string[] {
  const collected: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of listMatchingFilesIn(root, pattern)) {
      collected.push(file);
    }
  }
  for (const group of SCAN_FILE_GROUPS) {
    const files = svelteFilesWithPrefix(group.dir, group.prefix);
    for (const file of listMatchingFilesAmong(files, pattern)) {
      collected.push(file);
    }
  }
  return collected;
}

describe('Feature 029 T044 — no {@html} in Activity Feed components (FR-017)', () => {
  it('scanned directories contain no `{@html EXPR}` template token outside the allowlist', () => {
    // ERE pattern: match `{@html` followed by at least one whitespace
    // and at least one non-`}` character before the closing `}`. The
    // documentation form `\`{@html}\`` (closing brace immediately
    // attached) does NOT match.
    const matched = listMatchingFiles('\\{@html[[:space:]]+[^}]+\\}');
    const offenders = matched.filter((rel) => !ALLOWED_FILES.has(rel));
    expect(
      offenders,
      `Offending Svelte files using {@html}:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  // Vacuity controls. The assertion above passes when the scan finds nothing,
  // and this file's own header already names that risk — "until a root is
  // scanned this lint passes while proving nothing about the render sites". It
  // was a comment; these make it a check.
  //
  // Two things can empty the scan independently, so both are checked: the roots
  // can stop resolving to files, and the pattern can stop matching. This gate
  // guards against untrusted operator- and file-authored text reaching Svelte's
  // raw-HTML escape hatch, so a silent pass is an unnoticed XSS surface rather
  // than a tidy-up.
  it('scans a non-empty set of Svelte files', () => {
    // Aggregate rather than per-root on purpose: the header records that a root
    // may be listed BEFORE the components under it exist, which is a deliberate
    // pattern here and must keep working.
    expect(
      allScannedFiles().length,
      'The scan roots resolved to no .svelte files at all. Every assertion in this ' +
        'file is passing vacuously.'
    ).toBeGreaterThanOrEqual(15);
  });

  it('the {@html} pattern matches a real offender and spares the documentation form', () => {
    const dir = mkdtempSync(join(tmpdir(), 'html-interp-lint-'));
    try {
      writeFileSync(join(dir, 'offender.svelte'), '<div>{@html untrusted}</div>\n', 'utf8');
      writeFileSync(
        join(dir, 'clean.svelte'),
        // The documentation form, closing brace attached, which the pattern is
        // written to spare. If a pattern edit starts matching this, the gate
        // begins failing on its own prose.
        '<!-- never use `{@html}` here -->\n<div>{escaped}</div>\n',
        'utf8'
      );
      const matched = listMatchingFilesIn(dir, '\\{@html[[:space:]]+[^}]+\\}');
      expect(matched.map((f) => f.split('/').pop())).toEqual(['offender.svelte']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
