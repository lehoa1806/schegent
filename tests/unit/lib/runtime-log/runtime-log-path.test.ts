// Feature 019 — Path resolution helper for the runtime debug log sink.

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  resolveRuntimeLogPath,
  isAbsoluteCrossPlatform
} from '../../../../src/lib/runtime-log/runtime-log-path';

const POSIX_ROOT = '/home/operator/repo';
const WIN_ROOT = 'C:\\Users\\operator\\repo';

describe('isAbsoluteCrossPlatform', () => {
  it.each([
    ['/etc/log/syslog', true],
    ['C:\\Users\\op\\log.txt', true],
    ['C:/Users/op/log.txt', true],
    ['D:', true],
    ['\\\\server\\share\\log.txt', true],
    ['//server/share/log.txt', true]
  ])('detects absolute %s', (value, expected) => {
    expect(isAbsoluteCrossPlatform(value)).toBe(expected);
  });

  it.each([
    ['', false],
    ['relative/path', false],
    ['.schegent/syslog', false],
    ['../escape', false],
    ['logs\\syslog', false]
  ])('rejects relative %s', (value, expected) => {
    expect(isAbsoluteCrossPlatform(value)).toBe(expected);
  });
});

describe('resolveRuntimeLogPath — empty value (default)', () => {
  it('resolves to <workspaceRoot>/.schegent/syslog when workspace is open', () => {
    const result = resolveRuntimeLogPath('', POSIX_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(path.join(POSIX_ROOT, '.schegent', 'syslog'));
    }
  });

  it('treats whitespace-only input as empty', () => {
    const result = resolveRuntimeLogPath('   \t  ', POSIX_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(path.join(POSIX_ROOT, '.schegent', 'syslog'));
    }
  });

  it('treats undefined as empty default', () => {
    const result = resolveRuntimeLogPath(undefined, POSIX_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(path.join(POSIX_ROOT, '.schegent', 'syslog'));
    }
  });

  it('treats null as empty default', () => {
    const result = resolveRuntimeLogPath(null, POSIX_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(path.join(POSIX_ROOT, '.schegent', 'syslog'));
    }
  });

  it('returns no-workspace error when default is requested but no folder is open', () => {
    const result = resolveRuntimeLogPath('', null);
    expect(result).toEqual({ ok: false, error: 'no-workspace' });
  });
});

describe('resolveRuntimeLogPath — absolute paths (operator-trusted)', () => {
  it('passes through absolute POSIX paths', () => {
    const result = resolveRuntimeLogPath('/tmp/schegent-debug.log', POSIX_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(path.normalize('/tmp/schegent-debug.log'));
    }
  });

  it('passes through absolute Windows drive-letter paths', () => {
    const result = resolveRuntimeLogPath('C:\\Temp\\schegent-debug.log', WIN_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(path.normalize('C:\\Temp\\schegent-debug.log'));
    }
  });

  it('passes through Windows UNC paths', () => {
    const result = resolveRuntimeLogPath('\\\\server\\share\\schegent.log', WIN_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(path.normalize('\\\\server\\share\\schegent.log'));
    }
  });

  it('accepts absolute paths even with no workspace open (loose-file editor)', () => {
    const result = resolveRuntimeLogPath('/var/log/schegent.log', null);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(path.normalize('/var/log/schegent.log'));
    }
  });
});

describe('resolveRuntimeLogPath — workspace-relative paths', () => {
  it('joins simple relative paths to workspaceRoot', () => {
    const result = resolveRuntimeLogPath('logs/syslog', POSIX_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(path.join(POSIX_ROOT, 'logs', 'syslog'));
    }
  });

  it('joins nested relative paths to workspaceRoot', () => {
    const result = resolveRuntimeLogPath('build/output/runtime.log', POSIX_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(
        path.join(POSIX_ROOT, 'build', 'output', 'runtime.log')
      );
    }
  });

  it('accepts backslash-separated relative paths (Windows-style)', () => {
    const result = resolveRuntimeLogPath('logs\\syslog', POSIX_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(path.join(POSIX_ROOT, 'logs', 'syslog'));
    }
  });

  it('rejects relative paths containing `..` (traversal)', () => {
    const result = resolveRuntimeLogPath('../escape/syslog', POSIX_ROOT);
    expect(result).toEqual({ ok: false, error: 'relative-traversal' });
  });

  it('rejects relative paths with embedded `..` segments', () => {
    const result = resolveRuntimeLogPath('logs/../../escape', POSIX_ROOT);
    expect(result).toEqual({ ok: false, error: 'relative-traversal' });
  });

  it('rejects relative paths with `..` at the start of a windows-style chain', () => {
    const result = resolveRuntimeLogPath('..\\escape\\log.txt', WIN_ROOT);
    expect(result).toEqual({ ok: false, error: 'relative-traversal' });
  });

  it('returns no-workspace error when given a relative path and no workspace folder', () => {
    const result = resolveRuntimeLogPath('logs/syslog', null);
    expect(result).toEqual({ ok: false, error: 'no-workspace' });
  });
});

describe('resolveRuntimeLogPath — multi-root + loose-file edge cases (T023, FR-005)', () => {
  // Multi-root workspaces are surfaced to this resolver as a single
  // workspaceRoot string — the host picks folder index 0 (in the
  // wiring at `createRuntimeLogAccessor`) before calling. These cases
  // codify that contract so a future refactor cannot silently drop it.
  it('multi-root workspace: resolves the default against the chosen index-0 root', () => {
    const folderIndex0 = '/repos/primary';
    const result = resolveRuntimeLogPath('', folderIndex0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(path.join(folderIndex0, '.schegent', 'syslog'));
    }
  });

  it('multi-root workspace: relative override joins against index-0 root, not any sibling root', () => {
    const folderIndex0 = '/repos/primary';
    const result = resolveRuntimeLogPath('logs/runtime.log', folderIndex0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(path.join(folderIndex0, 'logs', 'runtime.log'));
      expect(result.path).not.toContain('secondary');
    }
  });

  it('loose-file workspace (no folder open) + relative path → no-workspace error', () => {
    const result = resolveRuntimeLogPath('logs/runtime.log', null);
    expect(result).toEqual({ ok: false, error: 'no-workspace' });
  });

  it('loose-file workspace + empty path → no-workspace error (default needs a root)', () => {
    const result = resolveRuntimeLogPath('', null);
    expect(result).toEqual({ ok: false, error: 'no-workspace' });
  });

  it('loose-file workspace + absolute POSIX path → succeeds (no root needed)', () => {
    const result = resolveRuntimeLogPath('/var/log/schegent-debug.log', null);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe('/var/log/schegent-debug.log');
    }
  });

  it('loose-file workspace + absolute Windows drive-letter path → succeeds', () => {
    const result = resolveRuntimeLogPath('C:\\Temp\\debug.log', null);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // path.normalize on POSIX preserves backslashes — the resolver
      // is only required to mark the result as ok and round-trip the
      // operator-supplied bytes.
      expect(result.path).toContain('C:');
      expect(result.path).toContain('debug.log');
    }
  });
});

describe('resolveRuntimeLogPath — invalid input', () => {
  it.each([
    [123],
    [{}],
    [[]],
    [true]
  ])('rejects non-string input %p', (value) => {
    const result = resolveRuntimeLogPath(value, POSIX_ROOT);
    expect(result).toEqual({ ok: false, error: 'invalid-input' });
  });
});
