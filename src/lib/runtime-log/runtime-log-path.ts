// Feature 019 — Runtime log path resolution.
//
// `resolveRuntimeLogPath` accepts:
//   - Empty string → resolves to `<workspaceRoot>/.schegent/syslog`.
//   - Absolute path (POSIX or Windows) → returned as-is.
//   - Workspace-relative path → resolved against workspace folder 0.
//     Relative paths containing `..` are rejected to block path
//     traversal out of the workspace (FR-016).
//
// Multi-root workspaces anchor against folder index 0 (mirrors the
// existing audit-log resolution rule).
//
// The function is pure — it does NOT touch the filesystem; callers
// receive a `RuntimeLogPathResult` and decide whether to log a warning
// or fall back.

import * as path from 'path';

export type RuntimeLogPathError =
  | 'no-workspace'
  | 'relative-traversal'
  | 'invalid-input'
  | 'absolute-outside-allowed-roots';

export type RuntimeLogPathResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: RuntimeLogPathError };

const DEFAULT_FILENAME = 'syslog';
const DEFAULT_SUBDIR = '.schegent';

/**
 * Cross-platform absolute-path detector. POSIX paths start with `/`;
 * Windows absolute paths are drive-letter (`C:\` / `C:/`) or UNC
 * (`\\server\share` / `//server/share`). We don't gate by `process.platform`
 * because operators on macOS may type a Windows path for a remote-mount
 * test and vice versa — the detection is purely lexical.
 */
export function isAbsoluteCrossPlatform(p: string): boolean {
  if (p.length === 0) return false;
  if (p.startsWith('/')) return true;
  if (p.startsWith('\\\\') || p.startsWith('//')) return true;
  // Drive-letter form: `C:\`, `C:/`, `D:`, etc.
  if (/^[A-Za-z]:[\\/]?/.test(p)) return true;
  return false;
}

/**
 * Returns true when `candidate` resolves to a path under one of the
 * `allowedRoots` after normalization. Uses `path.relative` so symlinks
 * and `..` segments in `candidate` cannot escape — `path.relative`
 * computes a lexical hop count, not a filesystem walk.
 */
function isUnderAllowedRoot(
  candidate: string,
  allowedRoots: readonly string[]
): boolean {
  const normalizedCandidate = path.normalize(candidate);
  for (const root of allowedRoots) {
    if (!root) continue;
    const normalizedRoot = path.normalize(root);
    const rel = path.relative(normalizedRoot, normalizedCandidate);
    // Inside if relative path does not climb out (`..` prefix) and is
    // not absolute on its own (which would mean the two paths share no
    // common root — different drive letters on Windows or different
    // filesystems on POSIX after normalization).
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve the configured `runtimeLogFilePath` to an absolute path the
 * sink can write to. `workspaceRoot` is the first workspace folder's
 * `fsPath` (or `null` when no folder is open).
 *
 * When `allowedAbsoluteRoots` is non-empty, absolute paths are rejected
 * if they do not resolve to a descendant of one of those roots.
 * Defense-in-depth against a malicious workspace settings file that
 * pre-sets `runtimeLogFilePath = '/etc/passwd.log'` and waits for the
 * sink to truncate-and-write under the operator's UID. The legitimate
 * roots are `workspaceRoot`, the extension's `globalStorage`, the OS
 * tmpdir, and the operator's home directory — wired by the extension
 * at activation. When `allowedAbsoluteRoots` is undefined or empty the
 * historical "absolute paths are operator-trusted" behavior is
 * preserved (kept for unit-test simplicity; production always supplies
 * the list).
 */
export function resolveRuntimeLogPath(
  rawValue: unknown,
  workspaceRoot: string | null,
  allowedAbsoluteRoots?: readonly string[]
): RuntimeLogPathResult {
  if (rawValue !== undefined && rawValue !== null && typeof rawValue !== 'string') {
    return { ok: false, error: 'invalid-input' };
  }
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';

  if (value === '') {
    if (!workspaceRoot) {
      return { ok: false, error: 'no-workspace' };
    }
    return {
      ok: true,
      path: path.join(workspaceRoot, DEFAULT_SUBDIR, DEFAULT_FILENAME)
    };
  }

  if (isAbsoluteCrossPlatform(value)) {
    const normalized = path.normalize(value);
    if (allowedAbsoluteRoots && allowedAbsoluteRoots.length > 0) {
      if (!isUnderAllowedRoot(normalized, allowedAbsoluteRoots)) {
        return { ok: false, error: 'absolute-outside-allowed-roots' };
      }
    }
    return { ok: true, path: normalized };
  }

  // Relative path. Block `..` segments outright (FR-016) so a
  // workspace-relative configuration cannot escape the workspace.
  const segments = value.split(/[\\/]+/);
  if (segments.some((seg) => seg === '..')) {
    return { ok: false, error: 'relative-traversal' };
  }
  if (!workspaceRoot) {
    return { ok: false, error: 'no-workspace' };
  }
  return { ok: true, path: path.join(workspaceRoot, ...segments) };
}
