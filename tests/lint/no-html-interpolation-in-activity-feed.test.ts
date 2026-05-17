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
// Feature 031 T032 — scan extended to cover
// `webview-ui/src/components/settings/wakeup/`. The wake-up session-
// log panel renders captured stdout/stderr (operator-influenced bytes
// via the autonomous CLI), so the same prohibition applies. The body
// MUST be rendered through `{text}` bindings only.
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
  // Wake-up settings panel (feature 031): the session-log expansion
  // panel renders captured stdout/stderr of the OS-scheduled wake-up
  // invocation. Same prohibition as the activity feed.
  resolve(REPO_ROOT, 'webview-ui', 'src', 'components', 'settings', 'wakeup')
];

// Empty allowlist — every existing scanned component renders text via
// Svelte's auto-escaping path. Add an entry here ONLY if you have a
// typed, host-rendered, trusted-HTML body to interpolate.
const ALLOWED_FILES: ReadonlySet<string> = new Set<string>();

function listMatchingFilesIn(scanRoot: string, pattern: string): readonly string[] {
  let out: string;
  try {
    out = execSync(
      `grep -rlnE --include="*.svelte" "${pattern}" "${scanRoot}"`,
      { encoding: 'utf8' }
    );
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
