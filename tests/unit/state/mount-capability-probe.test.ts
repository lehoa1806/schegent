import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { probeMountCapability } from '../../../src/state/mount-capability-probe';
import type { ExclusiveCreateObservation } from '../../../src/state/mount-capability';

/**
 * FR-R3-083 — the probe against a REAL filesystem, plus the two arms that need a
 * seam.
 *
 * The classification is covered by `mount-capability.test.ts`. What is covered
 * here is the behaviour the classification cannot see: that the probe answers at
 * all on a real mount, that it cleans up after itself on every outcome, and that
 * its bound holds against an attempt that never settles.
 *
 * The temp root is real on purpose. This suite exists to observe `O_EXCL`'s actual
 * semantics, and a JavaScript model of the filesystem cannot exhibit the
 * divergence the probe is looking for -- the same reasoning `tests/global-temp-root.ts`
 * records for the ownership-fs suite.
 */
let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mount-probe-'));
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

/** A real exclusive create, so the abandoned-second-attempt case has a real file to sweep. */
async function realCreateForTest(
  segments: readonly string[]
): Promise<ExclusiveCreateObservation> {
  const dir = path.join(workspaceRoot, ...segments.slice(0, -1));
  await fs.mkdir(dir, { recursive: true });
  const handle = await fs.open(path.join(dir, segments[segments.length - 1]), 'wx');
  await handle.close();
  return { outcome: 'created' };
}

/** What the probe left behind under `.schegent/`, or `[]` when it made nothing. */
async function schegentEntries(): Promise<readonly string[]> {
  try {
    return (await fs.readdir(path.join(workspaceRoot, '.schegent'))).sort();
  } catch {
    return [];
  }
}

/**
 * Probe artifacts only.
 *
 * `.gitignore` is EXPECTED: `schegent-gitignore.ts` states that every writer which
 * creates `.schegent/` also drops the local ignore file, and the probe creates it.
 *
 * It is NOT the first writer -- `extension.ts` elects ownership first, and that path
 * creates `.schegent/ownership/` without dropping the file. The source says so at
 * `mount-capability-probe.ts`; this comment used to restate the retracted version,
 * which left two answers in the tree with the false one reading as a test-asserted
 * fact. What the call buys is that the ignore file lands at ACTIVATION rather than
 * at the first audit append, which keeps an abandoned `.mount-probe.*` out of the
 * operator's `git status`.
 */
async function probeArtifacts(): Promise<readonly string[]> {
  return (await schegentEntries()).filter((name) => name.startsWith('.mount-probe'));
}

describe('mount capability probe (FR-R3-083)', () => {
  it('reports supported on an ordinary local filesystem', async () => {
    // Not a tautology: this is the only place the real `O_EXCL` path runs. A
    // regression that stopped opening exclusively -- `'w'` instead of `'wx'`, say --
    // would create twice and report `unsupported` here, which is the alarm.
    const verdict = await probeMountCapability({ workspaceRoot });
    expect(verdict.capability).toBe('supported');
    expect(verdict.cause).toBe('exclusive-create-holds');
  });

  it('leaves nothing behind on the supported path', async () => {
    await probeMountCapability({ workspaceRoot });
    // SC-005.
    expect(await probeArtifacts()).toEqual([]);
    // And the ignore file IS there, because the probe created the directory.
    expect(await schegentEntries()).toContain('.gitignore');
  });

  it('leaves nothing behind when the create throws', async () => {
    const verdict = await probeMountCapability({
      workspaceRoot,
      exclusiveCreate: () => Promise.reject(Object.assign(new Error('boom'), { code: 'EIO' }))
    });
    expect(verdict.capability).toBe('undetermined');
    expect(await probeArtifacts()).toEqual([]);
  });

  it('leaves nothing behind when the probe times out', async () => {
    const verdict = await probeMountCapability({
      workspaceRoot,
      timeoutMs: 10,
      exclusiveCreate: () => new Promise<ExclusiveCreateObservation>(() => undefined)
    });
    expect(verdict.capability).toBe('undetermined');
    expect(await probeArtifacts()).toEqual([]);
  });

  it('answers undetermined WITHIN its bound against a create that never settles', async () => {
    // T1127 -- the non-vacuity control for the timeout. Without it the bound is
    // untested code that happens to compile, and the failure it prevents is the one
    // that matters most: an unresponsive network mount is precisely the environment
    // this probe exists for, so an unbounded probe would hang activation on exactly
    // the workspace it was added to diagnose.
    const started = Date.now();
    const verdict = await probeMountCapability({
      workspaceRoot,
      timeoutMs: 50,
      exclusiveCreate: () => new Promise<ExclusiveCreateObservation>(() => undefined)
    });
    const elapsed = Date.now() - started;
    expect(verdict).toEqual({ capability: 'undetermined', cause: 'probe-timed-out' });
    // Generous ceiling: the assertion is "it returned rather than hanging", not a
    // wall-clock budget. Timing assertions belong in `test:perf`, which FR-R3-042
    // deliberately keeps out of this suite.
    expect(elapsed).toBeLessThan(2_000);
  });

  it('never throws, whatever the seam does', async () => {
    // FR-011. Activation must not depend on this, and a probe that can throw is a
    // probe that can prevent the extension from starting -- which would make an
    // environment-dependent check strictly worse than no check at all.
    await expect(
      probeMountCapability({
        workspaceRoot,
        exclusiveCreate: () => {
          throw new Error('synchronous');
        }
      })
    ).resolves.toMatchObject({ capability: 'undetermined' });
  });

  it('does not let an arbitrary error code reach an operator-visible line', async () => {
    // `error.code` is `unknown` at the type level and the verdict's errno is
    // interpolated into a log line. Nothing in the types stops a rejection from
    // carrying a path, a sentence, or a megabyte as its `code`, so the shape is
    // bounded rather than trusted.
    const verdict = await probeMountCapability({
      workspaceRoot,
      exclusiveCreate: () =>
        Promise.reject(
          Object.assign(new Error('x'), { code: '/Users/someone/private/workspace' })
        )
    });
    expect(verdict.errno).toBe('unknown');
    expect(verdict.capability).toBe('undetermined');
  });

  it('preserves a real errno, so the bound above is not just discarding data', async () => {
    const verdict = await probeMountCapability({
      workspaceRoot,
      exclusiveCreate: () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOTSUP' }))
    });
    expect(verdict.errno).toBe('ENOTSUP');
    expect(verdict.capability).toBe('unsupported');
  });

  it('drops the ignore file even when a create is injected', async () => {
    // The drop hangs on its OWN option, not on whether a test seam was supplied.
    // Gating it on `exclusiveCreate === undefined` meant the production side effect
    // was decided by which parameter a caller passed -- and that it was never
    // exercised through the seam at all.
    await probeMountCapability({
      workspaceRoot,
      exclusiveCreate: () => Promise.resolve({ outcome: 'created' })
    });
    expect(await schegentEntries()).toContain('.gitignore');
  });

  it('can be told not to drop it', async () => {
    await probeMountCapability({
      workspaceRoot,
      dropIgnoreFile: false,
      exclusiveCreate: () => Promise.resolve({ outcome: 'created' })
    });
    expect(await schegentEntries()).not.toContain('.gitignore');
  });

  it('stops doing filesystem work once disposed', async () => {
    // `dispose()` used to set a flag that suppressed only the REPORT while the probe
    // kept creating `.schegent/`, writing the ignore file, and creating and removing
    // `.mount-probe.*` -- against a root the window had left, or during host
    // shutdown. A disposal contract that stops the notification and not the writes
    // is not a disposal contract.
    const verdict = await probeMountCapability({ workspaceRoot, isDisposed: () => true });
    expect(verdict).toEqual({ capability: 'undetermined', cause: 'probe-disposed' });
    expect(await schegentEntries()).toEqual([]);
  });

  it('removes the artifact when the FIRST create landed and the second was abandoned', async () => {
    // Both flags at once, which is an ordinary shape on a degrading mount. A version
    // that skipped the inline sweep whenever anything was abandoned left the first
    // attempt's file behind forever -- the deferred sweep cannot help there, because
    // it waits on a create that never settles.
    let call = 0;
    const verdict = await probeMountCapability({
      workspaceRoot,
      timeoutMs: 40,
      exclusiveCreate: async (segments) => {
        call += 1;
        if (call === 1) {
          const opened = await realCreateForTest(segments);
          return opened;
        }
        return new Promise<ExclusiveCreateObservation>(() => undefined);
      }
    });
    expect(verdict.cause).toBe('probe-timed-out');
    expect(await probeArtifacts()).toEqual([]);
  });

  it('names a probe artifact unique to the process and the attempt', async () => {
    // FR-013. Two windows activating on one workspace must not observe each other's
    // artifact as their own second create. Observed rather than asserted about the
    // name: two probes in a row both report `supported`, which they could not do if
    // the second saw the first's file.
    const first = await probeMountCapability({ workspaceRoot });
    const second = await probeMountCapability({ workspaceRoot });
    expect([first.capability, second.capability]).toEqual(['supported', 'supported']);
  });
});
