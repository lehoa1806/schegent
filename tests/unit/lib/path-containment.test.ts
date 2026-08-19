// Feature FR-R3-005 (T331) — the containment oracle.
//
// Covers:
//   - A resolved path inside a root is `contained`, and the verdict carries
//     the resolved path so the caller acts on what it proved, not on what it
//     was handed.
//   - A symlink out of the roots is refused even though the lexical path is
//     spotless — the case a `path.relative` check cannot see.
//   - A `realpath` failure that is not "missing" is `resolve-failed`, never a
//     fall-through to lexical comparison.
//   - An unresolvable *root* also downgrades to `resolve-failed`: it might
//     have been the root that contained the target.
//   - A missing target is `absent` for the target/write forms, because a
//     destructive operation on a path that is not there has no work.
//   - `resolveContainedLink` does not follow the leaf, so an entry that is a
//     symlink out of the workspace is still unlinkable — while the same path
//     is refused by `resolveContainedTarget`.
//   - `resolveContainedForWrite` checks the deepest ancestor that exists when
//     the leaf does not, so a fresh path under a symlinked ancestor is caught.
//   - An empty root list refuses everything (fail closed).

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  NO_ERRNO,
  resolveContainedForWrite,
  resolveContainedLink,
  resolveContainedTarget,
  type ContainmentFs
} from '../../../src/lib/path-containment';

const WS = path.sep === '\\' ? 'C:\\ws' : '/ws';
const OUT = path.sep === '\\' ? 'C:\\elsewhere' : '/elsewhere';

function p(...segments: string[]): string {
  return path.join(...segments);
}

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/**
 * A `realpath` over a declared link table. Any path not named resolves to
 * itself; a path named with `null` raises the given errno.
 */
function fakeFs(
  links: Record<string, string>,
  failures: Record<string, string> = {}
): ContainmentFs {
  return {
    async realpath(target: string): Promise<string> {
      const normalized = path.resolve(target);
      const failure = failures[normalized];
      if (failure) throw errno(failure);
      for (const [from, to] of Object.entries(links)) {
        const resolvedFrom = path.resolve(from);
        if (normalized === resolvedFrom) return to;
        const rel = path.relative(resolvedFrom, normalized);
        if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
          return path.join(to, rel);
        }
      }
      return normalized;
    }
  };
}

describe('FR-R3-005 (T331) path-containment oracle', () => {
  describe('resolveContainedTarget', () => {
    it('accepts a path that resolves inside a root and returns the resolved path', async () => {
      const fs = fakeFs({});
      const verdict = await resolveContainedTarget(p(WS, '.schegent', 'sessions'), [WS], fs);
      expect(verdict).toEqual({
        outcome: 'contained',
        resolved: p(WS, '.schegent', 'sessions')
      });
    });

    it('refuses a lexically clean path that resolves out of the roots', async () => {
      // `<ws>/.schegent/sessions` is spotless to `path.relative`. It is a
      // symlink to `/elsewhere/sessions`, which is the whole point.
      const fs = fakeFs({ [p(WS, '.schegent')]: p(OUT, 'stolen') });
      const verdict = await resolveContainedTarget(p(WS, '.schegent', 'sessions'), [WS], fs);
      expect(verdict).toEqual({
        outcome: 'refused',
        reason: 'not-contained',
        errno: NO_ERRNO
      });
    });

    it('reports a missing target as absent rather than a refusal', async () => {
      const fs = fakeFs({}, { [p(WS, 'gone')]: 'ENOENT' });
      await expect(resolveContainedTarget(p(WS, 'gone'), [WS], fs)).resolves.toEqual({
        outcome: 'absent'
      });
    });

    it('treats ENOTDIR the same as ENOENT — a component is not a directory', async () => {
      const fs = fakeFs({}, { [p(WS, 'file', 'child')]: 'ENOTDIR' });
      await expect(
        resolveContainedTarget(p(WS, 'file', 'child'), [WS], fs)
      ).resolves.toEqual({ outcome: 'absent' });
    });

    it('refuses with resolve-failed when the target cannot be resolved', async () => {
      const fs = fakeFs({}, { [p(WS, 'locked')]: 'EACCES' });
      await expect(resolveContainedTarget(p(WS, 'locked'), [WS], fs)).resolves.toEqual({
        outcome: 'refused',
        reason: 'resolve-failed',
        errno: 'EACCES'
      });
    });

    it('never falls through to a lexical answer when resolution fails', async () => {
      // The lexical answer here is "contained". The oracle must not give it.
      const fs = fakeFs({}, { [p(WS, 'inside', 'deep')]: 'EIO' });
      const verdict = await resolveContainedTarget(p(WS, 'inside', 'deep'), [WS], fs);
      expect(verdict.outcome).toBe('refused');
    });

    it('downgrades to resolve-failed when a root will not resolve', async () => {
      // The unresolvable root might have been the one that contained the
      // target, so this cannot be reported as a clean not-contained.
      const fs = fakeFs({}, { [OUT]: 'EACCES' });
      const verdict = await resolveContainedTarget(p(WS, 'a'), [OUT, p(WS, 'b')], fs);
      expect(verdict).toEqual({
        outcome: 'refused',
        reason: 'resolve-failed',
        errno: 'EACCES'
      });
    });

    it('still accepts when a resolvable root contains the target and another root fails', async () => {
      const fs = fakeFs({}, { [OUT]: 'EACCES' });
      const verdict = await resolveContainedTarget(p(WS, 'a'), [OUT, WS], fs);
      expect(verdict).toEqual({ outcome: 'contained', resolved: p(WS, 'a') });
    });

    it('refuses everything when the root list is empty', async () => {
      const fs = fakeFs({});
      await expect(resolveContainedTarget(p(WS, 'a'), [], fs)).resolves.toEqual({
        outcome: 'refused',
        reason: 'not-contained',
        errno: NO_ERRNO
      });
    });

    it('ignores empty strings in the root list rather than treating them as a root', async () => {
      const fs = fakeFs({});
      await expect(resolveContainedTarget(p(WS, 'a'), ['', WS], fs)).resolves.toMatchObject({
        outcome: 'contained'
      });
      await expect(resolveContainedTarget(p(WS, 'a'), [''], fs)).resolves.toMatchObject({
        outcome: 'refused',
        reason: 'not-contained'
      });
    });

    it('accepts the root itself', async () => {
      const fs = fakeFs({});
      await expect(resolveContainedTarget(WS, [WS], fs)).resolves.toEqual({
        outcome: 'contained',
        resolved: path.resolve(WS)
      });
    });

    it('is not fooled by a sibling whose name shares the root prefix', async () => {
      const fs = fakeFs({});
      const verdict = await resolveContainedTarget(`${WS}-other`, [WS], fs);
      expect(verdict).toMatchObject({ outcome: 'refused', reason: 'not-contained' });
    });
  });

  describe('resolveContainedLink', () => {
    it('accepts an entry whose directory is contained even when the entry is a symlink out', async () => {
      // `unlink` removes the link, not its target, so refusing here would
      // leave the host unable to clean its own directory.
      const fs = fakeFs({ [p(WS, 'logs', 'syslog.1')]: p(OUT, 'target') });
      const verdict = await resolveContainedLink(p(WS, 'logs', 'syslog.1'), [WS], fs);
      expect(verdict).toEqual({
        outcome: 'contained',
        resolved: p(WS, 'logs', 'syslog.1')
      });
      // The same path through the target form is refused — the two entry
      // points genuinely differ, which is why both exist.
      await expect(
        resolveContainedTarget(p(WS, 'logs', 'syslog.1'), [WS], fs)
      ).resolves.toMatchObject({ outcome: 'refused', reason: 'not-contained' });
    });

    it('refuses when the entry directory itself resolves out of the roots', async () => {
      const fs = fakeFs({ [p(WS, 'logs')]: p(OUT, 'logs') });
      await expect(
        resolveContainedLink(p(WS, 'logs', 'syslog.1'), [WS], fs)
      ).resolves.toMatchObject({ outcome: 'refused', reason: 'not-contained' });
    });

    it('checks the deepest existing ancestor when the parent chain is missing', async () => {
      // `<ws>/link -> /elsewhere`. `<ws>/link/deep` does not exist yet, so a
      // naive parent check would find nothing to resolve and wave it through;
      // `mkdir -p` would then create `/elsewhere/deep`.
      const fs = fakeFs(
        { [p(WS, 'link')]: OUT },
        { [p(WS, 'link', 'deep')]: 'ENOENT', [p(OUT, 'deep')]: 'ENOENT' }
      );
      await expect(
        resolveContainedLink(p(WS, 'link', 'deep', 'syslog'), [WS], fs)
      ).resolves.toMatchObject({ outcome: 'refused', reason: 'not-contained' });
    });

    it('accepts a fresh path whose missing ancestors sit under a contained root', async () => {
      const fs = fakeFs({}, {
        [p(WS, 'new', 'deep')]: 'ENOENT',
        [p(WS, 'new')]: 'ENOENT'
      });
      await expect(
        resolveContainedLink(p(WS, 'new', 'deep', 'syslog'), [WS], fs)
      ).resolves.toEqual({
        outcome: 'contained',
        resolved: p(WS, 'new', 'deep', 'syslog')
      });
    });

    it('refuses with resolve-failed when an ancestor cannot be resolved', async () => {
      const fs = fakeFs({}, { [p(WS, 'logs')]: 'EACCES' });
      await expect(
        resolveContainedLink(p(WS, 'logs', 'syslog.1'), [WS], fs)
      ).resolves.toEqual({
        outcome: 'refused',
        reason: 'resolve-failed',
        errno: 'EACCES'
      });
    });

    it('refuses the filesystem root, which nothing can contain', async () => {
      const fs = fakeFs({});
      const root = path.parse(path.resolve(WS)).root;
      await expect(resolveContainedLink(root, [WS], fs)).resolves.toMatchObject({
        outcome: 'refused',
        reason: 'not-contained'
      });
    });
  });

  describe('resolveContainedForWrite', () => {
    it('resolves an existing leaf, so a symlinked log file is refused', async () => {
      const fs = fakeFs({ [p(WS, 'syslog')]: p(OUT, 'passwd') });
      await expect(
        resolveContainedForWrite(p(WS, 'syslog'), [WS], fs)
      ).resolves.toMatchObject({ outcome: 'refused', reason: 'not-contained' });
    });

    it('falls back to the ancestor check when the leaf does not exist yet', async () => {
      const fs = fakeFs({}, { [p(WS, 'syslog')]: 'ENOENT' });
      await expect(resolveContainedForWrite(p(WS, 'syslog'), [WS], fs)).resolves.toEqual({
        outcome: 'contained',
        resolved: p(WS, 'syslog')
      });
    });

    it('never returns absent — a path to be created is not a no-op', async () => {
      const fs = fakeFs({}, { [p(WS, 'syslog')]: 'ENOENT' });
      const verdict = await resolveContainedForWrite(p(WS, 'syslog'), [WS], fs);
      expect(verdict.outcome).not.toBe('absent');
    });

    it('refuses a fresh leaf under a symlinked ancestor', async () => {
      const fs = fakeFs(
        { [p(WS, '.schegent')]: p(OUT, 'stolen') },
        { [p(OUT, 'stolen', 'syslog')]: 'ENOENT' }
      );
      await expect(
        resolveContainedForWrite(p(WS, '.schegent', 'syslog'), [WS], fs)
      ).resolves.toMatchObject({ outcome: 'refused', reason: 'not-contained' });
    });
  });
});
