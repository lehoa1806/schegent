import { describe, expect, it } from 'vitest';
import {
  CONTAINMENT_REFUSED_ERRNO,
  classifyMountCapability,
  type ExclusiveCreateObservation
} from '../../../src/state/mount-capability';

/**
 * FR-R3-083 (T1122) — the mount classification, over every arm.
 *
 * WHAT THIS SUITE ESTABLISHES, AND WHAT IT DOES NOT
 *
 * Every case here is reached by handing the classification an observation
 * directly, because no filesystem available to this project exhibits the arm that
 * matters: a mount where the SECOND exclusive create of the same name succeeds.
 * `FR-R3-083` §4 permits exactly this and requires the weaker claim be stated as
 * one, so it is stated here and in
 * `docs/operations/platform-observation-record.md`:
 *
 *   **The code path is exercised. The real-world behaviour is not measured.**
 *
 * That is not a hedge. A reader deciding whether Schegent is safe on their NFS
 * mount learns from this suite that the probe would classify such a mount
 * correctly IF it behaves as documented — not that any mount was tried.
 */
const created: ExclusiveCreateObservation = { outcome: 'created' };
const exists: ExclusiveCreateObservation = { outcome: 'refused', errno: 'EEXIST' };
const timedOut: ExclusiveCreateObservation = { outcome: 'timed-out' };
const failed = (errno: string): ExclusiveCreateObservation => ({ outcome: 'io-failed', errno });

describe('mount capability classification (FR-R3-083)', () => {
  it('reports supported when the second exclusive create is refused EEXIST', () => {
    expect(classifyMountCapability(created, exists)).toEqual({
      capability: 'supported',
      cause: 'exclusive-create-holds',
      errno: 'EEXIST'
    });
  });

  it('reports unsupported when the second exclusive create SUCCEEDS', () => {
    // THE CASE THIS PROBE EXISTS FOR, and the one a refusal-only probe misses
    // entirely. A mount that creates twice lets two windows both believe they
    // elected themselves, which is the failure the fence cannot survive.
    //
    // Reached by injection. No such mount is available here, and that is recorded
    // as the weaker claim it is — see this file's header.
    expect(classifyMountCapability(created, created)).toEqual({
      capability: 'unsupported',
      cause: 'second-exclusive-create-succeeded'
    });
  });

  it.each(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'])(
    'reports unsupported when the filesystem answers %s',
    (errno) => {
      const verdict = classifyMountCapability(failed(errno), failed(errno));
      expect(verdict.capability).toBe('unsupported');
      expect(verdict.cause).toBe('exclusive-create-unsupported');
      // The deciding code is preserved, for the reason `AcquireOutcome.cause`
      // preserves it: it is what separates a full disk from a permissions problem
      // from a mount that does not implement the primitive.
      expect(verdict.errno).toBe(errno);
    }
  );

  it('keeps a read-only workspace apart from a broken mount', () => {
    // EROFS is a legitimate workspace condition. The fence will not elect there
    // either, but the MOUNT is fine, and telling that operator their filesystem
    // cannot arbitrate is a false finding that costs the real one its credibility.
    expect(classifyMountCapability(failed('EROFS'), failed('EROFS'))).toEqual({
      capability: 'read-only',
      cause: 'read-only-workspace',
      errno: 'EROFS'
    });
  });

  it.each(['EACCES', 'EPERM'])(
    'does not treat a permissions answer (%s) as a mount property',
    (errno) => {
      // Neither is in the unsupported set. A root-owned `.schegent`, an immutable
      // flag, or a FUSE mount answering EPERM where another answers EACCES would
      // otherwise produce "move the workspace to a local-style filesystem" about a
      // filesystem that is perfectly capable.
      //
      // `ownership-registry.ts` lists ENOTSUP/EPERM/EROFS/ENOSYS as codes worth
      // keeping APART; reading that as an equivalence class is what put EPERM here
      // in the first draft.
      const verdict = classifyMountCapability(failed(errno), failed(errno));
      expect(verdict.capability).toBe('undetermined');
      expect(verdict.cause).toBe('unclassified-error');
    }
  );

  it('reports a containment refusal as undetermined, never as a mount finding', () => {
    const verdict = classifyMountCapability(
      failed(CONTAINMENT_REFUSED_ERRNO),
      failed(CONTAINMENT_REFUSED_ERRNO)
    );
    expect(verdict.capability).toBe('undetermined');
    expect(verdict.cause).toBe('containment-refused');
  });

  it.each([
    ['first', timedOut, exists],
    ['second', created, timedOut]
  ])('reports undetermined when the %s attempt times out', (_which, first, second) => {
    // A bound that expired is not evidence. The probe must never manufacture a
    // finding out of its own impatience -- which is exactly what an unresponsive
    // network mount, the environment this exists for, would otherwise produce.
    expect(classifyMountCapability(first, second)).toEqual({
      capability: 'undetermined',
      cause: 'probe-timed-out'
    });
  });

  it('reports undetermined when the first create succeeded and the second failed oddly', () => {
    const verdict = classifyMountCapability(created, failed('ENOSPC'));
    expect(verdict.capability).toBe('undetermined');
    expect(verdict.errno).toBe('ENOSPC');
  });

  it('keeps the four capabilities mutually distinguishable', () => {
    // FR-008/FR-010, SC-004. `undetermined` is a third answer and not a shading of
    // either neighbour; collapsing it into one of them is the silent downgrade
    // FR-R3-083 §5 forbids.
    const seen = new Set([
      classifyMountCapability(created, exists).capability,
      classifyMountCapability(created, created).capability,
      classifyMountCapability(failed('EROFS'), failed('EROFS')).capability,
      classifyMountCapability(timedOut, timedOut).capability
    ]);
    expect([...seen].sort()).toEqual(['read-only', 'supported', 'undetermined', 'unsupported']);
  });
});
