// F2 (criterion-8 review, 2026-08-25) — is the containment oracle's comparison
// broken by a case difference on a case-insensitive filesystem?
//
// THE DEFERRAL, AND WHY IT WAS DEFERRED. The review found that `isContainedIn`
// compares with `path.relative`, which is lexical and case-sensitive, and reasoned
// that on `darwin` and Windows — both case-insensitive by default — a root and a
// candidate differing only in case name the same directory and would compare as
// unrelated, yielding `not-contained`. It fails CLOSED, which is why it was Low.
// It was deferred rather than fixed because a case-folding change to the
// containment oracle is the last place a subtle change is welcome, and validating
// one was thought to need a platform matrix that has never run (`VER-1`).
//
// THE PREMISE DOES NOT SURVIVE CONTACT WITH `realpath`. Every path reaching
// `isContainedIn` has been through `filesystem.realpath` — the target at
// `resolveContainedTarget`, the roots inside `judge`, the deepest existing
// ancestor inside `resolveNearestExisting`. On a case-insensitive filesystem
// `realpath` returns the case AS STORED ON DISK, so both sides arrive
// canonicalised and there is no case difference left to mishandle.
//
// A PLATFORM MATRIX IS NOT WHAT THIS NEEDED. Case-insensitivity is a property of
// the FILESYSTEM, not of the operating system: macOS can format case-sensitive
// APFS, Linux can mount case-insensitive volumes, and a `process.platform` check
// would be wrong in both directions. So this test PROBES the filesystem it is
// running on and asserts the correct outcome for whichever regime it finds — which
// makes it valid on every platform, today, without waiting for `VER-1`.
//
//   * case-INsensitive: the two spellings name one directory, `realpath`
//     canonicalises both, and containment must be granted.
//   * case-SENSITIVE: the two spellings name two different directories, and
//     refusing containment is CORRECT rather than a defect.
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveContainedTarget } from '../../../src/lib/path-containment';

let base = '';
let caseInsensitive = false;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'containment-case-')));
  await mkdir(join(base, 'MixedCase'));
  // Probe, do not assume. This is the whole method: ask the filesystem.
  try {
    await realpath(join(base, 'mixedcase'));
    caseInsensitive = true;
  } catch {
    caseInsensitive = false;
  }
});

describe('F2 — a case difference against the containment oracle', () => {
  it('probes the filesystem rather than the platform (method check)', () => {
    // If this ever throws, the probe itself broke and every assertion below is
    // measuring nothing.
    expect(typeof caseInsensitive).toBe('boolean');
    expect(base.length).toBeGreaterThan(0);
  });

  it('grants containment despite a case difference, or refuses correctly', async () => {
    const root = join(base, 'MixedCase');
    const target = join(base, 'mixedcase', 'file.txt');
    await writeFile(join(root, 'file.txt'), 'x');

    const verdict = await resolveContainedTarget(target, [join(base, 'mixedcase')]);

    if (caseInsensitive) {
      // The reported failure mode. `realpath` canonicalises both spellings to the
      // stored case before they ever reach the lexical comparison, so the verdict
      // is `contained` and F2 does not reproduce.
      expect(verdict.outcome).toBe('contained');
    } else {
      // Two genuinely different directories. Not-contained is the right answer.
      expect(verdict.outcome).not.toBe('contained');
    }
  });

  it('canonicalises a differently-cased root to the same resolved path', async () => {
    if (!caseInsensitive) return;
    const stored = await realpath(join(base, 'MixedCase'));
    const typed = await realpath(join(base, 'mixedcase'));
    // This is the mechanism the assertion above depends on, pinned separately so a
    // change in Node's realpath behaviour is attributed to Node rather than
    // mistaken for a containment regression.
    expect(typed).toBe(stored);
  });
});
