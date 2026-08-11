// Feature 087 (T013, US5, FR-015) — the workspace boundary.
//
// The case that matters most here is the prefix-compare trap: for root
// `/workspace`, the path `/workspace-evil/secret.md` passes a `startsWith`
// check and is outside the workspace. OWASP's guidance is to canonicalize
// first and then test containment *relationally* — `path.relative` produces a
// hop count, not a string prefix — which is the idiom `runtime-log-path.ts`
// already uses and the one plan D5 reuses here.

import { describe, expect, it } from 'vitest';
import { resolveWithinWorkspace } from '../../../../src/services/run-request/workspace-containment';

const ROOT = '/workspace';

describe('resolveWithinWorkspace', () => {
  it.each([
    ['notes/brief.md', '/workspace/notes/brief.md'],
    ['./notes/brief.md', '/workspace/notes/brief.md'],
    ['notes/./nested/../brief.md', '/workspace/notes/brief.md'],
    ['notes/', '/workspace/notes'],
    ['/workspace/notes/brief.md', '/workspace/notes/brief.md']
  ])('resolves %s inside the root', (candidate, expected) => {
    expect(resolveWithinWorkspace(ROOT, candidate)).toEqual({
      ok: true,
      absolutePath: expected
    });
  });

  it('treats the root itself as contained', () => {
    expect(resolveWithinWorkspace(ROOT, '.')).toEqual({ ok: true, absolutePath: ROOT });
  });

  it('normalizes a root with a trailing separator', () => {
    expect(resolveWithinWorkspace('/workspace/', 'notes/brief.md')).toEqual({
      ok: true,
      absolutePath: '/workspace/notes/brief.md'
    });
  });

  // The whole reason the check is relational and not a prefix compare.
  it('refuses a sibling root that shares a textual prefix', () => {
    expect(resolveWithinWorkspace(ROOT, '/workspace-evil/secret.md')).toEqual({ ok: false });
    expect(resolveWithinWorkspace(ROOT, '/workspaceevil')).toEqual({ ok: false });
  });

  it.each([
    '../outside.md',
    '..',
    'notes/../../outside.md',
    'a/b/c/../../../../outside.md',
    '/etc/passwd',
    '/'
  ])('refuses %s', (candidate) => {
    expect(resolveWithinWorkspace(ROOT, candidate)).toEqual({ ok: false });
  });

  it('refuses an empty candidate', () => {
    expect(resolveWithinWorkspace(ROOT, '')).toEqual({ ok: false });
    expect(resolveWithinWorkspace(ROOT, '   ')).toEqual({ ok: false });
  });

  it('refuses when there is no root to resolve against', () => {
    expect(resolveWithinWorkspace('', 'notes/brief.md')).toEqual({ ok: false });
  });

  // A NUL byte terminates a C string, so a path the checker reads as
  // `notes/brief.md` can reach a syscall as something shorter. Node throws on
  // it at the syscall; refusing here keeps the boundary the one that decides.
  it('refuses a candidate containing a NUL byte', () => {
    expect(resolveWithinWorkspace(ROOT, 'notes/brief.md\u0000.png')).toEqual({ ok: false });
  });
});
