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
import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

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

function listMatchingFilesIn(scanRoot: string, pattern: string): readonly string[] {
  return grepFor(`-rlnE --include="*.svelte" "${pattern}" "${scanRoot}"`);
}

/** The same prohibition applied to an explicit file list rather than a tree. */
function listMatchingFilesAmong(files: readonly string[], pattern: string): readonly string[] {
  // `grep` with no file operand reads stdin and never returns, so an empty
  // group has to short-circuit here rather than in the shell.
  if (files.length === 0) return [];
  return grepFor(`-lE "${pattern}" ${files.map((file) => `"${file}"`).join(' ')}`);
}

function grepFor(args: string): readonly string[] {
  let out: string;
  try {
    out = execSync(`grep ${args}`, { encoding: 'utf8' });
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && (!e.stdout || e.stdout.trim() === '')) return [];
    if (e.status === 2) {
      // `grep` returns 2 when the directory does not exist. Treat as
      // "no offenders" — a scan root may legitimately be absent in
      // partial worktrees (e.g. before the panel directory exists
      // pre-feature-031-implementation).
      return [];
    }
    throw err;
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((abs) =>
      abs.startsWith(REPO_ROOT + '/') ? abs.slice(REPO_ROOT.length + 1) : abs
    );
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
});
